import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePatch, Finding, GitProvider, PRMetadata, ReviewResult } from "../types.js";
import { gitEnv } from "../repo/git-env.js";
import type * as TriageModule from "../triage/triage.js";
import type * as OpenGrepModule from "../opengrep/runner.js";
import type * as TitleModule from "../title/generate.js";
import type * as DescriptionModule from "../description/generate.js";

const mocks = vi.hoisted(() => ({
  runCascadeReview: vi.fn(),
  runMultiCallReview: vi.fn(),
  runTriage: vi.fn(),
  isCascadeEnabled: vi.fn(),
  runOpenGrep: vi.fn(),
  generateConventionalTitle: vi.fn(),
  generatePRDescription: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
}));

vi.mock("../agent/multi-call.js", () => ({
  runCascadeReview: mocks.runCascadeReview,
  runMultiCallReview: mocks.runMultiCallReview,
}));
vi.mock("../triage/triage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TriageModule>()),
  runTriage: mocks.runTriage,
  isCascadeEnabled: mocks.isCascadeEnabled,
}));
vi.mock("../opengrep/runner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof OpenGrepModule>()),
  runOpenGrep: mocks.runOpenGrep,
}));
vi.mock("../title/generate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TitleModule>()),
  generateConventionalTitle: mocks.generateConventionalTitle,
}));
vi.mock("../description/generate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof DescriptionModule>()),
  generatePRDescription: mocks.generatePRDescription,
}));
vi.mock("../logger.js", () => {
  const log = { info: mocks.logInfo, warn: mocks.logWarn, debug: vi.fn(), error: vi.fn() };
  return { logger: { ...log, child: () => log }, flushLogger: vi.fn() };
});

const { runPrReview, headShaIncremental, runTriagedReview } = await import("../review-pipeline.js");

const HEAD = "0123456789abcdef0123456789abcdef01234567";

const METADATA: PRMetadata = {
  id: "7",
  title: "feat: add stuff",
  description: "body",
  author: "dev",
  sourceBranch: "feature/x",
  targetBranch: "main",
  url: "https://example.test/pr/7",
  headSha: HEAD,
};

const PATCH: FilePatch = {
  path: "src/index.ts",
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, content: "+added\n context" }],
  additions: 1,
  deletions: 0,
  isBinary: false,
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: PATCH.path,
    line: 1,
    endLine: null,
    severity: "warning",
    category: "bugs",
    message: "a problem",
    suggestedFix: null,
    ...overrides,
  };
}

function review(findings: Finding[] = []): ReviewResult {
  return {
    summary: "s",
    recommendation: "looks_good",
    findings,
    observations: [],
    ticketCompliance: [],
    missingTests: [],
    filesReviewed: [PATCH.path],
    modelUsed: "m",
    tokenCount: 1,
  };
}

function makeProvider(overrides: Partial<Record<keyof GitProvider, unknown>> = {}) {
  const base = {
    getDiff: vi.fn().mockResolvedValue([PATCH]),
    getPRMetadata: vi.fn().mockResolvedValue({ ...METADATA }),
    getFileContent: vi.fn().mockResolvedValue(null),
    searchCode: vi.fn().mockResolvedValue([]),
    postSummaryComment: vi.fn().mockResolvedValue(undefined),
    postInlineComments: vi.fn().mockResolvedValue(undefined),
    deleteExistingBotComments: vi.fn().mockResolvedValue(undefined),
    updatePRDescription: vi.fn().mockResolvedValue(undefined),
    updatePRTitle: vi.fn().mockResolvedValue(undefined),
    getLastReviewedSha: vi.fn().mockResolvedValue(null),
    getDiffSinceSha: vi.fn().mockResolvedValue(null),
    getPriorReviewContext: vi.fn().mockResolvedValue(null),
  };
  return { ...base, ...overrides } as typeof base;
}

function makePlatform(
  provider: ReturnType<typeof makeProvider>,
  overrides: Record<string, unknown> = {},
) {
  return {
    label: "PR" as const,
    provider: provider as unknown as GitProvider,
    config: { style: "balanced" as const, focusAreas: [], ignorePatterns: [] },
    failOnCritical: false,
    incrementalReview: true,
    renameTitleToConventional: false,
    generateDescription: false,
    maxTokens: 1000,
    workspacePath: undefined,
    fetchAuthHeader: undefined,
    incremental: headShaIncremental(provider),
    ticketSource: "github" as const,
    getLinkedTicketIds: vi.fn().mockResolvedValue([]),
    buildTicketProviders: vi.fn(() => new Map()),
    ...overrides,
  };
}

const tempDirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RUSTY_MCP_CONFIG", "/nonexistent/mcp-servers.json");
  mocks.isCascadeEnabled.mockReturnValue(false);
  mocks.runOpenGrep.mockResolvedValue({ available: true, findings: [], rawCount: 0 });
  mocks.runMultiCallReview.mockResolvedValue(review());
  mocks.runCascadeReview.mockResolvedValue(review());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("runPrReview incremental state", () => {
  it("skips without touching comments when this revision was already reviewed", async () => {
    const provider = makeProvider({ getLastReviewedSha: vi.fn().mockResolvedValue(HEAD) });

    await expect(runPrReview(makePlatform(provider))).resolves.toBe(0);

    expect(provider.deleteExistingBotComments).not.toHaveBeenCalled();
    expect(mocks.runMultiCallReview).not.toHaveBeenCalled();
  });

  it("reads the marker and prior context before deleting old comments", async () => {
    const order: string[] = [];
    const provider = makeProvider({
      getLastReviewedSha: vi.fn(async () => {
        order.push("marker");
        return "old";
      }),
      getPriorReviewContext: vi.fn(async () => {
        order.push("context");
        return null;
      }),
      deleteExistingBotComments: vi.fn(async () => {
        order.push("delete");
      }),
    });

    await runPrReview(makePlatform(provider));

    expect(order).toEqual(["marker", "context", "delete"]);
  });

  it("does a full review when reading the marker throws", async () => {
    const provider = makeProvider({
      getLastReviewedSha: vi.fn().mockRejectedValue(new Error("api down")),
    });

    await runPrReview(makePlatform(provider));

    expect(provider.getDiff).toHaveBeenCalled();
    expect(mocks.runMultiCallReview).toHaveBeenCalled();
  });

  it("reviews only the delta and carries prior context forward", async () => {
    const prior = { summary: "before", recommendation: "looks_good", findings: [] };
    const provider = makeProvider({
      getLastReviewedSha: vi.fn().mockResolvedValue("old"),
      getDiffSinceSha: vi.fn().mockResolvedValue([PATCH]),
      getPriorReviewContext: vi.fn().mockResolvedValue(prior),
    });

    await runPrReview(makePlatform(provider));

    expect(provider.getDiffSinceSha).toHaveBeenCalledWith("old", HEAD);
    expect(provider.getDiff).not.toHaveBeenCalled();
    expect(mocks.runMultiCallReview.mock.calls[0][4].priorContext).toEqual(prior);
  });

  it("falls back to the full diff, without prior context, when the delta is unreachable", async () => {
    const provider = makeProvider({
      getLastReviewedSha: vi.fn().mockResolvedValue("old"),
      getDiffSinceSha: vi.fn().mockResolvedValue(null),
      getPriorReviewContext: vi.fn().mockResolvedValue({ summary: "x" }),
    });

    await runPrReview(makePlatform(provider));

    expect(provider.getDiff).toHaveBeenCalled();
    expect(mocks.runMultiCallReview.mock.calls[0][4].priorContext).toBeUndefined();
  });

  it("posts a short note and skips the LLM when the delta has nothing reviewable", async () => {
    const provider = makeProvider({
      getLastReviewedSha: vi.fn().mockResolvedValue("old"),
      getDiffSinceSha: vi.fn().mockResolvedValue([]),
    });

    await expect(runPrReview(makePlatform(provider))).resolves.toBe(0);

    expect(provider.postSummaryComment).toHaveBeenCalledWith(
      "No reviewable changes since the last review.",
      { lastReviewedSha: HEAD },
    );
    expect(mocks.runMultiCallReview).not.toHaveBeenCalled();
  });

  it("does not read the marker when incremental review is off, but still embeds one", async () => {
    const provider = makeProvider();

    await runPrReview(makePlatform(provider, { incrementalReview: false }));

    expect(provider.getLastReviewedSha).not.toHaveBeenCalled();
    expect(provider.postSummaryComment.mock.calls[0][1]).toMatchObject({ lastReviewedSha: HEAD });
  });

  it("embeds no marker when the platform cannot identify the revision", async () => {
    const provider = makeProvider({
      getPRMetadata: vi.fn().mockResolvedValue({ ...METADATA, headSha: undefined }),
    });

    await runPrReview(makePlatform(provider));

    expect(provider.getLastReviewedSha).not.toHaveBeenCalled();
    expect(provider.postSummaryComment.mock.calls[0][1]).toBeUndefined();
  });
});

describe("runPrReview title and description", () => {
  it("renames a non-conventional title and reviews under the new one", async () => {
    mocks.generateConventionalTitle.mockResolvedValue({
      title: "fix: new",
      modelUsed: "m",
      tokenCount: 1,
    });
    const provider = makeProvider({
      getPRMetadata: vi.fn().mockResolvedValue({ ...METADATA, title: "stuff" }),
    });

    await runPrReview(makePlatform(provider, { renameTitleToConventional: true }));

    expect(provider.updatePRTitle).toHaveBeenCalledWith("fix: new");
    expect(mocks.runMultiCallReview.mock.calls[0][2].title).toBe("fix: new");
  });

  it("leaves a conventional title alone and continues when renaming throws", async () => {
    mocks.generateConventionalTitle.mockRejectedValue(new Error("llm down"));
    const conventional = makeProvider();
    await runPrReview(makePlatform(conventional, { renameTitleToConventional: true }));
    expect(mocks.generateConventionalTitle).not.toHaveBeenCalled();

    const failing = makeProvider({
      getPRMetadata: vi.fn().mockResolvedValue({ ...METADATA, title: "stuff" }),
    });
    await expect(
      runPrReview(makePlatform(failing, { renameTitleToConventional: true })),
    ).resolves.toBe(0);
    expect(mocks.runMultiCallReview).toHaveBeenCalledTimes(2);
  });

  it("generates a description for an empty body and continues when that throws", async () => {
    mocks.generatePRDescription.mockResolvedValueOnce({
      markdown: "generated",
      modelUsed: "m",
      tokenCount: 1,
    });
    const provider = makeProvider({
      getPRMetadata: vi.fn().mockResolvedValue({ ...METADATA, description: "" }),
    });
    await runPrReview(makePlatform(provider, { generateDescription: true }));
    expect(provider.updatePRDescription).toHaveBeenCalledWith("generated");

    mocks.generatePRDescription.mockRejectedValueOnce(new Error("llm down"));
    const failing = makeProvider({
      getPRMetadata: vi.fn().mockResolvedValue({ ...METADATA, description: "" }),
    });
    await expect(runPrReview(makePlatform(failing, { generateDescription: true }))).resolves.toBe(
      0,
    );
  });
});

describe("runPrReview tickets", () => {
  it("adds linked tickets without duplicating ones found in the description", async () => {
    const provider = makeProvider({
      getPRMetadata: vi.fn().mockResolvedValue({ ...METADATA, description: "fixes #12" }),
    });
    const buildTicketProviders = vi.fn(() => new Map());

    await runPrReview(
      makePlatform(provider, {
        getLinkedTicketIds: vi.fn().mockResolvedValue(["12", "34"]),
        buildTicketProviders,
      }),
    );

    const refs = buildTicketProviders.mock.calls[0] as unknown as [{ id: string }[]];
    expect(refs[0].map((r) => r.id).sort()).toEqual(["12", "34"]);
  });

  it("continues with extracted refs when fetching linked tickets throws", async () => {
    const provider = makeProvider();

    await expect(
      runPrReview(
        makePlatform(provider, {
          getLinkedTicketIds: vi.fn().mockRejectedValue(new Error("api down")),
        }),
      ),
    ).resolves.toBe(0);
  });

  it("lets a platform normalize extracted refs before deduplicating", async () => {
    const provider = makeProvider({
      getPRMetadata: vi.fn().mockResolvedValue({ ...METADATA, description: "fixes #12" }),
    });
    const buildTicketProviders = vi.fn(() => new Map());

    await runPrReview(
      makePlatform(provider, {
        ticketSource: "gitlab",
        normalizeTicketRefs: (refs: { id: string }[]) =>
          refs.map((r) => ({ ...r, source: "gitlab" })),
        getLinkedTicketIds: vi.fn().mockResolvedValue(["12"]),
        buildTicketProviders,
      }),
    );

    const refs = buildTicketProviders.mock.calls[0] as unknown as [{ source: string }[]];
    expect(refs[0]).toHaveLength(1);
    expect(refs[0][0].source).toBe("gitlab");
  });
});

describe("runPrReview convention file", () => {
  it("reads it from the target branch through the provider, without changing the caller's config", async () => {
    const provider = makeProvider({
      getFileContent: vi.fn(async (path: string, ref: string) =>
        path === ".rusty-bot.md" && ref === "main" ? "house rules" : null,
      ),
    });
    const platform = makePlatform(provider);

    await runPrReview(platform);

    expect(mocks.runMultiCallReview.mock.calls[0][1].conventionFile).toBe("house rules");
    expect(platform.config).not.toHaveProperty("conventionFile");
  });
});

describe("runPrReview checkout", () => {
  async function setupRepo(): Promise<{ path: string; headSha: string }> {
    const path = await mkdtemp(join(tmpdir(), "rusty-pipeline-"));
    tempDirs.push(path);
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

  it("uses provider-backed tools and the source branch when there is no workspace", async () => {
    const provider = makeProvider();

    await runPrReview(makePlatform(provider));

    expect(mocks.runMultiCallReview.mock.calls[0][4].checkout).toBeUndefined();
    expect(mocks.runMultiCallReview.mock.calls[0][4].provider).toBeDefined();
    expect(provider.getFileContent).toHaveBeenCalledWith(PATCH.path, "feature/x");
  });

  it("falls back to provider tools when the workspace is not a git repo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rusty-pipeline-empty-"));
    tempDirs.push(dir);

    await runPrReview(makePlatform(makeProvider(), { workspacePath: dir }));

    expect(mocks.runMultiCallReview.mock.calls[0][4].checkout).toBeUndefined();
  });

  it("passes a checkout at the PR head and only reads the target branch through the API", async () => {
    const repo = await setupRepo();
    const provider = makeProvider({
      getPRMetadata: vi.fn().mockResolvedValue({ ...METADATA, headSha: repo.headSha }),
    });

    await runPrReview(makePlatform(provider, { workspacePath: repo.path }));

    const checkout = mocks.runMultiCallReview.mock.calls[0][4].checkout;
    expect(checkout.tree).toBe(repo.headSha);
    expect(checkout.approximate).toBe(false);
    for (const [, ref] of provider.getFileContent.mock.calls) expect(ref).toBe("main");
  });
});

describe("runPrReview opengrep", () => {
  const OPEN_GREP_FINDING = {
    ruleId: "r",
    file: PATCH.path,
    startLine: 1,
    endLine: 1,
    message: "m",
    severity: "error",
  };

  it("feeds findings to triage and the review, and records the stats", async () => {
    mocks.isCascadeEnabled.mockReturnValue(true);
    mocks.runOpenGrep.mockResolvedValue({
      available: true,
      findings: [OPEN_GREP_FINDING],
      rawCount: 1,
    });
    mocks.runTriage.mockResolvedValue({
      files: [{ path: PATCH.path, classification: "deep-review", reason: "r" }],
      modelUsed: "t",
      tokenCount: 5,
    });
    const provider = makeProvider();

    await runPrReview(makePlatform(provider));

    expect(mocks.runTriage).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ path: PATCH.path })]),
      [OPEN_GREP_FINDING],
    );
    expect(mocks.runCascadeReview.mock.calls[0][5].openGrepFindings).toEqual([OPEN_GREP_FINDING]);
  });

  it("warns when the scan fails and still reviews", async () => {
    mocks.runOpenGrep.mockResolvedValue({
      available: false,
      findings: [],
      rawCount: 0,
      error: "scan blew up",
    });

    await expect(runPrReview(makePlatform(makeProvider()))).resolves.toBe(0);

    expect(mocks.logWarn).toHaveBeenCalledWith(
      { error: "scan blew up" },
      expect.stringContaining("opengrep"),
    );
    expect(mocks.runMultiCallReview).toHaveBeenCalled();
  });
});

describe("runPrReview posting", () => {
  it("posts only findings that anchor to the diff, and never line 0", async () => {
    const anchored = finding({ line: 1 });
    mocks.runMultiCallReview.mockResolvedValue(
      review([anchored, finding({ line: 0, message: "file level" }), finding({ line: 999 })]),
    );
    const provider = makeProvider();

    await runPrReview(makePlatform(provider));

    expect(provider.postInlineComments).toHaveBeenCalledWith([anchored]);
  });

  it("does not call postInlineComments when nothing anchors", async () => {
    const provider = makeProvider();

    await runPrReview(makePlatform(provider));

    expect(provider.postInlineComments).not.toHaveBeenCalled();
    expect(provider.postSummaryComment).toHaveBeenCalledTimes(1);
  });

  it("embeds the marker and prior context in the summary", async () => {
    const provider = makeProvider();

    await runPrReview(makePlatform(provider));

    const options = provider.postSummaryComment.mock.calls[0][1];
    expect(options.lastReviewedSha).toBe(HEAD);
    expect(options.priorContext).toBeDefined();
  });
});

describe("runPrReview exit code", () => {
  it("returns 1 only for a critical finding with failOnCritical on", async () => {
    mocks.runMultiCallReview.mockResolvedValue(review([finding({ severity: "critical" })]));
    await expect(runPrReview(makePlatform(makeProvider(), { failOnCritical: true }))).resolves.toBe(
      1,
    );
    await expect(
      runPrReview(makePlatform(makeProvider(), { failOnCritical: false })),
    ).resolves.toBe(0);

    mocks.runMultiCallReview.mockResolvedValue(review([finding({ severity: "warning" })]));
    await expect(runPrReview(makePlatform(makeProvider(), { failOnCritical: true }))).resolves.toBe(
      0,
    );
  });
});

describe("runTriagedReview", () => {
  const base = {
    patches: [PATCH],
    config: { style: "balanced" as const, focusAreas: [], ignorePatterns: [] },
    metadata: METADATA,
    tickets: undefined,
    fetchSourceFile: vi.fn().mockResolvedValue(null),
    options: { sourceRef: "feature/x" },
  };

  it("runs a plain multi-call review when the cascade is off", async () => {
    await runTriagedReview(base);

    expect(mocks.runTriage).not.toHaveBeenCalled();
    expect(mocks.runMultiCallReview).toHaveBeenCalledTimes(1);
  });

  it("falls back to a multi-call review when triage throws", async () => {
    mocks.isCascadeEnabled.mockReturnValue(true);
    mocks.runTriage.mockRejectedValue(new Error("triage down"));

    await runTriagedReview(base);

    expect(mocks.runCascadeReview).not.toHaveBeenCalled();
    expect(mocks.runMultiCallReview).toHaveBeenCalledTimes(1);
  });

  it("splits by triage class, expands only deep files, and records triage stats", async () => {
    mocks.isCascadeEnabled.mockReturnValue(true);
    const skimmed = { ...PATCH, path: "docs/a.md" };
    mocks.runTriage.mockResolvedValue({
      files: [
        { path: PATCH.path, classification: "deep-review", reason: "r" },
        { path: skimmed.path, classification: "skim", reason: "r" },
      ],
      modelUsed: "t",
      tokenCount: 5,
    });
    const fetchSourceFile = vi.fn().mockResolvedValue(null);

    const result = await runTriagedReview({ ...base, patches: [PATCH, skimmed], fetchSourceFile });

    const [skim, deep] = mocks.runCascadeReview.mock.calls[0];
    expect(skim.map((p: FilePatch) => p.path)).toEqual([skimmed.path]);
    expect(deep.map((p: FilePatch) => p.path)).toEqual([PATCH.path]);
    expect(fetchSourceFile).not.toHaveBeenCalledWith(skimmed.path);
    expect(result.triageStats).toEqual({
      filesSkipped: 0,
      filesSkimmed: 1,
      filesDeepReviewed: 1,
      triageModelUsed: "t",
      triageTokenCount: 5,
    });
  });
});

describe("runPrReview risk policy", () => {
  const assessment = {
    scope: "everyone" as const,
    detectability: "silent" as const,
    reversibility: "repair" as const,
    reasons: ["migration"],
    justification: "rewrites a status column for every row",
    level: "high" as const,
  };
  const lowAssessment = {
    ...assessment,
    scope: "one_user" as const,
    detectability: "immediate" as const,
    reversibility: "redeploy" as const,
    level: "low" as const,
  };
  const envPolicy = { enabled: true, labelPrefix: "risk:", requireLabel: true };

  function riskProvider(labels: string[] | Error, files: Record<string, string> = {}) {
    return makeProvider({
      getFileContent: vi.fn().mockImplementation(async (path: string) => files[path] ?? null),
      getLabels:
        labels instanceof Error
          ? vi.fn().mockRejectedValue(labels)
          : vi.fn().mockResolvedValue(labels),
      postStandaloneComment: vi.fn().mockResolvedValue(undefined),
    }) as ReturnType<typeof makeProvider> & {
      getLabels: ReturnType<typeof vi.fn>;
      postStandaloneComment: ReturnType<typeof vi.fn>;
    };
  }

  beforeEach(() => {
    mocks.runMultiCallReview.mockResolvedValue({ ...review(), riskAssessment: assessment });
  });

  it("asks for an assessment and reads the label when the env policy is on", async () => {
    const provider = riskProvider(["risk:high"]);
    await expect(runPrReview(makePlatform(provider, { riskPolicy: envPolicy }))).resolves.toBe(0);
    expect(mocks.runMultiCallReview.mock.calls[0][1].assessRisk).toBe(true);
    expect(provider.postSummaryComment.mock.calls[0][0]).toContain("## Risk: High\n");
    expect(provider.postStandaloneComment).not.toHaveBeenCalled();
  });

  it("does nothing when no policy is configured anywhere", async () => {
    const provider = riskProvider(["risk:low"]);
    await runPrReview(makePlatform(provider));
    expect(mocks.runMultiCallReview.mock.calls[0][1].assessRisk).toBeUndefined();
    expect(provider.getLabels).not.toHaveBeenCalled();
  });

  it("opens a disagreement thread when the bot rates higher, without failing", async () => {
    const provider = riskProvider(["risk:low"]);
    await expect(runPrReview(makePlatform(provider, { riskPolicy: envPolicy }))).resolves.toBe(0);
    expect(provider.postSummaryComment.mock.calls[0][0]).toContain(
      "## Risk: High (author says Low)",
    );
    expect(provider.postStandaloneComment.mock.calls[0][0]).toContain("## Risk label disagreement");
  });

  it("does not argue when the author rates higher than the bot", async () => {
    mocks.runMultiCallReview.mockResolvedValue({ ...review(), riskAssessment: lowAssessment });
    const provider = riskProvider(["risk:high"]);
    await runPrReview(makePlatform(provider, { riskPolicy: envPolicy }));
    expect(provider.postStandaloneComment).not.toHaveBeenCalled();
  });

  it("posts the review, then fails when the label is missing or doubled", async () => {
    const missing = riskProvider(["bug"]);
    await expect(runPrReview(makePlatform(missing, { riskPolicy: envPolicy }))).resolves.toBe(1);
    expect(missing.postSummaryComment).toHaveBeenCalled();
    expect(missing.postStandaloneComment.mock.calls[0][0]).toContain("## Risk label required");

    const doubled = riskProvider(["risk:low", "risk:high"]);
    await expect(runPrReview(makePlatform(doubled, { riskPolicy: envPolicy }))).resolves.toBe(1);
    expect(doubled.postStandaloneComment.mock.calls[0][0]).toContain("more than one risk label");
  });

  it("does not fail when enforcement is off, labels cannot be read, or the platform has none", async () => {
    const lenient = riskProvider([]);
    await expect(
      runPrReview(makePlatform(lenient, { riskPolicy: { ...envPolicy, requireLabel: false } })),
    ).resolves.toBe(0);
    expect(lenient.postStandaloneComment).not.toHaveBeenCalled();

    const broken = riskProvider(new Error("403"));
    await expect(runPrReview(makePlatform(broken, { riskPolicy: envPolicy }))).resolves.toBe(0);

    const noLabels = makeProvider();
    await expect(runPrReview(makePlatform(noLabels, { riskPolicy: envPolicy }))).resolves.toBe(0);
    expect(mocks.runMultiCallReview.mock.calls.at(-1)?.[1].assessRisk).toBe(true);
  });

  it("still enforces the label when the revision was already reviewed", async () => {
    const provider = riskProvider([]);
    provider.getLastReviewedSha.mockResolvedValue(HEAD);
    await expect(runPrReview(makePlatform(provider, { riskPolicy: envPolicy }))).resolves.toBe(1);
    expect(mocks.runMultiCallReview).not.toHaveBeenCalled();
    expect(provider.postStandaloneComment.mock.calls[0][0]).toContain("## Risk label required");
  });

  it("keeps the prior pass's higher level on an incremental re-review", async () => {
    mocks.runMultiCallReview.mockResolvedValue({ ...review(), riskAssessment: lowAssessment });
    const provider = riskProvider(["risk:high"]);
    provider.getLastReviewedSha.mockResolvedValue("old");
    provider.getDiffSinceSha.mockResolvedValue([PATCH]);
    provider.getPriorReviewContext.mockResolvedValue({
      summary: "earlier",
      recommendation: "looks_good",
      findings: [],
      riskAssessment: assessment,
    });
    await runPrReview(makePlatform(provider, { riskPolicy: envPolicy }));
    expect(provider.postSummaryComment.mock.calls[0][0]).toContain("## Risk: High\n");
  });

  describe("from .rusty-bot.json on the target branch", () => {
    it("turns the policy on from the repo file when the platform has none", async () => {
      const provider = riskProvider(["risk:medium"], {
        ".rusty-bot.json": JSON.stringify({
          risk: { reasons: ["ui-only"], promptFile: ".rusty-bot/risk.md" },
        }),
        ".rusty-bot/risk.md": "# our rubric",
      });
      await runPrReview(makePlatform(provider));
      const config = mocks.runMultiCallReview.mock.calls[0][1];
      expect(config).toMatchObject({
        assessRisk: true,
        riskReasons: ["ui-only"],
        riskPrompt: "# our rubric",
      });
      expect(provider.getFileContent).toHaveBeenCalledWith(
        ".rusty-bot.json",
        METADATA.targetBranch,
      );
      expect(provider.getFileContent).toHaveBeenCalledWith(
        ".rusty-bot/risk.md",
        METADATA.targetBranch,
      );
      expect(provider.getLabels).toHaveBeenCalled();
    });

    it("overrides the platform policy in both directions", async () => {
      const off = riskProvider([], {
        ".rusty-bot.json": JSON.stringify({ risk: { enabled: false } }),
      });
      await expect(runPrReview(makePlatform(off, { riskPolicy: envPolicy }))).resolves.toBe(0);
      expect(mocks.runMultiCallReview.mock.calls[0][1].assessRisk).toBe(false);
      expect(off.getLabels).not.toHaveBeenCalled();

      const prefixed = riskProvider(["Risk/low"], {
        ".rusty-bot.json": JSON.stringify({ risk: { labelPrefix: "Risk/" } }),
      });
      await runPrReview(makePlatform(prefixed, { riskPolicy: { ...envPolicy, enabled: false } }));
      expect(prefixed.postSummaryComment.mock.calls[0][0]).toContain(
        "## Risk: High (author says Low)",
      );
      expect(prefixed.postStandaloneComment.mock.calls[0][0]).toContain("`Risk/low`");
    });

    it("fails the run on a malformed repo file or a missing rubric file", async () => {
      const malformed = riskProvider(["risk:low"], {
        ".rusty-bot.json": '{"risk": {"require_label": false}}',
      });
      await expect(runPrReview(makePlatform(malformed))).rejects.toThrow(/invalid repo config/);

      const missingRubric = riskProvider(["risk:low"], {
        ".rusty-bot.json": JSON.stringify({ risk: { promptFile: "missing.md" } }),
      });
      await expect(runPrReview(makePlatform(missingRubric))).rejects.toThrow(
        /promptFile "missing.md" not found/,
      );
      expect(mocks.runMultiCallReview).not.toHaveBeenCalled();
    });
  });
});
