import { compressDiff, countTokens } from "../diff/compress.js";
import {
  buildGraphRankedContext,
  resolveGraphContextConfig,
  type GraphContextConfig,
} from "../diff/graph-context.js";
import type {
  FilePatch,
  ReviewConfig,
  PRMetadata,
  TicketInfo,
  ReviewResult,
  Finding,
  Observation,
  TicketComplianceItem,
  TicketComplianceStatus,
  MissingTestItem,
  DroppedFinding,
} from "../types.js";
import type { OpenGrepFinding } from "../opengrep/types.js";
import { runReview, type RunReviewOptions, type ReviewTier } from "./review.js";
import { runConsensusReview } from "./consensus.js";
import { judgeReviewResult, resolveJudgeConfig } from "./judge.js";
import { resolveReviewPassModelConfigs } from "./model.js";
import type { McpServerConfig } from "../mcp/types.js";
import { connectMcpServers } from "../mcp/client.js";
import { logger } from "../logger.js";

export interface MultiCallReviewOptions extends RunReviewOptions {
  mcpServers?: McpServerConfig;
  maxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 60_000;
const TICKET_COMPLIANCE_PRIORITY: Record<TicketComplianceStatus, number> = {
  addressed: 3,
  partially_addressed: 2,
  unclear: 1,
  not_addressed: 0,
};

function splitIntoGroups(patches: FilePatch[], maxTokensPerGroup: number): FilePatch[][] {
  const groups: FilePatch[][] = [];
  let currentGroup: FilePatch[] = [];
  let currentTokens = 0;

  for (const patch of patches) {
    const { compressed } = compressDiff([patch], Infinity);
    const tokens = countTokens(compressed);

    if (currentGroup.length > 0 && currentTokens + tokens > maxTokensPerGroup) {
      groups.push(currentGroup);
      currentGroup = [patch];
      currentTokens = tokens;
    } else {
      currentGroup.push(patch);
      currentTokens += tokens;
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function estimateTicketContextTokens(ticketContext?: TicketInfo[]): number {
  if (!ticketContext || ticketContext.length === 0) return 0;

  const serialized = ticketContext
    .map((ticket) =>
      [
        ticket.id,
        ticket.title,
        ticket.description,
        ticket.acceptanceCriteria ?? "",
        ticket.labels.join(","),
      ].join("\n"),
    )
    .join("\n\n");

  return countTokens(serialized);
}

async function buildRankedContextForPatches(
  patches: FilePatch[],
  prMetadata: PRMetadata,
  options: RunReviewOptions,
  config: GraphContextConfig,
): Promise<string | undefined> {
  if (!config.enabled || patches.length === 0 || !options.provider || !options.sourceRef) {
    return undefined;
  }

  const provider = options.provider;
  const sourceRef = options.sourceRef;
  const result = await buildGraphRankedContext(
    patches,
    (path) => provider.getFileContent(path, sourceRef),
    prMetadata,
    config,
  );

  if (!result.renderedContext) return undefined;

  logger.info(
    {
      selected: result.selections.map((s) => ({
        path: s.path,
        score: s.score,
        mode: s.mode,
        tokens: s.tokens,
        reasons: s.reasons,
      })),
      tokenCount: result.tokenCount,
      tokenBudget: config.tokenBudget,
    },
    "selected graph-ranked context",
  );

  return result.renderedContext;
}

export function normalizePath(file: string): string {
  return file
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/:\d+(?::\d+)?$/, "");
}

export function filterOpenGrepForFiles(
  findings: OpenGrepFinding[] | undefined,
  files: Set<string>,
): OpenGrepFinding[] | undefined {
  if (!findings || findings.length === 0) return undefined;
  const normalizedFiles = new Set(Array.from(files, normalizePath));
  const filtered = findings.filter((f) => normalizedFiles.has(normalizePath(f.file)));
  return filtered.length > 0 ? filtered : undefined;
}

export function filterObservationsForPrFiles(
  observations: Observation[],
  prFiles: Set<string>,
): Observation[] {
  const normalizedPrFiles = new Set(Array.from(prFiles, normalizePath));
  return observations.filter((o) => !normalizedPrFiles.has(normalizePath(o.file)));
}

export function mergeResults(results: ReviewResult[], modelUsed: string): ReviewResult {
  const allFindings: Finding[] = [];
  const allObservations: Observation[] = [];
  const allFiles = new Set<string>();
  let totalTokens = 0;

  for (const result of results) {
    allFindings.push(...result.findings);
    allObservations.push(...result.observations);
    result.filesReviewed.forEach((f) => allFiles.add(f));
    totalTokens += result.tokenCount;
  }

  const seen = new Set<string>();
  const dedupedFindings = allFindings.filter((f) => {
    const key = `${f.file}:${f.line}:${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // observations cross-chunk-dedup mirrors findings — when chunks overlap or
  // observe the same unchanged code, we'd otherwise emit the same observation
  // multiple times in the merged result
  const seenObs = new Set<string>();
  const dedupedObservations = allObservations.filter((o) => {
    const key = `${o.file}:${o.line}:${o.message}`;
    if (seenObs.has(key)) return false;
    seenObs.add(key);
    return true;
  });

  const droppedSeen = new Set<string>();
  const dedupedDropped: DroppedFinding[] = [];
  for (const r of results) {
    for (const d of r.droppedFindings ?? []) {
      const key = `${d.file}:${d.line}:${d.message}`;
      if (droppedSeen.has(key)) continue;
      droppedSeen.add(key);
      dedupedDropped.push(d);
    }
  }

  const criticalCount = dedupedFindings.filter((f) => f.severity === "critical").length;

  const summaries = results.map((r) => r.summary).filter(Boolean);
  const summary =
    summaries.length === 1
      ? summaries[0]
      : `Reviewed in ${results.length} passes.\n\n${summaries.join("\n\n")}`;

  const triageStats = results.find((r) => r.triageStats)?.triageStats;
  const consensusMetadata = results.find((r) => r.consensusMetadata)?.consensusMetadata;

  // preserve elevated recommendations from consensus passes even after merging
  const elevatedRecommendation = consensusMetadata?.recommendationElevated
    ? results.find((r) => r.consensusMetadata?.recommendationElevated)?.recommendation
    : undefined;

  const recommendation =
    elevatedRecommendation ??
    (criticalCount > 0
      ? ("critical_issues" as const)
      : dedupedFindings.length > 0
        ? ("address_before_merge" as const)
        : ("looks_good" as const));

  return {
    summary,
    recommendation,
    findings: dedupedFindings,
    observations: dedupedObservations,
    ticketCompliance: mergeTicketCompliance(results),
    missingTests: mergeMissingTests(results),
    filesReviewed: [...allFiles],
    modelUsed,
    tokenCount: totalTokens,
    ...(triageStats ? { triageStats } : {}),
    ...(consensusMetadata && { consensusMetadata }),
    ...(dedupedDropped.length > 0 && { droppedFindings: dedupedDropped }),
  };
}

function normalizeEvidence(evidence: string | null): string | null {
  const trimmed = evidence?.trim();
  return trimmed ? trimmed : null;
}

function normalizeComplianceKeyPart(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

interface TicketComplianceAccumulator extends TicketComplianceItem {
  evidenceParts: string[];
}

function mergeTicketCompliance(results: ReviewResult[]): TicketComplianceItem[] {
  const merged = new Map<string, TicketComplianceAccumulator>();

  for (const result of results) {
    for (const item of result.ticketCompliance) {
      const key = `${normalizeComplianceKeyPart(item.ticketId)}:${normalizeComplianceKeyPart(item.requirement)}`;
      const evidence = normalizeEvidence(item.evidence);
      const existing = merged.get(key);

      if (!existing) {
        merged.set(key, {
          ...item,
          evidence,
          evidenceParts: evidence ? [evidence] : [],
        });
        continue;
      }

      if (evidence && !existing.evidenceParts.includes(evidence)) {
        existing.evidenceParts.push(evidence);
      }

      const existingPriority = TICKET_COMPLIANCE_PRIORITY[existing.status];
      const nextPriority = TICKET_COMPLIANCE_PRIORITY[item.status];

      if (nextPriority > existingPriority) {
        existing.ticketId = item.ticketId;
        existing.requirement = item.requirement;
        existing.status = item.status;
      }
    }
  }

  return [...merged.values()].map(({ evidenceParts, ...item }) => ({
    ...item,
    evidence: evidenceParts.length > 0 ? evidenceParts.join(" | ") : null,
  }));
}

export function mergeMissingTests(results: ReviewResult[]): MissingTestItem[] {
  const seen = new Set<string>();
  const merged: MissingTestItem[] = [];

  for (const result of results) {
    for (const item of result.missingTests) {
      const key = `${item.file.toLowerCase()}:${item.description.toLowerCase().trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}

async function runTieredReview(
  patches: FilePatch[],
  config: ReviewConfig,
  prMetadata: PRMetadata,
  ticketContext: TicketInfo[] | undefined,
  resolvedOptions: RunReviewOptions,
  maxTokens: number,
  tier: ReviewTier,
  graphContextConfig: GraphContextConfig,
): Promise<ReviewResult[]> {
  if (patches.length === 0) return [];

  const tierPaths = new Set(patches.map((p) => p.path));
  const tierFindings = filterOpenGrepForFiles(resolvedOptions.openGrepFindings, tierPaths);
  const tierOptions: RunReviewOptions = {
    ...resolvedOptions,
    tier,
    openGrepFindings: tierFindings,
  };

  if (tier === "skim") {
    const [skimPassModel] = resolveReviewPassModelConfigs(1);
    const skimOptions: RunReviewOptions = {
      ...tierOptions,
      modelConfig: tierOptions.modelConfig ?? skimPassModel.config,
      modelSettings: tierOptions.modelSettings ?? skimPassModel.settings,
    };
    const { compressed, skippedFiles } = compressDiff(patches, maxTokens);
    if (skippedFiles.length === 0) {
      const result = await runReview(config, compressed, prMetadata, ticketContext, {
        ...skimOptions,
        chunkFiles: patches.map((p) => p.path),
      });
      return [result];
    }
    const groups = splitIntoGroups(patches, maxTokens);
    const results: ReviewResult[] = [];
    for (let i = 0; i < groups.length; i++) {
      const groupPaths = new Set(groups[i].map((p) => p.path));
      const groupOpenGrep = filterOpenGrepForFiles(resolvedOptions.openGrepFindings, groupPaths);
      const { compressed: groupDiff } = compressDiff(groups[i], maxTokens);
      const groupTickets = i === 0 ? ticketContext : undefined;
      const result = await runReview(config, groupDiff, prMetadata, groupTickets, {
        ...skimOptions,
        openGrepFindings: groupOpenGrep,
        chunkFiles: [...groupPaths],
      });
      results.push(result);
    }
    return results;
  }

  // deep-review: consensus + ticket compliance
  const rankedContext = await buildRankedContextForPatches(
    patches,
    prMetadata,
    resolvedOptions,
    graphContextConfig,
  );
  const { compressed, skippedFiles } = compressDiff(patches, maxTokens);
  if (skippedFiles.length === 0) {
    const result = await runConsensusReview(
      patches,
      config,
      prMetadata,
      compressed,
      ticketContext,
      { ...tierOptions, rankedContext, chunkFiles: patches.map((p) => p.path) },
    );
    return [result];
  }

  const groups = splitIntoGroups(patches, maxTokens);
  const results: ReviewResult[] = [];
  for (const group of groups) {
    const groupPaths = new Set(group.map((p) => p.path));
    const groupOpenGrep = filterOpenGrepForFiles(resolvedOptions.openGrepFindings, groupPaths);
    const groupRankedContext = await buildRankedContextForPatches(
      group,
      prMetadata,
      resolvedOptions,
      graphContextConfig,
    );
    const groupCompressed = compressDiff(group, maxTokens).compressed;
    const groupResult = await runConsensusReview(
      group,
      config,
      prMetadata,
      groupCompressed,
      ticketContext,
      {
        ...tierOptions,
        openGrepFindings: groupOpenGrep,
        rankedContext: groupRankedContext,
        chunkFiles: [...groupPaths],
      },
    );
    results.push(groupResult);
  }
  return results;
}

export async function runMultiCallReview(
  patches: FilePatch[],
  config: ReviewConfig,
  prMetadata: PRMetadata,
  ticketContext?: TicketInfo[],
  options?: MultiCallReviewOptions,
): Promise<ReviewResult> {
  const { mcpServers, maxTokens: maxTokensOpt, ...reviewOptions } = options ?? {};
  const maxTokens = maxTokensOpt ?? DEFAULT_MAX_TOKENS;
  const graphContextConfig = resolveGraphContextConfig();

  let mcpDisconnect: (() => Promise<void>) | undefined;
  let resolvedOptions: RunReviewOptions = reviewOptions;

  if (mcpServers && Object.keys(mcpServers).length > 0) {
    try {
      const mcp = await connectMcpServers(mcpServers);
      mcpDisconnect = mcp.disconnect;
      resolvedOptions = {
        ...reviewOptions,
        extraTools: { ...reviewOptions.extraTools, ...mcp.tools },
      };
    } catch (err) {
      logger.warn({ err }, "failed to connect MCP servers; continuing without MCP tools");
    }
  }

  try {
    const { compressed, skippedFiles } = compressDiff(patches, maxTokens);
    const rankedContext = await buildRankedContextForPatches(
      patches,
      prMetadata,
      resolvedOptions,
      graphContextConfig,
    );

    let result: ReviewResult;

    if (skippedFiles.length === 0) {
      result = await runConsensusReview(patches, config, prMetadata, compressed, ticketContext, {
        ...resolvedOptions,
        rankedContext,
        chunkFiles: patches.map((p) => p.path),
      });
    } else {
      const groups = splitIntoGroups(patches, maxTokens);

      if (ticketContext && ticketContext.length > 0 && groups.length > 1) {
        const ticketContextTokens = estimateTicketContextTokens(ticketContext);
        logger.info(
          {
            chunks: groups.length,
            linkedTickets: ticketContext.length,
            estimatedRepeatedTicketTokens: ticketContextTokens * Math.max(groups.length - 1, 0),
          },
          "multi-call review is reusing ticket context across chunks to accumulate compliance evidence",
        );
      }

      const allPaths = patches.map((p) => p.path);

      const results: ReviewResult[] = [];
      for (const group of groups) {
        const groupPaths = new Set(group.map((p) => p.path));
        const otherPrFiles = allPaths.filter((f) => !groupPaths.has(f));
        const groupOpenGrep = filterOpenGrepForFiles(resolvedOptions.openGrepFindings, groupPaths);
        const groupRankedContext = await buildRankedContextForPatches(
          group,
          prMetadata,
          resolvedOptions,
          graphContextConfig,
        );
        const groupCompressed = compressDiff(group, maxTokens).compressed;
        const groupResult = await runConsensusReview(
          group,
          config,
          prMetadata,
          groupCompressed,
          ticketContext,
          {
            ...resolvedOptions,
            otherPrFiles,
            openGrepFindings: groupOpenGrep,
            rankedContext: groupRankedContext,
            chunkFiles: [...groupPaths],
          },
        );
        results.push(groupResult);
      }

      result = mergeResults(results, results[0]?.modelUsed ?? "unknown");
    }

    const prFileSet = new Set(patches.map((p) => p.path));
    const beforeCount = result.observations.length;
    result.observations = filterObservationsForPrFiles(result.observations, prFileSet);
    const droppedCount = beforeCount - result.observations.length;
    if (droppedCount > 0) {
      logger.info(
        { dropped: droppedCount, total: beforeCount },
        "filtered observations that targeted files changed in this PR",
      );
    }

    const judgeConfig = resolveJudgeConfig();
    return await judgeReviewResult(result, patches, judgeConfig);
  } finally {
    if (mcpDisconnect) {
      try {
        await mcpDisconnect();
      } catch (err) {
        logger.warn({ err }, "MCP disconnect error");
      }
    }
  }
}

export async function runCascadeReview(
  skimPatches: FilePatch[],
  deepPatches: FilePatch[],
  config: ReviewConfig,
  prMetadata: PRMetadata,
  ticketContext: TicketInfo[] | undefined,
  options?: MultiCallReviewOptions,
): Promise<ReviewResult> {
  const { mcpServers, maxTokens: maxTokensOpt, ...reviewOptions } = options ?? {};
  const maxTokens = maxTokensOpt ?? DEFAULT_MAX_TOKENS;
  const graphContextConfig = resolveGraphContextConfig();

  let mcpDisconnect: (() => Promise<void>) | undefined;
  let resolvedOptions: RunReviewOptions = reviewOptions;

  if (mcpServers && Object.keys(mcpServers).length > 0) {
    try {
      const mcp = await connectMcpServers(mcpServers);
      mcpDisconnect = mcp.disconnect;
      resolvedOptions = {
        ...reviewOptions,
        extraTools: { ...reviewOptions.extraTools, ...mcp.tools },
      };
    } catch (err) {
      logger.warn({ err }, "failed to connect MCP servers; continuing without MCP tools");
    }
  }

  try {
    const allResults: ReviewResult[] = [];

    // when there are no deep-review files but tickets exist,
    // pass ticket context to the skim pass so it's at least visible in the prompt
    const hasDeepFiles = deepPatches.length > 0;
    const skimTickets = hasDeepFiles ? undefined : ticketContext;
    const deepTickets = ticketContext;

    const skimResults = await runTieredReview(
      skimPatches,
      config,
      prMetadata,
      skimTickets,
      resolvedOptions,
      maxTokens,
      "skim",
      graphContextConfig,
    );
    allResults.push(...skimResults);

    // pass skim file paths to the deep tier so the LLM knows they exist
    // (particularly important for ticket compliance — e.g. test files triaged
    // as skim should still count as evidence when evaluating "add tests" requirements)
    const skimFilePaths = skimPatches.map((p) => p.path);
    const deepOptionsWithSkimContext: RunReviewOptions =
      skimFilePaths.length > 0
        ? {
            ...resolvedOptions,
            otherPrFiles: [...(resolvedOptions.otherPrFiles ?? []), ...skimFilePaths],
          }
        : resolvedOptions;

    const deepResults = await runTieredReview(
      deepPatches,
      config,
      prMetadata,
      deepTickets,
      deepOptionsWithSkimContext,
      maxTokens,
      "deep-review",
      graphContextConfig,
    );
    allResults.push(...deepResults);

    if (allResults.length === 0) {
      return {
        summary: "No files required review after triage.",
        recommendation: "looks_good",
        findings: [],
        observations: [],
        ticketCompliance: [],
        missingTests: [],
        filesReviewed: [],
        modelUsed: "unknown",
        tokenCount: 0,
      };
    }

    const merged = mergeResults(allResults, allResults[0]?.modelUsed ?? "unknown");

    const allPatches = [...skimPatches, ...deepPatches];
    const judgeConfig = resolveJudgeConfig();
    return await judgeReviewResult(merged, allPatches, judgeConfig);
  } finally {
    if (mcpDisconnect) {
      try {
        await mcpDisconnect();
      } catch (err) {
        logger.warn({ err }, "MCP disconnect error");
      }
    }
  }
}
