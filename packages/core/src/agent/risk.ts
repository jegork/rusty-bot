import type { ReviewResult, RiskAssessment, RiskLevel } from "../types.js";
import type { RiskAxes } from "./schema.js";

export const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high"];

const SCOPE_RANK: Record<RiskAxes["scope"], number> = {
  one_user: 0,
  one_feature: 1,
  everyone: 2,
};
const DETECTABILITY_RANK: Record<RiskAxes["detectability"], number> = {
  immediate: 0,
  monitored: 1,
  silent: 2,
};
const REVERSIBILITY_RANK: Record<RiskAxes["reversibility"], number> = {
  redeploy: 0,
  rerun: 1,
  repair: 2,
};

// the rubric lives here, not in the model: any axis at its worst makes the
// change high, all three at their best make it low, the rest is medium
export function deriveRiskLevel(axes: RiskAxes): RiskLevel {
  const ranks = [
    SCOPE_RANK[axes.scope],
    DETECTABILITY_RANK[axes.detectability],
    REVERSIBILITY_RANK[axes.reversibility],
  ];
  if (ranks.some((r) => r === 2)) return "high";
  if (ranks.every((r) => r === 0)) return "low";
  return "medium";
}

export function compareRiskLevels(a: RiskLevel, b: RiskLevel): number {
  return RISK_LEVELS.indexOf(a) - RISK_LEVELS.indexOf(b);
}

function worstOf<K extends string>(rank: Record<K, number>, values: K[]): K {
  return values.reduce((worst, v) => (rank[v] > rank[worst] ? v : worst));
}

// consensus passes and diff chunks each answer the three questions for what
// they saw; the PR as a whole is as risky as its riskiest part
export function mergeRiskAssessments(results: ReviewResult[]): RiskAssessment | undefined {
  const assessments = results.flatMap((r) => (r.riskAssessment ? [r.riskAssessment] : []));
  if (assessments.length === 0) return undefined;
  if (assessments.length === 1) return assessments[0];

  const axes: RiskAxes = {
    scope: worstOf(
      SCOPE_RANK,
      assessments.map((a) => a.scope),
    ),
    detectability: worstOf(
      DETECTABILITY_RANK,
      assessments.map((a) => a.detectability),
    ),
    reversibility: worstOf(
      REVERSIBILITY_RANK,
      assessments.map((a) => a.reversibility),
    ),
  };
  const level = deriveRiskLevel(axes);

  const seen = new Set<string>();
  const reasons: string[] = [];
  for (const reason of assessments.flatMap((a) => a.reasons)) {
    const key = reason.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    reasons.push(reason.trim());
  }

  // the justification that argued for the merged level explains it best
  const representative = assessments.find((a) => a.level === level) ?? assessments[0];

  return { ...axes, level, reasons, justification: representative.justification };
}

export type RiskLabelResult =
  | { status: "ok"; level: RiskLevel }
  | { status: "missing" }
  | { status: "ambiguous"; levels: RiskLevel[] };

/** read the author's risk level from PR labels such as `risk:high` */
export function readRiskLabel(labels: string[], prefix: string): RiskLabelResult {
  const normalizedPrefix = prefix.toLowerCase();
  const levels: RiskLevel[] = [];
  for (const label of labels) {
    const normalized = label.trim().toLowerCase();
    if (!normalized.startsWith(normalizedPrefix)) continue;
    const value = normalized.slice(normalizedPrefix.length).trim();
    const level = RISK_LEVELS.find((l) => l === value);
    if (level && !levels.includes(level)) levels.push(level);
  }
  if (levels.length === 0) return { status: "missing" };
  if (levels.length > 1) return { status: "ambiguous", levels };
  return { status: "ok", level: levels[0] };
}
