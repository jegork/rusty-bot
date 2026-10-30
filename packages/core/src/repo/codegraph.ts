import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FILE_CONTEXT_CHARS } from "../agent/tools.js";
import { logger } from "../logger.js";
import { runGit, type GitRunError, type RepoCheckout } from "./checkout.js";

const log = logger.child({ module: "codegraph" });

const DEFAULT_INDEX_TIMEOUT_MS = 120_000;
const QUERY_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;
// repository hooks must not run when the bot materialises the PR head
const NO_HOOKS = [["core.hooksPath", "/dev/null"]] as const;

export interface CodeGraphIndex {
  /** temp worktree of checkout.tree holding the .codegraph/ index */
  dir: string;
  explore(query: string): Promise<string | null>;
  node(symbol: string): Promise<string | null>;
  dispose(): Promise<void>;
}

type Outcome =
  "disabled" | "no-binary" | "approximate-checkout" | "index-failed" | "index-timeout" | "ready";

function readIndexTimeoutMs(): number {
  const n = Number(process.env.RUSTY_CODEGRAPH_INDEX_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_INDEX_TIMEOUT_MS;
}

// codegraph is third-party code that parses untrusted PR content, so it gets
// only what it needs to run, never the provider or platform tokens in the job env
const CODEGRAPH_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const;

function codeGraphEnv(): NodeJS.ProcessEnv {
  // git config is set fresh, never copied: inherited GIT_CONFIG_* pairs and
  // GIT_CONFIG_PARAMETERS can carry auth headers
  const env: NodeJS.ProcessEnv = {
    DO_NOT_TRACK: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
  for (const key of CODEGRAPH_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function runCodeGraph(cwd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "codegraph",
      args,
      {
        cwd,
        // DO_NOT_TRACK turns off codegraph's usage telemetry and update check
        env: codeGraphEnv(),
        maxBuffer: MAX_BUFFER,
        timeout: timeoutMs,
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

// codegraph exits 0 on most failures, so emptiness is read from the output:
// a missing index prints a ✗ banner, an unknown symbol prints no code block.
export function toCodeGraphResult(stdout: string): string | null {
  const text = stdout.trim();
  if (!text || text.startsWith("✗") || !text.includes("```")) return null;
  if (text.length <= MAX_FILE_CONTEXT_CHARS) return text;
  const remaining = text.length - MAX_FILE_CONTEXT_CHARS;
  return (
    text.slice(0, MAX_FILE_CONTEXT_CHARS) + `\n... [output truncated, ${remaining} more characters]`
  );
}

async function removeWorktree(repoPath: string, dir: string): Promise<void> {
  try {
    await runGit(repoPath, ["worktree", "remove", "--force", dir]);
  } catch (err) {
    log.warn({ err, dir }, "git worktree remove failed, deleting the directory instead");
  }
  await rm(dir, { recursive: true, force: true });
  await runGit(repoPath, ["worktree", "prune"]).catch((err: unknown) => {
    log.warn({ err }, "git worktree prune failed");
  });
}

// builds a CodeGraph index of exactly the commit the other tools read, in a
// temp worktree, because codegraph indexes a working tree and the CI working
// tree is the merge commit. never throws: null means "use the plain tools".
export async function prepareCodeGraph(checkout: RepoCheckout): Promise<CodeGraphIndex | null> {
  const startedAt = Date.now();
  const event: Record<string, unknown> = { tree: checkout.tree };
  const finish = (outcome: Outcome, message: string) => {
    log.info({ ...event, outcome, durationMs: Date.now() - startedAt }, message);
  };

  if (process.env.RUSTY_CODEGRAPH !== "true") {
    finish("disabled", "codegraph: disabled; set RUSTY_CODEGRAPH=true to enable");
    return null;
  }
  if (checkout.approximate) {
    finish("approximate-checkout", "codegraph: PR head not available, skipping the index");
    return null;
  }
  try {
    event.version = (await runCodeGraph(checkout.repoPath, ["--version"], QUERY_TIMEOUT_MS)).trim();
  } catch (err) {
    event.error = (err as Error).message;
    finish("no-binary", "codegraph: binary not found on PATH, skipping the index");
    return null;
  }

  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "rusty-codegraph-"));
    const worktreeStartedAt = Date.now();
    await runGit(checkout.repoPath, ["worktree", "add", "--detach", dir, checkout.tree], {
      extraConfig: NO_HOOKS,
    });
    event.worktreeMs = Date.now() - worktreeStartedAt;

    const indexStartedAt = Date.now();
    const timeoutMs = readIndexTimeoutMs();
    try {
      await runCodeGraph(dir, ["init", "-y", dir], timeoutMs);
    } finally {
      event.indexMs = Date.now() - indexStartedAt;
    }

    const status = JSON.parse(await runCodeGraph(dir, ["status", "--json"], QUERY_TIMEOUT_MS)) as {
      fileCount?: number;
      nodeCount?: number;
      edgeCount?: number;
    };
    Object.assign(event, {
      files: status.fileCount,
      nodes: status.nodeCount,
      edges: status.edgeCount,
    });
  } catch (err) {
    const e = err as GitRunError & { killed?: boolean };
    event.error = e.stderr?.trim() || e.message;
    if (dir) await removeWorktree(checkout.repoPath, dir);
    finish(
      e.killed ? "index-timeout" : "index-failed",
      "codegraph: indexing failed, continuing without the CodeGraph tools",
    );
    return null;
  }

  const indexDir = dir;
  const query = async (args: string[]): Promise<string | null> => {
    try {
      return toCodeGraphResult(await runCodeGraph(indexDir, args, QUERY_TIMEOUT_MS));
    } catch (err) {
      log.warn({ err, args }, "codegraph query failed, returning no result");
      return null;
    }
  };
  let disposed: Promise<void> | undefined;
  finish("ready", "codegraph: indexed the PR head");
  return {
    dir: indexDir,
    explore: (q) => query(["explore", "--max-files", "2", "--", q]),
    node: (symbol) => query(["node", "--", symbol]),
    dispose: () => (disposed ??= removeWorktree(checkout.repoPath, indexDir)),
  };
}
