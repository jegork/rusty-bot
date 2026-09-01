import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FilePatch, Finding, ReviewResult } from "../types.js";

const generateMock = vi.fn();

vi.mock("@mastra/core/agent", () => ({
  Agent: vi.fn().mockImplementation(function () {
    return { generate: generateMock };
  }),
}));

const resolveJsonPromptInjectionMock = vi.fn(() => false);

vi.mock("../agent/model.js", () => ({
  resolveModelConfig: vi.fn(() => ({ type: "router", model: "test-model" })),
  resolveModelConfigWithOverride: vi.fn((model: string) => ({ type: "router", model })),
  resolveModel: vi.fn((config: { type: string; model?: string }) =>
    config.type === "router" ? (config.model ?? "test-model") : "test-model",
  ),
  getModelDisplayName: vi.fn((config: { type: string; model?: string }) =>
    config.type === "router" ? (config.model ?? "test-model") : "test-model",
  ),
  resolveModelSettings: vi.fn(() => ({})),
  resolveDefaultAgentOptions: vi.fn(() => undefined),
  resolveJsonPromptInjection: resolveJsonPromptInjectionMock,
  applyModelConstraints: vi.fn((_config, settings) => settings),
}));

const { judgeFindings, judgeReviewResult, resolveJudgeConfig, buildFindingExcerpt } =
  await import("../agent/judge.js");

const PATCHES: FilePatch[] = [
  {
    path: "src/app.ts",
    hunks: [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 5,
        content: [
          '+import { z } from "zod";',
          " const app = express();",
          '+app.get("/health", (req, res) => res.json({ ok: true }));',
          " const port = 3000;",
          " app.listen(port);",
        ].join("\n"),
      },
    ],
    additions: 2,
    deletions: 0,
    isBinary: false,
  },
];

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/app.ts",
    line: 1,
    endLine: null,
    severity: "warning",
    category: "bugs",
    message: "potential null dereference",
    suggestedFix: "",
    ...overrides,
  };
}

function makeReviewResult(findings: Finding[]): ReviewResult {
  return {
    summary: "test review",
    recommendation: "address_before_merge",
    findings,
    observations: [],
    ticketCompliance: [],
    missingTests: [],
    filesReviewed: ["src/app.ts"],
    modelUsed: "test-model",
    tokenCount: 100,
  };
}

describe("resolveJudgeConfig", () => {
  beforeEach(() => {
    delete process.env.RUSTY_JUDGE_ENABLED;
    delete process.env.RUSTY_JUDGE_THRESHOLD;
    delete process.env.RUSTY_JUDGE_MODEL;
  });

  it("defaults to disabled with threshold 6", () => {
    const config = resolveJudgeConfig();
    expect(config.enabled).toBe(false);
    expect(config.threshold).toBe(6);
    expect(config.model).toBeUndefined();
  });

  it("parses RUSTY_JUDGE_ENABLED=true", () => {
    process.env.RUSTY_JUDGE_ENABLED = "true";
    expect(resolveJudgeConfig().enabled).toBe(true);
  });

  it("parses RUSTY_JUDGE_ENABLED=1", () => {
    process.env.RUSTY_JUDGE_ENABLED = "1";
    expect(resolveJudgeConfig().enabled).toBe(true);
  });

  it("parses RUSTY_JUDGE_THRESHOLD", () => {
    process.env.RUSTY_JUDGE_THRESHOLD = "8";
    expect(resolveJudgeConfig().threshold).toBe(8);
  });

  it("parses RUSTY_JUDGE_MODEL", () => {
    process.env.RUSTY_JUDGE_MODEL = "anthropic/claude-haiku";
    expect(resolveJudgeConfig().model).toBe("anthropic/claude-haiku");
  });

  it("falls back to default threshold on non-numeric value", () => {
    process.env.RUSTY_JUDGE_THRESHOLD = "abc";
    expect(resolveJudgeConfig().threshold).toBe(6);
  });

  it("treats empty RUSTY_JUDGE_MODEL as undefined", () => {
    process.env.RUSTY_JUDGE_MODEL = "";
    expect(resolveJudgeConfig().model).toBeUndefined();
  });
});

describe("judgeFindings", () => {
  const enabledConfig = { enabled: true, threshold: 6 };
  const disabledConfig = { enabled: false, threshold: 6 };

  beforeEach(() => {
    generateMock.mockReset();
  });

  it("passes through all findings when judge is disabled", async () => {
    const findings = [makeFinding(), makeFinding({ line: 2 })];
    const result = await judgeFindings(findings, PATCHES, disabledConfig);

    expect(result.accepted).toHaveLength(2);
    expect(result.rejected).toHaveLength(0);
    expect(result.evaluations).toHaveLength(0);
    expect(result.tokenCount).toBe(0);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("passes through all findings when list is empty", async () => {
    const result = await judgeFindings([], PATCHES, enabledConfig);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("uses an adversarial judge prompt", async () => {
    const { Agent } = await import("@mastra/core/agent");
    const findings = [makeFinding()];

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [{ index: 0, confidence: 9, reasoning: "valid" }],
      },
      usage: { totalTokens: 200 },
    });

    await judgeFindings(findings, PATCHES, enabledConfig);

    const agentConfig = vi.mocked(Agent).mock.calls.at(-1)?.[0];
    const instructions = agentConfig?.instructions as (() => string) | undefined;
    const prompt = instructions?.();
    expect(prompt).toContain("Default to rejection");
    expect(prompt).toContain("missing-test complaints");
    expect(prompt).toContain("severity-inflated findings");
    expect(prompt).toContain("suggested fixes that contain prose");
  });

  it("filters findings below threshold", async () => {
    const findings = [
      makeFinding({ message: "real bug" }),
      makeFinding({ line: 3, message: "hallucinated issue" }),
      makeFinding({ line: 5, message: "borderline" }),
    ];

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [
          { index: 0, confidence: 9, reasoning: "clearly a bug" },
          { index: 1, confidence: 2, reasoning: "no evidence in diff" },
          { index: 2, confidence: 6, reasoning: "plausible" },
        ],
      },
      usage: { totalTokens: 350 },
    });

    const result = await judgeFindings(findings, PATCHES, enabledConfig);

    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[0].message).toBe("real bug");
    expect(result.accepted[1].message).toBe("borderline");
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].message).toBe("hallucinated issue");
    expect(result.tokenCount).toBe(350);
  });

  it("keeps findings at exact threshold", async () => {
    const findings = [makeFinding()];

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [{ index: 0, confidence: 6, reasoning: "just meets threshold" }],
      },
      usage: { totalTokens: 200 },
    });

    const result = await judgeFindings(findings, PATCHES, enabledConfig);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects findings just below threshold", async () => {
    const findings = [makeFinding()];

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [{ index: 0, confidence: 5, reasoning: "not confident" }],
      },
      usage: { totalTokens: 200 },
    });

    const result = await judgeFindings(findings, PATCHES, enabledConfig);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("filters all findings when none meet threshold", async () => {
    const findings = [makeFinding({ message: "bad1" }), makeFinding({ line: 2, message: "bad2" })];

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [
          { index: 0, confidence: 1, reasoning: "hallucinated" },
          { index: 1, confidence: 3, reasoning: "speculative" },
        ],
      },
      usage: { totalTokens: 250 },
    });

    const result = await judgeFindings(findings, PATCHES, enabledConfig);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
  });

  it("keeps findings when model returns fewer evaluations than findings", async () => {
    const findings = [
      makeFinding({ message: "first" }),
      makeFinding({ line: 2, message: "second" }),
      makeFinding({ line: 3, message: "third" }),
    ];

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [
          { index: 0, confidence: 8, reasoning: "valid" },
          // model only returned 1 evaluation for 3 findings
        ],
      },
      usage: { totalTokens: 150 },
    });

    const result = await judgeFindings(findings, PATCHES, enabledConfig);
    // first finding passes, remaining two have no evaluation → kept (safe default)
    expect(result.accepted).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
  });

  it("keeps all findings when judge call throws", async () => {
    const findings = [makeFinding()];

    generateMock.mockRejectedValueOnce(new Error("API rate limit"));

    const result = await judgeFindings(findings, PATCHES, enabledConfig);
    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
    expect(result.evaluations).toHaveLength(0);
    expect(result.tokenCount).toBe(0);
  });

  it("respects custom threshold", async () => {
    const findings = [makeFinding()];

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [{ index: 0, confidence: 7, reasoning: "decent" }],
      },
      usage: { totalTokens: 200 },
    });

    const strictConfig = { enabled: true, threshold: 8 };
    const result = await judgeFindings(findings, PATCHES, strictConfig);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("respects custom model override", async () => {
    const { Agent } = await import("@mastra/core/agent");
    const findings = [makeFinding()];

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [{ index: 0, confidence: 9, reasoning: "valid" }],
      },
      usage: { totalTokens: 200 },
    });

    await judgeFindings(findings, PATCHES, {
      enabled: true,
      threshold: 6,
      model: "anthropic/claude-haiku",
    });

    const agentConfig = vi.mocked(Agent).mock.calls.at(-1)?.[0];
    expect(agentConfig?.model).toEqual(expect.any(Function));
    const resolveAgentModel = agentConfig?.model as (() => unknown) | undefined;
    expect(resolveAgentModel?.()).toBe("anthropic/claude-haiku");
  });

  it("routes override model through provider resolution (azure-openai prefix)", async () => {
    const modelModule = await import("../agent/model.js");
    const resolveWithOverrideSpy = vi.mocked(modelModule.resolveModelConfigWithOverride);
    resolveWithOverrideSpy.mockClear();

    const findings = [makeFinding()];

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [{ index: 0, confidence: 9, reasoning: "valid" }],
      },
      usage: { totalTokens: 200 },
    });

    await judgeFindings(findings, PATCHES, {
      enabled: true,
      threshold: 6,
      model: "azure-openai/gpt-5.4-mini",
    });

    // override must flow through the provider resolution helper, otherwise
    // azure-openai/ strings get handed to the mastra router and fail with
    // "Could not find config for provider azure-openai"
    expect(resolveWithOverrideSpy).toHaveBeenCalledWith("azure-openai/gpt-5.4-mini");
  });
});

describe("judgeReviewResult", () => {
  beforeEach(() => {
    generateMock.mockReset();
  });

  it("passes through unchanged when judge is disabled", async () => {
    const review = makeReviewResult([makeFinding()]);
    const result = await judgeReviewResult(review, PATCHES, { enabled: false, threshold: 6 });

    expect(result.findings).toHaveLength(1);
    expect(result.filteredCount).toBeUndefined();
    expect(result.judgeTokenCount).toBeUndefined();
  });

  it("updates filteredCount on the result", async () => {
    const findings = [
      makeFinding({ message: "keep", severity: "critical" }),
      makeFinding({ line: 2, message: "drop" }),
    ];
    const review = makeReviewResult(findings);

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [
          { index: 0, confidence: 9, reasoning: "real" },
          { index: 1, confidence: 2, reasoning: "fake" },
        ],
      },
      usage: { totalTokens: 300 },
    });

    const result = await judgeReviewResult(review, PATCHES, { enabled: true, threshold: 6 });
    expect(result.findings).toHaveLength(1);
    expect(result.filteredCount).toBe(1);
    expect(result.judgeTokenCount).toBe(300);
  });

  it("recalculates recommendation to looks_good when all findings filtered", async () => {
    const review = makeReviewResult([makeFinding({ severity: "critical" })]);

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [{ index: 0, confidence: 1, reasoning: "hallucinated" }],
      },
      usage: { totalTokens: 200 },
    });

    const result = await judgeReviewResult(review, PATCHES, { enabled: true, threshold: 6 });
    expect(result.findings).toHaveLength(0);
    expect(result.recommendation).toBe("looks_good");
  });

  it("downgrades recommendation from critical_issues when critical finding is filtered", async () => {
    const findings = [
      makeFinding({ severity: "critical", message: "false alarm" }),
      makeFinding({ line: 2, severity: "warning", message: "real warning" }),
    ];
    const review = makeReviewResult(findings);

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [
          { index: 0, confidence: 3, reasoning: "no evidence" },
          { index: 1, confidence: 8, reasoning: "confirmed" },
        ],
      },
      usage: { totalTokens: 280 },
    });

    const result = await judgeReviewResult(review, PATCHES, { enabled: true, threshold: 6 });
    expect(result.recommendation).toBe("address_before_merge");
    expect(result.filteredCount).toBe(1);
  });

  it("preserves elevated recommendation from consensus when no findings exist", async () => {
    const review: ReviewResult = {
      ...makeReviewResult([]),
      recommendation: "address_before_merge",
      consensusMetadata: {
        passes: 3,
        threshold: 2,

        effectiveThreshold: 2,

        degraded: false,
        agreementRate: 1,
        recommendationElevated: true,
        passRecommendations: [
          "address_before_merge",
          "address_before_merge",
          "address_before_merge",
        ],
        failedPasses: 0,
      },
    };

    const result = await judgeReviewResult(review, PATCHES, { enabled: true, threshold: 6 });
    expect(result.findings).toHaveLength(0);
    expect(result.recommendation).toBe("address_before_merge");
  });

  it("does not preserve recommendation when not elevated by consensus", async () => {
    const review: ReviewResult = {
      ...makeReviewResult([makeFinding({ severity: "warning" })]),
      recommendation: "address_before_merge",
      consensusMetadata: {
        passes: 3,
        threshold: 2,
        effectiveThreshold: 2,
        degraded: false,
        agreementRate: 1,
        recommendationElevated: false,
        passRecommendations: [
          "address_before_merge",
          "address_before_merge",
          "address_before_merge",
        ],
        failedPasses: 0,
      },
    };

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [{ index: 0, confidence: 2, reasoning: "false positive" }],
      },
      usage: { totalTokens: 200 },
    });

    const result = await judgeReviewResult(review, PATCHES, { enabled: true, threshold: 6 });
    expect(result.findings).toHaveLength(0);
    expect(result.recommendation).toBe("looks_good");
  });

  it("preserves observations, filesReviewed, and other metadata", async () => {
    const review: ReviewResult = {
      ...makeReviewResult([makeFinding()]),
      observations: [
        { file: "b.ts", line: 10, severity: "suggestion", category: "style", message: "naming" },
      ],
      filesReviewed: ["src/app.ts", "src/b.ts"],
      modelUsed: "claude-sonnet",
      tokenCount: 500,
    };

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [{ index: 0, confidence: 9, reasoning: "valid" }],
      },
      usage: { totalTokens: 200 },
    });

    const result = await judgeReviewResult(review, PATCHES, { enabled: true, threshold: 6 });
    expect(result.observations).toHaveLength(1);
    expect(result.filesReviewed).toEqual(["src/app.ts", "src/b.ts"]);
    expect(result.modelUsed).toBe("claude-sonnet");
    expect(result.tokenCount).toBe(500);
    expect(result.judgeTokenCount).toBe(200);
    expect(result.summary).toBe("test review");
  });

  it("keeps an elevated critical_issues recommendation when only a warning survives judging", async () => {
    const review: ReviewResult = {
      ...makeReviewResult([makeFinding({ severity: "warning", message: "surviving warning" })]),
      recommendation: "critical_issues",
      consensusMetadata: {
        passes: 3,
        threshold: 2,
        effectiveThreshold: 2,
        degraded: false,
        agreementRate: 1,
        recommendationElevated: true,
        passRecommendations: ["critical_issues", "critical_issues", "address_before_merge"],
        failedPasses: 0,
      },
    };

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [{ index: 0, confidence: 9, reasoning: "real" }],
      },
      usage: { totalTokens: 200 },
    });

    const result = await judgeReviewResult(review, PATCHES, { enabled: true, threshold: 6 });
    expect(result.findings).toHaveLength(1);
    expect(result.recommendation).toBe("critical_issues");
  });

  it("derives looks_good when only a suggestion survives judging and nothing is elevated", async () => {
    const review = makeReviewResult([
      makeFinding({ severity: "suggestion", message: "style nit" }),
    ]);

    generateMock.mockResolvedValueOnce({
      object: {
        evaluations: [{ index: 0, confidence: 9, reasoning: "valid but a nit" }],
      },
      usage: { totalTokens: 200 },
    });

    const result = await judgeReviewResult(review, PATCHES, { enabled: true, threshold: 6 });
    expect(result.findings).toHaveLength(1);
    expect(result.recommendation).toBe("looks_good");
  });

  it("passes droppedFindings through unchanged when judge runs", async () => {
    const review: ReviewResult = {
      ...makeReviewResult([makeFinding()]),
      droppedFindings: [
        { file: "x.ts", line: 1, severity: "warning", message: "dropped 1", voteCount: 1 },
        { file: "y.ts", line: 2, severity: "critical", message: "dropped 2", voteCount: 1 },
      ],
    };

    generateMock.mockResolvedValueOnce({
      object: { evaluations: [{ index: 0, confidence: 9, reasoning: "valid" }] },
      usage: { totalTokens: 50 },
    });

    const result = await judgeReviewResult(review, PATCHES, { enabled: true, threshold: 6 });
    expect(result.droppedFindings).toEqual(review.droppedFindings);
  });
});

describe("judgeFindings jsonPromptInjection forwarding", () => {
  beforeEach(() => {
    generateMock.mockReset();
    resolveJsonPromptInjectionMock.mockReset();
  });

  it("forwards jsonPromptInjection=true into structuredOutput when resolver returns true", async () => {
    resolveJsonPromptInjectionMock.mockReturnValueOnce(true);
    generateMock.mockResolvedValueOnce({
      object: { evaluations: [{ index: 0, confidence: 9, reasoning: "ok" }] },
      usage: { totalTokens: 25 },
    });

    await judgeFindings([makeFinding()], PATCHES, { enabled: true, threshold: 6 });

    const callArgs = generateMock.mock.calls[0][1];
    expect(callArgs.structuredOutput.jsonPromptInjection).toBe(true);
  });

  it("forwards jsonPromptInjection=false into structuredOutput when resolver returns false", async () => {
    resolveJsonPromptInjectionMock.mockReturnValueOnce(false);
    generateMock.mockResolvedValueOnce({
      object: { evaluations: [{ index: 0, confidence: 9, reasoning: "ok" }] },
      usage: { totalTokens: 25 },
    });

    await judgeFindings([makeFinding()], PATCHES, { enabled: true, threshold: 6 });

    const callArgs = generateMock.mock.calls[0][1];
    expect(callArgs.structuredOutput.jsonPromptInjection).toBe(false);
  });
});

describe("buildFindingExcerpt", () => {
  const TWO_HUNK_PATCH: FilePatch = {
    path: "src/multi.ts",
    hunks: [
      {
        oldStart: 10,
        oldLines: 3,
        newStart: 10,
        newLines: 3,
        content: ["+near top change", " context line", " more context"].join("\n"),
      },
      {
        oldStart: 50,
        oldLines: 4,
        newStart: 52,
        newLines: 5,
        content: [" before", "-removed mid", "+replacement", "+inserted", " after"].join("\n"),
      },
    ],
    additions: 3,
    deletions: 1,
    isBinary: false,
  };

  it("emits the file header plus the hunk that contains the finding line", () => {
    const finding = makeFinding({ file: "src/app.ts", line: 1 });
    const excerpt = buildFindingExcerpt(PATCHES, finding);

    expect(excerpt.startsWith("## src/app.ts")).toBe(true);
    expect(excerpt).toContain("__new hunk__");
    expect(excerpt).toContain('1 +import { z } from "zod";');
    // pure-add hunk (PATCHES has 2 additions, 0 deletions) — old block must be omitted
    expect(excerpt).not.toContain("__old hunk__");
  });

  it("returns the not-found sentinel when the file isn't in the patches", () => {
    const finding = makeFinding({ file: "src/missing.ts", line: 1 });
    const excerpt = buildFindingExcerpt(PATCHES, finding);

    expect(excerpt).toContain("[no matching hunk");
    expect(excerpt).not.toContain("## src/");
  });

  it("returns the not-found sentinel when the line is outside every hunk", () => {
    const finding = makeFinding({ file: "src/app.ts", line: 999 });
    const excerpt = buildFindingExcerpt(PATCHES, finding);

    expect(excerpt).toContain("[no matching hunk");
  });

  it("picks the second hunk when the finding lands inside it", () => {
    const finding = makeFinding({ file: "src/multi.ts", line: 53 });
    const excerpt = buildFindingExcerpt([TWO_HUNK_PATCH], finding);

    expect(excerpt).toContain("## src/multi.ts");
    expect(excerpt).toContain("53 +replacement");
    expect(excerpt).not.toContain("near top change");
  });

  it("includes both hunks when the finding range spans them", () => {
    const finding = makeFinding({ file: "src/multi.ts", line: 11, endLine: 53 });
    const excerpt = buildFindingExcerpt([TWO_HUNK_PATCH], finding);

    expect(excerpt).toContain("near top change");
    expect(excerpt).toContain("53 +replacement");
  });

  it("renders both old and new hunks for diffs with removals", () => {
    const finding = makeFinding({ file: "src/multi.ts", line: 53 });
    const excerpt = buildFindingExcerpt([TWO_HUNK_PATCH], finding);

    expect(excerpt).toContain("__old hunk__");
    expect(excerpt).toContain("__new hunk__");
    expect(excerpt).toContain("-removed mid");
  });

  it("emits each context line exactly once across both hunk blocks", () => {
    // mixed hunk: context + addition + removal — context must appear once total
    const patches: FilePatch[] = [
      {
        path: "src/mixed.ts",
        additions: 1,
        deletions: 1,
        isBinary: false,
        hunks: [
          {
            oldStart: 10,
            oldLines: 4,
            newStart: 10,
            newLines: 4,
            content: [
              " unchanged-before-MARKER",
              "-removed-line",
              "+added-line",
              " unchanged-after-MARKER",
            ].join("\n"),
          },
        ],
      },
    ];
    const finding = makeFinding({ file: "src/mixed.ts", line: 10 });
    const excerpt = buildFindingExcerpt(patches, finding);
    const lines = excerpt.split("\n");
    expect(lines.filter((l) => l.includes("unchanged-before-MARKER"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("unchanged-after-MARKER"))).toHaveLength(1);
    expect(excerpt).toContain("__new hunk__");
    expect(excerpt).toContain("__old hunk__");
  });

  it("renders removed lines with old-side line numbers in __old hunk__", () => {
    const patches: FilePatch[] = [
      {
        path: "src/removal.ts",
        additions: 0,
        deletions: 2,
        isBinary: false,
        hunks: [
          {
            oldStart: 50,
            oldLines: 3,
            newStart: 50,
            newLines: 1,
            content: ["-gone-1", "-gone-2", " surviving-line"].join("\n"),
          },
        ],
      },
    ];
    const finding = makeFinding({ file: "src/removal.ts", line: 50 });
    const excerpt = buildFindingExcerpt(patches, finding);
    // removed lines use old-side line numbers (50 + offset)
    expect(excerpt).toContain("50 -gone-1");
    expect(excerpt).toContain("51 -gone-2");
    // the surviving context line goes to the new block with its new-side number
    expect(excerpt).toContain("50  surviving-line");
    // both blocks present
    expect(excerpt).toContain("__old hunk__");
    expect(excerpt).toContain("__new hunk__");
  });

  it("places sibling-signature annotations on the new side only", () => {
    const patches: FilePatch[] = [
      {
        path: "src/sig.ts",
        additions: 1,
        deletions: 0,
        isBinary: false,
        hunks: [
          {
            oldStart: 5,
            oldLines: 1,
            newStart: 5,
            newLines: 2,
            content: ["~ // ... function outer() {", " context-line", "+added"].join("\n"),
          },
        ],
      },
    ];
    const finding = makeFinding({ file: "src/sig.ts", line: 5 });
    const excerpt = buildFindingExcerpt(patches, finding);
    expect(excerpt.match(/~ \/\/ \.\.\. function outer/g)).toHaveLength(1);
    // pure-add hunk → no __old hunk__ block at all
    expect(excerpt).not.toContain("__old hunk__");
  });
});

describe("judge formatter", () => {
  it("inlines a per-finding excerpt and does not dump the full repo diff", async () => {
    generateMock.mockReset();
    generateMock.mockResolvedValueOnce({
      object: { evaluations: [{ index: 0, confidence: 9, reasoning: "ok" }] },
      usage: { totalTokens: 30 },
    });

    const finding = makeFinding({ file: "src/app.ts", line: 1 });
    await judgeFindings([finding], PATCHES, { enabled: true, threshold: 6 });

    const userMessage = generateMock.mock.calls[0][0] as string;
    expect(userMessage).toContain("## Findings to evaluate");
    expect(userMessage).toContain("### Finding 0");
    expect(userMessage).toContain("- **Diff context:**");
    expect(userMessage).toContain("## src/app.ts");
    expect(userMessage).not.toContain("## Diff under review");
  });

  it("uses the not-found sentinel for findings whose file isn't in the patches", async () => {
    generateMock.mockReset();
    generateMock.mockResolvedValueOnce({
      object: { evaluations: [{ index: 0, confidence: 4, reasoning: "no evidence" }] },
      usage: { totalTokens: 30 },
    });

    const finding = makeFinding({ file: "ghost.ts", line: 12 });
    await judgeFindings([finding], PATCHES, { enabled: true, threshold: 6 });

    const userMessage = generateMock.mock.calls[0][0] as string;
    expect(userMessage).toContain("[no matching hunk");
  });
});
