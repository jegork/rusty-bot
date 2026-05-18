import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReviewResult, Finding, ReviewConfig, PRMetadata } from "../types.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/index.ts",
    line: 10,
    endLine: null,
    severity: "warning",
    category: "bugs",
    message: "potential null reference in handler function",
    suggestedFix: null,
    ...overrides,
  };
}

function makeResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: "Looks fine",
    recommendation: "looks_good",
    findings: [],
    observations: [],
    ticketCompliance: [],
    missingTests: [],
    filesReviewed: ["src/index.ts"],
    modelUsed: "test-model",
    tokenCount: 100,
    ...overrides,
  };
}

const sharedFinding = makeFinding();
const uniqueFinding = makeFinding({
  file: "src/other.ts",
  line: 99,
  message: "completely different issue in another file about performance",
});

let callCount = 0;
let mockBehavior: "default" | "no-findings-but-flagged" = "default";

vi.mock("../agent/review.js", () => ({
  runReview: vi.fn(async () => {
    const idx = callCount++;

    if (mockBehavior === "no-findings-but-flagged") {
      return makeResult({
        recommendation: "address_before_merge",
        summary: "resource cleanup issue should be fixed before merge",
        findings: [],
      });
    }

    if (idx % 3 === 2) {
      return makeResult({ findings: [uniqueFinding], tokenCount: 100 });
    }
    return makeResult({ findings: [sharedFinding], tokenCount: 100 });
  }),
}));

const { runConsensusReview } = await import("../agent/consensus.js");

const prMetadata: PRMetadata = {
  id: "42",
  title: "test PR",
  description: "",
  author: "dev",
  sourceBranch: "feat/test",
  targetBranch: "main",
  url: "https://example.com/pr/42",
};

const config: ReviewConfig = {
  style: "balanced",
  focusAreas: [],
  ignorePatterns: [],
};

describe("runConsensusReview", () => {
  beforeEach(() => {
    callCount = 0;
    mockBehavior = "default";
    delete process.env.RUSTY_REVIEW_MODELS;
    delete process.env.RUSTY_REVIEW_TEMPERATURES;
    delete process.env.RUSTY_REVIEW_TOP_PS;
    delete process.env.RUSTY_REVIEW_ADAPTIVE_PASSES;
    process.env.RUSTY_REVIEW_ADAPTIVE_PASSES = "false";
    delete process.env.RUSTY_LLM_MODEL;
    vi.clearAllMocks();
  });

  it("passes through to runReview when consensusPasses=1", async () => {
    const singlePassConfig = { ...config, consensusPasses: 1 };
    const result = await runConsensusReview([], singlePassConfig, prMetadata, "diff content");
    const { runReview } = await import("../agent/review.js");
    expect(runReview).toHaveBeenCalledTimes(1);
    expect(result.consensusMetadata).toBeUndefined();
  });

  it("uses RUSTY_REVIEW_MODELS[0] / RUSTY_REVIEW_TEMPERATURES[0] on the single-pass path", async () => {
    process.env.RUSTY_REVIEW_MODELS = "anthropic/single-pass-model,requesty/moonshot/kimi-k2.5";
    process.env.RUSTY_REVIEW_TEMPERATURES = "0.2,1";
    process.env.RUSTY_LLM_MODEL = "requesty/moonshot/kimi-k2.5";

    const singlePassConfig = { ...config, consensusPasses: 1 };
    await runConsensusReview([], singlePassConfig, prMetadata, "diff content");
    const { runReview } = await import("../agent/review.js");
    const calls = (runReview as ReturnType<typeof vi.fn>).mock.calls;

    expect(calls[0][4]?.modelConfig).toEqual({
      type: "router",
      model: "anthropic/single-pass-model",
    });
    expect(calls[0][4]?.modelSettings).toEqual({ temperature: 0.2 });
  });

  it("runs N passes and filters by majority vote", async () => {
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    const { runReview } = await import("../agent/review.js");
    expect(runReview).toHaveBeenCalledTimes(3);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe("src/index.ts");
    expect(result.findings[0].voteCount).toBe(2);
  });

  it("drops findings below custom threshold", async () => {
    const strictConfig = { ...config, consensusPasses: 3, consensusThreshold: 3 };
    const result = await runConsensusReview([], strictConfig, prMetadata, "diff content");
    expect(result.findings).toHaveLength(0);
  });

  it("includes consensus metadata with agreement rate and pass recommendations", async () => {
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.consensusMetadata).toMatchObject({
      passes: 3,
      threshold: 2,
      recommendationElevated: false,
    });
    expect(result.consensusMetadata?.agreementRate).toBeGreaterThanOrEqual(0);
    expect(result.consensusMetadata?.agreementRate).toBeLessThanOrEqual(1);
    expect(result.consensusMetadata?.passRecommendations).toHaveLength(3);
  });

  it("derives recommendation from filtered findings only", async () => {
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.recommendation).toBe("address_before_merge");
  });

  it("aggregates token counts from all passes", async () => {
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.tokenCount).toBe(300);
  });

  it("defaults to 3 passes when adaptive pass planning is disabled", async () => {
    process.env.RUSTY_REVIEW_ADAPTIVE_PASSES = "false";

    const result = await runConsensusReview([], config, prMetadata, "diff content");
    const { runReview } = await import("../agent/review.js");
    expect(runReview).toHaveBeenCalledTimes(3);
    expect(result.consensusMetadata?.passes).toBe(3);
  });

  it("defaults to 2 passes with small patches when adaptive is on (default)", async () => {
    delete process.env.RUSTY_REVIEW_ADAPTIVE_PASSES;

    const result = await runConsensusReview([], config, prMetadata, "diff content");
    const { runReview } = await import("../agent/review.js");
    expect(runReview).toHaveBeenCalledTimes(2);
    expect(result.consensusMetadata?.passes).toBe(2);
    expect(result.consensusMetadata?.passPlanReason).toBe("ordinary deep-review chunk");
  });

  it("passes per-pass model configs and settings to each review pass", async () => {
    process.env.RUSTY_LLM_MODEL = "anthropic/default";
    process.env.RUSTY_REVIEW_MODELS = "anthropic/pass-1,openai/pass-2";
    process.env.RUSTY_REVIEW_TEMPERATURES = "0.1,0.2";

    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    const { runReview } = await import("../agent/review.js");
    const calls = (runReview as ReturnType<typeof vi.fn>).mock.calls;

    expect(calls[0][4]?.modelConfig).toEqual({ type: "router", model: "anthropic/pass-1" });
    expect(calls[0][4]?.modelSettings).toEqual({ temperature: 0.1 });
    expect(calls[1][4]?.modelConfig).toEqual({ type: "router", model: "openai/pass-2" });
    expect(calls[1][4]?.modelSettings).toEqual({ temperature: 0.2 });
    expect(calls[2][4]?.modelConfig).toEqual({ type: "router", model: "anthropic/default" });
    expect(result.consensusMetadata?.passModels).toEqual([
      "anthropic/pass-1",
      "openai/pass-2",
      "anthropic/default",
    ]);
  });

  it("reduces ordinary deep-review chunks to two passes by default (adaptive pass planning)", async () => {
    delete process.env.RUSTY_REVIEW_ADAPTIVE_PASSES;

    const patches = [
      {
        path: "src/service.ts",
        additions: 20,
        deletions: 5,
        isBinary: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: "+x" }],
      },
    ];
    const result = await runConsensusReview(patches, config, prMetadata, "diff content");
    const { runReview } = await import("../agent/review.js");

    expect(runReview).toHaveBeenCalledTimes(2);
    expect(result.consensusMetadata?.passes).toBe(2);
    expect(result.consensusMetadata?.threshold).toBe(2);
    expect(result.consensusMetadata?.passPlanReason).toBe("ordinary deep-review chunk");
  });

  it("uses strict majority as the default threshold for two-pass consensus", async () => {
    const consensusConfig = { ...config, consensusPasses: 2 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");

    expect(result.consensusMetadata?.threshold).toBe(2);
  });

  it("keeps three adaptive passes for security-sensitive chunks", async () => {
    delete process.env.RUSTY_REVIEW_ADAPTIVE_PASSES;

    const patches = [
      {
        path: "src/auth/session.ts",
        additions: 20,
        deletions: 5,
        isBinary: false,
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: "+x" }],
      },
    ];
    const result = await runConsensusReview(patches, config, prMetadata, "diff content");
    const { runReview } = await import("../agent/review.js");

    expect(runReview).toHaveBeenCalledTimes(3);
    expect(result.consensusMetadata?.passes).toBe(3);
    expect(result.consensusMetadata?.passPlanReason).toBe("security-sensitive file");
  });

  it("populates droppedFindings for clusters below threshold", async () => {
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    // uniqueFinding only appears in 1/3 passes → dropped
    expect(result.droppedFindings).toBeDefined();
    expect(result.droppedFindings).toHaveLength(1);
    expect(result.droppedFindings![0].file).toBe("src/other.ts");
    expect(result.droppedFindings![0].voteCount).toBe(1);
  });

  it("omits droppedFindings when all clusters meet threshold", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }));
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.droppedFindings).toBeUndefined();
  });

  it("produces numbered summaries for multi-pass reviews", async () => {
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.summary).toContain("1. ");
    expect(result.summary).toContain("2. ");
    expect(result.summary).toContain("3. ");
    expect(result.summary).toMatch(/^Consensus review \(3 passes, threshold 2\)\./);
  });

  it("sets recommendationElevated when recommendation comes from pass votes not findings", async () => {
    mockBehavior = "no-findings-but-flagged";
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.consensusMetadata?.recommendationElevated).toBe(true);
  });

  it("sets recommendationElevated=false when recommendation is derived from findings", async () => {
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.consensusMetadata?.recommendationElevated).toBe(false);
  });

  it("agreement rate is 1 when all clusters survive", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }));
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.consensusMetadata?.agreementRate).toBe(1);
  });

  it("agreement rate is 0 when no clusters survive strict threshold", async () => {
    const strictConfig = { ...config, consensusPasses: 3, consensusThreshold: 3 };
    const result = await runConsensusReview([], strictConfig, prMetadata, "diff content");
    expect(result.consensusMetadata?.agreementRate).toBe(0);
  });

  it("agreement rate is 1 when there are zero finding clusters", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [], tokenCount: 100 }))
      .mockResolvedValueOnce(makeResult({ findings: [], tokenCount: 100 }))
      .mockResolvedValueOnce(makeResult({ findings: [], tokenCount: 100 }));
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.consensusMetadata?.agreementRate).toBe(1);
  });

  it("uses per-pass recommendations when findings are empty but majority flags issues", async () => {
    mockBehavior = "no-findings-but-flagged";
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.findings).toHaveLength(0);
    // 3/3 passes said "address_before_merge" → recommendation should reflect that
    expect(result.recommendation).toBe("address_before_merge");
  });

  it("keeps looks_good when minority of passes flag issues", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ recommendation: "address_before_merge", findings: [] }))
      .mockResolvedValueOnce(makeResult({ recommendation: "looks_good", findings: [] }))
      .mockResolvedValueOnce(makeResult({ recommendation: "looks_good", findings: [] }));
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    // 1/3 passes flagged → below threshold=2 → looks_good
    expect(result.recommendation).toBe("looks_good");
  });

  it("elevates to critical_issues when majority of passes flag critical", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ recommendation: "critical_issues", findings: [] }))
      .mockResolvedValueOnce(makeResult({ recommendation: "critical_issues", findings: [] }))
      .mockResolvedValueOnce(makeResult({ recommendation: "looks_good", findings: [] }));
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.recommendation).toBe("critical_issues");
  });

  it("downgrades to address_before_merge when critical is minority but issues are majority", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ recommendation: "critical_issues", findings: [] }))
      .mockResolvedValueOnce(makeResult({ recommendation: "address_before_merge", findings: [] }))
      .mockResolvedValueOnce(makeResult({ recommendation: "looks_good", findings: [] }));
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    // 2/3 flag issues (meets threshold) but only 1/3 flag critical (below threshold)
    expect(result.recommendation).toBe("address_before_merge");
  });
});

describe("runConsensusReview failure tolerance", () => {
  beforeEach(() => {
    callCount = 0;
    mockBehavior = "default";
    process.env.RUSTY_REVIEW_ADAPTIVE_PASSES = "false";
    vi.clearAllMocks();
  });

  it("tolerates one failed pass when the remaining successes still meet the threshold", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
      .mockRejectedValueOnce(new Error("structured output failed"))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }));

    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");

    // 2 successful passes, threshold=2 ⇒ finding with 2 votes still survives
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].voteCount).toBe(2);
    expect(result.consensusMetadata?.failedPasses).toBe(1);
    expect(result.consensusMetadata?.passRecommendations).toHaveLength(2);
  });

  it("degrades gracefully when only one pass survives and below threshold (1/3)", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
      .mockRejectedValueOnce(new Error("structured output failed (pass 2)"))
      .mockRejectedValueOnce(new Error("structured output failed (pass 3)"));

    const consensusConfig = { ...config, consensusPasses: 3 };

    // 1 successful pass, configured threshold=2 ⇒ effective threshold drops to 1,
    // surviving pass's single-vote findings pass through clustering. judge would
    // filter downstream, but consensus itself no longer aborts.
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].voteCount).toBe(1);
    expect(result.consensusMetadata?.degraded).toBe(true);
    expect(result.consensusMetadata?.threshold).toBe(2);
    expect(result.consensusMetadata?.effectiveThreshold).toBe(1);
    expect(result.consensusMetadata?.failedPasses).toBe(2);
  });

  it("degrades gracefully on 1/2 (the production failure mode this PR addresses)", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
      .mockRejectedValueOnce(
        new Error("structured output parser returned no object (model likely emitted text…)"),
      );

    const consensusConfig = { ...config, consensusPasses: 2 };

    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");

    expect(result.findings).toHaveLength(1);
    expect(result.consensusMetadata?.degraded).toBe(true);
    expect(result.consensusMetadata?.threshold).toBe(2);
    expect(result.consensusMetadata?.effectiveThreshold).toBe(1);
    expect(result.consensusMetadata?.failedPasses).toBe(1);
  });

  it("does NOT mark a 2/3 run as degraded when it still meets threshold", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
      .mockRejectedValueOnce(new Error("structured output failed"))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }));

    const consensusConfig = { ...config, consensusPasses: 3 };

    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");

    expect(result.consensusMetadata?.degraded).toBe(false);
    expect(result.consensusMetadata?.threshold).toBe(2);
    expect(result.consensusMetadata?.effectiveThreshold).toBe(2);
  });

  it("throws when every pass fails", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("fail 1"))
      .mockRejectedValueOnce(new Error("fail 2"))
      .mockRejectedValueOnce(new Error("fail 3"));

    const consensusConfig = { ...config, consensusPasses: 3 };
    await expect(
      runConsensusReview([], consensusConfig, prMetadata, "diff content"),
    ).rejects.toThrow();
  });

  it("reports failedPasses=0 when all passes succeed", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }));

    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");

    expect(result.consensusMetadata?.failedPasses).toBe(0);
  });

  it("aggregates token counts only from successful passes", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
      .mockRejectedValueOnce(new Error("pass 2 failed"))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 250 }));

    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");

    expect(result.tokenCount).toBe(350);
  });

  it("throws with an AggregateError that includes every pass failure", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"))
      .mockRejectedValueOnce(new Error("third failure"));

    const consensusConfig = { ...config, consensusPasses: 3 };
    try {
      await runConsensusReview([], consensusConfig, prMetadata, "diff content");
      expect.fail("expected runConsensusReview to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors).toHaveLength(3);
    }
  });
});

describe("runConsensusReview ticket compliance pass-0-only invariant", () => {
  const ticketContext = [
    {
      id: "AUTH-42",
      title: "JWT auth",
      description: "Login with JWT",
      labels: [] as string[],
      source: "jira",
    },
  ];

  beforeEach(() => {
    callCount = 0;
    mockBehavior = "default";
    delete process.env.RUSTY_REVIEW_MODELS;
    delete process.env.RUSTY_REVIEW_TEMPERATURES;
    process.env.RUSTY_REVIEW_ADAPTIVE_PASSES = "false";
    vi.clearAllMocks();
  });

  it("returns pass 0's ticketCompliance verbatim when pass 0 succeeds", async () => {
    const { runReview } = await import("../agent/review.js");
    const pass0Compliance = [
      {
        ticketId: "AUTH-42",
        requirement: "Login endpoint returns JWT",
        status: "addressed" as const,
        evidence: "src/auth.ts:42 — returns JWT",
      },
    ];
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ ticketCompliance: pass0Compliance }))
      .mockResolvedValueOnce(makeResult({ ticketCompliance: [] }))
      .mockResolvedValueOnce(makeResult({ ticketCompliance: [] }));

    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview(
      [],
      consensusConfig,
      prMetadata,
      "diff content",
      ticketContext,
    );

    expect(result.ticketCompliance).toEqual(pass0Compliance);
  });

  it("returns EMPTY ticketCompliance (not pass 1's) when pass 0 fails — pass 1 never saw the tickets so its empty array is meaningless", async () => {
    const { runReview } = await import("../agent/review.js");
    const pass1Compliance = [
      {
        ticketId: "AUTH-42",
        requirement: "should never appear in output",
        status: "addressed" as const,
        evidence: "this came from a pass that never saw the ticket",
      },
    ];
    (runReview as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("pass 0 transient failure"))
      .mockResolvedValueOnce(makeResult({ ticketCompliance: pass1Compliance }))
      .mockResolvedValueOnce(makeResult({ ticketCompliance: [] }));

    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview(
      [],
      consensusConfig,
      prMetadata,
      "diff content",
      ticketContext,
    );

    expect(result.ticketCompliance).toEqual([]);
  });

  it("emits a warn log when pass 0 fails and ticketContext was supplied", async () => {
    const { runReview } = await import("../agent/review.js");
    const { logger } = await import("../logger.js");
    const warnSpy = vi.spyOn(logger, "warn");
    (runReview as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("pass 0 fail"))
      .mockResolvedValueOnce(makeResult())
      .mockResolvedValueOnce(makeResult());

    const consensusConfig = { ...config, consensusPasses: 3 };
    await runConsensusReview([], consensusConfig, prMetadata, "diff content", ticketContext);

    const ticketWarn = warnSpy.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("ticket compliance unavailable"),
    );
    expect(ticketWarn).toBeDefined();
  });

  it("does NOT emit the ticket-compliance warn when pass 0 fails but no tickets were linked (no compliance was expected anyway)", async () => {
    const { runReview } = await import("../agent/review.js");
    const { logger } = await import("../logger.js");
    const warnSpy = vi.spyOn(logger, "warn");
    (runReview as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("pass 0 fail"))
      .mockResolvedValueOnce(makeResult())
      .mockResolvedValueOnce(makeResult());

    const consensusConfig = { ...config, consensusPasses: 3 };
    await runConsensusReview([], consensusConfig, prMetadata, "diff content"); // no ticketContext

    const ticketWarn = warnSpy.mock.calls.find(
      (call) => typeof call[1] === "string" && call[1].includes("ticket compliance unavailable"),
    );
    expect(ticketWarn).toBeUndefined();
  });
});

describe("RUSTY_LOG_RAW_FINDINGS", () => {
  beforeEach(() => {
    callCount = 0;
    mockBehavior = "default";
    delete process.env.RUSTY_REVIEW_MODELS;
    delete process.env.RUSTY_LOG_RAW_FINDINGS;
    process.env.RUSTY_REVIEW_ADAPTIVE_PASSES = "false";
    vi.clearAllMocks();
  });

  it("does not emit raw-findings logs by default", async () => {
    const { logger } = await import("../logger.js");
    const debugSpy = vi.spyOn(logger, "debug");

    await runConsensusReview([], { ...config, consensusPasses: 3 }, prMetadata, "diff content");

    const rawFindingCalls = debugSpy.mock.calls.filter(
      (c) =>
        typeof c[1] === "string" && c[1].includes("raw consensus pass findings before clustering"),
    );
    expect(rawFindingCalls).toHaveLength(0);
    debugSpy.mockRestore();
  });

  it("emits one debug log per pass with file/line/severity/category/message when flag is 'true'", async () => {
    process.env.RUSTY_LOG_RAW_FINDINGS = "true";
    const { logger } = await import("../logger.js");
    const debugSpy = vi.spyOn(logger, "debug");

    await runConsensusReview([], { ...config, consensusPasses: 3 }, prMetadata, "diff content");

    const rawFindingCalls = debugSpy.mock.calls.filter(
      (c) =>
        typeof c[1] === "string" && c[1].includes("raw consensus pass findings before clustering"),
    );
    expect(rawFindingCalls).toHaveLength(3);

    for (let i = 0; i < 3; i++) {
      const bindings = rawFindingCalls[i][0] as Record<string, unknown>;
      expect(bindings.passIndex).toBe(i);
      expect(bindings.prId).toBe("42");
      expect(bindings.findingCount).toBeTypeOf("number");
      const findings = bindings.findings as Record<string, unknown>[];
      expect(findings).toBeInstanceOf(Array);
      // each finding entry must carry exactly the documented redacted fields
      for (const f of findings) {
        expect(f).toHaveProperty("file");
        expect(f).toHaveProperty("line");
        expect(f).toHaveProperty("severity");
        expect(f).toHaveProperty("category");
        expect(f).toHaveProperty("message");
      }
    }
    debugSpy.mockRestore();
  });

  it("treats values other than the literal string 'true' as off", async () => {
    process.env.RUSTY_LOG_RAW_FINDINGS = "1"; // not 'true'
    const { logger } = await import("../logger.js");
    const debugSpy = vi.spyOn(logger, "debug");

    await runConsensusReview([], { ...config, consensusPasses: 3 }, prMetadata, "diff content");

    const rawFindingCalls = debugSpy.mock.calls.filter(
      (c) =>
        typeof c[1] === "string" && c[1].includes("raw consensus pass findings before clustering"),
    );
    expect(rawFindingCalls).toHaveLength(0);
    debugSpy.mockRestore();
  });
});
