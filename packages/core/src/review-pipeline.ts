import { runCascadeReview, runMultiCallReview } from "./agent/multi-call.js";
import type { MultiCallReviewOptions } from "./agent/multi-call.js";
import { buildPriorContextFromReview } from "./agent/prior-context.js";
import { compareRiskLevels, mergeRiskAssessments, readRiskLabel } from "./agent/risk.js";
import type { RiskLabelResult } from "./agent/risk.js";
import { fetchConventionFile } from "./convention-file.js";
import { generatePRDescription, shouldGenerateDescription } from "./description/generate.js";
import { filterAnchorableFindings } from "./diff/anchor.js";
import { expandContext } from "./diff/context.js";
import { filterFiles } from "./diff/filter.js";
import { summarizeLanguages } from "./diff/language.js";
import { formatSummaryComment } from "./formatter/summary.js";
import { formatMissingRiskLabelComment, formatRiskDisagreementComment } from "./formatter/risk.js";
import { logger } from "./logger.js";
import { loadMcpServerConfigsFromEnv } from "./mcp/client.js";
import { extractChangedFilePaths, runOpenGrep } from "./opengrep/runner.js";
import { resolveRepoCheckout } from "./repo/resolve.js";
import { fetchRepoConfig, fetchRiskPrompt, type RiskPolicy } from "./repo-config.js";
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
  RiskLevel,
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
  /** risk policy from the platform's env; the repo's `.rusty-bot.json` overrides it when present */
  riskPolicy?: RiskPolicy;
}

// a label read that fails for transport reasons must not fail the PR, and a
// platform without labels cannot enforce one: both read as "could not check"
async function readAuthorRiskLabel(
  provider: GitProvider,
  risk: RiskPolicy | undefined,
): Promise<RiskLabelResult | null> {
  if (!risk?.enabled || !provider.getLabels) return null;
  try {
    const labels = await provider.getLabels();
    const result = readRiskLabel(labels, risk.labelPrefix);
    log.info({ labels, result }, "read author risk label");
    return result;
  } catch (err) {
    log.warn({ err }, "failed to read PR labels; skipping risk label enforcement");
    return null;
  }
}

async function enforceRiskLabel(
  provider: GitProvider,
  risk: RiskPolicy | undefined,
  authorRisk: RiskLabelResult | null,
): Promise<boolean> {
  if (!risk?.requireLabel || authorRisk === null || authorRisk.status === "ok") return true;
  await provider.postStandaloneComment?.(
    formatMissingRiskLabelComment(authorRisk, risk.labelPrefix),
    { tag: RISK_LABEL_TAG },
  );
  log.warn({ status: authorRisk.status }, "PR has no usable risk label");
  return false;
}

const RISK_LABEL_TAG = "risk-label";
const RISK_DISAGREEMENT_TAG = "risk-disagreement";

/** the policy file is read from the target branch, so a PR cannot relax the gate that reviews it */
async function resolveRiskPolicy(
  platform: ReviewPlatform,
  metadata: PRMetadata,
  config: ReviewConfig,
): Promise<RiskPolicy | undefined> {
  const { provider } = platform;
  // the strict reader tells a missing file from a failed read, so a transient
  // error fails the run instead of switching the policy off for that run
  const getFileContent = (path: string, ref: string) =>
    provider.readFile ? provider.readFile(path, ref) : provider.getFileContent(path, ref);
  const repoConfig = await fetchRepoConfig(getFileContent, metadata.targetBranch);
  const risk = repoConfig?.risk ?? platform.riskPolicy;
  if (!risk) return undefined;
  config.assessRisk = risk.enabled;
  config.riskReasons = risk.reasons;
  if (risk.enabled && risk.promptFile) {
    config.riskPrompt = await fetchRiskPrompt(
      getFileContent,
      metadata.targetBranch,
      risk.promptFile,
    );
  }
  log.info(
    { source: repoConfig?.risk ? "repo config" : "env", enabled: risk.enabled },
    "resolved risk policy",
  );
  return risk;
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
  const risk = await resolveRiskPolicy(platform, metadata, config);
  const authorRisk = await readAuthorRiskLabel(provider, risk);

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
    // relabelling creates no revision, so a re-run lands here; the label still
    // has to be checked or a missing-label failure would be sticky. the full
    // path closes every bot thread, this one only the earlier label reminders,
    // so a re-run never stacks them and a now-present label clears them
    if (risk?.enabled) await provider.closeStandaloneComments?.(RISK_LABEL_TAG);
    return (await enforceRiskLabel(provider, risk, authorRisk)) ? 0 : 1;
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

  // an incremental pass only saw the new diff; the PR stays as risky as its riskiest part
  if (incrementalUsed && priorContext?.riskAssessment) {
    const merged = mergeRiskAssessments([
      { ...review, riskAssessment: priorContext.riskAssessment },
      review,
    ]);
    if (merged) review.riskAssessment = merged;
  }
  const authorRiskLevel: RiskLevel | null = authorRisk?.status === "ok" ? authorRisk.level : null;

  const criticalCount = review.findings.filter((f) => f.severity === "critical").length;
  log.info(
    {
      findings: review.findings.length,
      critical: criticalCount,
      warnings: review.findings.filter((f) => f.severity === "warning").length,
      recommendation: review.recommendation,
      riskLevel: review.riskAssessment?.level,
      authorRiskLevel,
    },
    "review complete",
  );

  await provider.postSummaryComment(
    formatSummaryComment(review, { ticketResolution, authorRiskLevel }),
    current
      ? { ...incremental.marker(current), priorContext: buildPriorContextFromReview(review) }
      : undefined,
  );
  await postInlineFindings(provider, review, reviewable);

  // a higher bot rating is an argument, not a verdict: it opens a thread the
  // author has to answer or act on, and leaves the exit code alone
  if (
    risk &&
    review.riskAssessment &&
    authorRiskLevel &&
    compareRiskLevels(review.riskAssessment.level, authorRiskLevel) > 0
  ) {
    await provider.postStandaloneComment?.(
      formatRiskDisagreementComment(authorRiskLevel, review.riskAssessment, risk.labelPrefix),
      { tag: RISK_DISAGREEMENT_TAG },
    );
    log.info(
      { authorRiskLevel, botRiskLevel: review.riskAssessment.level },
      "posted risk label disagreement",
    );
  }

  const labelOk = await enforceRiskLabel(provider, risk, authorRisk);

  if (platform.failOnCritical && criticalCount > 0) {
    log.warn({ criticalCount }, "failing due to critical issues");
    return 1;
  }
  if (!labelOk) {
    log.warn("failing because the PR has no usable risk label");
    return 1;
  }
  return 0;
}
