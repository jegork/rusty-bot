import type {
  FilePatch,
  FocusArea,
  PriorReviewContext,
  ReviewConfig,
  TicketRef,
} from "@rusty-bot/core";
import { ReviewStyleSchema } from "@rusty-bot/core";
import {
  filterFiles,
  stripDeletionOnlyHunks,
  expandContext,
  summarizeLanguages,
  extractTicketRefs,
  resolveTicketsWithStatus,
  fetchConventionFile,
  AzureDevOpsTicketProvider,
  runMultiCallReview,
  runCascadeReview,
  formatSummaryComment,
  loadMcpServerConfigsFromEnv,
  logger,
  flushLogger,
  isCascadeEnabled,
  runTriage,
  splitByClassification,
  runOpenGrep,
  extractChangedFilePaths,
  generatePRDescription,
  shouldGenerateDescription,
  generateConventionalTitle,
  isConventionalTitle,
  filterAnchorableFindings,
  buildPriorContextFromReview,
  configureGlobalHttp,
} from "@rusty-bot/core";
import { AzureDevOpsProvider } from "./provider.js";

const log = logger.child({ package: "azure-devops" });

const MAX_TOKENS = 120_000;

export function parseConfig(): {
  provider: AzureDevOpsProvider;
  config: ReviewConfig;
  failOnCritical: boolean;
  incrementalReview: boolean;
  env: { orgUrl: string; project: string; accessToken: string };
} {
  const pullRequestId = process.env.SYSTEM_PULLREQUEST_PULLREQUESTID;
  const orgUrl = process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
  const project = process.env.SYSTEM_TEAMPROJECT;
  const repoName = process.env.BUILD_REPOSITORY_NAME;
  const accessToken = process.env.SYSTEM_ACCESSTOKEN;

  if (!pullRequestId || !orgUrl || !project || !repoName || !accessToken) {
    const missing: string[] = [];
    if (!pullRequestId) missing.push("SYSTEM_PULLREQUEST_PULLREQUESTID");
    if (!orgUrl) missing.push("SYSTEM_TEAMFOUNDATIONCOLLECTIONURI");
    if (!project) missing.push("SYSTEM_TEAMPROJECT");
    if (!repoName) missing.push("BUILD_REPOSITORY_NAME");
    if (!accessToken) missing.push("SYSTEM_ACCESSTOKEN");
    throw new Error(`missing required env vars: ${missing.join(", ")}`);
  }

  const reviewStyle = process.env.RUSTY_REVIEW_STYLE ?? "balanced";
  const parsedStyle = ReviewStyleSchema.safeParse(reviewStyle);
  if (!parsedStyle.success) {
    throw new Error(`invalid review style: ${reviewStyle}`);
  }

  const focusAreas = (process.env.RUSTY_FOCUS_AREAS?.split(",").filter(Boolean) ??
    []) as FocusArea[];
  const ignorePatterns = process.env.RUSTY_IGNORE_PATTERNS?.split(",").filter(Boolean) ?? [];
  const failOnCritical = process.env.RUSTY_FAIL_ON_CRITICAL !== "false";
  const incrementalReview = process.env.RUSTY_INCREMENTAL_REVIEW !== "false";

  return {
    provider: new AzureDevOpsProvider({
      orgUrl,
      project,
      repoName,
      pullRequestId: parseInt(pullRequestId, 10),
      accessToken,
    }),
    config: {
      style: parsedStyle.data,
      focusAreas,
      ignorePatterns,
    },
    failOnCritical,
    incrementalReview,
    env: { orgUrl, project, accessToken },
  };
}

async function main(): Promise<void> {
  configureGlobalHttp();

  const { provider, config, failOnCritical, incrementalReview, env } = parseConfig();

  const metadata = await provider.getPRMetadata();
  log.info(
    { prId: metadata.id, source: metadata.sourceBranch, target: metadata.targetBranch },
    "reviewing PR",
  );

  const conventionFile = await fetchConventionFile(
    (path, ref) => provider.getFileContent(path, ref),
    metadata.targetBranch,
  );
  if (conventionFile) {
    config.conventionFile = conventionFile;
  }

  // read incremental marker + prior context before deleting old bot comments —
  // otherwise we lose the iteration id and the carry-forward state
  let lastReviewedIteration: string | null = null;
  let latestIteration: string | null = null;
  let priorContext: PriorReviewContext | null = null;
  if (incrementalReview) {
    try {
      [lastReviewedIteration, latestIteration] = await Promise.all([
        provider.getLastReviewedIteration(),
        provider.getLatestIterationId(),
      ]);
    } catch (err) {
      log.warn({ err }, "failed to read iteration state, falling back to full review");
    }
    if (lastReviewedIteration) {
      try {
        priorContext = await provider.getPriorReviewContext();
      } catch (err) {
        log.warn({ err }, "failed to read prior review context; continuing without it");
      }
    }
  } else {
    try {
      latestIteration = await provider.getLatestIterationId();
    } catch (err) {
      log.warn({ err }, "failed to read latest iteration id, marker will not be embedded");
    }
  }

  if (lastReviewedIteration && latestIteration && lastReviewedIteration === latestIteration) {
    log.info(
      { iteration: latestIteration },
      "latest iteration matches last reviewed iteration, skipping review",
    );
    return;
  }

  await provider.deleteExistingBotComments();

  let rawPatches: FilePatch[] | null = null;
  let incrementalUsed = false;
  if (lastReviewedIteration) {
    const incremental = await provider.getDiffSinceIteration(lastReviewedIteration);
    if (incremental) {
      rawPatches = incremental;
      incrementalUsed = true;
      log.info(
        {
          lastReviewedIteration,
          latestIteration,
          files: incremental.length,
        },
        "running incremental review",
      );
    }
  }

  rawPatches ??= await provider.getDiff();

  const filtered = filterFiles(rawPatches, config.ignorePatterns);
  const reviewable = stripDeletionOnlyHunks(filtered);
  const skippedCount = rawPatches.length - reviewable.length;
  log.info(
    {
      total: rawPatches.length,
      reviewed: reviewable.length,
      skipped: skippedCount,
      mode: incrementalUsed ? "incremental" : "full",
    },
    "files changed",
  );

  if (incrementalUsed && reviewable.length === 0 && latestIteration) {
    log.info(
      { lastReviewedIteration, latestIteration },
      "no reviewable changes in incremental delta, skipping LLM review",
    );
    await provider.postSummaryComment("No reviewable changes since the last review.", {
      lastReviewedIteration: latestIteration,
    });
    return;
  }

  if (process.env.RUSTY_RENAME_TITLE_TO_CONVENTIONAL === "true") {
    try {
      if (!isConventionalTitle(metadata.title)) {
        const titleResult = await generateConventionalTitle(reviewable, metadata);
        await provider.updatePRTitle(titleResult.title);
        log.info(
          {
            originalTitle: metadata.title,
            newTitle: titleResult.title,
            model: titleResult.modelUsed,
            tokens: titleResult.tokenCount,
          },
          "renamed PR title to conventional commit format",
        );
        metadata.title = titleResult.title;
      }
    } catch (err) {
      log.warn({ err }, "failed to rename PR title, continuing with review");
    }
  }

  if (process.env.RUSTY_GENERATE_DESCRIPTION === "true") {
    try {
      if (shouldGenerateDescription(metadata.description)) {
        const descResult = await generatePRDescription(reviewable, metadata, metadata.description, {
          incremental: incrementalUsed,
        });
        await provider.updatePRDescription(descResult.markdown);
        metadata.description = descResult.markdown;
        log.info(
          { model: descResult.modelUsed, tokens: descResult.tokenCount },
          "generated PR description",
        );
      }
    } catch (err) {
      log.warn({ err }, "failed to generate PR description, continuing with review");
    }
  }

  const ticketRefs = extractTicketRefs(metadata.description, metadata.sourceBranch);

  let linkedRefs: TicketRef[] = [];
  try {
    const linkedIds = await provider.getLinkedWorkItemIds();
    const existingIds = new Set(
      ticketRefs.filter((r) => r.source === "azure-devops").map((r) => r.id),
    );
    linkedRefs = linkedIds
      .filter((id) => !existingIds.has(id))
      .map((id) => ({ id, source: "azure-devops" }));
  } catch (err) {
    log.warn({ err }, "failed to fetch linked work items from ADO, continuing with extracted refs");
  }
  const allRefs = [...ticketRefs, ...linkedRefs];

  const ticketProviders = new Map<string, AzureDevOpsTicketProvider>();
  if (allRefs.some((r) => r.source === "azure-devops")) {
    ticketProviders.set(
      "azure-devops",
      new AzureDevOpsTicketProvider({
        orgUrl: env.orgUrl,
        project: env.project,
        pat: env.accessToken,
      }),
    );
  }

  const { tickets, status: ticketResolution } = await resolveTicketsWithStatus(
    allRefs,
    ticketProviders,
  );

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

  let review;

  if (isCascadeEnabled()) {
    log.info({ fileCount: reviewable.length }, "cascade enabled, running triage");

    let triageResult;
    try {
      triageResult = await runTriage(reviewable, openGrepFindings);
    } catch (err) {
      log.warn({ err }, "triage failed, falling back to full review");
    }

    if (triageResult) {
      const { skip, skim, deepReview } = splitByClassification(reviewable, triageResult.files);
      log.info(
        { skipped: skip.length, skimmed: skim.length, deepReview: deepReview.length },
        "triage classification",
      );

      const expandedDeep = await expandContext(deepReview, (path) =>
        provider.getFileContent(path, metadata.sourceBranch),
      );

      review = await runCascadeReview(
        skim,
        expandedDeep,
        config,
        metadata,
        tickets.length > 0 ? tickets : undefined,
        {
          provider,
          sourceRef: metadata.sourceBranch,
          languageSummary,
          mcpServers,
          maxTokens: MAX_TOKENS,
          openGrepFindings,
          priorContext: incrementalUsed && priorContext ? priorContext : undefined,
        },
      );

      review.triageStats = {
        filesSkipped: skip.length,
        filesSkimmed: skim.length,
        filesDeepReviewed: deepReview.length,
        triageModelUsed: triageResult.modelUsed,
        triageTokenCount: triageResult.tokenCount,
      };
    }
  }

  if (!review) {
    const expanded = await expandContext(reviewable, (path) =>
      provider.getFileContent(path, metadata.sourceBranch),
    );

    review = await runMultiCallReview(
      expanded,
      config,
      metadata,
      tickets.length > 0 ? tickets : undefined,
      {
        provider,
        sourceRef: metadata.sourceBranch,
        languageSummary,
        mcpServers,
        maxTokens: MAX_TOKENS,
        openGrepFindings,
        priorContext: incrementalUsed && priorContext ? priorContext : undefined,
      },
    );
  }

  review.openGrepStats = {
    available: openGrepResult.available,
    findingCount: openGrepResult.rawCount,
    ...(openGrepResult.error ? { error: openGrepResult.error } : {}),
  };

  const criticalCount = review.findings.filter((f) => f.severity === "critical").length;
  const warningCount = review.findings.filter((f) => f.severity === "warning").length;
  log.info(
    {
      findings: review.findings.length,
      critical: criticalCount,
      warnings: warningCount,
      recommendation: review.recommendation,
    },
    "review complete",
  );

  const summaryMarkdown = formatSummaryComment(review, { ticketResolution });
  await provider.postSummaryComment(
    summaryMarkdown,
    latestIteration
      ? {
          lastReviewedIteration: latestIteration,
          priorContext: buildPriorContextFromReview(review),
        }
      : undefined,
  );

  const { anchored: inlineFindings, dropped } = filterAnchorableFindings(
    review.findings,
    reviewable,
  );
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
  await provider.postInlineComments(inlineFindings);

  log.info(
    { inlineComments: inlineFindings.length, droppedAnchors: dropped.length },
    "posted summary and inline comments",
  );

  if (failOnCritical && criticalCount > 0) {
    log.warn({ criticalCount }, "failing pipeline due to critical issues");
    process.exit(1);
  }
}

// only run when invoked directly, not when imported in tests
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  main().catch((err: unknown) => {
    log.fatal({ err }, "fatal error");
    flushLogger(() => process.exit(2));
  });
}
