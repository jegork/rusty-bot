import { execFile } from "node:child_process";
import { logger } from "../logger.js";
import type { CodeSearchResult } from "../types.js";
import { gitEnv, type GitEnvOptions } from "./git-env.js";

const log = logger.child({ module: "repo-checkout" });

const SEARCH_RESULT_LIMIT = 50;
const MAX_BUFFER = 16 * 1024 * 1024;

export interface GitRunOptions extends GitEnvOptions {
  timeoutMs?: number;
}

export interface GitRunError extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
}

// callback form rather than promisify so a test spy on execFile still behaves
// like the real thing (promisify relies on execFile's custom symbol).
export function runGit(
  repoPath: string,
  args: string[],
  options: GitRunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: repoPath,
        env: gitEnv({}, { extraConfig: options.extraConfig }),
        maxBuffer: MAX_BUFFER,
        timeout: options.timeoutMs,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        if (err) {
          const runError: GitRunError = Object.assign(err, { stdout, stderr });
          reject(runError);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// read-only view of one commit tree. exposes grep and readFile only — no shell,
// no writes. every user-controlled value sits behind `-e` or `--`, or inside the
// `<tree>:<path>` object name, so it can never be parsed as an option.
export class RepoCheckout {
  readonly repoPath: string;
  readonly tree: string;
  readonly approximate: boolean;

  constructor(opts: { repoPath: string; tree: string; approximate: boolean }) {
    this.repoPath = opts.repoPath;
    this.tree = opts.tree;
    this.approximate = opts.approximate;
  }

  async grep(query: string): Promise<CodeSearchResult[]> {
    if (!query.trim()) return [];
    const args = [
      "grep",
      "--no-color",
      "-n",
      "-I",
      "--fixed-strings",
      "--max-count=5",
      "-e",
      query,
      this.tree,
      "--",
    ];
    try {
      return parseGrepLines(await runGit(this.repoPath, args), `${this.tree}:`);
    } catch (err) {
      const e = err as GitRunError;
      // exit 1 is "no matches", not a failure
      if (e.code === 1) return [];
      // a very common query can overflow the buffer; the head of it is still usable
      if (e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && e.stdout) {
        return parseGrepLines(e.stdout, `${this.tree}:`);
      }
      log.warn(
        { err, query, tree: this.tree, stderr: e.stderr?.trim() },
        "git grep failed, returning no results",
      );
      return [];
    }
  }

  async readFile(path: string): Promise<string | null> {
    if (!path || path.startsWith("-") || path.includes("\0")) return null;
    try {
      return await runGit(this.repoPath, ["show", `${this.tree}:${path}`]);
    } catch (err) {
      const e = err as GitRunError;
      // 128 is git's "no such path in tree"
      if (e.code !== 128) {
        log.warn(
          { err, path, tree: this.tree, stderr: e.stderr?.trim() },
          "git show failed, treating file as missing",
        );
      }
      return null;
    }
  }
}

// `git grep -n <tree>` lines look like `<tree>:path:line:content`.
function parseGrepLines(stdout: string, prefix = ""): CodeSearchResult[] {
  const results: CodeSearchResult[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const raw = prefix && line.startsWith(prefix) ? line.slice(prefix.length) : line;
    const firstColon = raw.indexOf(":");
    if (firstColon === -1) continue;
    const secondColon = raw.indexOf(":", firstColon + 1);
    if (secondColon === -1) continue;
    const file = raw.slice(0, firstColon);
    const lineNumber = Number.parseInt(raw.slice(firstColon + 1, secondColon), 10);
    if (!Number.isFinite(lineNumber)) continue;
    results.push({ file, line: lineNumber, content: raw.slice(secondColon + 1) });
    if (results.length >= SEARCH_RESULT_LIMIT) break;
  }
  return results;
}
