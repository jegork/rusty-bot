import type {
  GitProvider,
  FilePatch,
  PRMetadata,
  Finding,
  Hunk,
  CodeSearchResult,
  PostSummaryCommentOptions,
  PriorReviewContext,
} from "@rusty-bot/core";
import {
  encodePriorReviewContext,
  extractPriorReviewContext,
  formatInlineComment,
  logger,
  SearchUnavailableError,
} from "@rusty-bot/core";
import type { z } from "zod";
import {
  GitLabMergeRequestSchema,
  GitLabMergeRequestDiffsSchema,
  GitLabRepositoryCompareSchema,
  GitLabNotesSchema,
  GitLabDiscussionsSchema,
  GitLabClosesIssuesSchema,
  GitLabSearchResultSchema,
} from "./schemas.js";

const BOT_MARKER = "<!-- rusty-bot-review -->";
const LAST_SHA_MARKER_RE = /<!--\s*rusty-bot:last-sha:([0-9a-f]{7,64})\s*-->/i;

const log = logger.child({ package: "gitlab", component: "provider" });

function buildLastShaMarker(sha: string): string {
  return `<!-- rusty-bot:last-sha:${sha} -->`;
}

export interface GitLabProviderConfig {
  /** API root, e.g. https://gitlab.com/api/v4 */
  apiBaseUrl: string;
  /** Project id (numeric) or full path (e.g. "group/sub/project") */
  projectId: string;
  /** MR internal id (iid) */
  mergeRequestIid: number;
  /** Personal access token, project access token, or CI_JOB_TOKEN */
  token: string;
  /** When true, send token via JOB-TOKEN header (CI job token); else PRIVATE-TOKEN */
  isJobToken?: boolean;
}

interface ParsedHunkHeader {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

function parseHunkHeader(line: string): ParsedHunkHeader {
  const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
  if (!match) {
    return { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 };
  }
  return {
    oldStart: parseInt(match[1], 10),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- capture groups can be undefined at runtime
    oldLines: match[2] != null ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- capture groups can be undefined at runtime
    newLines: match[4] != null ? parseInt(match[4], 10) : 1,
  };
}

/**
 * GitLab returns the diff body (without the `diff --git` header) per file in
 * the changes endpoint. Convert it to our internal Hunk[] representation.
 */
function parseGitLabFileDiff(diffBody: string): {
  hunks: Hunk[];
  additions: number;
  deletions: number;
} {
  const hunks: Hunk[] = [];
  let additions = 0;
  let deletions = 0;

  const lines = diffBody.split("\n");
  let current: { header: ParsedHunkHeader; lines: string[] } | null = null;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) {
        hunks.push({ ...current.header, content: current.lines.join("\n") });
      }
      current = { header: parseHunkHeader(line), lines: [line] };
    } else if (current) {
      current.lines.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
  }

  if (current) {
    hunks.push({ ...current.header, content: current.lines.join("\n") });
  }

  return { hunks, additions, deletions };
}

export class GitLabProvider implements GitProvider {
  private readonly apiBaseUrl: string;
  private readonly projectId: string;
  private readonly projectIdEncoded: string;
  private readonly mergeRequestIid: number;
  private readonly token: string;
  private readonly tokenHeader: string;
  /** populated by getDiff/getPRMetadata for use by postInlineComments */
  private cachedDiffRefs: { base_sha: string; start_sha: string; head_sha: string } | null = null;

  constructor(config: GitLabProviderConfig) {
    this.apiBaseUrl = config.apiBaseUrl.replace(/\/$/, "");
    this.projectId = config.projectId;
    this.projectIdEncoded = encodeURIComponent(config.projectId);
    this.mergeRequestIid = config.mergeRequestIid;
    this.token = config.token;
    this.tokenHeader = config.isJobToken ? "JOB-TOKEN" : "PRIVATE-TOKEN";
  }

  private get mrBase(): string {
    return `${this.apiBaseUrl}/projects/${this.projectIdEncoded}/merge_requests/${this.mergeRequestIid}`;
  }

  private get projectBase(): string {
    return `${this.apiBaseUrl}/projects/${this.projectIdEncoded}`;
  }

  private async fetchApi(url: string, options: RequestInit = {}): Promise<Response> {
    const { headers: extraHeaders, ...rest } = options;
    const headers: Record<string, string> = {
      [this.tokenHeader]: this.token,
      Accept: "application/json",
    };
    if (rest.body) {
      headers["Content-Type"] = "application/json";
    }
    if (extraHeaders) {
      new Headers(extraHeaders).forEach((v, k) => {
        headers[k] = v;
      });
    }
    const res = await fetch(url, { ...rest, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitLab API error ${res.status}: ${res.statusText} - ${body}`);
    }
    return res;
  }

  private async request<T extends z.ZodType>(
    url: string,
    schema: T,
    options?: RequestInit,
  ): Promise<z.infer<T>> {
    const res = await this.fetchApi(url, options);
    const json: unknown = await res.json();
    return schema.parse(json);
  }

  async getPRMetadata(): Promise<PRMetadata> {
    const data = await this.request(this.mrBase, GitLabMergeRequestSchema);
    if (data.diff_refs?.base_sha && data.diff_refs.start_sha && data.diff_refs.head_sha) {
      this.cachedDiffRefs = {
        base_sha: data.diff_refs.base_sha,
        start_sha: data.diff_refs.start_sha,
        head_sha: data.diff_refs.head_sha,
      };
    }
    return {
      id: String(data.iid),
      title: data.title,
      description: data.description ?? "",
      author: data.author?.username ?? data.author?.name ?? "",
      sourceBranch: data.source_branch,
      targetBranch: data.target_branch,
      url: data.web_url ?? "",
      ...(data.sha ? { headSha: data.sha } : {}),
    };
  }

  async getDiff(): Promise<FilePatch[]> {
    // /merge_requests/:iid/diffs (paginated, flat array). The deprecated
    // /changes endpoint is removed in API v5 — use this instead. unidiff=true
    // forces the portable unified diff format.
    const PER_PAGE = 50;
    const patches: FilePatch[] = [];
    for (let page = 1; ; page++) {
      const url = `${this.mrBase}/diffs?per_page=${PER_PAGE}&page=${page}&unidiff=true`;
      const entries = await this.request(url, GitLabMergeRequestDiffsSchema);
      if (entries.length === 0) break;
      for (const entry of entries) {
        if (entry.deleted_file) continue;
        const path = entry.new_path;
        if (entry.diff.includes("Binary files") && entry.diff.includes("differ")) {
          patches.push({ path, hunks: [], additions: 0, deletions: 0, isBinary: true });
          continue;
        }
        const { hunks, additions, deletions } = parseGitLabFileDiff(entry.diff);
        patches.push({ path, hunks, additions, deletions, isBinary: false });
      }
      if (entries.length < PER_PAGE) break;
    }

    // /diffs doesn't include diff_refs — fetch them from the MR endpoint so
    // postInlineComments has them available for positioned discussions.
    if (!this.cachedDiffRefs) {
      await this.ensureDiffRefs();
    }

    return patches;
  }

  async getDiffSinceSha(sinceSha: string, headSha: string): Promise<FilePatch[] | null> {
    if (sinceSha === headSha) return [];
    try {
      const url = `${this.projectBase}/repository/compare?from=${encodeURIComponent(
        sinceSha,
      )}&to=${encodeURIComponent(headSha)}&unidiff=true`;
      const compare = await this.request(url, GitLabRepositoryCompareSchema);
      const patches: FilePatch[] = [];
      for (const d of compare.diffs ?? []) {
        if (d.deleted_file || !d.diff) continue;
        const path = d.new_path;
        if (d.diff.includes("Binary files") && d.diff.includes("differ")) {
          patches.push({ path, hunks: [], additions: 0, deletions: 0, isBinary: true });
          continue;
        }
        const { hunks, additions, deletions } = parseGitLabFileDiff(d.diff);
        patches.push({ path, hunks, additions, deletions, isBinary: false });
      }
      return patches;
    } catch (err) {
      log.warn(
        { err, sinceSha, headSha },
        "could not fetch incremental diff (sha unreachable, force-push, or rebase)",
      );
      return null;
    }
  }

  async getLastReviewedSha(): Promise<string | null> {
    const notes = await this.request(`${this.mrBase}/notes?per_page=100`, GitLabNotesSchema);
    // walk newest-first; gitlab returns notes ordered newest-first by default
    for (const note of notes) {
      if (note.system) continue;
      const body = note.body;
      if (!body?.includes(BOT_MARKER)) continue;
      const match = LAST_SHA_MARKER_RE.exec(body);
      if (match) return match[1].toLowerCase();
    }
    return null;
  }

  async getPriorReviewContext(): Promise<PriorReviewContext | null> {
    const notes = await this.request(`${this.mrBase}/notes?per_page=100`, GitLabNotesSchema);
    for (const note of notes) {
      if (note.system) continue;
      const body = note.body;
      if (!body?.includes(BOT_MARKER)) continue;
      const ctx = extractPriorReviewContext(body);
      if (ctx) return ctx;
    }
    return null;
  }

  async getFileContent(path: string, ref: string): Promise<string | null> {
    try {
      const url = `${this.projectBase}/repository/files/${encodeURIComponent(
        path,
      )}/raw?ref=${encodeURIComponent(ref)}`;
      const res = await this.fetchApi(url, { headers: { Accept: "text/plain" } });
      return await res.text();
    } catch {
      return null;
    }
  }

  async searchCode(query: string): Promise<CodeSearchResult[]> {
    try {
      const url = `${this.projectBase}/search?scope=blobs&search=${encodeURIComponent(query)}&per_page=20`;
      const res = await this.fetchApi(url);
      const parsed = GitLabSearchResultSchema.safeParse(await res.json());
      if (!parsed.success)
        throw new SearchUnavailableError("failed", undefined, { cause: parsed.error });
      return parsed.data.map((r) => ({
        file: r.path ?? r.filename ?? "",
        line: r.startline ?? 0,
        content: r.data ?? "",
      }));
    } catch (err) {
      if (err instanceof SearchUnavailableError) throw err;
      const rateLimited = err instanceof Error && err.message.startsWith("GitLab API error 429");
      throw new SearchUnavailableError(rateLimited ? "rate_limited" : "failed", undefined, {
        cause: err,
      });
    }
  }

  async postSummaryComment(markdown: string, options?: PostSummaryCommentOptions): Promise<void> {
    const headerLines = [BOT_MARKER];
    if (options?.lastReviewedSha) {
      headerLines.push(buildLastShaMarker(options.lastReviewedSha));
    }
    if (options?.priorContext) {
      headerLines.push(encodePriorReviewContext(options.priorContext));
    }
    const body = `${headerLines.join("\n")}\n${markdown}`;
    await this.fetchApi(`${this.mrBase}/notes`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  async postInlineComments(findings: Finding[]): Promise<void> {
    if (findings.length === 0) return;

    const refs = await this.ensureDiffRefs();
    if (!refs) {
      log.warn(
        "missing diff_refs from GitLab MR — falling back to top-level notes for inline findings",
      );
      for (const finding of findings) {
        const body = `${BOT_MARKER}\n**${finding.file}:${finding.line}**\n\n${formatInlineComment(finding)}`;
        await this.fetchApi(`${this.mrBase}/notes`, {
          method: "POST",
          body: JSON.stringify({ body }),
        });
      }
      return;
    }

    for (const finding of findings) {
      const endLine = finding.endLine ?? finding.line;
      const body = `${BOT_MARKER}\n${formatInlineComment(finding)}`;
      const position: Record<string, unknown> = {
        position_type: "text",
        base_sha: refs.base_sha,
        start_sha: refs.start_sha,
        head_sha: refs.head_sha,
        new_path: finding.file,
        old_path: finding.file,
        new_line: endLine,
      };
      try {
        await this.fetchApi(`${this.mrBase}/discussions`, {
          method: "POST",
          body: JSON.stringify({ body, position }),
        });
      } catch (err) {
        log.warn(
          { err, file: finding.file, line: finding.line },
          "failed to post inline discussion, falling back to top-level note",
        );
        const fallback = `${BOT_MARKER}\n**${finding.file}:${finding.line}**\n\n${formatInlineComment(finding)}`;
        await this.fetchApi(`${this.mrBase}/notes`, {
          method: "POST",
          body: JSON.stringify({ body: fallback }),
        });
      }
    }
  }

  async deleteExistingBotComments(): Promise<void> {
    // discussions API returns both individual notes and threaded discussions —
    // walk every note and delete the bot-authored ones individually.
    const discussions = await this.request(
      `${this.mrBase}/discussions?per_page=100`,
      GitLabDiscussionsSchema,
    );
    for (const discussion of discussions) {
      for (const note of discussion.notes) {
        if (note.system) continue;
        if (!note.body?.includes(BOT_MARKER)) continue;
        try {
          await this.fetchApi(`${this.mrBase}/notes/${note.id}`, { method: "DELETE" });
        } catch (err) {
          log.warn(
            { err, noteId: note.id },
            "failed to delete bot note (likely a positional note in a resolved discussion)",
          );
        }
      }
    }
  }

  async getLinkedIssueIids(): Promise<string[]> {
    try {
      const data = await this.request(
        `${this.mrBase}/closes_issues?per_page=100`,
        GitLabClosesIssuesSchema,
      );
      // references.full is e.g. "group/project#123"; fall back to the raw iid
      return data.map((issue) => issue.references?.full ?? String(issue.iid));
    } catch {
      return [];
    }
  }

  async updatePRDescription(description: string): Promise<void> {
    await this.fetchApi(this.mrBase, {
      method: "PUT",
      body: JSON.stringify({ description }),
    });
  }

  async updatePRTitle(title: string): Promise<void> {
    await this.fetchApi(this.mrBase, {
      method: "PUT",
      body: JSON.stringify({ title }),
    });
  }

  private async ensureDiffRefs(): Promise<{
    base_sha: string;
    start_sha: string;
    head_sha: string;
  } | null> {
    if (this.cachedDiffRefs) return this.cachedDiffRefs;
    try {
      const data = await this.request(this.mrBase, GitLabMergeRequestSchema);
      if (data.diff_refs?.base_sha && data.diff_refs.start_sha && data.diff_refs.head_sha) {
        this.cachedDiffRefs = {
          base_sha: data.diff_refs.base_sha,
          start_sha: data.diff_refs.start_sha,
          head_sha: data.diff_refs.head_sha,
        };
        return this.cachedDiffRefs;
      }
    } catch {
      // fall through to null
    }
    return null;
  }
}
