import { describe, expect, it } from "vitest";
import { formatMissingRiskLabelComment, formatRiskDisagreementComment } from "../formatter/risk.js";
import type { RiskAssessment } from "../types.js";

const assessment: RiskAssessment = {
  scope: "one_feature",
  detectability: "silent",
  reversibility: "redeploy",
  reasons: ["financial-figures"],
  justification: "A missing amount is now read as zero, so a validity check passes.",
  level: "high",
};

describe("formatRiskDisagreementComment", () => {
  it("names both labels and tells the author how to close the thread", () => {
    const text = formatRiskDisagreementComment("low", assessment, "risk:");
    expect(text).toContain("`risk:low`");
    expect(text).toContain("rates it **High**");
    expect(text).toContain("| How would we find out? | nobody notices |");
    expect(text).toContain("**Reasons:** `financial-figures`");
    expect(text).toContain("change the label to `risk:high`");
    expect(text).toContain("resolve this thread");
  });

  it("uses the configured prefix verbatim", () => {
    expect(formatRiskDisagreementComment("medium", assessment, "Risk/")).toContain("`Risk/high`");
  });
});

describe("formatMissingRiskLabelComment", () => {
  it("lists the accepted labels when none is present", () => {
    const text = formatMissingRiskLabelComment({ status: "missing" }, "risk:");
    expect(text).toContain("`risk:low`, `risk:medium`, `risk:high`");
  });

  it("names the conflicting labels when more than one is present", () => {
    const text = formatMissingRiskLabelComment(
      { status: "ambiguous", levels: ["low", "high"] },
      "risk:",
    );
    expect(text).toContain("more than one risk label (`risk:low`, `risk:high`)");
  });
});
