import type { RiskAssessment, RiskLevel } from "../types.js";
import type { RiskLabelResult } from "../agent/risk.js";

const LEVEL_LABEL: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" };

const SCOPE_TEXT: Record<RiskAssessment["scope"], string> = {
  one_user: "one user or one screen",
  one_feature: "users of one feature, client or dossier",
  everyone: "every user, all data or the whole service",
};
const DETECTABILITY_TEXT: Record<RiskAssessment["detectability"], string> = {
  immediate: "the user sees it immediately",
  monitored: "logs, metrics or a failing job",
  silent: "nobody notices",
};
const REVERSIBILITY_TEXT: Record<RiskAssessment["reversibility"], string> = {
  redeploy: "a redeploy undoes it",
  rerun: "a redeploy plus a re-run",
  repair: "data must be repaired or has already left",
};

export function formatRiskLevel(level: RiskLevel): string {
  return LEVEL_LABEL[level];
}

export function buildRiskAxesTable(assessment: RiskAssessment): string {
  return [
    "| Question | Answer |",
    "|----------|--------|",
    `| Who is affected if it is wrong? | ${SCOPE_TEXT[assessment.scope]} |`,
    `| How would we find out? | ${DETECTABILITY_TEXT[assessment.detectability]} |`,
    `| Does a redeploy undo it? | ${REVERSIBILITY_TEXT[assessment.reversibility]} |`,
  ].join("\n");
}

export function buildRiskSection(
  assessment: RiskAssessment,
  authorLevel?: RiskLevel | null,
): string {
  const heading =
    authorLevel && authorLevel !== assessment.level
      ? `## Risk: ${LEVEL_LABEL[assessment.level]} (author says ${LEVEL_LABEL[authorLevel]})`
      : `## Risk: ${LEVEL_LABEL[assessment.level]}`;
  const lines = [heading, "", buildRiskAxesTable(assessment), ""];
  if (assessment.reasons.length > 0) {
    lines.push(`**Reasons:** ${assessment.reasons.map((r) => `\`${r}\``).join(", ")}`, "");
  }
  lines.push(assessment.justification, "");
  return lines.join("\n");
}

/** posted as its own thread when the bot rates the PR higher than the author's label */
export function formatRiskDisagreementComment(
  authorLevel: RiskLevel,
  assessment: RiskAssessment,
  labelPrefix: string,
): string {
  return [
    `## Risk label disagreement`,
    "",
    `The author labelled this PR \`${labelPrefix}${authorLevel}\`; this review rates it **${LEVEL_LABEL[assessment.level]}**.`,
    "",
    buildRiskAxesTable(assessment),
    "",
    ...(assessment.reasons.length > 0
      ? [`**Reasons:** ${assessment.reasons.map((r) => `\`${r}\``).join(", ")}`, ""]
      : []),
    assessment.justification,
    "",
    `Either change the label to \`${labelPrefix}${assessment.level}\` or reply with why \`${labelPrefix}${authorLevel}\` is right, then resolve this thread.`,
  ].join("\n");
}

export function formatMissingRiskLabelComment(
  result: RiskLabelResult,
  labelPrefix: string,
): string {
  const levels = ["low", "medium", "high"].map((l) => `\`${labelPrefix}${l}\``).join(", ");
  if (result.status === "ambiguous") {
    return `## Risk label required\n\nThis PR carries more than one risk label (${result.levels.map((l) => `\`${labelPrefix}${l}\``).join(", ")}). Keep exactly one of ${levels}.`;
  }
  return `## Risk label required\n\nAdd exactly one of ${levels} to this PR. The label states who is affected if the change is wrong, how it would be noticed, and whether a redeploy undoes it.`;
}
