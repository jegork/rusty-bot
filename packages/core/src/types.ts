export type {
  Severity,
  FocusArea,
  ReviewStyle,
  Recommendation,
  TicketComplianceStatus,
  Finding,
  Observation,
  TicketComplianceItem,
  MissingTestItem,
  ScopeCreepItem,
  ReviewOutput,
} from "./agent/schema.js";

import type {
  Finding,
  Observation,
  FocusArea,
  ReviewStyle,
  Recommendation,
  Severity,
  ReviewOutput,
  ScopeCreepItem,
} from "./agent/schema.js";

export interface DroppedFinding {
  file: string;
  line: number;
  severity: Severity;
  message: string;
  voteCount: number;
}

export interface ConsensusMetadata {
  passes: number;
  /** configured threshold (`ceil(passes/2)` by default) — may not match the
   * threshold actually applied to clustering if the review degraded. */
  threshold: number;
  /** threshold actually used to filter clusters. equals `threshold` in healthy
   * runs; lower when partial pass failures triggered graceful degradation. */
  effectiveThreshold: number;
  /** true when fewer passes succeeded than the configured threshold required
   * and the review proceeded with a lowered effective threshold instead of
   * aborting. judge filtering becomes the primary quality gate in this case. */
  degraded: boolean;
  agreementRate: number;
  recommendationElevated: boolean;
  passRecommendations: Recommendation[];
  /** display names of every configured pass model, in slot order — includes
   * models whose pass failed. Use `successfulPassModels` for user-facing
   * attribution where credit should reflect what actually ran. */
  passModels?: string[];
  /** display names of pass models that produced a result (subset of
   * `passModels` in the same relative order). When `failedPasses > 0`, this
   * is what consumers should render as "reviewers" — `passModels` alone
   * would credit models whose call threw. Optional for backward compat with
   * older serialized metadata; consensus.ts always populates it. */
  successfulPassModels?: string[];
  passPlanReason?: string;
  /** number of consensus passes that threw before producing a result */
  failedPasses: number;
}

export type TriageClassification = "skip" | "skim" | "deep-review";

export interface TriageFileResult {
  path: string;
  classification: TriageClassification;
  reason: string;
}

export interface TriageResult {
  files: TriageFileResult[];
  modelUsed: string;
  tokenCount: number;
}

export interface TriageStats {
  filesSkipped: number;
  filesSkimmed: number;
  filesDeepReviewed: number;
  triageModelUsed: string;
  triageTokenCount: number;
}

export interface OpenGrepStats {
  /** whether opengrep was available to run */
  available: boolean;
  /** total findings from opengrep pre-scan */
  findingCount: number;
  /** error message if opengrep failed */
  error?: string;
}

export interface ReviewResult extends ReviewOutput {
  findings: Finding[];
  observations: Observation[];
  modelUsed: string;
  tokenCount: number;
  triageStats?: TriageStats;
  /** number of findings removed by the judge pass */
  filteredCount?: number;
  /** tokens consumed by the judge pass */
  judgeTokenCount?: number;
  /** "failed" when the judge errored or returned unusable output; undefined when the judge was disabled */
  judgeStatus?: "ok" | "failed";
  consensusMetadata?: ConsensusMetadata;
  droppedFindings?: DroppedFinding[];
  openGrepStats?: OpenGrepStats;
  /** out-of-scope changes; only populated when `ReviewConfig.flagScopeCreep` is on */
  scopeCreep?: ScopeCreepItem[];
}

export interface ReviewConfig {
  style: ReviewStyle;
  focusAreas: FocusArea[];
  ignorePatterns: string[];
  conventionFile?: string;
  consensusPasses?: number;
  consensusThreshold?: number | null;
  generateDescription?: boolean;
  /** ask the deep-review tier to list changes that fall outside the PR's stated intent */
  flagScopeCreep?: boolean;
}

export interface PRMetadata {
  id: string;
  title: string;
  description: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  url: string;
  /** sha at the head of the source branch — populated by providers that can fetch it cheaply */
  headSha?: string;
}

export interface PostSummaryCommentOptions {
  /** when set, providers embed a hidden marker so the next run can resume incrementally */
  lastReviewedSha?: string;
  /** ADO equivalent of lastReviewedSha — iteration id of the just-completed review */
  lastReviewedIteration?: string;
  /** when set, providers embed an encoded marker the next incremental run can read back as PR-wide context */
  priorContext?: PriorReviewContext;
}

export interface PriorReviewContextFinding {
  file: string;
  line: number;
  severity: Severity;
  message: string;
}

/**
 * carry-forward state from a previous review pass. on incremental re-review the next
 * pass only sees the diff since the last review, so we hand it the prior summary +
 * already-surfaced findings so it can keep PR-wide situational awareness without
 * re-reading the full PR diff.
 */
export interface PriorReviewContext {
  summary: string;
  recommendation: Recommendation;
  findings: PriorReviewContextFinding[];
  /** file paths covered by the prior review pass. lets the next incremental
   * re-review know which work was already evaluated, so it doesn't flag features
   * from linked tickets as "missing" when those features landed in earlier
   * commits and were already approved. optional for backward compat with markers
   * encoded before this field existed; decoders treat missing as undefined. */
  filesReviewed?: string[];
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export interface FilePatch {
  path: string;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface TicketInfo {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria?: string;
  labels: string[];
  source: string;
}

export interface TicketResolutionStatus {
  /** Total linked ticket references detected before any cap is applied. */
  totalRefsFound: number;
  /** Number of refs actually considered for resolution after the MAX_TICKETS cap. */
  refsConsidered: number;
  /** Number of refs dropped because they exceeded the MAX_TICKETS cap. */
  refsSkippedByLimit: number;
  /** Number of considered refs successfully fetched into TicketInfo objects. */
  fetched: number;
  /** Number of considered refs skipped because no provider was configured for their source. */
  consideredMissingProvider: number;
  /** Number of considered refs where the provider was available but the fetch still failed. */
  consideredFetchFailed: number;
}

export type TicketSource = "github" | "jira" | "linear" | "azure-devops" | "gitlab";

export interface TicketRef {
  id: string;
  source: TicketSource;
  url?: string;
}

export interface CodeSearchResult {
  file: string;
  line: number;
  content: string;
}

export interface GitProvider {
  getDiff(): Promise<FilePatch[]>;
  getPRMetadata(): Promise<PRMetadata>;
  getFileContent(path: string, ref: string): Promise<string | null>;
  searchCode(query: string): Promise<CodeSearchResult[]>;
  postSummaryComment(markdown: string, options?: PostSummaryCommentOptions): Promise<void>;
  postInlineComments(findings: Finding[]): Promise<void>;
  deleteExistingBotComments(): Promise<void>;
  updatePRDescription(description: string): Promise<void>;
  updatePRTitle(title: string): Promise<void>;
  /** read the sha embedded in a previously-posted summary comment, if any */
  getLastReviewedSha?(): Promise<string | null>;
  /** fetch only the diff between an earlier sha and the current head; null if unreachable */
  getDiffSinceSha?(sinceSha: string, headSha: string): Promise<FilePatch[] | null>;
  /** read PR-wide context (summary + findings) embedded in a previously-posted summary comment, if any */
  getPriorReviewContext?(): Promise<PriorReviewContext | null>;
}

export interface TicketProvider {
  fetchTicket(ref: string): Promise<TicketInfo | null>;
}
