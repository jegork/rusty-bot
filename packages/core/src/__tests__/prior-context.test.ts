import { describe, expect, it } from "vitest";
import {
  buildPriorContextFromReview,
  encodePriorReviewContext,
  extractPriorReviewContext,
  PRIOR_CONTEXT_LIMITS,
} from "../agent/prior-context.js";
import type { PriorReviewContext, ReviewResult } from "../types.js";

function makeContext(overrides: Partial<PriorReviewContext> = {}): PriorReviewContext {
  return {
    summary: "this PR adds a /health endpoint and zod validation.",
    recommendation: "address_before_merge",
    findings: [
      {
        file: "src/app.ts",
        line: 42,
        severity: "warning",
        message: "potential null deref when req.body is missing",
      },
    ],
    ...overrides,
  };
}

describe("encode/extract roundtrip", () => {
  it("roundtrips a normal context unchanged", () => {
    const ctx = makeContext();
    const marker = encodePriorReviewContext(ctx);
    const body = `<!-- rusty-bot-review -->\n${marker}\n# Summary\n…`;
    const decoded = extractPriorReviewContext(body);
    expect(decoded).toEqual(ctx);
  });

  it("roundtrips an empty findings list", () => {
    const ctx = makeContext({ findings: [] });
    const decoded = extractPriorReviewContext(encodePriorReviewContext(ctx));
    expect(decoded?.findings).toEqual([]);
  });

  it("roundtrips a `looks_good` recommendation", () => {
    const ctx = makeContext({ recommendation: "looks_good" });
    const decoded = extractPriorReviewContext(encodePriorReviewContext(ctx));
    expect(decoded?.recommendation).toBe("looks_good");
  });

  it("roundtrips filesReviewed when present", () => {
    const ctx = makeContext({ filesReviewed: ["src/a.ts", "src/b.ts"] });
    const decoded = extractPriorReviewContext(encodePriorReviewContext(ctx));
    expect(decoded?.filesReviewed).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("omits filesReviewed from the encoded payload when empty (keeps markers small)", () => {
    const ctx = makeContext({ filesReviewed: [] });
    const marker = encodePriorReviewContext(ctx);
    // pull the base64 out and inspect the JSON directly — filesReviewed should not be a key
    const m = /<!-- rusty-bot:context:([A-Za-z0-9+/=]+) -->/.exec(marker);
    expect(m).not.toBeNull();
    const json = Buffer.from(m![1], "base64").toString("utf-8");
    expect(JSON.parse(json)).not.toHaveProperty("filesReviewed");
  });

  it("decodes legacy markers without filesReviewed as undefined (backward compat)", () => {
    const legacy = Buffer.from(
      JSON.stringify({
        summary: "old marker",
        recommendation: "looks_good",
        findings: [],
      }),
      "utf-8",
    ).toString("base64");
    const decoded = extractPriorReviewContext(`<!-- rusty-bot:context:${legacy} -->`);
    expect(decoded).not.toBeNull();
    expect(decoded?.filesReviewed).toBeUndefined();
  });
});

describe("encodePriorReviewContext truncation", () => {
  it("truncates summaries longer than the cap and appends [truncated]", () => {
    const huge = "x".repeat(PRIOR_CONTEXT_LIMITS.summaryCharCap + 500);
    const decoded = extractPriorReviewContext(
      encodePriorReviewContext(makeContext({ summary: huge })),
    );
    expect(decoded?.summary.length).toBeLessThan(huge.length);
    expect(decoded?.summary).toContain("[truncated]");
    expect(decoded?.summary.startsWith("xxx")).toBe(true);
  });

  it("does not touch summaries within the cap", () => {
    const ctx = makeContext({ summary: "short" });
    const decoded = extractPriorReviewContext(encodePriorReviewContext(ctx));
    expect(decoded?.summary).toBe("short");
  });

  it("caps the findings list at FINDINGS_COUNT_CAP items", () => {
    const findings = Array.from({ length: PRIOR_CONTEXT_LIMITS.findingsCountCap + 10 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: i + 1,
      severity: "warning" as const,
      message: `msg ${i}`,
    }));
    const decoded = extractPriorReviewContext(encodePriorReviewContext(makeContext({ findings })));
    expect(decoded?.findings).toHaveLength(PRIOR_CONTEXT_LIMITS.findingsCountCap);
    expect(decoded?.findings[0].message).toBe("msg 0");
    expect(decoded?.findings.at(-1)?.message).toBe(
      `msg ${PRIOR_CONTEXT_LIMITS.findingsCountCap - 1}`,
    );
  });

  it("truncates long finding messages with an ellipsis", () => {
    const huge = "y".repeat(PRIOR_CONTEXT_LIMITS.findingMessageCharCap + 200);
    const decoded = extractPriorReviewContext(
      encodePriorReviewContext(
        makeContext({
          findings: [{ file: "src/a.ts", line: 1, severity: "warning", message: huge }],
        }),
      ),
    );
    expect(decoded?.findings[0].message.length).toBeLessThan(huge.length);
    expect(decoded?.findings[0].message.endsWith("…")).toBe(true);
  });

  it("caps filesReviewed at FILES_REVIEWED_COUNT_CAP entries", () => {
    const filesReviewed = Array.from(
      { length: PRIOR_CONTEXT_LIMITS.filesReviewedCountCap + 25 },
      (_, i) => `src/f${i}.ts`,
    );
    const decoded = extractPriorReviewContext(
      encodePriorReviewContext(makeContext({ filesReviewed })),
    );
    expect(decoded?.filesReviewed).toHaveLength(PRIOR_CONTEXT_LIMITS.filesReviewedCountCap);
    expect(decoded?.filesReviewed?.[0]).toBe("src/f0.ts");
    expect(decoded?.filesReviewed?.at(-1)).toBe(
      `src/f${PRIOR_CONTEXT_LIMITS.filesReviewedCountCap - 1}.ts`,
    );
  });
});

describe("extractPriorReviewContext failure modes", () => {
  it("returns null when no marker is present", () => {
    expect(extractPriorReviewContext("# Summary\nno markers here")).toBeNull();
  });

  it("returns null when the base64 payload is corrupt", () => {
    expect(extractPriorReviewContext("<!-- rusty-bot:context:!!!notbase64!!! -->")).toBeNull();
  });

  it("returns null when JSON is missing required fields", () => {
    const bad = Buffer.from(JSON.stringify({ summary: "ok" }), "utf-8").toString("base64");
    expect(extractPriorReviewContext(`<!-- rusty-bot:context:${bad} -->`)).toBeNull();
  });

  it("returns null when recommendation is not a known enum value", () => {
    const bad = Buffer.from(
      JSON.stringify({ summary: "x", recommendation: "totally_invalid", findings: [] }),
      "utf-8",
    ).toString("base64");
    expect(extractPriorReviewContext(`<!-- rusty-bot:context:${bad} -->`)).toBeNull();
  });

  it("returns null when a finding entry has the wrong shape", () => {
    const bad = Buffer.from(
      JSON.stringify({
        summary: "x",
        recommendation: "looks_good",
        findings: [{ file: 1, line: "no", severity: "warning", message: "x" }],
      }),
      "utf-8",
    ).toString("base64");
    expect(extractPriorReviewContext(`<!-- rusty-bot:context:${bad} -->`)).toBeNull();
  });

  it("returns null when severity is unknown", () => {
    const bad = Buffer.from(
      JSON.stringify({
        summary: "x",
        recommendation: "looks_good",
        findings: [{ file: "a.ts", line: 1, severity: "extreme", message: "x" }],
      }),
      "utf-8",
    ).toString("base64");
    expect(extractPriorReviewContext(`<!-- rusty-bot:context:${bad} -->`)).toBeNull();
  });

  it("returns null when filesReviewed is present but not an array", () => {
    const bad = Buffer.from(
      JSON.stringify({
        summary: "x",
        recommendation: "looks_good",
        findings: [],
        filesReviewed: "src/a.ts",
      }),
      "utf-8",
    ).toString("base64");
    expect(extractPriorReviewContext(`<!-- rusty-bot:context:${bad} -->`)).toBeNull();
  });

  it("returns null when filesReviewed contains non-strings", () => {
    const bad = Buffer.from(
      JSON.stringify({
        summary: "x",
        recommendation: "looks_good",
        findings: [],
        filesReviewed: ["ok.ts", 42],
      }),
      "utf-8",
    ).toString("base64");
    expect(extractPriorReviewContext(`<!-- rusty-bot:context:${bad} -->`)).toBeNull();
  });
});

describe("buildPriorContextFromReview", () => {
  it("carries forward summary, recommendation, and findings (file/line/severity/message only)", () => {
    const review: ReviewResult = {
      summary: "This PR refactors auth.",
      recommendation: "address_before_merge",
      findings: [
        {
          file: "src/auth.ts",
          line: 17,
          endLine: 19,
          severity: "critical",
          category: "security",
          message: "missing csrf check",
          suggestedFix: "add csrf middleware",
        },
      ],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: ["src/auth.ts"],
      modelUsed: "test-model",
      tokenCount: 1000,
    };

    const ctx = buildPriorContextFromReview(review);
    expect(ctx.summary).toBe(review.summary);
    expect(ctx.recommendation).toBe(review.recommendation);
    expect(ctx.findings).toEqual([
      {
        file: "src/auth.ts",
        line: 17,
        severity: "critical",
        message: "missing csrf check",
      },
    ]);
    expect(ctx.filesReviewed).toEqual(["src/auth.ts"]);
  });

  it("produces an empty findings array when the review has none", () => {
    const review: ReviewResult = {
      summary: "no issues",
      recommendation: "looks_good",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: [],
      modelUsed: "test-model",
      tokenCount: 0,
    };
    expect(buildPriorContextFromReview(review).findings).toEqual([]);
  });

  it("carries forward filesReviewed verbatim from the review result", () => {
    const review: ReviewResult = {
      summary: "PR-wide summary",
      recommendation: "looks_good",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: [
        "packages/ui/src/components/StopButton.tsx",
        "apps/web/src/features/live-viewer/hooks.ts",
      ],
      modelUsed: "test-model",
      tokenCount: 0,
    };
    expect(buildPriorContextFromReview(review).filesReviewed).toEqual([
      "packages/ui/src/components/StopButton.tsx",
      "apps/web/src/features/live-viewer/hooks.ts",
    ]);
  });
});

describe("risk assessment carry-forward", () => {
  const riskAssessment = {
    scope: "one_feature" as const,
    detectability: "silent" as const,
    reversibility: "rerun" as const,
    reasons: ["financial-figures"],
    justification: "a missing amount reads as zero",
    level: "high" as const,
  };

  it("roundtrips the assessment and omits it when absent", () => {
    const ctx = makeContext({ riskAssessment });
    expect(extractPriorReviewContext(encodePriorReviewContext(ctx))).toEqual(ctx);
    const without = extractPriorReviewContext(encodePriorReviewContext(makeContext()));
    expect(without).not.toHaveProperty("riskAssessment");
  });

  it("caps the reasons list and the justification", () => {
    const ctx = makeContext({
      riskAssessment: {
        ...riskAssessment,
        reasons: Array.from({ length: 40 }, (_, i) => `r${i}`),
        justification: "x".repeat(5_000),
      },
    });
    const decoded = extractPriorReviewContext(encodePriorReviewContext(ctx));
    expect(decoded?.riskAssessment?.reasons).toHaveLength(20);
    expect(decoded?.riskAssessment?.justification.length).toBeLessThan(1_100);
  });

  it("rejects the whole marker when the assessment is malformed", () => {
    const json = JSON.stringify({
      ...makeContext(),
      riskAssessment: { ...riskAssessment, level: "critical" },
    });
    const marker = `<!-- rusty-bot:context:${Buffer.from(json).toString("base64")} -->`;
    expect(extractPriorReviewContext(marker)).toBeNull();
  });

  it("carries the review's assessment into the prior context", () => {
    const review = {
      summary: "s",
      recommendation: "looks_good",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: ["a.ts"],
      modelUsed: "m",
      tokenCount: 1,
      riskAssessment,
    } satisfies ReviewResult;
    expect(buildPriorContextFromReview(review).riskAssessment).toEqual(riskAssessment);
  });
});

describe("unconfirmed concerns carry-forward", () => {
  const BLOB =
    "Deleting an organization cascades to its document rows, but the uploaded blobs in storage are never removed, leaving orphaned blobs.";
  const BLOB_NEAR =
    "Deleting an organization cascades to its document rows, but the blobs in storage are never removed.";

  function reviewWith(overrides: Partial<ReviewResult> = {}): ReviewResult {
    return {
      summary: "s",
      recommendation: "looks_good",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: [],
      modelUsed: "m",
      tokenCount: 1,
      ...overrides,
    };
  }

  function concern(message: string, overrides: Record<string, unknown> = {}) {
    return {
      file: "a.py",
      line: 3,
      severity: "warning" as const,
      message,
      carriedRuns: 0,
      ...overrides,
    };
  }

  it("records this run's dropped findings as fresh concerns", () => {
    const ctx = buildPriorContextFromReview(
      reviewWith({
        droppedFindings: [
          { file: "m.py", line: 18, severity: "warning", message: BLOB, voteCount: 1 },
        ],
      }),
    );
    expect(ctx.unconfirmed).toEqual([
      { file: "m.py", line: 18, severity: "warning", message: BLOB, carriedRuns: 0 },
    ]);
  });

  it("omits the field when there is nothing unconfirmed", () => {
    expect(buildPriorContextFromReview(reviewWith())).not.toHaveProperty("unconfirmed");
  });

  it("ignores the previous context's concerns unless it is passed in (full reviews start over)", () => {
    const previous = makeContext({
      unconfirmed: [concern("stale cache key collision sharding tenant")],
    });
    expect(buildPriorContextFromReview(reviewWith(), null)).not.toHaveProperty("unconfirmed");
    expect(buildPriorContextFromReview(reviewWith(), previous).unconfirmed).toHaveLength(1);
  });

  it("ages a carried concern by one run and retires it at the cap", () => {
    const max = PRIOR_CONTEXT_LIMITS.unconfirmedMaxCarriedRuns;
    const previous = makeContext({
      unconfirmed: [
        concern("young webhook replay window concern", { carriedRuns: 0 }),
        concern("old tenant sharding drift concern", { carriedRuns: max - 1 }),
      ],
    });
    const ctx = buildPriorContextFromReview(reviewWith(), previous);
    expect(ctx.unconfirmed).toEqual([
      concern("young webhook replay window concern", { carriedRuns: 1 }),
    ]);
  });

  function published(file: string, line: number, message: string) {
    return {
      file,
      line,
      endLine: null,
      severity: "warning" as const,
      category: "bugs" as const,
      message,
      suggestedFix: null,
    };
  }

  it("retires a concern this run published at the same place in similar words", () => {
    const previous = makeContext({ unconfirmed: [concern(BLOB, { file: "m.py", line: 18 })] });
    const ctx = buildPriorContextFromReview(
      reviewWith({ findings: [published("m.py", 21, BLOB_NEAR)] }),
      previous,
    );
    expect(ctx).not.toHaveProperty("unconfirmed");
  });

  it.each([
    ["in another file", published("entity.py", 18, BLOB)],
    ["beyond the line window", published("m.py", 40, BLOB)],
    ["at the same place about something else", published("m.py", 18, "missing index on the slug")],
  ])("keeps carrying a concern when the published finding sits %s", (_label, finding) => {
    const previous = makeContext({ unconfirmed: [concern(BLOB, { file: "m.py", line: 18 })] });
    const ctx = buildPriorContextFromReview(reviewWith({ findings: [finding] }), previous);
    expect(ctx.unconfirmed).toEqual([concern(BLOB, { file: "m.py", line: 18, carriedRuns: 1 })]);
  });

  it("keeps one entry, the fresh one, when this run raised the same concern again below threshold", () => {
    const previous = makeContext({ unconfirmed: [concern(BLOB, { carriedRuns: 1 })] });
    const ctx = buildPriorContextFromReview(
      reviewWith({
        droppedFindings: [
          { file: "a.py", line: 5, severity: "warning", message: BLOB_NEAR, voteCount: 1 },
        ],
      }),
      previous,
    );
    expect(ctx.unconfirmed).toEqual([
      { file: "a.py", line: 5, severity: "warning", message: BLOB_NEAR, carriedRuns: 0 },
    ]);
  });

  it("keeps fresh concerns ahead of carried ones under the count cap", () => {
    const cap = PRIOR_CONTEXT_LIMITS.unconfirmedCountCap;
    const previous = makeContext({
      unconfirmed: [concern("carried zebra quokka narwhal axolotl")],
    });
    const dropped = Array.from({ length: cap }, (_, i) => ({
      file: `f${i}.py`,
      line: i + 1,
      severity: "suggestion" as const,
      message: `fresh concern number ${i} about thing${i}`,
      voteCount: 1,
    }));
    const ctx = buildPriorContextFromReview(reviewWith({ droppedFindings: dropped }), previous);
    expect(ctx.unconfirmed).toHaveLength(cap);
    expect(ctx.unconfirmed!.every((c) => c.carriedRuns === 0)).toBe(true);
  });

  it("roundtrips through the marker with caps applied", () => {
    const cap = PRIOR_CONTEXT_LIMITS.unconfirmedCountCap;
    const long = "x".repeat(PRIOR_CONTEXT_LIMITS.findingMessageCharCap + 50);
    const ctx = makeContext({
      unconfirmed: Array.from({ length: cap + 5 }, (_, i) => concern(long, { line: i + 1 })),
    });
    const decoded = extractPriorReviewContext(encodePriorReviewContext(ctx));
    expect(decoded?.unconfirmed).toHaveLength(cap);
    expect(decoded?.unconfirmed?.[0].message.endsWith("…")).toBe(true);
    expect(decoded?.unconfirmed?.[0].carriedRuns).toBe(0);
  });

  it("decodes markers written before the field existed", () => {
    const decoded = extractPriorReviewContext(encodePriorReviewContext(makeContext()));
    expect(decoded).not.toBeNull();
    expect(decoded?.unconfirmed).toBeUndefined();
  });

  it("rejects a marker whose concerns are malformed", () => {
    for (const unconfirmed of [
      "nope",
      [{ file: "a", line: 1, severity: "warning", message: "m" }],
      [concern("m", { carriedRuns: -1 })],
      [concern("m", { carriedRuns: 1.5 })],
      [concern("m", { severity: "fatal" })],
    ]) {
      const json = JSON.stringify({ ...makeContext(), unconfirmed });
      const marker = `<!-- rusty-bot:context:${Buffer.from(json).toString("base64")} -->`;
      expect(extractPriorReviewContext(marker)).toBeNull();
    }
  });
});

describe("incremental run counter", () => {
  const review: ReviewResult = {
    summary: "s",
    recommendation: "looks_good",
    findings: [],
    observations: [],
    ticketCompliance: [],
    missingTests: [],
    filesReviewed: [],
    modelUsed: "m",
    tokenCount: 1,
  };

  it("is 0 after a full review and counts up from the previous incremental context", () => {
    expect(buildPriorContextFromReview(review).incrementalRuns).toBe(0);
    expect(buildPriorContextFromReview(review, makeContext()).incrementalRuns).toBe(1);
    expect(
      buildPriorContextFromReview(review, makeContext({ incrementalRuns: 4 })).incrementalRuns,
    ).toBe(5);
  });

  it("roundtrips through the marker, including 0", () => {
    for (const incrementalRuns of [0, 7]) {
      const decoded = extractPriorReviewContext(
        encodePriorReviewContext(makeContext({ incrementalRuns })),
      );
      expect(decoded?.incrementalRuns).toBe(incrementalRuns);
    }
  });

  it.each([-1, 1.5, "3", null])("rejects a marker whose counter is %s", (incrementalRuns) => {
    const json = JSON.stringify({ ...makeContext(), incrementalRuns });
    const marker = `<!-- rusty-bot:context:${Buffer.from(json).toString("base64")} -->`;
    expect(extractPriorReviewContext(marker)).toBeNull();
  });
});
