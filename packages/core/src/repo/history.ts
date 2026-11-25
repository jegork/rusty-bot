import { logger } from "../logger.js";
import { runGit, type GitRunError } from "./checkout.js";

const log = logger.child({ module: "git-history" });

export const HISTORY_COMMIT_LIMIT = 20;
export const HISTORY_FILES_PER_COMMIT = 10;
const HISTORY_SUBJECT_CHARS = 200;
const HISTORY_TIMEOUT_MS = 20_000;
const SHA_PATTERN = /^[0-9a-f]{40,64}$/;
// a branch name is only ever interpolated into a ref we verify; this keeps it
// from being read as an option or a revision expression
const BRANCH_PATTERN = /^(?!-)(?!.*\.\.)[\w./-]+$/;

export interface HistoryCommit {
  sha: string;
  /** committer date, YYYY-MM-DD */
  date: string;
  subject: string;
  /** `<status> <path>` per changed file, e.g. `A alembic/versions/abc_add.py`, `D …` */
  files: string[];
  /** files the commit changed beyond those listed */
  moreFiles: number;
}

export interface HistoryResult {
  commits: HistoryCommit[];
  /** more commits matched than were returned */
  truncated: boolean;
}

// read-only `git log` over the target branch of a checkout that has its full
// history. a shallow clone would answer "no commits" for anything older than
// its boundary, which reads as "never existed", so those get no history at all.
export class GitHistory {
  private cache = new Map<string, Promise<HistoryResult>>();

  constructor(
    readonly repoPath: string,
    readonly targetBranch: string,
    readonly ref: string,
  ) {}

  /** never throws: null means this checkout cannot answer history questions. */
  static async resolve(repoPath: string, targetBranch: string): Promise<GitHistory | null> {
    if (!BRANCH_PATTERN.test(targetBranch)) return null;
    try {
      const shallow = await runGit(repoPath, ["rev-parse", "--is-shallow-repository"]);
      if (shallow.trim() !== "false") {
        log.info({ repoPath }, "checkout is shallow; git history tool not offered");
        return null;
      }
    } catch {
      return null;
    }
    for (const candidate of [`refs/remotes/origin/${targetBranch}`, `refs/heads/${targetBranch}`]) {
      try {
        const sha = (
          await runGit(repoPath, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])
        ).trim();
        if (SHA_PATTERN.test(sha)) return new GitHistory(repoPath, targetBranch, sha);
      } catch {
        // try the next candidate
      }
    }
    log.info(
      { repoPath, targetBranch },
      "target branch not in checkout; git history tool not offered",
    );
    return null;
  }

  log(options: { path?: string; query?: string }): Promise<HistoryResult> {
    const key = JSON.stringify([options.path ?? "", options.query ?? ""]);
    const existing = this.cache.get(key);
    if (existing) return existing;
    const p = this.run(options);
    this.cache.set(key, p);
    return p;
  }

  private async run({ path, query }: { path?: string; query?: string }): Promise<HistoryResult> {
    const args = [
      "log",
      `--max-count=${HISTORY_COMMIT_LIMIT + 1}`,
      "--name-status",
      "--format=%x1e%H%x1f%cs%x1f%s",
    ];
    // one argv element, so the query cannot be read as a separate option
    if (query) args.push(`-S${query}`);
    args.push(this.ref, "--");
    if (path) args.push(path);
    try {
      return parseLog(await runGit(this.repoPath, args, { timeoutMs: HISTORY_TIMEOUT_MS }));
    } catch (err) {
      const e = err as GitRunError;
      log.warn({ err, path, query, stderr: e.stderr?.trim() }, "git log failed");
      throw new Error("git history lookup failed");
    }
  }
}

function parseLog(stdout: string): HistoryResult {
  const records = stdout.split("\x1e").filter((r) => r.trim() !== "");
  const commits = records.slice(0, HISTORY_COMMIT_LIMIT).map((record) => {
    const [header, ...rest] = record.split("\n");
    const [sha, date, subject] = header.split("\x1f");
    const files = rest
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => l.replace(/\t/g, " "));
    return {
      sha: sha.slice(0, 12),
      date,
      subject:
        subject.length > HISTORY_SUBJECT_CHARS
          ? subject.slice(0, HISTORY_SUBJECT_CHARS) + "…"
          : subject,
      files: files.slice(0, HISTORY_FILES_PER_COMMIT),
      moreFiles: Math.max(0, files.length - HISTORY_FILES_PER_COMMIT),
    };
  });
  return { commits, truncated: records.length > HISTORY_COMMIT_LIMIT };
}
