import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewResult, Finding, ReviewConfig, PRMetadata, FilePatch } from "../types.js";
import { compressDiff, countTokens } from "../diff/compress.js";

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

const { runConsensusReview, deriveConsensusThreshold } = await import("../agent/consensus.js");

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

  it("agreement rate is the mean pairwise overlap when pass 2 disagrees with passes 0 and 1", async () => {
    const strictConfig = { ...config, consensusPasses: 3, consensusThreshold: 3 };
    const result = await runConsensusReview([], strictConfig, prMetadata, "diff content");
    // pairs: (0,1) = 1, (0,2) = 0, (1,2) = 0
    expect(result.consensusMetadata?.agreementRate).toBeCloseTo((1 + 0 + 0) / 3);
  });

  it("agreement rate is 1 when two passes report identical findings", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding, uniqueFinding] }))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding, uniqueFinding] }));
    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 2 },
      prMetadata,
      "diff content",
    );
    expect(result.consensusMetadata?.agreementRate).toBe(1);
  });

  it("agreement rate is 0 when two passes report disjoint findings", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding] }))
      .mockResolvedValueOnce(makeResult({ findings: [uniqueFinding] }));
    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 2 },
      prMetadata,
      "diff content",
    );
    expect(result.consensusMetadata?.agreementRate).toBe(0);
  });

  it("agreement rate averages pairwise jaccards over partially overlapping passes", async () => {
    const { runReview } = await import("../agent/review.js");
    const thirdFinding = makeFinding({
      file: "src/third.ts",
      line: 5,
      message: "unrelated resource leak in the connection pool teardown",
    });
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding, uniqueFinding] }))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding] }))
      .mockResolvedValueOnce(makeResult({ findings: [thirdFinding] }));
    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 3 },
      prMetadata,
      "diff content",
    );
    // clusters: shared {0,1}, unique {0}, third {2}
    // (0,1) = 1/2, (0,2) = 0/3, (1,2) = 0/2
    expect(result.consensusMetadata?.agreementRate).toBeCloseTo((0.5 + 0 + 0) / 3);
  });

  it("agreement rate treats two empty passes as agreeing", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [] }))
      .mockResolvedValueOnce(makeResult({ findings: [] }))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding] }));
    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 3 },
      prMetadata,
      "diff content",
    );
    // (0,1) both empty = 1, (0,2) = 0, (1,2) = 0
    expect(result.consensusMetadata?.agreementRate).toBeCloseTo(1 / 3);
  });

  it("agreement rate is null when every pass finds nothing", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [], tokenCount: 100 }))
      .mockResolvedValueOnce(makeResult({ findings: [], tokenCount: 100 }))
      .mockResolvedValueOnce(makeResult({ findings: [], tokenCount: 100 }));
    const consensusConfig = { ...config, consensusPasses: 3 };
    const result = await runConsensusReview([], consensusConfig, prMetadata, "diff content");
    expect(result.consensusMetadata?.agreementRate).toBeNull();
  });

  it("agreement rate is null when only one pass survives (degraded)", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("pass 0 failed"))
      .mockRejectedValueOnce(new Error("pass 1 failed"))
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding] }));
    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 3 },
      prMetadata,
      "diff content",
    );
    expect(result.consensusMetadata?.degraded).toBe(true);
    expect(result.consensusMetadata?.agreementRate).toBeNull();
  });

  it("agreement rate is computed over the survivors only when one pass fails", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeResult({ findings: [sharedFinding] }))
      .mockRejectedValueOnce(new Error("pass 1 failed"))
      .mockResolvedValueOnce(makeResult({ findings: [uniqueFinding] }));
    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 3 },
      prMetadata,
      "diff content",
    );
    expect(result.consensusMetadata?.failedPasses).toBe(1);
    expect(result.consensusMetadata?.agreementRate).toBe(0);
  });

  it("does not count de-duplicated observations as dropped", async () => {
    const { runReview } = await import("../agent/review.js");
    const observation = {
      file: "src/index.ts",
      line: 10,
      severity: "suggestion" as const,
      category: "bugs" as const,
      message: "consider extracting this block into a helper",
    };
    const same = () => makeResult({ observations: [observation] });
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(same())
      .mockResolvedValueOnce(same())
      .mockResolvedValueOnce(same());
    const { logger } = await import("../logger.js");
    const infoSpy = vi.spyOn(logger, "info");
    await runConsensusReview([], { ...config, consensusPasses: 3 }, prMetadata, "diff content");
    const call = infoSpy.mock.calls.find((c) => c[1] === "consensus voting complete");
    expect(call?.[0]).toMatchObject({ droppedObservations: 0, rawObservations: 3 });
    infoSpy.mockRestore();
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

  it("degrades when one pass hangs until its time budget rejects it", async () => {
    vi.useFakeTimers();
    try {
      const { runReview } = await import("../agent/review.js");
      // stands in for the real runReview, which enforces its own budget
      const timingOut = () =>
        new Promise<never>((_, reject) =>
          setTimeout(() => {
            const err = new Error("review pass exceeded its time budget");
            (err as Error & { id?: string }).id = "REVIEW_PASS_TIMEOUT";
            reject(err);
          }, 1000),
        );
      (runReview as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }))
        .mockReturnValueOnce(timingOut())
        .mockResolvedValueOnce(makeResult({ findings: [sharedFinding], tokenCount: 100 }));

      // threshold 3 of 3 passes: two survivors fall short, so the vote degrades
      const consensusConfig = { ...config, consensusPasses: 3, consensusThreshold: 3 };
      const pending = runConsensusReview([], consensusConfig, prMetadata, "diff content");
      await vi.advanceTimersByTimeAsync(1000);
      const result = await pending;

      expect(result.consensusMetadata?.degraded).toBe(true);
      expect(result.consensusMetadata?.failedPasses).toBe(1);
      expect(result.consensusMetadata?.effectiveThreshold).toBe(2);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].voteCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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

describe("raw findings cluster record and file sink", () => {
  let dir: string;
  beforeEach(() => {
    callCount = 0;
    mockBehavior = "default";
    delete process.env.RUSTY_REVIEW_MODELS;
    delete process.env.RUSTY_LOG_RAW_FINDINGS;
    delete process.env.RUSTY_LOG_RAW_FINDINGS_FILE;
    process.env.RUSTY_REVIEW_ADAPTIVE_PASSES = "false";
    dir = mkdtempSync(join(tmpdir(), "raw-findings-"));
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.RUSTY_LOG_RAW_FINDINGS;
    delete process.env.RUSTY_LOG_RAW_FINDINGS_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  const clusterCalls = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(
      (c) => typeof c[1] === "string" && c[1].includes("raw consensus clusters after clustering"),
    );

  it("emits a cluster record with variants when the flag is on", async () => {
    process.env.RUSTY_LOG_RAW_FINDINGS = "true";
    const { logger } = await import("../logger.js");
    const debugSpy = vi.spyOn(logger, "debug");

    await runConsensusReview([], { ...config, consensusPasses: 3 }, prMetadata, "diff content");

    const calls = clusterCalls(debugSpy);
    expect(calls).toHaveLength(1);
    const record = calls[0][0] as {
      effectiveThreshold: number;
      clusters: { voteCount: number; surviving: boolean; variants: Record<string, unknown>[] }[];
    };
    expect(record.effectiveThreshold).toBe(2);
    const shared = record.clusters.find((c) => c.voteCount === 2)!;
    expect(shared.surviving).toBe(true);
    expect(shared.variants.length).toBeGreaterThanOrEqual(2);
    for (const v of shared.variants) {
      expect(Object.keys(v).sort()).toEqual(["category", "line", "message", "severity"]);
    }
    expect(record.clusters.find((c) => c.voteCount === 1)!.surviving).toBe(false);
    debugSpy.mockRestore();
  });

  it("omits the cluster record when the flag is off", async () => {
    const { logger } = await import("../logger.js");
    const debugSpy = vi.spyOn(logger, "debug");

    await runConsensusReview([], { ...config, consensusPasses: 3 }, prMetadata, "diff content");

    expect(clusterCalls(debugSpy)).toHaveLength(0);
    debugSpy.mockRestore();
  });

  it("appends parseable ndjson records when flag and file are set", async () => {
    process.env.RUSTY_LOG_RAW_FINDINGS = "true";
    const path = join(dir, "raw.ndjson");
    process.env.RUSTY_LOG_RAW_FINDINGS_FILE = path;

    await runConsensusReview([], { ...config, consensusPasses: 3 }, prMetadata, "diff content");

    const lines = readFileSync(path, "utf8").trim().split("\n");
    const records = lines.map((l) => JSON.parse(l) as { kind: string });
    expect(records.map((r) => r.kind)).toEqual(["pass", "pass", "pass", "clusters"]);
  });

  it("writes nothing when the file is set but the flag is off", async () => {
    const path = join(dir, "raw.ndjson");
    process.env.RUSTY_LOG_RAW_FINDINGS_FILE = path;

    await runConsensusReview([], { ...config, consensusPasses: 3 }, prMetadata, "diff content");

    expect(existsSync(path)).toBe(false);
  });

  it("attributes pass records to the original slot and model when an earlier pass failed", async () => {
    process.env.RUSTY_LOG_RAW_FINDINGS = "true";
    process.env.RUSTY_REVIEW_MODELS = "anthropic/model-a,anthropic/model-b,anthropic/model-c";
    const path = join(dir, "raw.ndjson");
    process.env.RUSTY_LOG_RAW_FINDINGS_FILE = path;
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("pass 0 fail"));
    const { logger } = await import("../logger.js");
    const infoSpy = vi.spyOn(logger, "info");

    await runConsensusReview([], { ...config, consensusPasses: 3 }, prMetadata, "diff content");

    const manifest = infoSpy.mock.calls.find((c) => c[1] === "consensus run manifest")![0] as {
      passModels: string[];
    };
    const passRecords = readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { kind: string; passIndex: number; model: string })
      .filter((r) => r.kind === "pass");
    expect(passRecords.map((r) => r.passIndex)).toEqual([1, 2]);
    expect(passRecords.map((r) => r.model)).toEqual([
      manifest.passModels[1],
      manifest.passModels[2],
    ]);
    expect(manifest.passModels[1]).not.toBe(manifest.passModels[0]);
    infoSpy.mockRestore();
  });

  it("warns instead of failing the review when the path is unwritable", async () => {
    process.env.RUSTY_LOG_RAW_FINDINGS = "true";
    process.env.RUSTY_LOG_RAW_FINDINGS_FILE = join(dir, "missing-dir", "raw.ndjson");
    const { logger } = await import("../logger.js");
    const warnSpy = vi.spyOn(logger, "warn");

    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 3 },
      prMetadata,
      "diff content",
    );

    expect(result.findings).toHaveLength(1);
    expect(
      warnSpy.mock.calls.some(
        (c) => typeof c[1] === "string" && c[1].includes("failed to write raw findings record"),
      ),
    ).toBe(true);
    warnSpy.mockRestore();
  });
});

describe("consensus run manifest and env overrides", () => {
  beforeEach(() => {
    callCount = 0;
    mockBehavior = "default";
    delete process.env.RUSTY_REVIEW_MODELS;
    delete process.env.RUSTY_CONSENSUS_PASSES;
    delete process.env.RUSTY_CONSENSUS_THRESHOLD;
    process.env.RUSTY_REVIEW_ADAPTIVE_PASSES = "false";
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.RUSTY_CONSENSUS_PASSES;
    delete process.env.RUSTY_CONSENSUS_THRESHOLD;
  });

  const manifestCalls = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((c) => c[1] === "consensus run manifest");

  it("emits exactly one manifest with resolved values", async () => {
    const { logger } = await import("../logger.js");
    const infoSpy = vi.spyOn(logger, "info");

    await runConsensusReview([], { ...config, consensusPasses: 3 }, prMetadata, "diff content");

    const calls = manifestCalls(infoSpy);
    expect(calls).toHaveLength(1);
    const m = calls[0][0] as Record<string, unknown>;
    expect(m.prId).toBe("42");
    expect(m.passes).toBe(3);
    expect(m.threshold).toBe(2);
    expect(m.baseSeed).toBeTypeOf("number");
    expect(m.passModels).toHaveLength(3);
    expect(m.passSettings).toHaveLength(3);
    expect(m.clusterConfig).toEqual({ lineWindow: 5, jaccard: 0.3, categoryJaccard: 0.2 });
    expect(m.adaptivePasses).toBe(false);
    infoSpy.mockRestore();
  });

  it("honors RUSTY_CONSENSUS_PASSES and RUSTY_CONSENSUS_THRESHOLD when config is silent", async () => {
    process.env.RUSTY_CONSENSUS_PASSES = "4";
    process.env.RUSTY_CONSENSUS_THRESHOLD = "3";
    const { logger } = await import("../logger.js");
    const infoSpy = vi.spyOn(logger, "info");

    await runConsensusReview([], config, prMetadata, "diff content");

    const m = manifestCalls(infoSpy)[0][0] as Record<string, unknown>;
    expect(m.passes).toBe(4);
    expect(m.threshold).toBe(3);
    infoSpy.mockRestore();
  });

  it("lets explicit config beat env", async () => {
    process.env.RUSTY_CONSENSUS_PASSES = "5";
    process.env.RUSTY_CONSENSUS_THRESHOLD = "5";
    const { logger } = await import("../logger.js");
    const infoSpy = vi.spyOn(logger, "info");

    await runConsensusReview(
      [],
      { ...config, consensusPasses: 3, consensusThreshold: 1 },
      prMetadata,
      "diff content",
    );

    const m = manifestCalls(infoSpy)[0][0] as Record<string, unknown>;
    expect(m.passes).toBe(3);
    expect(m.threshold).toBe(1);
    infoSpy.mockRestore();
  });

  it("rejects RUSTY_CONSENSUS_PASSES above 5 with a single warn naming the variable", async () => {
    process.env.RUSTY_CONSENSUS_PASSES = "30";
    const { logger } = await import("../logger.js");
    const infoSpy = vi.spyOn(logger, "info");
    const warnSpy = vi.spyOn(logger, "warn");

    await runConsensusReview([], config, prMetadata, "diff content");

    const m = manifestCalls(infoSpy)[0][0] as Record<string, unknown>;
    expect(m.passes).toBe(3);
    const envWarns = warnSpy.mock.calls.filter(
      (c) => (c[0] as Record<string, unknown>)?.variable === "RUSTY_CONSENSUS_PASSES",
    );
    expect(envWarns).toHaveLength(1);
    expect((envWarns[0][0] as Record<string, unknown>).value).toBe("30");
    infoSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("accepts the 5-pass upper bound", async () => {
    process.env.RUSTY_CONSENSUS_PASSES = "5";
    const { logger } = await import("../logger.js");
    const infoSpy = vi.spyOn(logger, "info");

    await runConsensusReview([], config, prMetadata, "diff content");

    expect((manifestCalls(infoSpy)[0][0] as Record<string, unknown>).passes).toBe(5);
    infoSpy.mockRestore();
  });

  it("falls back to defaults on empty, zero, fractional and garbage env", async () => {
    const { logger } = await import("../logger.js");
    for (const bad of ["", "0", "2.5", "abc", "-3"]) {
      process.env.RUSTY_CONSENSUS_PASSES = bad;
      process.env.RUSTY_CONSENSUS_THRESHOLD = bad;
      const infoSpy = vi.spyOn(logger, "info");

      await runConsensusReview([], config, prMetadata, "diff content");

      const m = manifestCalls(infoSpy)[0][0] as Record<string, unknown>;
      expect(m.passes).toBe(3);
      expect(m.threshold).toBe(2);
      infoSpy.mockRestore();
    }
  });
});

describe("runConsensusReview scope creep", () => {
  it("merges scopeCreep across passes, one entry per file", async () => {
    const { runReview } = await import("../agent/review.js");
    (runReview as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        makeResult({ scopeCreep: [{ file: "src/a.ts", description: "pass 0 wording" }] }),
      )
      .mockResolvedValueOnce(
        makeResult({
          scopeCreep: [
            { file: "src/a.ts", description: "pass 1 wording" },
            { file: "src/b.ts", description: "only pass 1 saw this" },
          ],
        }),
      )
      .mockResolvedValueOnce(makeResult({}));

    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 3, flagScopeCreep: true },
      prMetadata,
      "diff content",
    );

    expect(result.scopeCreep).toEqual([
      { file: "src/a.ts", description: "pass 0 wording" },
      { file: "src/b.ts", description: "only pass 1 saw this" },
    ]);
  });
});

describe("runConsensusReview per-pass diff rendering", () => {
  function makePatch(path: string, addLines: number): FilePatch {
    return {
      path,
      additions: addLines,
      deletions: 0,
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: addLines,
          content: Array.from({ length: addLines }, (_, i) => `+${path} line ${i}`).join("\n"),
        },
      ],
    };
  }

  // distinct sizes so a size sort would erase the per-pass shuffle
  const patches = ["a", "b", "c", "d", "e", "f"].map((n, i) => makePatch(`src/${n}.ts`, 3 + i * 2));

  beforeEach(() => {
    callCount = 0;
    mockBehavior = "default";
    delete process.env.RUSTY_REVIEW_MODELS;
    process.env.RUSTY_REVIEW_ADAPTIVE_PASSES = "false";
    vi.clearAllMocks();
  });

  async function passCalls() {
    const { runReview } = await import("../agent/review.js");
    return (runReview as ReturnType<typeof vi.fn>).mock.calls;
  }

  it("renders a differently ordered diff for each pass", async () => {
    await runConsensusReview(
      patches,
      { ...config, consensusPasses: 3 },
      prMetadata,
      "single-pass diff",
    );

    const diffs = (await passCalls()).map((c) => c[1] as string);
    expect(diffs).toHaveLength(3);
    expect(diffs[0]).not.toBe(diffs[1]);
    expect(diffs.every((d) => d !== "single-pass diff")).toBe(true);
  });

  it("applies the token budget to every pass and warns about skipped files", async () => {
    const { logger } = await import("../logger.js");
    const warnSpy = vi.spyOn(logger, "warn");
    const maxTokens = 40;

    await runConsensusReview(
      patches,
      { ...config, consensusPasses: 3 },
      prMetadata,
      "single-pass diff",
      undefined,
      { maxTokens },
    );

    const diffs = (await passCalls()).map((c) => c[1] as string);
    for (const d of diffs) {
      expect(countTokens(d)).toBeLessThanOrEqual(maxTokens + 2);
      expect(d).not.toBe(compressDiff(patches, Infinity).compressed);
    }
    const skipWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[1] === "string" && c[1].includes("exceeded token budget"),
    );
    expect(skipWarns).toHaveLength(3);
    warnSpy.mockRestore();
  });

  it("does not leak maxTokens into runReview options and keeps deadlineAt on every pass", async () => {
    await runConsensusReview(
      patches,
      { ...config, consensusPasses: 3 },
      prMetadata,
      "single-pass diff",
      undefined,
      { maxTokens: 1000, deadlineAt: 123 },
    );

    for (const c of await passCalls()) {
      const opts = c[4] as Record<string, unknown>;
      expect(opts.deadlineAt).toBe(123);
      expect(opts).not.toHaveProperty("maxTokens");
    }
  });

  it("sends the caller's budget-bounded diff to the single-pass fallback", async () => {
    await runConsensusReview(
      patches,
      { ...config, consensusPasses: 1 },
      prMetadata,
      "single-pass diff",
      undefined,
      { maxTokens: 10 },
    );

    const calls = await passCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe("single-pass diff");
  });
});

describe("runConsensusReview homogeneous ensemble detection", () => {
  const homogeneousWarning = (calls: unknown[][]) =>
    calls.filter((c) => typeof c[1] === "string" && c[1].includes("ensemble is homogeneous"));

  beforeEach(() => {
    callCount = 0;
    mockBehavior = "default";
    delete process.env.RUSTY_REVIEW_MODELS;
    delete process.env.RUSTY_REVIEW_TEMPERATURES;
    delete process.env.RUSTY_REVIEW_TOP_PS;
    process.env.RUSTY_REVIEW_ADAPTIVE_PASSES = "false";
    vi.clearAllMocks();
  });

  it("flags and warns when no review models are configured", async () => {
    const { logger } = await import("../logger.js");
    const warnSpy = vi.spyOn(logger, "warn");

    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 3 },
      prMetadata,
      "diff content",
    );

    expect(result.consensusMetadata?.homogeneousEnsemble).toBe(true);
    expect(homogeneousWarning(warnSpy.mock.calls)).toHaveLength(1);
    warnSpy.mockRestore();
  });

  it("does not flag an ensemble with distinct models", async () => {
    process.env.RUSTY_REVIEW_MODELS = "anthropic/pass-1,openai/pass-2";
    const { logger } = await import("../logger.js");
    const warnSpy = vi.spyOn(logger, "warn");

    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 2 },
      prMetadata,
      "diff content",
    );

    expect(result.consensusMetadata?.homogeneousEnsemble).toBeFalsy();
    expect(homogeneousWarning(warnSpy.mock.calls)).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("does not flag the same model run with different temperatures", async () => {
    process.env.RUSTY_REVIEW_MODELS = "anthropic/same,anthropic/same";
    process.env.RUSTY_REVIEW_TEMPERATURES = "0.1,0.9";

    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 2 },
      prMetadata,
      "diff content",
    );

    expect(result.consensusMetadata?.homogeneousEnsemble).toBeFalsy();
  });
});

describe("deriveConsensusThreshold", () => {
  it.each([
    [0, 3, 1],
    [-1, 3, 1],
    [0.5, 3, 1],
    [2.4, 3, 2],
    [5, 3, 3],
    [3, 2, 2],
    [2, 3, 2],
    [null, 2, 2],
    [undefined, 3, 2],
    [null, 5, 3],
  ])("(%s, %s) -> %s", (configured, passes, expected) => {
    expect(deriveConsensusThreshold(configured, passes)).toBe(expected);
  });

  it("warns when the configured value was out of range or fractional", async () => {
    const { logger } = await import("../logger.js");
    const warnSpy = vi.spyOn(logger, "warn");

    deriveConsensusThreshold(0, 3);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    deriveConsensusThreshold(2.4, 3);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    deriveConsensusThreshold(2, 3);
    deriveConsensusThreshold(null, 3);
    expect(warnSpy).toHaveBeenCalledTimes(2);

    deriveConsensusThreshold(-1, 3);
    deriveConsensusThreshold(0.5, 3);
    expect(warnSpy).toHaveBeenCalledTimes(4);

    deriveConsensusThreshold(5, 3);
    deriveConsensusThreshold(3, 2);
    expect(warnSpy).toHaveBeenCalledTimes(4);
    warnSpy.mockRestore();
  });

  it("never lets a zero threshold disable the vote gate", async () => {
    process.env.RUSTY_REVIEW_ADAPTIVE_PASSES = "false";
    callCount = 0;
    mockBehavior = "default";
    const result = await runConsensusReview(
      [],
      { ...config, consensusPasses: 3, consensusThreshold: 0 },
      prMetadata,
      "diff content",
    );
    expect(result.consensusMetadata?.threshold).toBe(1);
  });
});
