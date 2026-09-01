import type { Recommendation, Severity } from "../types.js";

const RECOMMENDATION_RANK: Record<Recommendation, number> = {
  looks_good: 0,
  address_before_merge: 1,
  critical_issues: 2,
};

// max over severity rank: findings set the floor, an elevated recommendation
// (from consensus pass votes) can raise it further but never lower it below
// what the findings imply.
export function deriveMergedRecommendation(
  findings: readonly { severity: Severity }[],
  elevated: readonly Recommendation[],
): Recommendation {
  const fromFindings: Recommendation = findings.some((f) => f.severity === "critical")
    ? "critical_issues"
    : findings.some((f) => f.severity === "warning")
      ? "address_before_merge"
      : "looks_good";
  return [fromFindings, ...elevated].reduce((a, b) =>
    RECOMMENDATION_RANK[b] > RECOMMENDATION_RANK[a] ? b : a,
  );
}
