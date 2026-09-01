import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
  logger,
  parseDiff,
  type CodeSearchResult,
  type FilePatch,
  type GitProvider,
  type PRMetadata,
} from "@rusty-bot/core";
import { gitEnv } from "./git-env.js";

const execFileAsync = promisify(execFile);

const log = logger.child({ package: "cli", module: "local-provider" });

const SEARCH_RESULT_LIMIT = 50;

export interface LocalGitProviderOptions {
  repoPath: string;
  baseRef: string;
  headRef: string;
  prTitle?: string;
  prDescription?: string;
  prAuthor?: string;
  prUrl?: string;
}

// Local provider that backs the review with `git` and the working tree.
// Network-only operations (posting comments, updating PR fields) are no-ops;
// the CLI prints results to stdout instead.
export class LocalGitProvider implements GitProvider {
  constructor(private readonly opts: LocalGitProviderOptions) {}

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.opts.repoPath,
      maxBuffer: 64 * 1024 * 1024,
      env: gitEnv(),
    });
    return stdout;
  }

  async getDiff(): Promise<FilePatch[]> {
    const raw = await this.git([
      "diff",
      "--no-color",
      `${this.opts.baseRef}...${this.opts.headRef}`,
    ]);
    return parseDiff(raw);
  }

  async getPRMetadata(): Promise<PRMetadata> {
    let headSha: string | undefined;
    try {
      headSha = (await this.git(["rev-parse", this.opts.headRef])).trim();
    } catch {
      headSha = undefined;
    }

    let author = this.opts.prAuthor;
    if (!author) {
      try {
        author = (await this.git(["log", "-1", "--format=%an", this.opts.headRef])).trim();
      } catch {
        author = "unknown";
      }
    }

    return {
      id: headSha?.slice(0, 7) ?? "local",
      title: this.opts.prTitle ?? `Local review: ${this.opts.baseRef}...${this.opts.headRef}`,
      description: this.opts.prDescription ?? "",
      author,
      sourceBranch: this.opts.headRef,
      targetBranch: this.opts.baseRef,
      url: this.opts.prUrl ?? "",
      headSha,
    };
  }

  async getFileContent(path: string, ref: string): Promise<string | null> {
    // only short-circuit to the working tree when the user explicitly chose
    // HEAD as the head ref. for any other ref the working tree may be on a
    // different branch and would return content that does not match the diff.
    if (ref === this.opts.headRef && this.opts.headRef === "HEAD") {
      try {
        const abs = isAbsolute(path) ? path : join(this.opts.repoPath, path);
        return await readFile(abs, "utf8");
      } catch {
        // fall through to git show
      }
    }

    try {
      return await this.git(["show", `${ref}:${path}`]);
    } catch {
      return null;
    }
  }

  async searchCode(query: string): Promise<CodeSearchResult[]> {
    if (!query.trim()) return [];

    // prefer ripgrep when available — it's faster, respects gitignore, and
    // produces a stable column-prefixed format. fall back to `git grep`,
    // which is always present alongside git itself.
    const rgResults = await this.searchWithRipgrep(query);
    if (rgResults !== null) return rgResults;
    return this.searchWithGitGrep(query);
  }

  private async searchWithRipgrep(query: string): Promise<CodeSearchResult[] | null> {
    try {
      const { stdout } = await execFileAsync(
        "rg",
        [
          "--no-heading",
          "--with-filename",
          "--line-number",
          "--color=never",
          "--max-count",
          "5",
          "--max-columns",
          "300",
          "--fixed-strings",
          "--",
          query,
          // pass the cwd explicitly: when rg is invoked via execFile its stdin
          // is a pipe (not a tty), and without a path argument it would read
          // patterns from stdin and hang forever.
          ".",
        ],
        { cwd: this.opts.repoPath, maxBuffer: 16 * 1024 * 1024 },
      );
      return parseRipgrepOutput(stdout);
    } catch (err) {
      const code = (err as { code?: number | string }).code;
      // ripgrep exits 1 when there are no matches — treat as empty result, not a fallback.
      if (code === 1) return [];
      // ENOENT or any other failure means rg is unavailable; let the caller fall back.
      return null;
    }
  }

  private async searchWithGitGrep(query: string): Promise<CodeSearchResult[]> {
    try {
      const stdout = await this.git([
        "grep",
        "--no-color",
        "-n",
        "-I",
        "--fixed-strings",
        "--max-count=5",
        "--",
        query,
      ]);
      return parseGitGrepOutput(stdout);
    } catch (err) {
      const code = (err as { code?: number | string }).code;
      // `git grep` exits 1 when there are no matches — that's a normal "empty result"
      // and not worth logging. anything else (ENOENT, non-repo cwd, broken pipe, ...)
      // is a real failure that the LLM cannot distinguish from "no matches", so warn.
      if (code === 1) return [];
      log.warn({ err, query }, "git grep failed, returning no results");
      return [];
    }
  }

  async postSummaryComment(): Promise<void> {
    // no-op — CLI prints the summary to stdout instead.
  }

  async postInlineComments(): Promise<void> {
    // no-op — CLI prints inline findings to stdout instead.
  }

  async deleteExistingBotComments(): Promise<void> {
    // no-op — there are no existing comments to clean up locally.
  }

  async updatePRDescription(): Promise<void> {
    // no-op — there is no PR to update locally.
  }

  async updatePRTitle(): Promise<void> {
    // no-op — there is no PR to update locally.
  }
}

// ripgrep --no-heading lines look like `path:line:content` (column suppressed when --column is omitted).
function parseRipgrepOutput(stdout: string): CodeSearchResult[] {
  return parseGrepLines(stdout);
}

// `git grep -n` produces the same `path:line:content` format.
function parseGitGrepOutput(stdout: string): CodeSearchResult[] {
  return parseGrepLines(stdout);
}

function parseGrepLines(stdout: string): CodeSearchResult[] {
  const results: CodeSearchResult[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw) continue;
    const firstColon = raw.indexOf(":");
    if (firstColon === -1) continue;
    const secondColon = raw.indexOf(":", firstColon + 1);
    if (secondColon === -1) continue;
    const file = raw.slice(0, firstColon);
    const lineStr = raw.slice(firstColon + 1, secondColon);
    const line = Number.parseInt(lineStr, 10);
    if (!Number.isFinite(line)) continue;
    const content = raw.slice(secondColon + 1);
    results.push({ file, line, content });
    if (results.length >= SEARCH_RESULT_LIMIT) break;
  }
  return results;
}
