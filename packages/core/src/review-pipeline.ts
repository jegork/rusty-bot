import { runCascadeReview, runMultiCallReview } from "./agent/multi-call.js";
import type { MultiCallReviewOptions } from "./agent/multi-call.js";
import { buildPriorContextFromReview } from "./agent/prior-context.js";
import { fetchConventionFile } from "./convention-file.js";
import { generatePRDescription, shouldGenerateDescription } from "./description/generate.js";
import { filterAnchorableFindings } from "./diff/anchor.js";
import { expandContext } from "./diff/context.js";
import { filterFiles } from "./diff/filter.js";
import { summarizeLanguages } from "./diff/language.js";
import { formatSummaryComment } from "./formatter/summary.js";
import { logger } from "./logger.js";
import { loadMcpServerConfigsFromEnv } from "./mcp/client.js";
import { extractChangedFilePaths, runOpenGrep } from "./opengrep/runner.js";
import { resolveRepoCheckout } from "./repo/resolve.js";
import { extractTicketRefs } from "./tickets/extract.js";
import { resolveTicketsWithStatus } from "./tickets/resolve.js";
import { generateConventionalTitle } from "./title/generate.js";
import { isConventionalTitle } from "./title/parse.js";
import { isCascadeEnabled, runTriage, splitByClassification } from "./triage/triage.js";
import type {
  FilePatch,
  GitProvider,
  PostSummaryCommentOptions,
  PRMetadata,
  PriorReviewContext,
  ReviewConfig,
  ReviewResult,
  TicketInfo,
  TicketProvider,
  TicketRef,
  TicketSource,
} from "./types.js";

const log = logger.child({ module: "review-pipeline" });

export interface RunTriagedReviewParams {
  patches: FilePatch[];
  config: ReviewConfig;
  metadata: PRMetadata;
  tickets: TicketInfo[] | undefined;
  /** reads a changed file for context expansion */
  fetchSourceFile: (path: string) => Promise<string | null>;
  options: MultiCallReviewOptions;
}

/** triage into a cascade review when enabled, otherwise (or if triage fails) a full multi-call review. */
export async function runTriagedReview(params: RunTriagedReviewParams): Promise<ReviewResult> {
  const { patches, config, metadata, tickets, fetchSourceFile, options } = params;

  if (isCascadeEnabled()) {
    log.info({ fileCount: patches.length }, "cascade enabled, running triage");

    let triageResult;
    try {
      triageResult = await runTriage(patches, options.openGrepFindings);
    } catch (err) {
      log.warn({ err }, "triage failed, falling back to full review");
    }

    if (triageResult) {
      const { skip, skim, deepReview } = splitByClassification(patches, triageResult.files);
      log.info(
        { skipped: skip.length, skimmed: skim.length, deepReview: deepReview.length },
        "triage classification",
      );

      const expandedDeep = await expandContext(deepReview, fetchSourceFile);
      const review = await runCascadeReview(skim, expandedDeep, config, metadata, tickets, options);
      review.triageStats = {
        filesSkipped: skip.length,
        filesSkimmed: skim.length,
        filesDeepReviewed: deepReview.length,
        triageModelUsed: triageResult.modelUsed,
        triageTokenCount: triageResult.tokenCount,
      };
      return review;
    }
  }

  const expanded = await expandContext(patches, fetchSourceFile);
  return runMultiCallReview(expanded, config, metadata, tickets, options);
}

export interface IncrementalState {
  /** the revision the previous review covered, read from its summary comment */
  lastReviewed: string | null;
  /** the revision this review covers; embedded in the summary for the next run */
  current: string | null;
}

/** how a platform identifies a reviewed revision: a commit sha, or an ADO iteration id. */
export interface IncrementalStrategy {
  /** must not throw: a failed read means a full review. `enabled` is false when incremental review is off. */
  readState(metadata: PRMetadata, enabled: boolean): Promise<IncrementalState>;
  /** the diff between two revisions; null when it cannot be computed */
  getDiffSince(lastReviewed: string, current: string | null): Promise<FilePatch[] | null>;
  /** summary comment options that record `current` as reviewed */
  marker(current: string): PostSummaryCommentOptions;
}

export function headShaIncremental(provider: GitProvider): IncrementalStrategy {
  return {
    async readState(metadata, enabled) {
      const current = metadata.headSha ?? null;
      if (!enabled || !current) return { lastReviewed: null, current };
      try {
        return { lastReviewed: (await provider.getLastReviewedSha?.()) ?? null, current };
      } catch (err) {
        log.warn({ err }, "failed to read last-reviewed sha, falling back to full review");
        return { lastReviewed: null, current };
      }
    },
    async getDiffSince(lastReviewed, current) {
      if (!current) return null;
      return (await provider.getDiffSinceSha?.(lastReviewed, current)) ?? null;
    },
    marker: (current) => ({ lastReviewedSha: current }),
  };
}

/** everything that differs between one CI platform and another. */
export interface ReviewPlatform {
  /** what the platform calls a change, for log messages */
  label: "PR" | "MR";
  provider: GitProvider;
  config: ReviewConfig;
  failOnCritical: boolean;
  incrementalReview: boolean;
  renameTitleToConventional: boolean;
  generateDescription: boolean;
  maxTokens: number;
  /** where the CI job checked out the repository, if anywhere */
  workspacePath: string | undefined;
  /** Authorization header value for fetching the PR head into the workspace */
  fetchAuthHeader: string | undefined;
  incremental: IncrementalStrategy;
  ticketSource: TicketSource;
  getLinkedTicketIds(): Promise<string[]>;
  buildTicketProviders(refs: TicketRef[]): Map<string, TicketProvider>;
  /** adjusts refs extracted from the description, e.g. bare #N belongs to GitLab on GitLab */
  normalizeTicketRefs?(refs: TicketRef[]): TicketRef[];
}

async function renameTitle(platform: ReviewPlatform, patches: FilePatch[], metadata: PRMetadata) {
  const { label, provider } = platform;
  try {
    if (isConventionalTitle(metadata.title)) return;
    const result = await generateConventionalTitle(patches, metadata);
    await provider.updatePRTitle(result.title);
    log.info(
      {
        originalTitle: metadata.title,
        newTitle: result.title,
        model: result.modelUsed,
        tokens: result.tokenCount,
      },
      `renamed ${label} title to conventional commit format`,
    );
    metadata.title = result.title;
  } catch (err) {
    log.warn({ err }, `failed to rename ${label} title, continuing with review`);
  }
}

async function generateDescription(
  platform: ReviewPlatform,
  patches: FilePatch[],
  metadata: PRMetadata,
  incremental: boolean,
) {
  const { label, provider } = platform;
  try {
    if (!shouldGenerateDescription(metadata.description)) return;
    const result = await generatePRDescription(patches, metadata, metadata.description, {
      incremental,
    });
    await provider.updatePRDescription(result.markdown);
    metadata.description = result.markdown;
    log.info(
      { model: result.modelUsed, tokens: result.tokenCount },
      `generated ${label} description`,
    );
  } catch (err) {
    log.warn({ err }, `failed to generate ${label} description, continuing with review`);
  }
}

async function resolveTickets(platform: ReviewPlatform, metadata: PRMetadata) {
  const extracted = extractTicketRefs(metadata.description, metadata.sourceBranch);
  const refs = platform.normalizeTicketRefs?.(extracted) ?? extracted;

  let linkedRefs: TicketRef[] = [];
  try {
    const linkedIds = await platform.getLinkedTicketIds();
    const existingIds = new Set(
      refs.filter((r) => r.source === platform.ticketSource).map((r) => r.id),
    );
    linkedRefs = linkedIds
      .filter((id) => !existingIds.has(id))
      .map((id) => ({ id, source: platform.ticketSource }));
  } catch (err) {
    log.warn(
      { err, source: platform.ticketSource },
      "failed to fetch linked tickets, continuing with extracted refs",
    );
  }

  const allRefs = [...refs, ...linkedRefs];
  return resolveTicketsWithStatus(allRefs, platform.buildTicketProviders(allRefs));
}

async function postInlineFindings(
  provider: GitProvider,
  review: ReviewResult,
  patches: FilePatch[],
) {
  const candidates = review.findings.filter((f) => f.line > 0);
  const { anchored, dropped } = filterAnchorableFindings(candidates, patches);
  if (dropped.length > 0) {
    log.warn(
      {
        droppedCount: dropped.length,
        samples: dropped.slice(0, 5).map((d) => ({
          file: d.finding.file,
          line: d.finding.line,
          reason: d.reason,
        })),
      },
      "dropped findings that don't anchor to the diff before posting inline comments",
    );
  }
  if (anchored.length > 0) {
    await provider.postInlineComments(anchored);
  }
  log.info(
    { inlineComments: anchored.length, droppedAnchors: dropped.length },
    "posted summary and inline comments",
  );
}

/** reviews one PR end to end and returns the process exit code. */
export async function runPrReview(platform: ReviewPlatform): Promise<number> {
  const { label, provider, incremental } = platform;

  const metadata = await provider.getPRMetadata();
  log.info(
    { prId: metadata.id, source: metadata.sourceBranch, target: metadata.targetBranch },
    `reviewing ${label}`,
  );

  const checkout = await resolveRepoCheckout({
    repoPath: platform.workspacePath,
    headSha: metadata.headSha,
    fetchAuthHeader: platform.fetchAuthHeader,
  });
  const fetchSourceFile = (path: string) =>
    checkout ? checkout.readFile(path) : provider.getFileContent(path, metadata.sourceBranch);

  const conventionFile = await fetchConventionFile(
    (path, ref) => provider.getFileContent(path, ref),
    metadata.targetBranch,
  );
  const config: ReviewConfig = {
    ...platform.config,
    ...(conventionFile && { conventionFile }),
  };

  // read the marker and prior context before deleting old bot comments, which hold them
  const { lastReviewed, current } = await incremental.readState(
    metadata,
    platform.incrementalReview,
  );
  let priorContext: PriorReviewContext | null = null;
  if (lastReviewed) {
    try {
      priorContext = (await provider.getPriorReviewContext?.()) ?? null;
    } catch (err) {
      log.warn({ err }, "failed to read prior review context; continuing without it");
    }
  }

  if (lastReviewed && current && lastReviewed === current) {
    log.info({ revision: current }, "this revision was already reviewed, skipping review");
    return 0;
  }

  await provider.deleteExistingBotComments();

  const delta = lastReviewed ? await incremental.getDiffSince(lastReviewed, current) : null;
  const incrementalUsed = delta !== null;
  if (delta) {
    log.info({ lastReviewed, current, files: delta.length }, "running incremental review");
  }
  const rawPatches = delta ?? (await provider.getDiff());

  const reviewable = filterFiles(rawPatches, config.ignorePatterns);
  log.info(
    {
      total: rawPatches.length,
      reviewed: reviewable.length,
      skipped: rawPatches.length - reviewable.length,
      mode: incrementalUsed ? "incremental" : "full",
    },
    "files changed",
  );

  if (incrementalUsed && reviewable.length === 0 && current) {
    log.info(
      { lastReviewed, current },
      "no reviewable changes in incremental delta, skipping LLM review",
    );
    await provider.postSummaryComment(
      "No reviewable changes since the last review.",
      incremental.marker(current),
    );
    return 0;
  }

  if (platform.renameTitleToConventional) {
    await renameTitle(platform, reviewable, metadata);
  }
  if (platform.generateDescription) {
    await generateDescription(platform, reviewable, metadata, incrementalUsed);
  }

  const { tickets, status: ticketResolution } = await resolveTickets(platform, metadata);

  const languageSummary = summarizeLanguages(reviewable);
  const mcpServers = await loadMcpServerConfigsFromEnv();

  const openGrepResult = await runOpenGrep(extractChangedFilePaths(reviewable), {
    config: process.env.RUSTY_OPENGREP_RULES ?? "auto",
  });
  const openGrepFindings = openGrepResult.findings.length > 0 ? openGrepResult.findings : undefined;
  if (openGrepResult.error) {
    log.warn(
      { error: openGrepResult.error },
      "opengrep pre-scan failed, review will proceed without its findings",
    );
  } else if (openGrepResult.available) {
    log.info({ findingCount: openGrepResult.findings.length }, "opengrep pre-scan complete");
  }

  const review = await runTriagedReview({
    patches: reviewable,
    config,
    metadata,
    tickets: tickets.length > 0 ? tickets : undefined,
    fetchSourceFile,
    options: {
      provider,
      sourceRef: metadata.sourceBranch,
      checkout: checkout ?? undefined,
      languageSummary,
      mcpServers,
      maxTokens: platform.maxTokens,
      openGrepFindings,
      priorContext: incrementalUsed && priorContext ? priorContext : undefined,
    },
  });

  review.openGrepStats = {
    available: openGrepResult.available,
    findingCount: openGrepResult.rawCount,
    ...(openGrepResult.error ? { error: openGrepResult.error } : {}),
  };

  const criticalCount = review.findings.filter((f) => f.severity === "critical").length;
  log.info(
    {
      findings: review.findings.length,
      critical: criticalCount,
      warnings: review.findings.filter((f) => f.severity === "warning").length,
      recommendation: review.recommendation,
    },
    "review complete",
  );

  await provider.postSummaryComment(
    formatSummaryComment(review, { ticketResolution }),
    current
      ? { ...incremental.marker(current), priorContext: buildPriorContextFromReview(review) }
      : undefined,
  );
  await postInlineFindings(provider, review, reviewable);

  if (platform.failOnCritical && criticalCount > 0) {
    log.warn({ criticalCount }, "failing due to critical issues");
    return 1;
  }
  return 0;
}
