import { describe, it, expect } from "vitest";
import { deriveMergedRecommendation } from "../agent/recommendation.js";

describe("deriveMergedRecommendation", () => {
  it("returns looks_good for suggestion-only findings", () => {
    const result = deriveMergedRecommendation([{ severity: "suggestion" }], []);
    expect(result).toBe("looks_good");
  });

  it("returns address_before_merge when a warning is present", () => {
    const result = deriveMergedRecommendation([{ severity: "warning" }], []);
    expect(result).toBe("address_before_merge");
  });

  it("returns critical_issues when a critical finding beats an elevated address_before_merge", () => {
    const result = deriveMergedRecommendation([{ severity: "critical" }], ["address_before_merge"]);
    expect(result).toBe("critical_issues");
  });

  it("returns critical_issues when an elevated critical_issues beats a findings-derived address_before_merge", () => {
    const result = deriveMergedRecommendation([{ severity: "warning" }], ["critical_issues"]);
    expect(result).toBe("critical_issues");
  });

  it("returns looks_good when findings and elevated are both empty", () => {
    const result = deriveMergedRecommendation([], []);
    expect(result).toBe("looks_good");
  });
});
