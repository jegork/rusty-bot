import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitEnv } from "../repo/git-env.js";
import { GitHistory, HISTORY_COMMIT_LIMIT, HISTORY_FILES_PER_COMMIT } from "../repo/history.js";

const execFileAsync = promisify(execFile);

// git hooks export GIT_DIR and friends when the suite runs from pre-commit;
// the fixtures must not land on the repository being committed
for (const key of Object.keys(process.env)) {
  if (key.startsWith("GIT_")) Reflect.deleteProperty(process.env, key);
}

const IDENTITY = {
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, env: gitEnv(IDENTITY) });
  return stdout.trim();
}

const tempDirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rusty-history-"));
  tempDirs.push(dir);
  return dir;
}

const MIGRATION = "alembic/versions/abc123_add_documents.py";

async function commitFile(repo: string, path: string, content: string, message: string) {
  await mkdir(join(repo, path, ".."), { recursive: true });
  await writeFile(join(repo, path), content);
  await git(repo, ["add", "--", path]);
  await git(repo, ["commit", "--quiet", "-m", message]);
}

// main: unrelated, migration added in "PR 4536", reverted in "PR 4568", unrelated
async function migrationRepo(): Promise<string> {
  const repo = await tempDir();
  await git(repo, ["init", "--initial-branch=main", "--quiet"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await commitFile(repo, "README.md", "hello\n", "chore: init");
  await commitFile(repo, MIGRATION, 'revision = "abc123"\n', "feat: add documents table (#4536)");
  await git(repo, ["rm", "--quiet", "--", MIGRATION]);
  await git(repo, [
    "commit",
    "--quiet",
    "-m",
    'Revert "feat: add documents table (#4536)" (#4568)',
  ]);
  await commitFile(repo, "src/app.py", "print(1)\n", "fix: unrelated");
  return repo;
}

describe("GitHistory.resolve", () => {
  let repo: string;
  beforeAll(async () => {
    repo = await migrationRepo();
  });

  it("offers history for a full clone with the target branch", async () => {
    const history = await GitHistory.resolve(repo, "main");
    expect(history?.ref).toBe(await git(repo, ["rev-parse", "main"]));
    expect(history?.targetBranch).toBe("main");
  });

  it("prefers the remote-tracking branch over a local one that moved on", async () => {
    const clone = await tempDir();
    await git(clone, ["clone", "--quiet", `file://${repo}`, "."]);
    await git(clone, ["config", "commit.gpgsign", "false"]);
    await commitFile(clone, "local.txt", "x\n", "local only");

    const history = await GitHistory.resolve(clone, "main");

    expect(history?.ref).toBe(await git(clone, ["rev-parse", "origin/main"]));
  });

  it("offers nothing for a shallow clone, whose history would read as 'never existed'", async () => {
    const clone = await tempDir();
    await git(clone, ["clone", "--quiet", "--depth=1", `file://${repo}`, "."]);
    expect(await GitHistory.resolve(clone, "main")).toBeNull();
  });

  it("offers nothing when the target branch is not in the checkout", async () => {
    expect(await GitHistory.resolve(repo, "release")).toBeNull();
  });

  it.each(["--all", "-main", "main..HEAD", "main with space", ""])(
    "rejects the branch name %j without running git on it",
    async (branch) => {
      expect(await GitHistory.resolve(repo, branch)).toBeNull();
    },
  );

  it("offers nothing outside a git repository", async () => {
    expect(await GitHistory.resolve(await tempDir(), "main")).toBeNull();
  });
});

describe("GitHistory.log", () => {
  let repo: string;
  let history: GitHistory;
  beforeAll(async () => {
    repo = await migrationRepo();
    history = (await GitHistory.resolve(repo, "main"))!;
  });

  it("finds a revision id that shipped and was reverted, revert first", async () => {
    const { commits, truncated } = await history.log({ query: "abc123" });

    expect(truncated).toBe(false);
    expect(commits.map((c) => c.subject)).toEqual([
      'Revert "feat: add documents table (#4536)" (#4568)',
      "feat: add documents table (#4536)",
    ]);
    expect(commits[0].files).toEqual([`D ${MIGRATION}`]);
    expect(commits[1].files).toEqual([`A ${MIGRATION}`]);
    expect(commits[0].sha).toMatch(/^[0-9a-f]{12}$/);
    expect(commits[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("lists the commits that touched a path, even one that no longer exists", async () => {
    const { commits } = await history.log({ path: "alembic/versions" });
    expect(commits).toHaveLength(2);
  });

  it("narrows a query to a path", async () => {
    expect((await history.log({ path: "src", query: "abc123" })).commits).toEqual([]);
    expect((await history.log({ path: "src", query: "print" })).commits).toHaveLength(1);
  });

  it("treats a query that looks like an option as a plain string", async () => {
    expect((await history.log({ query: "--all" })).commits).toEqual([]);
  });

  it("does not see commits outside the target branch", async () => {
    await git(repo, ["checkout", "--quiet", "-b", "feature"]);
    await commitFile(repo, "feature.py", 'revision = "zzz999"\n', "feat: on the PR branch");
    await git(repo, ["checkout", "--quiet", "main"]);
    const fresh = (await GitHistory.resolve(repo, "main"))!;
    expect((await fresh.log({ query: "zzz999" })).commits).toEqual([]);
  });

  it("returns the same answer for a repeated lookup without running git again", async () => {
    expect(history.log({ query: "abc123" })).toBe(history.log({ query: "abc123" }));
  });

  it("rejects when git fails, so the tool can say the lookup failed", async () => {
    const broken = new GitHistory(await tempDir(), "main", "0".repeat(40));
    await expect(broken.log({ query: "x" })).rejects.toThrow("git history lookup failed");
  });
});

describe("GitHistory.log caps", () => {
  it("caps commits and files per commit", async () => {
    const repo = await tempDir();
    await git(repo, ["init", "--initial-branch=main", "--quiet"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    const wide = HISTORY_FILES_PER_COMMIT + 2;
    for (let i = 0; i < wide; i++) await writeFile(join(repo, `f${i}.txt`), "wide-marker\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "--quiet", "-m", "wide"]);
    for (let i = 0; i < HISTORY_COMMIT_LIMIT + 1; i++) {
      await commitFile(repo, "f0.txt", `${i}\n`, `edit ${i}`);
    }
    const history = (await GitHistory.resolve(repo, "main"))!;

    const all = await history.log({ path: "f0.txt" });
    expect(all.commits).toHaveLength(HISTORY_COMMIT_LIMIT);
    expect(all.truncated).toBe(true);

    // a path would also narrow the file list, so find the wide commit by content alone
    const { commits } = await history.log({ query: "wide-marker" });
    expect(commits.map((c) => c.subject)).toEqual(["edit 0", "wide"]);
    expect(commits[0].files).toEqual(["M f0.txt"]);
    expect(commits[1].files).toHaveLength(HISTORY_FILES_PER_COMMIT);
    expect(commits[1].moreFiles).toBe(2);
  }, 30_000);
});

afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});
