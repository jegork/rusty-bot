import { z } from "zod";

export const SeveritySchema = z.enum(["critical", "warning", "suggestion"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const FocusAreaSchema = z.enum([
  "security",
  "performance",
  "bugs",
  "style",
  "tests",
  "docs",
]);
export type FocusArea = z.infer<typeof FocusAreaSchema>;

export const ReviewStyleSchema = z.enum(["strict", "balanced", "lenient", "roast", "thorough"]);
export type ReviewStyle = z.infer<typeof ReviewStyleSchema>;

export const RecommendationSchema = z.enum([
  "looks_good",
  "address_before_merge",
  "critical_issues",
]);
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const TicketComplianceStatusSchema = z.enum([
  "addressed",
  "partially_addressed",
  "not_addressed",
  "unclear",
]);
export type TicketComplianceStatus = z.infer<typeof TicketComplianceStatusSchema>;

export const FindingSchema = z.object({
  file: z.string(),
  line: z.number(),
  endLine: z
    .number()
    .nullable()
    .describe(
      "last line of the range when the fix spans multiple lines; null for single-line fixes",
    ),
  severity: SeveritySchema,
  category: FocusAreaSchema,
  message: z.string(),
  suggestedFix: z
    .string()
    .nullable()
    .describe(
      "exact replacement code for the line(s) from `line` to `endLine` — raw code only, no markdown fences, no extra context lines; null when no localized fix is possible",
    ),
});

// extends LLM output with consensus pipeline metadata
export type Finding = z.infer<typeof FindingSchema> & {
  voteCount?: number;
};

export const SkimFindingSchema = z.object({
  file: z.string(),
  line: z.number(),
  endLine: z
    .number()
    .nullable()
    .describe(
      "last line of the range when the issue spans multiple lines; null for single-line issues",
    ),
  severity: SeveritySchema,
  category: FocusAreaSchema,
  message: z.string(),
  suggestedFix: z
    .string()
    .nullable()
    .describe(
      "exact replacement code for the line(s) from `line` to `endLine` — raw code only, no markdown fences, no extra context lines; null when no localized fix is possible",
    ),
});

export const ObservationSchema = z.object({
  file: z.string(),
  line: z.number(),
  severity: SeveritySchema,
  category: FocusAreaSchema,
  message: z.string(),
});

// extends LLM output with consensus pipeline metadata
export type Observation = z.infer<typeof ObservationSchema> & {
  voteCount?: number;
};

export const TicketComplianceSchema = z.object({
  ticketId: z
    .string()
    .nullable()
    .describe("linked ticket identifier when available, otherwise null"),
  requirement: z.string().describe("single ticket requirement or acceptance criterion"),
  status: TicketComplianceStatusSchema.describe("whether the diff addresses the requirement"),
  evidence: z
    .string()
    .nullable()
    .describe("brief evidence from the diff supporting the compliance status, otherwise null"),
});

export type TicketComplianceItem = z.infer<typeof TicketComplianceSchema>;

export const MissingTestSchema = z.object({
  file: z.string().describe("source file that lacks test coverage"),
  description: z
    .string()
    .describe(
      "concrete test case or scenario that should be added, e.g. 'edge case: empty input array' or 'error path: API returns 500'",
    ),
});

export type MissingTestItem = z.infer<typeof MissingTestSchema>;

export const ScopeCreepSchema = z.object({
  file: z.string().describe("changed file containing the out-of-scope change"),
  description: z
    .string()
    .describe(
      "one sentence naming what the change does and why it falls outside the PR's stated intent",
    ),
});

export type ScopeCreepItem = z.infer<typeof ScopeCreepSchema>;

export const RiskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const RiskScopeSchema = z.enum(["one_user", "one_feature", "everyone"]);
export const RiskDetectabilitySchema = z.enum(["immediate", "monitored", "silent"]);
export const RiskReversibilitySchema = z.enum(["redeploy", "rerun", "repair"]);

export const RiskAssessmentOutputSchema = z.object({
  scope: RiskScopeSchema.describe(
    "who is affected if the change is wrong: one_user (one user or one screen), one_feature (users of one feature, client or dossier), everyone (every user, all stored data, or the whole service)",
  ),
  detectability: RiskDetectabilitySchema.describe(
    "how a defect would be found: immediate (the user sees it right away), monitored (logs, metrics or a failing job), silent (nobody notices: wrong numbers, a silent no-op, silent data exposure)",
  ),
  reversibility: RiskReversibilitySchema.describe(
    "whether a redeploy undoes a defect: redeploy (yes), rerun (yes, after re-running a job or migration), repair (no: stored data must be repaired, or data has already left the system)",
  ),
  reasons: z
    .array(z.string())
    .describe(
      "short tags naming what drives the risk, e.g. migration, authz, external-contract, money-math, resource, prompt, infra, deps, ui-only; empty only when nothing drives it",
    ),
  justification: z
    .string()
    .describe(
      "one paragraph explaining the three answers with reference to concrete changes in the diff",
    ),
});

export type RiskAssessmentOutput = z.infer<typeof RiskAssessmentOutputSchema>;
export type RiskAxes = Pick<RiskAssessmentOutput, "scope" | "detectability" | "reversibility">;

// the level is derived in code from the three axes (see agent/risk.ts), so the
// model only answers the questions and never picks the verdict itself
export type RiskAssessment = RiskAssessmentOutput & { level: RiskLevel };

export const ReviewOutputSchema = z.object({
  summary: z.string().describe("concise summary of the PR and overall assessment"),
  recommendation: RecommendationSchema.describe("merge recommendation based on findings"),
  findings: z
    .array(FindingSchema)
    .describe("issues found in the changed code, tied to specific lines in the diff"),
  observations: z
    .array(ObservationSchema)
    .describe("issues found in referenced but unchanged code"),
  ticketCompliance: z
    .array(TicketComplianceSchema)
    .describe(
      "requirement-by-requirement compliance checklist for linked tickets; empty when no linked tickets are available",
    ),
  missingTests: z
    .array(MissingTestSchema)
    .describe(
      "concrete test cases that should be added for the changed code; each entry describes a specific scenario, not a vague 'add tests' suggestion. Empty when test coverage appears adequate.",
    ),
  filesReviewed: z.array(z.string()).describe("list of file paths that were reviewed"),
});

export type ReviewOutput = z.infer<typeof ReviewOutputSchema>;

// only used when RUSTY_FLAG_SCOPE_CREEP is on so the base schema stays
// identical for everyone else
export const ScopeCreepReviewOutputSchema = ReviewOutputSchema.extend({
  scopeCreep: z
    .array(ScopeCreepSchema)
    .describe(
      "changes in the diff that do not serve the PR's stated intent; empty when every change is in scope or the intent cannot be established",
    ),
});

const RISK_ASSESSMENT_FIELD = {
  riskAssessment: RiskAssessmentOutputSchema.describe(
    "risk assessment of the whole PR, answering the three questions in the risk assessment rules",
  ),
};

export const RiskReviewOutputSchema = ReviewOutputSchema.extend(RISK_ASSESSMENT_FIELD);
export const ScopeCreepRiskReviewOutputSchema =
  ScopeCreepReviewOutputSchema.extend(RISK_ASSESSMENT_FIELD);

export type DeepReviewOutputSchema =
  | typeof ReviewOutputSchema
  | typeof ScopeCreepReviewOutputSchema
  | typeof RiskReviewOutputSchema
  | typeof ScopeCreepRiskReviewOutputSchema;

/** pick the deep-review output schema for the enabled optional sections */
export function selectDeepReviewOutputSchema(options: {
  scopeCreep?: boolean;
  riskAssessment?: boolean;
}): DeepReviewOutputSchema {
  if (options.scopeCreep && options.riskAssessment) return ScopeCreepRiskReviewOutputSchema;
  if (options.scopeCreep) return ScopeCreepReviewOutputSchema;
  if (options.riskAssessment) return RiskReviewOutputSchema;
  return ReviewOutputSchema;
}

export const SkimReviewOutputSchema = z.object({
  summary: z.string().describe("concise summary of the PR and overall assessment"),
  recommendation: RecommendationSchema.describe("merge recommendation based on findings"),
  findings: z
    .array(SkimFindingSchema)
    .describe("issues found in the changed code, tied to specific lines in the diff"),
  observations: z
    .array(ObservationSchema)
    .describe("issues found in referenced but unchanged code"),
  filesReviewed: z.array(z.string()).describe("list of file paths that were reviewed"),
});
