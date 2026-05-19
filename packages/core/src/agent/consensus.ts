import type {
  FilePatch,
  ReviewConfig,
  PRMetadata,
  TicketInfo,
  ReviewResult,
  Finding,
  Observation,
  Recommendation,
  DroppedFinding,
} from "../types.js";
import { compressDiff } from "../diff/compress.js";
import { shufflePatches } from "../diff/shuffle.js";
import { clusterFindings, clusterObservations } from "./cluster.js";
import { runReview, type RunReviewOptions } from "./review.js";
import { mergeMissingTests } from "./multi-call.js";
import { resolveReviewPassModelConfigs } from "./model.js";
import { logger } from "../logger.js";

const DEFAULT_CONSENSUS_PASSES = 3;
const LARGE_REVIEW_LINE_THRESHOLD = 300;
const SECURITY_SENSITIVE_PATH = /\b(auth|crypto|payment|permission|token|session|policy|secret)\b/i;

const RECOMMENDATION_SEVERITY: Record<Recommendation, number> = {
  looks_good: 0,
  address_before_merge: 1,
  critical_issues: 2,
};

function deriveBaseSeed(prMetadata: PRMetadata): number {
  let hash = 0;
  const str = `${prMetadata.id}:${prMetadata.sourceBranch}`;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return hash >>> 0;
}

function deriveRecommendation(
  findings: Finding[],
  passRecommendations: Recommendation[],
  threshold: number,
): Recommendation {
  const hasCritical = findings.some((f) => f.severity === "critical");
  if (hasCritical) return "critical_issues";
  if (findings.length > 0) return "address_before_merge";

  // when findings are empty, check if a majority of passes flagged issues —
  // this catches cases where the LLM describes problems in its summary/recommendation
  // but doesn't emit structured findings
  const nonGoodCount = passRecommendations.filter((r) => RECOMMENDATION_SEVERITY[r] > 0).length;

  if (nonGoodCount >= threshold) {
    const criticalCount = passRecommendations.filter((r) => r === "critical_issues").length;
    if (criticalCount >= threshold) return "critical_issues";
    return "address_before_merge";
  }

  return "looks_good";
}

function isAdaptivePassPlanningEnabled(): boolean {
  const raw = process.env.RUSTY_REVIEW_ADAPTIVE_PASSES;
  if (raw === undefined || raw === "") return true;
  return raw === "true" || raw === "1";
}

function isSecuritySensitivePatch(patch: FilePatch): boolean {
  return SECURITY_SENSITIVE_PATH.test(patch.path);
}

function planConsensusPasses(
  patches: FilePatch[],
  configuredPasses: number,
): { passes: number; reason?: string } {
  if (!isAdaptivePassPlanningEnabled() || configuredPasses <= 1) {
    return { passes: configuredPasses };
  }

  const hasSecuritySensitiveFile = patches.some(isSecuritySensitivePatch);
  if (hasSecuritySensitiveFile) {
    return { passes: Math.min(configuredPasses, 3), reason: "security-sensitive file" };
  }

  const changedLines = patches.reduce((sum, patch) => sum + patch.additions + patch.deletions, 0);
  const hasLargeFile = patches.some(
    (patch) => patch.additions + patch.deletions >= LARGE_REVIEW_LINE_THRESHOLD,
  );

  if (changedLines >= LARGE_REVIEW_LINE_THRESHOLD || hasLargeFile) {
    return { passes: Math.min(configuredPasses, 3), reason: "large deep-review chunk" };
  }

  return { passes: Math.min(configuredPasses, 2), reason: "ordinary deep-review chunk" };
}

function deriveConsensusThreshold(configuredThreshold: number | null | undefined, passes: number) {
  return Math.min(configuredThreshold ?? Math.floor(passes / 2) + 1, passes);
}

export async function runConsensusReview(
  patches: FilePatch[],
  config: ReviewConfig,
  prMetadata: PRMetadata,
  diff: string,
  ticketContext?: TicketInfo[],
  options?: RunReviewOptions,
): Promise<ReviewResult> {
  const configuredPasses = config.consensusPasses ?? DEFAULT_CONSENSUS_PASSES;
  const passPlan = planConsensusPasses(patches, configuredPasses);
  const passes = passPlan.passes;

  if (passes <= 1) {
    const [singlePassModel] = resolveReviewPassModelConfigs(1);
    return runReview(config, diff, prMetadata, ticketContext, {
      ...options,
      modelConfig: options?.modelConfig ?? singlePassModel.config,
      modelSettings: options?.modelSettings ?? singlePassModel.settings,
    });
  }

  const threshold = deriveConsensusThreshold(config.consensusThreshold, passes);
  const baseSeed = deriveBaseSeed(prMetadata);
  const passModelConfigs = resolveReviewPassModelConfigs(passes);

  logger.info(
    {
      passes,
      threshold,
      prId: prMetadata.id,
      passPlanReason: passPlan.reason,
      passModels: passModelConfigs.map((m) => m.displayName),
    },
    "starting consensus review",
  );

  const passPromises = Array.from({ length: passes }, (_, i) => {
    const shuffled = shufflePatches(patches, baseSeed + i);
    const { compressed } = compressDiff(shuffled, Infinity);
    const tickets = i === 0 ? ticketContext : undefined;
    const passModel = passModelConfigs[i];
    return runReview(config, compressed, prMetadata, tickets, {
      ...options,
      modelConfig: passModel.config,
      modelSettings: passModel.settings,
    });
  });

  const settled = await Promise.allSettled(passPromises);
  const results: ReviewResult[] = [];
  const failures: unknown[] = [];

  for (let i = 0; i < settled.length; i++) {
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      failures.push(outcome.reason);
      logger.warn(
        {
          err: outcome.reason,
          passIndex: i,
          model: passModelConfigs[i].displayName,
          prId: prMetadata.id,
        },
        "consensus pass failed",
      );
    }
  }

  // ticket compliance comes from pass 0 only — pass 0 is the single pass that
  // received `ticketContext` (line 140 above; this is a deliberate token-cost
  // optimization since linked tickets can be 5-10k tokens). settled[0] is
  // always pass 0 because Promise.allSettled preserves input order. when pass
  // 0 failed we have NO compliance data — returning a later pass's empty
  // compliance array would silently read as "no requirements outstanding,"
  // which is the opposite of the truth. emit an explicit warn and return empty.
  const pass0Outcome = settled[0];
  const pass0Result = pass0Outcome.status === "fulfilled" ? pass0Outcome.value : undefined;
  if (!pass0Result && ticketContext && ticketContext.length > 0) {
    logger.warn(
      { prId: prMetadata.id, passes, failedPasses: failures.length },
      "pass 0 failed; ticket compliance unavailable for this review (no fallback pass receives ticketContext)",
    );
  }

  if (results.length === 0) {
    throw new AggregateError(failures, `consensus review failed: 0/${passes} passes succeeded`);
  }

  // graceful degradation: when at least one pass survived but we're below the
  // configured threshold, fall back to the surviving pass count instead of
  // throwing. Single flaky upstream calls (e.g. STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED
  // on a model that emitted unparseable text) shouldn't abort the whole review.
  // the judge runs downstream of clustering and filters single-vote findings on
  // its own confidence rubric, so quality control is preserved.
  const effectiveThreshold = Math.min(threshold, results.length);
  const degraded = effectiveThreshold < threshold;
  if (degraded) {
    const survivingModels = settled
      .map((s, i) => (s.status === "fulfilled" ? passModelConfigs[i].displayName : null))
      .filter((m): m is string => m !== null);
    const failedModels = settled
      .map((s, i) => (s.status === "rejected" ? passModelConfigs[i].displayName : null))
      .filter((m): m is string => m !== null);
    logger.warn(
      {
        passes,
        configuredThreshold: threshold,
        effectiveThreshold,
        succeededPasses: results.length,
        failedPasses: failures.length,
        survivingModels,
        failedModels,
        prId: prMetadata.id,
      },
      "consensus review degraded — surviving passes below configured threshold; judge will filter",
    );
  }

  const failedPasses = failures.length;

  const findingsByPass = results.map((r) => r.findings);
  const observationsByPass = results.map((r) => r.observations);
  const passRecommendations = results.map((r) => r.recommendation);

  // gated by RUSTY_LOG_RAW_FINDINGS=true. emits per-pass finding lists
  // BEFORE clustering so we can tell whether models are actually
  // producing different findings (clustering's job is hard) vs. all
  // saying the same thing (clustering's job is easy). prerequisite for
  // tuning the consensus threshold / Jaccard similarity / line proximity
  // window — see CONSENSUS-QUALITY-WRITEUP.md. defaults to no-op.
  if (process.env.RUSTY_LOG_RAW_FINDINGS === "true") {
    for (let i = 0; i < results.length; i++) {
      logger.debug(
        {
          prId: prMetadata.id,
          passIndex: i,
          model: passModelConfigs[i].displayName,
          findingCount: results[i].findings.length,
          findings: results[i].findings.map((f) => ({
            file: f.file,
            line: f.line,
            severity: f.severity,
            category: f.category,
            message: f.message,
          })),
        },
        "raw consensus pass findings before clustering",
      );
    }
  }

  const findingClusters = clusterFindings(findingsByPass);
  const observationClusters = clusterObservations(observationsByPass);

  const survivingClusters = findingClusters.filter((c) => c.voteCount >= effectiveThreshold);
  const droppedClusters = findingClusters.filter((c) => c.voteCount < effectiveThreshold);

  const survivingFindings: Finding[] = survivingClusters.map((c) => ({
    ...c.representative,
    voteCount: c.voteCount,
  }));

  const droppedFindings: DroppedFinding[] = droppedClusters.map((c) => ({
    file: c.representative.file,
    line: c.representative.line,
    severity: c.representative.severity,
    message: c.representative.message,
    voteCount: c.voteCount,
  }));

  const survivingObservations: Observation[] = observationClusters
    .filter((c) => c.voteCount >= effectiveThreshold)
    .map((c) => ({ ...c.representative, voteCount: c.voteCount }));

  const allFiles = new Set(results.flatMap((r) => r.filesReviewed));
  const totalTokens = results.reduce((sum, r) => sum + r.tokenCount, 0);

  const totalRawObservations = observationsByPass.reduce((sum, pass) => sum + pass.length, 0);

  const recommendation = deriveRecommendation(
    survivingFindings,
    passRecommendations,
    effectiveThreshold,
  );
  const recommendationElevated = survivingFindings.length === 0 && recommendation !== "looks_good";

  const agreementRate =
    findingClusters.length > 0 ? survivingClusters.length / findingClusters.length : 1;

  logger.info(
    {
      passes,
      threshold,
      effectiveThreshold,
      degraded,
      failedPasses,
      totalClusters: findingClusters.length,
      surviving: survivingFindings.length,
      dropped: droppedFindings.length,
      droppedObservations: totalRawObservations - survivingObservations.length,
      agreementRate,
      passRecommendations,
      passModels: passModelConfigs.map((m) => m.displayName),
      passTokens: settled.map((outcome) =>
        outcome.status === "fulfilled" ? outcome.value.tokenCount : 0,
      ),
      totalTokens,
    },
    "consensus voting complete",
  );

  const summaries = results.map((r) => r.summary).filter(Boolean);
  const summary =
    summaries.length <= 1
      ? (summaries[0] ?? "")
      : `Consensus review (${passes} passes, threshold ${threshold}).\n\n${summaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;

  return {
    summary,
    recommendation,
    findings: survivingFindings,
    observations: survivingObservations,
    ticketCompliance: pass0Result?.ticketCompliance ?? [],
    missingTests: mergeMissingTests(results),
    filesReviewed: [...allFiles],
    modelUsed: results[0]?.modelUsed ?? "unknown",
    tokenCount: totalTokens,
    consensusMetadata: {
      passes,
      threshold,
      effectiveThreshold,
      degraded,
      agreementRate,
      recommendationElevated,
      passRecommendations,
      passModels: passModelConfigs.map((m) => m.displayName),
      // only credit models whose pass actually produced a result. an upstream
      // failure (e.g. an invalid model id on openrouter, a 422 from the
      // provider, a timeout) leaves the slot in `settled` as rejected — we
      // omit those from successfulPassModels so the formatter doesn't
      // attribute the review to a model that never ran.
      successfulPassModels: settled
        .map((s, i) => (s.status === "fulfilled" ? passModelConfigs[i].displayName : null))
        .filter((m): m is string => m !== null),
      ...(passPlan.reason ? { passPlanReason: passPlan.reason } : {}),
      failedPasses,
    },
    droppedFindings: droppedFindings.length > 0 ? droppedFindings : undefined,
  };
}
