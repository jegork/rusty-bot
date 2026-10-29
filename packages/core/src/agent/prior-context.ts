import type { PriorReviewContext, PriorReviewContextFinding, ReviewResult } from "../types.js";

const MARKER_PREFIX = "<!-- rusty-bot:context:";
const MARKER_SUFFIX = " -->";
export const PRIOR_CONTEXT_MARKER_RE = /<!--\s*rusty-bot:context:([A-Za-z0-9+/=]+)\s*-->/i;

const PRIOR_CONTEXT_MARKER_GLOBAL_RE = new RegExp(PRIOR_CONTEXT_MARKER_RE.source, "gi");

const SUMMARY_CHAR_CAP = 4_000;
const FINDING_MESSAGE_CHAR_CAP = 250;
const FINDINGS_COUNT_CAP = 50;
const FILES_REVIEWED_COUNT_CAP = 100;
const TRUNCATED_SUFFIX = "\n\n[truncated]";
const ELLIPSIS = "…";

const RECOMMENDATIONS = new Set(["looks_good", "address_before_merge", "critical_issues"]);

const SEVERITIES = new Set(["suggestion", "warning", "critical"]);

function truncateMessage(message: string): string {
  if (message.length <= FINDING_MESSAGE_CHAR_CAP) return message;
  return message.slice(0, FINDING_MESSAGE_CHAR_CAP) + ELLIPSIS;
}

function truncateSummary(summary: string): string {
  if (summary.length <= SUMMARY_CHAR_CAP) return summary;
  return summary.slice(0, SUMMARY_CHAR_CAP) + TRUNCATED_SUFFIX;
}

export function buildPriorContextFromReview(review: ReviewResult): PriorReviewContext {
  return {
    summary: review.summary,
    recommendation: review.recommendation,
    findings: review.findings.map((f) => ({
      file: f.file,
      line: f.line,
      severity: f.severity,
      message: f.message,
    })),
    filesReviewed: review.filesReviewed,
  };
}

/** serialize prior-context state into a hidden comment marker, applying caps. */
export function encodePriorReviewContext(ctx: PriorReviewContext): string {
  const truncated: PriorReviewContext = {
    summary: truncateSummary(ctx.summary),
    recommendation: ctx.recommendation,
    findings: ctx.findings.slice(0, FINDINGS_COUNT_CAP).map((f) => ({
      file: f.file,
      line: f.line,
      severity: f.severity,
      message: truncateMessage(f.message),
    })),
    ...(ctx.filesReviewed && ctx.filesReviewed.length > 0
      ? { filesReviewed: ctx.filesReviewed.slice(0, FILES_REVIEWED_COUNT_CAP) }
      : {}),
  };
  const json = JSON.stringify(truncated);
  const b64 = Buffer.from(json, "utf-8").toString("base64");
  return `${MARKER_PREFIX}${b64}${MARKER_SUFFIX}`;
}

function isFinding(value: unknown): value is PriorReviewContextFinding {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.file === "string" &&
    typeof v.line === "number" &&
    typeof v.severity === "string" &&
    SEVERITIES.has(v.severity) &&
    typeof v.message === "string"
  );
}

function isContext(value: unknown): value is PriorReviewContext {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.summary !== "string") return false;
  if (typeof v.recommendation !== "string") return false;
  if (!RECOMMENDATIONS.has(v.recommendation)) return false;
  if (!Array.isArray(v.findings)) return false;
  if (!v.findings.every(isFinding)) return false;
  // filesReviewed is optional (older markers don't have it); when present must
  // be an array of strings — anything else means the payload was tampered with
  // or produced by a buggy encoder, both of which should fall back to null.
  if (v.filesReviewed !== undefined) {
    if (!Array.isArray(v.filesReviewed)) return false;
    if (!v.filesReviewed.every((p) => typeof p === "string")) return false;
  }
  return true;
}

/** extract a prior-context marker from a comment body. returns null on absence or any malformedness. */
export function extractPriorReviewContext(commentBody: string): PriorReviewContext | null {
  // providers write the marker in the header lines above the first blank line; anything
  // later is model-authored text and must not be able to supply a marker
  const header = commentBody.split(/\r?\n[ \t]*\r?\n/, 1)[0];
  const match = PRIOR_CONTEXT_MARKER_RE.exec(header);
  if (!match) return null;
  try {
    const json = Buffer.from(match[1], "base64").toString("utf-8");
    const parsed: unknown = JSON.parse(json);
    return isContext(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** remove anything shaped like a prior-context marker from model-authored text. */
export function stripPriorContextMarkers(text: string): string {
  let out = text;
  // loop so removing one marker cannot splice its neighbours into a new one
  for (let prev = ""; prev !== out;) {
    prev = out;
    out = out.replace(PRIOR_CONTEXT_MARKER_GLOBAL_RE, "");
  }
  return out;
}

export const PRIOR_CONTEXT_LIMITS = {
  summaryCharCap: SUMMARY_CHAR_CAP,
  findingMessageCharCap: FINDING_MESSAGE_CHAR_CAP,
  findingsCountCap: FINDINGS_COUNT_CAP,
  filesReviewedCountCap: FILES_REVIEWED_COUNT_CAP,
} as const;
