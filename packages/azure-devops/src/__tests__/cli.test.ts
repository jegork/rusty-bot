import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RustyBotCore from "@rusty-bot/core";
import type { FilePatch, PRMetadata } from "@rusty-bot/core";
import { gitEnv, isCascadeEnabled, runMultiCallReview, runOpenGrep } from "@rusty-bot/core";
import { AzureDevOpsProvider } from "../provider.js";
import { main } from "../cli.js";

vi.mock("../provider.js", () => ({ AzureDevOpsProvider: vi.fn() }));

vi.mock("@rusty-bot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof RustyBotCore>();
  return {
    ...actual,
    isCascadeEnabled: vi.fn(),
    runOpenGrep: vi.fn(),
    runMultiCallReview: vi.fn(),
  };
});

const METADATA: PRMetadata = {
  id: "7",
  title: "feat: add stuff",
  description: "",
  author: "dev",
  sourceBranch: "refs/heads/feature/x",
  targetBranch: "refs/heads/main",
  url: "https://dev.azure.com/acme/proj/_git/repo/pullrequest/7",
  headSha: "0123456789abcdef0123456789abcdef01234567",
};

const PATCH: FilePatch = {
  path: "src/index.ts",
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, content: "+added\n context" }],
  additions: 1,
  deletions: 0,
  isBinary: false,
};

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// a real repo whose HEAD commit stands in for lastMergeSourceCommit
async function setupRepo(): Promise<{ path: string; headSha: string }> {
  const path = await tempDir("rusty-ado-");
  const env = gitEnv({
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
  const git = (args: string[]) => execFileSync("git", args, { cwd: path, env }).toString().trim();
  git(["init", "--initial-branch=main", "--quiet"]);
  git(["config", "commit.gpgsign", "false"]);
  await writeFile(join(path, "index.ts"), "export const fromCheckout = 1;\n");
  git(["add", "."]);
  git(["commit", "-m", "head", "--quiet"]);
  return { path, headSha: git(["rev-parse", "HEAD"]) };
}

function useProvider(metadata: PRMetadata) {
  const provider = {
    getPRMetadata: vi.fn().mockResolvedValue(metadata),
    getFileContent: vi.fn().mockResolvedValue(null),
    getLastReviewedIteration: vi.fn().mockResolvedValue(null),
    getLatestIterationId: vi.fn().mockResolvedValue(null),
    getPriorReviewContext: vi.fn().mockResolvedValue(null),
    deleteExistingBotComments: vi.fn().mockResolvedValue(undefined),
    getDiff: vi.fn().mockResolvedValue([PATCH]),
    getDiffSinceIteration: vi.fn().mockResolvedValue(null),
    getLinkedWorkItemIds: vi.fn().mockResolvedValue([]),
    postSummaryComment: vi.fn().mockResolvedValue(undefined),
    postInlineComments: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(AzureDevOpsProvider).mockImplementation(function (this: AzureDevOpsProvider) {
    return Object.assign(this, provider) as unknown as AzureDevOpsProvider;
  });
  return provider;
}

function reviewOptions() {
  return vi.mocked(runMultiCallReview).mock.calls[0][4];
}

describe("azure devops pipeline checkout wiring", () => {
  beforeEach(() => {
    vi.stubEnv("SYSTEM_PULLREQUEST_PULLREQUESTID", "7");
    vi.stubEnv("SYSTEM_TEAMFOUNDATIONCOLLECTIONURI", "https://dev.azure.com/acme/");
    vi.stubEnv("SYSTEM_TEAMPROJECT", "proj");
    vi.stubEnv("BUILD_REPOSITORY_NAME", "repo");
    vi.stubEnv("SYSTEM_ACCESSTOKEN", "ado-token");
    vi.stubEnv("BUILD_SOURCESDIRECTORY", undefined);
    vi.stubEnv("RUSTY_INCREMENTAL_REVIEW", "false");
    vi.stubEnv("RUSTY_FAIL_ON_CRITICAL", "false");
    vi.mocked(isCascadeEnabled).mockReturnValue(false);
    vi.mocked(runOpenGrep).mockResolvedValue({ available: false, findings: [], rawCount: 0 });
    vi.mocked(runMultiCallReview).mockResolvedValue({
      summary: "ok",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: [PATCH.path],
      recommendation: "looks_good",
      modelUsed: "test-model",
      tokenCount: 1,
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("runs with provider-backed tools when BUILD_SOURCESDIRECTORY is unset", async () => {
    const provider = useProvider(METADATA);

    await main();

    expect(reviewOptions()?.checkout).toBeUndefined();
    expect(reviewOptions()?.provider).toBeDefined();
    expect(provider.getFileContent).toHaveBeenCalledWith(PATCH.path, METADATA.sourceBranch);
  });

  it("falls back to provider tools when BUILD_SOURCESDIRECTORY is not a git repo", async () => {
    vi.stubEnv("BUILD_SOURCESDIRECTORY", await tempDir("rusty-ado-empty-"));
    useProvider(METADATA);

    await main();

    expect(reviewOptions()?.checkout).toBeUndefined();
  });

  it("passes a checkout at the PR head sha and expands context from it", async () => {
    const repo = await setupRepo();
    vi.stubEnv("BUILD_SOURCESDIRECTORY", repo.path);
    const provider = useProvider({ ...METADATA, headSha: repo.headSha });

    await main();

    const checkout = reviewOptions()?.checkout;
    expect(checkout?.tree).toBe(repo.headSha);
    expect(checkout?.approximate).toBe(false);
    // the convention file stays on the target branch through the API; nothing else may
    for (const [, ref] of provider.getFileContent.mock.calls) {
      expect(ref).toBe(METADATA.targetBranch);
    }
  });

  it("searches the workspace HEAD when the PR head is absent and cannot be fetched", async () => {
    const repo = await setupRepo();
    vi.stubEnv("BUILD_SOURCESDIRECTORY", repo.path);
    useProvider(METADATA);

    await main();

    const checkout = reviewOptions()?.checkout;
    expect(checkout?.tree).toBe("HEAD");
    expect(checkout?.approximate).toBe(true);
  });
});
