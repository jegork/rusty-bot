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

describe("risk label policy", () => {
  const assessment = {
    scope: "everyone" as const,
    detectability: "silent" as const,
    reversibility: "repair" as const,
    reasons: ["migration"],
    justification: "rewrites a status column for every row",
    level: "high" as const,
  };

  function useRiskProvider(labels: string[]) {
    const provider = useProvider(METADATA) as ReturnType<typeof useProvider> & {
      getLabels: ReturnType<typeof vi.fn>;
      postStandaloneComment: ReturnType<typeof vi.fn>;
    };
    provider.getLabels = vi.fn().mockResolvedValue(labels);
    provider.postStandaloneComment = vi.fn().mockResolvedValue(undefined);
    vi.mocked(AzureDevOpsProvider).mockImplementation(function (this: AzureDevOpsProvider) {
      return Object.assign(this, provider) as unknown as AzureDevOpsProvider;
    });
    return provider;
  }

  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("SYSTEM_PULLREQUEST_PULLREQUESTID", "7");
    vi.stubEnv("SYSTEM_TEAMFOUNDATIONCOLLECTIONURI", "https://dev.azure.com/acme/");
    vi.stubEnv("SYSTEM_TEAMPROJECT", "proj");
    vi.stubEnv("BUILD_REPOSITORY_NAME", "repo");
    vi.stubEnv("SYSTEM_ACCESSTOKEN", "ado-token");
    vi.stubEnv("BUILD_SOURCESDIRECTORY", undefined);
    vi.stubEnv("RUSTY_INCREMENTAL_REVIEW", "false");
    vi.stubEnv("RUSTY_FAIL_ON_CRITICAL", "false");
    vi.stubEnv("RUSTY_RISK_ASSESSMENT", "true");
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
      riskAssessment: assessment,
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    exitSpy.mockRestore();
  });

  it("asks the review for a risk assessment when enabled", async () => {
    useRiskProvider(["risk:high"]);
    await main();
    expect(vi.mocked(runMultiCallReview).mock.calls[0][1].assessRisk).toBe(true);
  });

  it("merges with the author's label into the summary and stays quiet when they agree", async () => {
    const provider = useRiskProvider(["risk:high"]);
    await main();
    expect(provider.postSummaryComment.mock.calls[0][0]).toContain("## Risk: High\n");
    expect(provider.postStandaloneComment).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("opens a disagreement thread when the bot rates the PR higher, without failing", async () => {
    const provider = useRiskProvider(["risk:low"]);
    await main();
    expect(provider.postSummaryComment.mock.calls[0][0]).toContain(
      "## Risk: High (author says Low)",
    );
    const thread = provider.postStandaloneComment.mock.calls[0][0];
    expect(thread).toContain("## Risk label disagreement");
    expect(thread).toContain("`risk:low`");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not argue when the author rates the PR higher than the bot", async () => {
    vi.mocked(runMultiCallReview).mockResolvedValueOnce({
      summary: "ok",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: [PATCH.path],
      recommendation: "looks_good",
      modelUsed: "test-model",
      tokenCount: 1,
      riskAssessment: {
        ...assessment,
        scope: "one_user",
        detectability: "immediate",
        reversibility: "redeploy",
        level: "low",
      },
    });
    const provider = useRiskProvider(["risk:high"]);
    await main();
    expect(provider.postStandaloneComment).not.toHaveBeenCalled();
  });

  it("posts the review, then fails the task when the risk label is missing", async () => {
    const provider = useRiskProvider(["bug"]);
    await expect(main()).rejects.toThrow("process.exit");
    expect(provider.postSummaryComment).toHaveBeenCalled();
    expect(provider.postStandaloneComment.mock.calls[0][0]).toContain("## Risk label required");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("fails on two conflicting labels", async () => {
    const provider = useRiskProvider(["risk:low", "risk:high"]);
    await expect(main()).rejects.toThrow("process.exit");
    expect(provider.postStandaloneComment.mock.calls[0][0]).toContain("more than one risk label");
  });

  it("does not fail when the label is missing but enforcement is off", async () => {
    vi.stubEnv("RUSTY_RISK_REQUIRE_LABEL", "false");
    const provider = useRiskProvider([]);
    await main();
    expect(provider.postStandaloneComment).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("does not fail when labels cannot be read at all", async () => {
    const provider = useRiskProvider([]);
    provider.getLabels.mockRejectedValue(new Error("403"));
    await main();
    expect(provider.postStandaloneComment).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("still enforces the label when the review itself is skipped as already current", async () => {
    vi.stubEnv("RUSTY_INCREMENTAL_REVIEW", "true");
    const provider = useRiskProvider([]);
    provider.getLastReviewedIteration.mockResolvedValue("3");
    provider.getLatestIterationId.mockResolvedValue("3");
    await expect(main()).rejects.toThrow("process.exit");
    expect(runMultiCallReview).not.toHaveBeenCalled();
    expect(provider.postStandaloneComment.mock.calls[0][0]).toContain("## Risk label required");
  });

  it("keeps the prior pass's higher level on an incremental re-review", async () => {
    vi.stubEnv("RUSTY_INCREMENTAL_REVIEW", "true");
    vi.mocked(runMultiCallReview).mockResolvedValueOnce({
      summary: "ok",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: [PATCH.path],
      recommendation: "looks_good",
      modelUsed: "test-model",
      tokenCount: 1,
      riskAssessment: {
        ...assessment,
        scope: "one_user",
        detectability: "immediate",
        reversibility: "redeploy",
        level: "low",
      },
    });
    const provider = useRiskProvider(["risk:high"]);
    provider.getLastReviewedIteration.mockResolvedValue("2");
    provider.getLatestIterationId.mockResolvedValue("3");
    provider.getDiffSinceIteration.mockResolvedValue([PATCH]);
    provider.getPriorReviewContext.mockResolvedValue({
      summary: "earlier",
      recommendation: "looks_good",
      findings: [],
      riskAssessment: assessment,
    });
    await main();
    expect(provider.postSummaryComment.mock.calls[0][0]).toContain("## Risk: High\n");
  });

  it("leaves the review alone when risk assessment is off", async () => {
    vi.stubEnv("RUSTY_RISK_ASSESSMENT", "false");
    const provider = useRiskProvider([]);
    await main();
    expect(vi.mocked(runMultiCallReview).mock.calls[0][1].assessRisk).toBe(false);
    expect(provider.getLabels).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe("risk policy from .rusty-bot.json", () => {
  const assessment = {
    scope: "one_feature" as const,
    detectability: "monitored" as const,
    reversibility: "redeploy" as const,
    reasons: ["ui-only"],
    justification: "a visible change in one screen",
    level: "medium" as const,
  };

  function useConfiguredProvider(repoConfig: string | null, labels: string[]) {
    const provider = useProvider(METADATA) as ReturnType<typeof useProvider> & {
      getLabels: ReturnType<typeof vi.fn>;
      postStandaloneComment: ReturnType<typeof vi.fn>;
    };
    provider.getFileContent = vi
      .fn()
      .mockImplementation(async (path: string) => (path === ".rusty-bot.json" ? repoConfig : null));
    provider.getLabels = vi.fn().mockResolvedValue(labels);
    provider.postStandaloneComment = vi.fn().mockResolvedValue(undefined);
    vi.mocked(AzureDevOpsProvider).mockImplementation(function (this: AzureDevOpsProvider) {
      return Object.assign(this, provider) as unknown as AzureDevOpsProvider;
    });
    return provider;
  }

  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubEnv("SYSTEM_PULLREQUEST_PULLREQUESTID", "7");
    vi.stubEnv("SYSTEM_TEAMFOUNDATIONCOLLECTIONURI", "https://dev.azure.com/acme/");
    vi.stubEnv("SYSTEM_TEAMPROJECT", "proj");
    vi.stubEnv("BUILD_REPOSITORY_NAME", "repo");
    vi.stubEnv("SYSTEM_ACCESSTOKEN", "ado-token");
    vi.stubEnv("BUILD_SOURCESDIRECTORY", undefined);
    vi.stubEnv("RUSTY_INCREMENTAL_REVIEW", "false");
    vi.stubEnv("RUSTY_FAIL_ON_CRITICAL", "false");
    vi.stubEnv("RUSTY_RISK_ASSESSMENT", undefined);
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
      riskAssessment: assessment,
    });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    exitSpy.mockRestore();
  });

  it("turns the policy on from the repo file when the env vars are unset", async () => {
    const provider = useConfiguredProvider(
      JSON.stringify({
        risk: { reasons: ["ui-only"], instructions: "one prod org" },
      }),
      ["risk:medium"],
    );
    await main();
    const reviewConfig = vi.mocked(runMultiCallReview).mock.calls[0][1];
    expect(reviewConfig.assessRisk).toBe(true);
    expect(reviewConfig.riskReasons).toEqual(["ui-only"]);
    expect(reviewConfig.riskInstructions).toBe("one prod org");
    expect(provider.getFileContent).toHaveBeenCalledWith(".rusty-bot.json", METADATA.targetBranch);
    expect(provider.getLabels).toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("lets the repo file override the env vars in both directions", async () => {
    vi.stubEnv("RUSTY_RISK_ASSESSMENT", "true");
    const off = useConfiguredProvider(JSON.stringify({ risk: { enabled: false } }), []);
    await main();
    expect(vi.mocked(runMultiCallReview).mock.calls[0][1].assessRisk).toBe(false);
    expect(off.getLabels).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.stubEnv("RUSTY_RISK_ASSESSMENT", "false");
    const lenient = useConfiguredProvider(
      JSON.stringify({ risk: { requireLabel: false, labelPrefix: "Risk/" } }),
      [],
    );
    await main();
    expect(vi.mocked(runMultiCallReview).mock.calls[0][1].assessRisk).toBe(true);
    expect(lenient.postStandaloneComment).not.toHaveBeenCalled();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("reads the author's label with the prefix from the repo file", async () => {
    const provider = useConfiguredProvider(JSON.stringify({ risk: { labelPrefix: "Risk/" } }), [
      "Risk/low",
    ]);
    await main();
    expect(provider.postSummaryComment.mock.calls[0][0]).toContain(
      "## Risk: Medium (author says Low)",
    );
    expect(provider.postStandaloneComment.mock.calls[0][0]).toContain("`Risk/low`");
  });

  it("falls back to the env vars when there is no repo file", async () => {
    vi.stubEnv("RUSTY_RISK_ASSESSMENT", "true");
    const provider = useConfiguredProvider(null, ["risk:medium"]);
    await main();
    expect(vi.mocked(runMultiCallReview).mock.calls[0][1].assessRisk).toBe(true);
    expect(provider.getLabels).toHaveBeenCalled();
  });

  it("fails the run on a malformed repo file instead of reviewing without the policy", async () => {
    useConfiguredProvider('{"risk": {"require_label": false}}', ["risk:medium"]);
    await expect(main()).rejects.toThrow(/invalid repo config/);
    expect(runMultiCallReview).not.toHaveBeenCalled();
  });
});
