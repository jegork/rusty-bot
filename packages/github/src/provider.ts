import type { Octokit } from "octokit";
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
} from "@rusty-bot/core";

const BOT_MARKER = "<!-- rusty-bot-review -->";
const LAST_SHA_MARKER_RE = /<!--\s*rusty-bot:last-sha:([0-9a-f]{40})\s*-->/i;
const log = logger.child({ package: "github", component: "provider" });

function buildLastShaMarker(sha: string): string {
  return `<!-- rusty-bot:last-sha:${sha} -->`;
}

interface InlineCommentPayload {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "RIGHT";
}

function buildInlineCommentPayload(finding: Finding): InlineCommentPayload {
  const isMultiLine = finding.endLine && finding.endLine !== finding.line;
  const payload: InlineCommentPayload = {
    path: finding.file,
    line: finding.endLine ?? finding.line,
    side: "RIGHT",
    body: formatInlineComment(finding),
  };
  if (isMultiLine) {
    payload.start_line = finding.line;
    payload.start_side = "RIGHT";
  }
  return payload;
}

/** GitHub's review endpoint returns 422 with `errors: ["Path could not be
 * resolved"]` when a comment's path/line combo doesn't match its view of the
 * PR's diff (file not present, line outside any hunk, or an edge case where
 * our local hunk-index disagrees with GitHub's position model). Detect this
 * specifically so we don't treat unrelated 422s (e.g., validation errors on
 * body length) as recoverable. */
function isPathResolutionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: unknown;
    response?: { data?: { errors?: unknown } };
  };
  if (e.status !== 422) return false;
  const errs = e.response?.data?.errors;
  if (!Array.isArray(errs)) return false;
  return errs.some(
    (entry) =>
      typeof entry === "string" && entry.toLowerCase().includes("path could not be resolved"),
  );
}

function pickPayloadDiagnostics(p: InlineCommentPayload): Record<string, unknown> {
  return {
    path: p.path,
    line: p.line,
    ...(p.start_line !== undefined && { startLine: p.start_line }),
  };
}

interface GitHubProviderConfig {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
}

function parseHunkHeader(line: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
} {
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

function parseDiff(rawDiff: string): FilePatch[] {
  const patches: FilePatch[] = [];
  const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split("\n");

    const pathMatch = /^--- a\/(.+)\n\+\+\+ b\/(.+)/m.exec(section);
    const binaryMatch = section.includes("Binary files");

    if (binaryMatch) {
      const headerMatch = /a\/(.+?) b\/(.+)/.exec(lines[0]);
      const path = headerMatch?.[2] ?? "unknown";
      patches.push({
        path,
        hunks: [],
        additions: 0,
        deletions: 0,
        isBinary: true,
      });
      continue;
    }

    if (!pathMatch) continue;

    const path = pathMatch[2];
    const hunks: Hunk[] = [];
    let additions = 0;
    let deletions = 0;

    let currentHunk: { header: ReturnType<typeof parseHunkHeader>; lines: string[] } | null = null;

    for (const line of lines) {
      if (line.startsWith("@@")) {
        if (currentHunk) {
          hunks.push({
            ...currentHunk.header,
            content: currentHunk.lines.join("\n"),
          });
        }
        currentHunk = { header: parseHunkHeader(line), lines: [line] };
      } else if (currentHunk) {
        currentHunk.lines.push(line);
        if (line.startsWith("+") && !line.startsWith("+++")) additions++;
        if (line.startsWith("-") && !line.startsWith("---")) deletions++;
      }
    }

    if (currentHunk) {
      hunks.push({
        ...currentHunk.header,
        content: currentHunk.lines.join("\n"),
      });
    }

    patches.push({ path, hunks, additions, deletions, isBinary: false });
  }

  return patches;
}

/** subset of github's IssueComment shape we actually read — we only care about
 * the body text, which carries the hidden bot markers. */
interface CachedPRComment { body?: string | null }

export class GitHubProvider implements GitProvider {
  private readonly octokit: Octokit;
  private readonly owner: string;
  private readonly repo: string;
  private readonly pullNumber: number;
  /** in-flight (or resolved) promise for the PR comments fetch, scoped to the
   * lifetime of this provider instance. `getLastReviewedSha` and
   * `getPriorReviewContext` both walk the same comment list — without this
   * cache, an incremental re-review fires two identical API calls for the
   * same data. provider instances are constructed per-review (see cli.ts and
   * orchestrator.ts) so the cache lifetime matches what we want: one fetch
   * per review, never stale across reviews. */
  private commentsPromise: Promise<CachedPRComment[]> | null = null;

  constructor(config: GitHubProviderConfig) {
    this.octokit = config.octokit;
    this.owner = config.owner;
    this.repo = config.repo;
    this.pullNumber = config.pullNumber;
  }

  /** fetch the issue comments list once per provider instance. concurrent
   * callers that hit this before the fetch resolves all await the same
   * in-flight promise. */
  private async fetchPRCommentsCached(): Promise<CachedPRComment[]> {
    this.commentsPromise ??= this.octokit
      .request("GET /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner: this.owner,
        repo: this.repo,
        issue_number: this.pullNumber,
      })
      .then((response) => response.data as CachedPRComment[]);
    return this.commentsPromise;
  }

  async getRawDiff(): Promise<string> {
    const response = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: this.owner,
      repo: this.repo,
      pull_number: this.pullNumber,
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
    });

    return response.data as unknown as string;
  }

  async getDiff(): Promise<FilePatch[]> {
    const raw = await this.getRawDiff();
    return parseDiff(raw);
  }

  async getDiffSinceSha(sinceSha: string, headSha: string): Promise<FilePatch[] | null> {
    if (sinceSha === headSha) return [];
    try {
      const response = await this.octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
        owner: this.owner,
        repo: this.repo,
        basehead: `${sinceSha}...${headSha}`,
        headers: {
          accept: "application/vnd.github.v3.diff",
        },
      });
      return parseDiff(response.data as unknown as string);
    } catch (err) {
      log.warn(
        { err, sinceSha, headSha },
        "could not fetch incremental diff (sha unreachable, force-push, or rebase)",
      );
      return null;
    }
  }

  async getLastReviewedSha(): Promise<string | null> {
    const comments = await this.fetchPRCommentsCached();

    // walk newest-first so a fresher marker wins if multiple bot comments survive
    for (let i = comments.length - 1; i >= 0; i--) {
      const body = comments[i].body;
      if (!body?.includes(BOT_MARKER)) continue;
      const match = LAST_SHA_MARKER_RE.exec(body);
      if (match) return match[1].toLowerCase();
    }
    return null;
  }

  async getPriorReviewContext(): Promise<PriorReviewContext | null> {
    const comments = await this.fetchPRCommentsCached();

    // walk newest-first; only return the most recent prior context
    for (let i = comments.length - 1; i >= 0; i--) {
      const body = comments[i].body;
      if (!body?.includes(BOT_MARKER)) continue;
      const ctx = extractPriorReviewContext(body);
      if (ctx) return ctx;
    }
    return null;
  }

  async getPRMetadata(): Promise<PRMetadata> {
    const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: this.owner,
      repo: this.repo,
      pull_number: this.pullNumber,
    });

    return {
      id: String(data.number),
      title: data.title,
      description: data.body ?? "",
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- user can be null for deleted accounts despite Octokit types
      author: data.user?.login ?? "",
      sourceBranch: data.head.ref,
      targetBranch: data.base.ref,
      url: data.html_url,
      headSha: data.head.sha,
    };
  }

  async getFileContent(path: string, ref: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
        owner: this.owner,
        repo: this.repo,
        path,
        ref,
        headers: { accept: "application/vnd.github.v3.raw" },
      });
      return data as unknown as string;
    } catch {
      return null;
    }
  }

  async searchCode(query: string): Promise<CodeSearchResult[]> {
    try {
      const { data } = await this.octokit.request("GET /search/code", {
        q: `${query} repo:${this.owner}/${this.repo}`,
        per_page: 20,
        headers: { accept: "application/vnd.github.text-match+json" },
      });
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- items may be absent on rate-limited or error responses
      return (data.items ?? []).map((item) => ({
        file: item.path,
        line: 0,
        content: item.text_matches?.[0]?.fragment ?? "",
      }));
    } catch {
      return [];
    }
  }

  async postSummaryComment(markdown: string, options?: PostSummaryCommentOptions): Promise<void> {
    const headerParts: string[] = [BOT_MARKER];
    if (options?.lastReviewedSha) {
      headerParts.push(buildLastShaMarker(options.lastReviewedSha));
    }
    if (options?.priorContext) {
      headerParts.push(encodePriorReviewContext(options.priorContext));
    }
    await this.octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
      owner: this.owner,
      repo: this.repo,
      issue_number: this.pullNumber,
      body: `${headerParts.join("\n")}\n${markdown}`,
    });
  }

  async postInlineComments(findings: Finding[]): Promise<void> {
    if (findings.length === 0) return;

    const comments = findings.map(buildInlineCommentPayload);

    // happy path: one review with all comments. GitHub's batch endpoint is
    // all-or-nothing — if any single comment fails path/line validation,
    // the entire POST returns 422 and no comments are posted.
    try {
      await this.postReviewWithComments(comments);
      return;
    } catch (err) {
      if (!isPathResolutionError(err)) throw err;
      if (comments.length === 1) {
        // a single bad comment — nothing to salvage. log and drop it so the
        // already-posted summary comment isn't undone by a fatal action error.
        log.warn(
          { err, sample: pickPayloadDiagnostics(comments[0]) },
          "github rejected the only inline comment with path-resolution; dropping it (summary comment remains)",
        );
        return;
      }
      log.warn(
        { err, commentCount: comments.length },
        "batch review post rejected by github (likely one or more anchors didn't resolve), retrying each comment individually",
      );
    }

    // fallback: post each comment as its own single-comment review. comments
    // that github rejects get logged and dropped; survivors land as separate
    // reviews. UX trade-off vs. the lost-everything alternative is worth it.
    let posted = 0;
    const dropped: { payload: ReturnType<typeof buildInlineCommentPayload>; err: unknown }[] = [];
    for (const comment of comments) {
      try {
        await this.postReviewWithComments([comment]);
        posted++;
      } catch (err) {
        if (!isPathResolutionError(err)) throw err;
        dropped.push({ payload: comment, err });
      }
    }

    if (dropped.length > 0) {
      log.warn(
        {
          droppedCount: dropped.length,
          postedCount: posted,
          samples: dropped.slice(0, 3).map((d) => pickPayloadDiagnostics(d.payload)),
        },
        "github rejected some inline comments by path/line resolution; posted the rest individually",
      );
    }
  }

  private async postReviewWithComments(
    comments: ReturnType<typeof buildInlineCommentPayload>[],
  ): Promise<void> {
    await this.octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
      owner: this.owner,
      repo: this.repo,
      pull_number: this.pullNumber,
      event: "COMMENT",
      body: "",
      comments,
    });
  }

  async getLinkedIssueNumbers(): Promise<number[]> {
    const data = await this.octokit.graphql<{
      repository?: {
        pullRequest?: {
          closingIssuesReferences?: {
            nodes?: { number: number }[];
          };
        } | null;
      } | null;
    }>(
      `query ($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            closingIssuesReferences(first: 50) {
              nodes { number }
            }
          }
        }
      }`,
      { owner: this.owner, repo: this.repo, pr: this.pullNumber },
    );
    const nodes = data.repository?.pullRequest?.closingIssuesReferences?.nodes;
    return nodes?.map((n) => n.number) ?? [];
  }

  async deleteExistingBotComments(): Promise<void> {
    const { data: comments } = await this.octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner: this.owner,
        repo: this.repo,
        issue_number: this.pullNumber,
      },
    );

    const botComments = comments.filter((c: { body?: string }) => c.body?.includes(BOT_MARKER));

    await Promise.all(
      botComments.map((c: { id: number }) =>
        this.octokit.request("DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}", {
          owner: this.owner,
          repo: this.repo,
          comment_id: c.id,
        }),
      ),
    );
  }

  async updatePRDescription(description: string): Promise<void> {
    await this.octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: this.owner,
      repo: this.repo,
      pull_number: this.pullNumber,
      body: description,
    });
  }

  async updatePRTitle(title: string): Promise<void> {
    await this.octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: this.owner,
      repo: this.repo,
      pull_number: this.pullNumber,
      title,
    });
  }
}
