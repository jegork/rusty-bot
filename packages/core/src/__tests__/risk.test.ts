import { describe, expect, it } from "vitest";
import {
  compareRiskLevels,
  deriveRiskLevel,
  mergeRiskAssessments,
  readRiskLabel,
} from "../agent/risk.js";
import type { ReviewResult, RiskAssessment } from "../types.js";

function makeAssessment(overrides: Partial<RiskAssessment> = {}): RiskAssessment {
  return {
    scope: "one_user",
    detectability: "immediate",
    reversibility: "redeploy",
    reasons: [],
    justification: "cosmetic change",
    level: "low",
    ...overrides,
  };
}

function makeResult(riskAssessment?: RiskAssessment): ReviewResult {
  return {
    summary: "",
    recommendation: "looks_good",
    findings: [],
    observations: [],
    ticketCompliance: [],
    missingTests: [],
    filesReviewed: [],
    modelUsed: "m",
    tokenCount: 0,
    ...(riskAssessment ? { riskAssessment } : {}),
  };
}

describe("deriveRiskLevel", () => {
  it("is low only when every axis is at its best", () => {
    expect(
      deriveRiskLevel({ scope: "one_user", detectability: "immediate", reversibility: "redeploy" }),
    ).toBe("low");
  });

  it("is high as soon as one axis is at its worst, whatever the others say", () => {
    expect(
      deriveRiskLevel({ scope: "one_user", detectability: "silent", reversibility: "redeploy" }),
    ).toBe("high");
    expect(
      deriveRiskLevel({ scope: "one_user", detectability: "immediate", reversibility: "repair" }),
    ).toBe("high");
    expect(
      deriveRiskLevel({ scope: "everyone", detectability: "immediate", reversibility: "redeploy" }),
    ).toBe("high");
  });

  it("is medium for anything in between", () => {
    expect(
      deriveRiskLevel({
        scope: "one_feature",
        detectability: "immediate",
        reversibility: "redeploy",
      }),
    ).toBe("medium");
    expect(
      deriveRiskLevel({ scope: "one_feature", detectability: "monitored", reversibility: "rerun" }),
    ).toBe("medium");
  });
});

describe("compareRiskLevels", () => {
  it("orders low < medium < high", () => {
    expect(compareRiskLevels("low", "high")).toBeLessThan(0);
    expect(compareRiskLevels("high", "medium")).toBeGreaterThan(0);
    expect(compareRiskLevels("medium", "medium")).toBe(0);
  });
});

describe("mergeRiskAssessments", () => {
  it("returns undefined when no pass assessed risk", () => {
    expect(mergeRiskAssessments([makeResult(), makeResult()])).toBeUndefined();
  });

  it("returns the single assessment untouched", () => {
    const only = makeAssessment({ reasons: ["ui-only"] });
    expect(mergeRiskAssessments([makeResult(), makeResult(only)])).toBe(only);
  });

  it("takes the worst answer per axis and re-derives the level", () => {
    const merged = mergeRiskAssessments([
      makeResult(makeAssessment({ scope: "one_feature", level: "medium", justification: "a" })),
      makeResult(
        makeAssessment({ detectability: "silent", level: "high", justification: "silent no-op" }),
      ),
      makeResult(makeAssessment({ reversibility: "rerun", level: "medium", justification: "c" })),
    ]);
    expect(merged).toMatchObject({
      scope: "one_feature",
      detectability: "silent",
      reversibility: "rerun",
      level: "high",
    });
  });

  it("keeps the justification of a pass that argued for the merged level", () => {
    const merged = mergeRiskAssessments([
      makeResult(makeAssessment({ justification: "trivial" })),
      makeResult(
        makeAssessment({ scope: "everyone", level: "high", justification: "hits everyone" }),
      ),
    ]);
    expect(merged?.justification).toBe("hits everyone");
  });

  it("dedupes reasons case-insensitively, keeping first spelling and order", () => {
    const merged = mergeRiskAssessments([
      makeResult(makeAssessment({ reasons: ["Migration", " authz "] })),
      makeResult(makeAssessment({ reasons: ["migration", "", "deps"] })),
    ]);
    expect(merged?.reasons).toEqual(["Migration", "authz", "deps"]);
  });
});

describe("readRiskLabel", () => {
  it("reads the level from a prefixed label, ignoring case and whitespace", () => {
    expect(readRiskLabel(["bug", " Risk:HIGH "], "risk:")).toEqual({
      status: "ok",
      level: "high",
    });
  });

  it("reports a missing label when nothing matches the prefix or the value is unknown", () => {
    expect(readRiskLabel(["bug", "risk:critical"], "risk:")).toEqual({ status: "missing" });
    expect(readRiskLabel([], "risk:")).toEqual({ status: "missing" });
  });

  it("reports ambiguity when two different levels are present", () => {
    expect(readRiskLabel(["risk:low", "risk:high"], "risk:")).toEqual({
      status: "ambiguous",
      levels: ["low", "high"],
    });
  });

  it("treats a repeated identical label as one", () => {
    expect(readRiskLabel(["risk:low", "RISK:low"], "risk:")).toEqual({
      status: "ok",
      level: "low",
    });
  });

  it("does not match the prefix in the middle of a label", () => {
    expect(readRiskLabel(["no-risk:high"], "risk:")).toEqual({ status: "missing" });
  });
});
