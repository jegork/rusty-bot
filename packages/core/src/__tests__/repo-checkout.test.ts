import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RepoCheckout } from "../repo/checkout.js";
import { gitEnv } from "../repo/git-env.js";
import { resolveRepoCheckout } from "../repo/resolve.js";

// real child_process, only wrapped so argv/env of each spawn can be inspected
vi.mock("node:child_process", { spy: true });

const execFileAsync = promisify(execFile);

// git hooks export GIT_DIR / GIT_INDEX_FILE etc. when the suite runs from
// pre-commit; the fixture setup below must not land on the repo being committed.
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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv(GIT_IDENTITY_ENV) });
  return stdout.trim();
}

interface Fixture {
  path: string;
  baseSha: string;
  featureSha: string;
}

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function setupRepo(): Promise<Fixture> {
  const path = await tempDir("rusty-checkout-");
  await git(path, ["init", "--initial-branch=main", "--quiet"]);
  await git(path, ["config", "commit.gpgsign", "false"]);

  await mkdir(join(path, "src"), { recursive: true });
  await writeFile(join(path, "src/a.ts"), "export const a = 1;\n");
  await writeFile(
    join(path, "src/many.ts"),
    Array.from({ length: 7 }, (_, i) => `const repeated${i} = "repeated";\n`).join(""),
  );
  await writeFile(join(path, "src/flags.ts"), 'const flag = "--max-count=1";\n');
  await writeFile(join(path, "blob.bin"), Buffer.from([0, 1, 2, ...Buffer.from("repeated"), 0]));
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "base", "--quiet"]);
  const baseSha = await git(path, ["rev-parse", "HEAD"]);

  await git(path, ["checkout", "-b", "feature", "--quiet"]);
  await writeFile(join(path, "src/a.ts"), "export const a = 2;\n");
  await writeFile(join(path, "src/b.ts"), "// b\n\nexport function newSymbol() {}\n");
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "feature", "--quiet"]);
  const featureSha = await git(path, ["rev-parse", "HEAD"]);

  // the working tree stays on main so a test reading the wrong source would see base content
  await git(path, ["checkout", "main", "--quiet"]);
  return { path, baseSha, featureSha };
}

// mirrors a CI checkout: shallow, only the target branch, PR head absent
async function shallowClone(origin: string): Promise<string> {
  const path = await tempDir("rusty-clone-");
  await git(path, ["clone", "--quiet", "--depth=1", "--branch", "main", `file://${origin}`, "."]);
  return path;
}

function gitSpawns(subcommand: string) {
  return vi
    .mocked(execFile)
    .mock.calls.filter(([file, args]) => file === "git" && (args as string[])[0] === subcommand)
    .map(([, args, opts]) => ({
      args: args as string[],
      env: (opts as { env: NodeJS.ProcessEnv }).env,
    }));
}

let repo: Fixture;

beforeEach(async () => {
  repo = await setupRepo();
  vi.mocked(execFile).mockClear();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("RepoCheckout.grep", () => {
  it("finds a symbol that only exists in the PR head tree", async () => {
    const head = new RepoCheckout({
      repoPath: repo.path,
      tree: repo.featureSha,
      approximate: false,
    });
    const base = new RepoCheckout({ repoPath: repo.path, tree: repo.baseSha, approximate: false });

    expect(await head.grep("newSymbol")).toEqual([
      { file: "src/b.ts", line: 3, content: "export function newSymbol() {}" },
    ]);
    expect(await base.grep("newSymbol")).toEqual([]);
  });

  it("strips the tree prefix when searching the workspace HEAD", async () => {
    const checkout = new RepoCheckout({ repoPath: repo.path, tree: "HEAD", approximate: true });

    const results = await checkout.grep("export const a");

    expect(results).toEqual([{ file: "src/a.ts", line: 1, content: "export const a = 1;" }]);
  });

  it("returns [] when nothing matches", async () => {
    const checkout = new RepoCheckout({
      repoPath: repo.path,
      tree: repo.featureSha,
      approximate: false,
    });

    expect(await checkout.grep("definitely_not_in_repo_xyz")).toEqual([]);
  });

  it("caps matches per file at five and skips binary files", async () => {
    const checkout = new RepoCheckout({
      repoPath: repo.path,
      tree: repo.baseSha,
      approximate: false,
    });

    const results = await checkout.grep('"repeated"');

    expect(results).toHaveLength(5);
    expect(results.every((r) => r.file === "src/many.ts")).toBe(true);
  });

  it("treats an option-looking query as a search string", async () => {
    const outDir = await tempDir("rusty-grep-out-");
    const target = join(outDir, "x");
    const checkout = new RepoCheckout({
      repoPath: repo.path,
      tree: repo.featureSha,
      approximate: false,
    });

    expect(await checkout.grep("--max-count=1")).toEqual([
      { file: "src/flags.ts", line: 1, content: 'const flag = "--max-count=1";' },
    ]);
    expect(await checkout.grep(`--open-files-in-pager=touch ${target}`)).toEqual([]);
    expect(await checkout.grep(`--output=${target}`)).toEqual([]);
    expect(existsSync(target)).toBe(false);
  });

  it("does not spawn git for an empty or whitespace query", async () => {
    const checkout = new RepoCheckout({
      repoPath: repo.path,
      tree: repo.featureSha,
      approximate: false,
    });

    expect(await checkout.grep("")).toEqual([]);
    expect(await checkout.grep("  \t\n")).toEqual([]);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("returns [] instead of throwing when the repo path is not a repository", async () => {
    const notRepo = await tempDir("rusty-not-repo-");
    const checkout = new RepoCheckout({ repoPath: notRepo, tree: "HEAD", approximate: true });

    expect(await checkout.grep("anything")).toEqual([]);
  });
});

describe("RepoCheckout.readFile", () => {
  it("reads the file as it is in the checkout's tree, not the working tree", async () => {
    const head = new RepoCheckout({
      repoPath: repo.path,
      tree: repo.featureSha,
      approximate: false,
    });
    const base = new RepoCheckout({ repoPath: repo.path, tree: repo.baseSha, approximate: false });

    expect(await head.readFile("src/a.ts")).toBe("export const a = 2;\n");
    expect(await base.readFile("src/a.ts")).toBe("export const a = 1;\n");
    expect(await base.readFile("src/b.ts")).toBeNull();
  });

  it("returns null for a missing path or one escaping the repo", async () => {
    const checkout = new RepoCheckout({
      repoPath: repo.path,
      tree: repo.featureSha,
      approximate: false,
    });

    expect(await checkout.readFile("nope.ts")).toBeNull();
    expect(await checkout.readFile("../outside.ts")).toBeNull();
  });

  it("rejects option-looking and NUL-containing paths without spawning git", async () => {
    const checkout = new RepoCheckout({
      repoPath: repo.path,
      tree: repo.featureSha,
      approximate: false,
    });

    expect(await checkout.readFile("-x")).toBeNull();
    expect(await checkout.readFile("--output=/tmp/x")).toBeNull();
    expect(await checkout.readFile("src/a.ts\0")).toBeNull();
    expect(await checkout.readFile("")).toBeNull();
    expect(execFile).not.toHaveBeenCalled();
  });
});

describe("resolveRepoCheckout", () => {
  it("returns null when there is no repository at the path", async () => {
    const notRepo = await tempDir("rusty-not-repo-");

    expect(await resolveRepoCheckout({ repoPath: notRepo, headSha: repo.featureSha })).toBeNull();
    expect(
      await resolveRepoCheckout({ repoPath: join(notRepo, "missing"), headSha: repo.featureSha }),
    ).toBeNull();
    expect(await resolveRepoCheckout({ repoPath: undefined, headSha: repo.featureSha })).toBeNull();
  });

  it("uses the head sha exactly when it is already in the repo", async () => {
    const checkout = await resolveRepoCheckout({ repoPath: repo.path, headSha: repo.featureSha });

    expect(checkout?.tree).toBe(repo.featureSha);
    expect(checkout?.approximate).toBe(false);
    expect(gitSpawns("fetch")).toEqual([]);
  });

  it("falls back to the workspace HEAD when the sha is absent and there is no remote", async () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";

    const checkout = await resolveRepoCheckout({ repoPath: repo.path, headSha: missing });

    expect(checkout?.tree).toBe("HEAD");
    expect(checkout?.approximate).toBe(true);
    expect(await checkout?.readFile("src/a.ts")).toBe("export const a = 1;\n");
  });

  it("falls back to the workspace HEAD when no head sha is known", async () => {
    const checkout = await resolveRepoCheckout({ repoPath: repo.path, headSha: undefined });

    expect(checkout).toMatchObject({ tree: "HEAD", approximate: true });
  });

  it("never passes a malformed head sha to git", async () => {
    const clone = await shallowClone(repo.path);

    const checkout = await resolveRepoCheckout({
      repoPath: clone,
      headSha: "--upload-pack=touch /tmp/pwned",
    });

    expect(checkout).toMatchObject({ tree: "HEAD", approximate: true });
    expect(gitSpawns("fetch")).toEqual([]);
    expect(gitSpawns("cat-file")).toEqual([]);
  });

  it("fetches the head sha from origin when the shallow checkout lacks it", async () => {
    const clone = await shallowClone(repo.path);
    await expect(git(clone, ["cat-file", "-e", `${repo.featureSha}^{commit}`])).rejects.toThrow();

    const checkout = await resolveRepoCheckout({ repoPath: clone, headSha: repo.featureSha });

    expect(checkout?.tree).toBe(repo.featureSha);
    expect(checkout?.approximate).toBe(false);
    expect(await checkout?.grep("newSymbol")).toHaveLength(1);
  });

  it("degrades to the workspace HEAD when origin is unreachable", async () => {
    const clone = await shallowClone(repo.path);
    await git(clone, ["remote", "set-url", "origin", join(clone, "does-not-exist")]);

    const checkout = await resolveRepoCheckout({ repoPath: clone, headSha: repo.featureSha });

    expect(checkout).toMatchObject({ tree: "HEAD", approximate: true });
    expect(gitSpawns("fetch")).toHaveLength(1);
  });

  it("sends the fetch auth header through env config, never argv", async () => {
    const clone = await shallowClone(repo.path);
    const header = "bearer secret-token-value";

    const checkout = await resolveRepoCheckout({
      repoPath: clone,
      headSha: repo.featureSha,
      fetchAuthHeader: header,
    });

    expect(checkout?.approximate).toBe(false);
    const [fetch] = gitSpawns("fetch");
    expect(fetch.args.join(" ")).not.toContain("secret-token-value");
    expect(configPairs(fetch.env)).toContainEqual([
      "http.extraheader",
      "AUTHORIZATION: bearer secret-token-value",
    ]);
    // the reset entry must precede the header or a persisted one would be sent too
    const pairs = configPairs(fetch.env).filter(([k]) => k === "http.extraheader");
    expect(pairs).toEqual([
      ["http.extraheader", ""],
      ["http.extraheader", "AUTHORIZATION: bearer secret-token-value"],
    ]);
    for (const spawn of [...gitSpawns("cat-file"), ...gitSpawns("rev-parse")]) {
      expect(JSON.stringify(spawn.env)).not.toContain("secret-token-value");
    }
  });
});

function configPairs(env: NodeJS.ProcessEnv): [string, string][] {
  const count = Number(env.GIT_CONFIG_COUNT);
  return Array.from({ length: count }, (_, i) => [
    env[`GIT_CONFIG_KEY_${i}`] ?? "",
    env[`GIT_CONFIG_VALUE_${i}`] ?? "",
  ]);
}
