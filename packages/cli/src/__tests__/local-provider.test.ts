import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalGitProvider } from "../local-provider.js";

const execFileAsync = promisify(execFile);

// git hooks export GIT_DIR / GIT_INDEX_FILE etc. when the suite runs from
// pre-commit. left in place, every git call below (and in the provider) would
// target the repo being committed instead of the temp repo — `git init` there
// flips core.bare=true on the real checkout. list from `git rev-parse --local-env-vars`.
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

interface GitRepo {
  path: string;
  initialSha: string;
  featureSha: string;
}

// pass author + committer identity via env so we don't depend on the local
// .git/config write landing before `git commit` reads it. without this the
// test flakes whenever the host's global git user.name / user.email leaks
// through under high parallel-worker load.
const GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY_ENV },
  });
  return stdout.trim();
}

async function setupRepo(): Promise<GitRepo> {
  const path = await mkdtemp(join(tmpdir(), "rusty-cli-test-"));
  await git(path, ["init", "--initial-branch=main", "--quiet"]);
  await git(path, ["config", "commit.gpgsign", "false"]);

  await writeFile(join(path, "a.ts"), "export const a = 1;\n");
  await mkdir(join(path, "src"), { recursive: true });
  await writeFile(join(path, "src/keep.ts"), "export const keep = 'main-only';\n");
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "initial", "--quiet"]);
  const initialSha = await git(path, ["rev-parse", "HEAD"]);

  await git(path, ["checkout", "-b", "feature", "--quiet"]);
  await writeFile(join(path, "a.ts"), "export const a = 2;\nexport const b = 3;\n");
  await writeFile(join(path, "src/keep.ts"), "export const keep = 'feature-only';\n");
  await git(path, ["add", "."]);
  await git(path, ["commit", "-m", "feature change", "--quiet"]);
  const featureSha = await git(path, ["rev-parse", "HEAD"]);

  // leave the working tree on `main` so we can detect cases where the provider
  // serves the working tree for an explicit non-HEAD ref.
  await git(path, ["checkout", "main", "--quiet"]);

  return { path, initialSha, featureSha };
}

describe("LocalGitProvider (integration)", () => {
  let repo: GitRepo;

  beforeEach(async () => {
    repo = await setupRepo();
  });

  afterEach(async () => {
    await rm(repo.path, { recursive: true, force: true });
  });

  describe("getDiff", () => {
    it("returns parsed file patches for the configured base...head range", async () => {
      const provider = new LocalGitProvider({
        repoPath: repo.path,
        baseRef: "main",
        headRef: "feature",
      });
      const patches = await provider.getDiff();
      const paths = patches.map((p) => p.path).sort();
      expect(paths).toEqual(["a.ts", "src/keep.ts"]);
      const aPatch = patches.find((p) => p.path === "a.ts");
      expect(aPatch?.additions).toBeGreaterThan(0);
    });

    it("returns an empty array when base and head are the same ref", async () => {
      const provider = new LocalGitProvider({
        repoPath: repo.path,
        baseRef: "main",
        headRef: "main",
      });
      const patches = await provider.getDiff();
      expect(patches).toEqual([]);
    });
  });

  describe("getPRMetadata", () => {
    it("populates branches, sha, and a synthesized title", async () => {
      const provider = new LocalGitProvider({
        repoPath: repo.path,
        baseRef: "main",
        headRef: "feature",
      });
      const meta = await provider.getPRMetadata();
      expect(meta.targetBranch).toBe("main");
      expect(meta.sourceBranch).toBe("feature");
      expect(meta.headSha).toBe(repo.featureSha);
      expect(meta.title).toContain("main");
      expect(meta.title).toContain("feature");
      expect(meta.author).toBe("Test User");
    });
  });

  describe("getFileContent", () => {
    it("returns the file at the requested ref via git show", async () => {
      const provider = new LocalGitProvider({
        repoPath: repo.path,
        baseRef: "main",
        headRef: "feature",
      });
      const onFeature = await provider.getFileContent("a.ts", "feature");
      expect(onFeature).toContain("export const b = 3");
      const onMain = await provider.getFileContent("a.ts", "main");
      expect(onMain).toBe("export const a = 1;\n");
    });

    it("does NOT serve the working tree when headRef is an explicit branch name", async () => {
      // working tree is on main; headRef configured to 'feature'. asking for the
      // feature ref must go through git show, not return main's working tree.
      const provider = new LocalGitProvider({
        repoPath: repo.path,
        baseRef: "main",
        headRef: "feature",
      });
      const content = await provider.getFileContent("src/keep.ts", "feature");
      expect(content).toBe("export const keep = 'feature-only';\n");
    });

    it("serves the working tree when headRef is 'HEAD'", async () => {
      // simulate uncommitted edits — these should be visible when headRef===HEAD.
      await writeFile(join(repo.path, "src/keep.ts"), "uncommitted local edit\n");
      const provider = new LocalGitProvider({
        repoPath: repo.path,
        baseRef: "main",
        headRef: "HEAD",
      });
      const content = await provider.getFileContent("src/keep.ts", "HEAD");
      expect(content).toBe("uncommitted local edit\n");
    });

    it("returns null when the file does not exist at the ref", async () => {
      const provider = new LocalGitProvider({
        repoPath: repo.path,
        baseRef: "main",
        headRef: "feature",
      });
      const content = await provider.getFileContent("does-not-exist.ts", "main");
      expect(content).toBeNull();
    });
  });

  describe("searchCode", () => {
    it("returns file/line/content rows for matching tracked content", async () => {
      const provider = new LocalGitProvider({
        repoPath: repo.path,
        baseRef: "main",
        headRef: "HEAD",
      });
      const results = await provider.searchCode("export const keep");
      expect(results.length).toBeGreaterThan(0);
      const hit = results.find((r) => r.file.endsWith("src/keep.ts"));
      expect(hit).toBeDefined();
      expect(hit?.line).toBeGreaterThan(0);
      expect(hit?.content).toContain("export const keep");
    });

    it("returns an empty array when there are no matches", async () => {
      const provider = new LocalGitProvider({
        repoPath: repo.path,
        baseRef: "main",
        headRef: "HEAD",
      });
      const results = await provider.searchCode("definitely_not_in_repo_xyz_123");
      expect(results).toEqual([]);
    });

    it("returns an empty array for an empty query without invoking a search tool", async () => {
      const provider = new LocalGitProvider({
        repoPath: repo.path,
        baseRef: "main",
        headRef: "HEAD",
      });
      expect(await provider.searchCode("")).toEqual([]);
      expect(await provider.searchCode("   ")).toEqual([]);
    });
  });

  describe("PR mutation methods", () => {
    it("are no-ops that resolve without throwing", async () => {
      const provider = new LocalGitProvider({
        repoPath: repo.path,
        baseRef: "main",
        headRef: "HEAD",
      });
      await expect(provider.postSummaryComment()).resolves.toBeUndefined();
      await expect(provider.postInlineComments()).resolves.toBeUndefined();
      await expect(provider.deleteExistingBotComments()).resolves.toBeUndefined();
      await expect(provider.updatePRDescription()).resolves.toBeUndefined();
      await expect(provider.updatePRTitle()).resolves.toBeUndefined();
    });
  });
});
