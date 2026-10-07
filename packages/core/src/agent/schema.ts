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
