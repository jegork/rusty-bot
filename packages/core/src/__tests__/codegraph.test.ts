import { execFile, execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_CONTEXT_CHARS } from "../agent/tools.js";
import { RepoCheckout } from "../repo/checkout.js";
import { prepareCodeGraph, toCodeGraphResult } from "../repo/codegraph.js";
import { gitEnv } from "../repo/git-env.js";

// real child_process, only wrapped so spawns can be counted
vi.mock("node:child_process", { spy: true });

const logMock = vi.hoisted(() => {
  const m: Record<string, unknown> = {};
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) m[level] = vi.fn();
  m.child = () => m;
  return m as Record<"info" | "warn", ReturnType<typeof vi.fn>> & { child: () => unknown };
});

vi.mock("../logger.js", () => ({ logger: logMock, flushLogger: vi.fn() }));

const execFileAsync = promisify(execFile);

// see repo-checkout.test.ts: a pre-commit run exports these and the fixture must not land on this repo
for (const key of [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]) {
  Reflect.deleteProperty(process.env, key);
}

const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const hasCodeGraph = (() => {
  try {
    execFileSync("codegraph", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv(GIT_IDENTITY_ENV) });
  return stdout.trim();
}

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Fixture {
  path: string;
  baseSha: string;
  featureSha: string;
}

// base defines oldName; the feature commit renames it and adds a caller. the
// working tree is left on base, like a CI checkout that is not the PR head.
async function setupRepo(): Promise<Fixture> {
  const path = await tempDir("rusty-codegraph-repo-");
  await git(path, ["init", "--initial-branch=main", "--quiet"]);
  await git(path, ["config", "commit.gpgsign", "false"]);
  await mkdir(join(path, "src"), { recursive: true });
  await writeFile(
    join(path, "src/lib.ts"),
    "export function oldName(a: number) {\n  return a + 1;\n}\n",
  );
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "base", "--quiet"]);
  const baseSha = await git(path, ["rev-parse", "HEAD"]);

  await writeFile(
    join(path, "src/lib.ts"),
    "export function newName(a: number) {\n  return a + 1;\n}\n",
  );
  await writeFile(
    join(path, "src/use.ts"),
    'import { newName } from "./lib";\n\nexport function callsNewName() {\n  return newName(2);\n}\n',
  );
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "feature", "--quiet"]);
  const featureSha = await git(path, ["rev-parse", "HEAD"]);
  await git(path, ["switch", "--detach", "--quiet", baseSha]);
  return { path, baseSha, featureSha };
}

// a stand-in codegraph on PATH: answers --version, then behaves per `init`
async function fakeCodeGraphOnPath(init: string): Promise<void> {
  const bin = await tempDir("rusty-codegraph-bin-");
  const script = `#!/bin/sh
case "$1" in
  --version) echo 1.6.2 ;;
  init) ${init} ;;
  status) echo '{"fileCount":2,"nodeCount":5,"edgeCount":6}' ;;
  *) echo '✗ CodeGraph isn'"'"'t available here' ;;
esac
`;
  await writeFile(join(bin, "codegraph"), script);
  await chmod(join(bin, "codegraph"), 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
}

async function worktreeCount(repoPath: string): Promise<number> {
  const out = await git(repoPath, ["worktree", "list", "--porcelain"]);
  return out.split("\n").filter((l) => l.startsWith("worktree ")).length;
}

function codeGraphSpawns(): unknown[][] {
  return vi.mocked(execFile).mock.calls.filter((c) => c[0] === "codegraph");
}

function loggedOutcome(): unknown {
  const events = [...logMock.info.mock.calls, ...logMock.warn.mock.calls]
    .map((c) => c[0] as Record<string, unknown>)
    .filter((e) => e && typeof e === "object" && "outcome" in e);
  expect(events).toHaveLength(1);
  return events[0]?.outcome;
}

beforeEach(() => {
  vi.mocked(execFile).mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
  vi.stubEnv("RUSTY_CODEGRAPH", "true");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("prepareCodeGraph", () => {
  it("returns null without spawning anything when the flag is unset", async () => {
    vi.stubEnv("RUSTY_CODEGRAPH", "");
    const checkout = new RepoCheckout({
      repoPath: "/nowhere",
      tree: "abc1234",
      approximate: false,
    });

    expect(await prepareCodeGraph(checkout)).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
    expect(loggedOutcome()).toBe("disabled");
  });

  it("treats any flag value other than true as off", async () => {
    vi.stubEnv("RUSTY_CODEGRAPH", "1");
    const checkout = new RepoCheckout({
      repoPath: "/nowhere",
      tree: "abc1234",
      approximate: false,
    });

    expect(await prepareCodeGraph(checkout)).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });

  it("skips an approximate checkout, since it would index the merge commit", async () => {
    const checkout = new RepoCheckout({ repoPath: "/nowhere", tree: "HEAD", approximate: true });

    expect(await prepareCodeGraph(checkout)).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
    expect(loggedOutcome()).toBe("approximate-checkout");
  });

  it("returns null when codegraph is not on PATH", async () => {
    const { path, featureSha } = await setupRepo();
    vi.stubEnv("PATH", await tempDir("rusty-empty-path-"));
    const checkout = new RepoCheckout({ repoPath: path, tree: featureSha, approximate: false });

    await expect(prepareCodeGraph(checkout)).resolves.toBeNull();
    expect(loggedOutcome()).toBe("no-binary");
  });

  it.skipIf(!hasCodeGraph)(
    "indexes the PR head commit, not the working tree",
    async () => {
      const { path, featureSha } = await setupRepo();
      const checkout = new RepoCheckout({ repoPath: path, tree: featureSha, approximate: false });

      const graph = await prepareCodeGraph(checkout);
      try {
        expect(graph).not.toBeNull();
        expect(loggedOutcome()).toBe("ready");
        const found = await graph!.node("newName");
        expect(found).toContain("export function newName");
        expect(found).toContain("callsNewName");
        expect(await graph!.node("oldName")).toBeNull();
        expect(await graph!.explore("newName")).toContain("callsNewName");
        // an option-looking value reaches codegraph as a query, not a flag
        expect(await graph!.node("--help")).toBeNull();
      } finally {
        await graph?.dispose();
      }
    },
    30_000,
  );

  it("gives up on an index that outlives its timeout and removes the worktree", async () => {
    const { path, featureSha } = await setupRepo();
    await fakeCodeGraphOnPath("sleep 5");
    vi.stubEnv("RUSTY_CODEGRAPH_INDEX_TIMEOUT_MS", "1");
    const checkout = new RepoCheckout({ repoPath: path, tree: featureSha, approximate: false });

    expect(await prepareCodeGraph(checkout)).toBeNull();
    expect(loggedOutcome()).toBe("index-timeout");
    expect(await worktreeCount(path)).toBe(1);
  });

  it("removes the worktree when indexing fails", async () => {
    const { path, featureSha } = await setupRepo();
    await fakeCodeGraphOnPath("exit 3");
    const checkout = new RepoCheckout({ repoPath: path, tree: featureSha, approximate: false });

    expect(await prepareCodeGraph(checkout)).toBeNull();
    expect(loggedOutcome()).toBe("index-failed");
    expect(await worktreeCount(path)).toBe(1);
  });

  it("returns null when the head commit is missing from the repository", async () => {
    const { path } = await setupRepo();
    await fakeCodeGraphOnPath("true");
    const checkout = new RepoCheckout({
      repoPath: path,
      tree: "0123456789abcdef0123456789abcdef01234567",
      approximate: false,
    });

    expect(await prepareCodeGraph(checkout)).toBeNull();
    expect(loggedOutcome()).toBe("index-failed");
    expect(await worktreeCount(path)).toBe(1);
  });

  it("dispose removes the temp worktree and is safe to call twice", async () => {
    const { path, featureSha } = await setupRepo();
    await fakeCodeGraphOnPath("true");
    const checkout = new RepoCheckout({ repoPath: path, tree: featureSha, approximate: false });

    const graph = await prepareCodeGraph(checkout);
    expect(graph).not.toBeNull();
    expect(await worktreeCount(path)).toBe(2);
    // the fake prints no code block, so queries come back empty rather than throwing
    expect(await graph!.node("newName")).toBeNull();

    await graph!.dispose();
    await graph!.dispose();
    expect(await worktreeCount(path)).toBe(1);
    expect(codeGraphSpawns().length).toBeGreaterThan(0);
  });
});

describe("toCodeGraphResult", () => {
  const block = "**newName** (function)\n\n```typescript\n1\texport function newName() {}\n```\n";

  it("treats the not-available banner as no result", () => {
    expect(
      toCodeGraphResult("✗ CodeGraph isn't available here — no .codegraph/ index\n```x```"),
    ).toBe(null);
    expect(toCodeGraphResult("  \n✗ leading whitespace still counts")).toBeNull();
  });

  it("treats output without a code block as no result", () => {
    expect(toCodeGraphResult('Symbol "oldName" not found in the codebase\n')).toBeNull();
    expect(toCodeGraphResult("")).toBeNull();
  });

  it("passes a result at exactly the cap through untouched", () => {
    const exact = block + "x".repeat(MAX_FILE_CONTEXT_CHARS - block.length);
    expect(toCodeGraphResult(exact)).toBe(exact);
  });

  it("truncates a longer result and says how much was cut", () => {
    const long = block + "x".repeat(MAX_FILE_CONTEXT_CHARS);
    const result = toCodeGraphResult(long)!;

    expect(result.startsWith(long.slice(0, MAX_FILE_CONTEXT_CHARS))).toBe(true);
    expect(result).toContain(`[output truncated, ${block.length} more characters]`);
  });
});
