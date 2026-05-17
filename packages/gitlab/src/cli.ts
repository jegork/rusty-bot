import type {
  FilePatch,
  FocusArea,
  PriorReviewContext,
  ReviewConfig,
  TicketProvider,
  TicketRef,
} from "@rusty-bot/core";
import {
  ReviewStyleSchema,
  filterFiles,
  stripDeletionOnlyHunks,
  expandContext,
  summarizeLanguages,
  extractTicketRefs,
  resolveTicketsWithStatus,
  fetchConventionFile,
  GitLabTicketProvider,
  JiraTicketProvider,
  LinearTicketProvider,
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
import { GitLabProvider } from "./provider.js";

const log = logger.child({ package: "gitlab" });

const MAX_TOKENS = 120_000;
const ALL_FOCUS_AREAS: FocusArea[] = ["security", "performance", "bugs", "style", "tests", "docs"];

export interface GitLabCliConfig {
  provider: GitLabProvider;
  review: ReviewConfig;
  failOnCritical: boolean;
  incrementalReview: boolean;
  apiBaseUrl: string;
  token: string;
  isJobToken: boolean;
  projectPath: string;
}

interface ParseEnvOptions {
  env?: NodeJS.ProcessEnv;
}

export function parseConfig({ env = process.env }: ParseEnvOptions = {}): GitLabCliConfig {
  // GitLab CI populates CI_MERGE_REQUEST_IID only on `merge_request_event` pipelines.
  // Allow explicit overrides for non-CI invocations (e.g. running locally).
  const mrIidStr = env.RUSTY_GITLAB_MR_IID ?? env.CI_MERGE_REQUEST_IID;
  const projectPath =
    env.RUSTY_GITLAB_PROJECT_PATH ?? env.CI_MERGE_REQUEST_PROJECT_PATH ?? env.CI_PROJECT_PATH;
  // GitLab v4 API base; CI_API_V4_URL is provided automatically inside CI jobs.
  const apiBaseUrl =
    env.RUSTY_GITLAB_API_URL ??
    env.CI_API_V4_URL ??
    `${(env.CI_SERVER_URL ?? "https://gitlab.com").replace(/\/$/, "")}/api/v4`;

  // Auth precedence: explicit RUSTY_GITLAB_TOKEN (project/personal access token), else CI_JOB_TOKEN.
  // CI_JOB_TOKEN works for read APIs but cannot post MR notes/discussions on most installs —
  // surface that in the warning below so operators know to add a project access token.
  const explicitToken = env.RUSTY_GITLAB_TOKEN ?? env.GITLAB_TOKEN;
  const jobToken = env.CI_JOB_TOKEN;
  const token = explicitToken ?? jobToken;
  const isJobToken = !explicitToken && jobToken !== undefined;

  if (!mrIidStr || !projectPath || !token) {
    const missing: string[] = [];
    if (!mrIidStr) missing.push("CI_MERGE_REQUEST_IID (or RUSTY_GITLAB_MR_IID)");
    if (!projectPath) missing.push("CI_PROJECT_PATH (or RUSTY_GITLAB_PROJECT_PATH)");
    if (!token) missing.push("RUSTY_GITLAB_TOKEN (or CI_JOB_TOKEN)");
    throw new Error(`missing required env vars: ${missing.join(", ")}`);
  }

  const mrIid = parseInt(mrIidStr, 10);
  if (Number.isNaN(mrIid)) {
    throw new Error(`invalid CI_MERGE_REQUEST_IID: ${mrIidStr}`);
  }

  if (isJobToken) {
    log.warn(
      "using CI_JOB_TOKEN — posting MR comments may fail. Set RUSTY_GITLAB_TOKEN to a project access token with 'api' scope.",
    );
  }

  const reviewStyle = env.RUSTY_REVIEW_STYLE ?? "balanced";
  const parsedStyle = ReviewStyleSchema.safeParse(reviewStyle);
  if (!parsedStyle.success) {
    throw new Error(`invalid review style: ${reviewStyle}`);
  }

  const rawFocusAreas =
    env.RUSTY_FOCUS_AREAS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const focusAreas = rawFocusAreas.filter((area): area is FocusArea =>
    (ALL_FOCUS_AREAS as string[]).includes(area),
  );
  const invalidFocusAreas = rawFocusAreas.filter((area) => !focusAreas.includes(area as FocusArea));
  if (invalidFocusAreas.length > 0) {
    log.warn(
      { invalid: invalidFocusAreas, allowed: ALL_FOCUS_AREAS },
      "ignoring unknown RUSTY_FOCUS_AREAS values",
    );
  }
  const ignorePatterns =
    env.RUSTY_IGNORE_PATTERNS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? [];
  const failOnCritical = env.RUSTY_FAIL_ON_CRITICAL !== "false";
  const incrementalReview = env.RUSTY_INCREMENTAL_REVIEW !== "false";

  return {
    provider: new GitLabProvider({
      apiBaseUrl,
      projectId: projectPath,
      mergeRequestIid: mrIid,
      token,
      isJobToken,
    }),
    review: {
      style: parsedStyle.data,
      focusAreas: focusAreas.length > 0 ? focusAreas : ALL_FOCUS_AREAS,
      ignorePatterns,
    },
    failOnCritical,
    incrementalReview,
    apiBaseUrl,
    token,
    isJobToken,
    projectPath,
  };
}

function buildTicketProviders(
  apiBaseUrl: string,
  token: string,
  isJobToken: boolean,
  projectPath: string,
  env: NodeJS.ProcessEnv,
): Map<string, TicketProvider> {
  const providers = new Map<string, TicketProvider>();

  providers.set(
    "gitlab",
    new GitLabTicketProvider({
      baseUrl: apiBaseUrl,
      token,
      isJobToken,
      defaultProjectPath: projectPath,
    }),
  );

  const jiraUrl = env.RUSTY_JIRA_BASE_URL;
  const jiraEmail = env.RUSTY_JIRA_EMAIL;
  const jiraToken = env.RUSTY_JIRA_API_TOKEN;
  if (jiraUrl && jiraEmail && jiraToken) {
    providers.set(
      "jira",
      new JiraTicketProvider({ baseUrl: jiraUrl, email: jiraEmail, apiToken: jiraToken }),
    );
  }

  const linearKey = env.RUSTY_LINEAR_API_KEY;
  if (linearKey) {
    providers.set("linear", new LinearTicketProvider({ apiKey: linearKey }));
  }

  return providers;
}

/**
 * In a GitLab context, bare `#123` references mean GitLab issues, not GitHub.
 * The shared extractor defaults `#N` to source=github (since github is the
 * common case across providers). Rewrite those bare numeric refs here so the
 * GitLab ticket provider can resolve them against the current project.
 */
function remapBareRefsToGitLab(refs: TicketRef[]): TicketRef[] {
  return refs.map((ref) => {
    if (ref.source !== "github") return ref;
    if (ref.id.includes("/")) return ref; // owner/repo#N — not a bare ref, leave as github
    if (!/^\d+$/.test(ref.id)) return ref;
    return { ...ref, source: "gitlab" };
  });
}

export async function runReview(config: GitLabCliConfig): Promise<number> {
  const { provider, review: reviewConfig, failOnCritical, incrementalReview } = config;

  const metadata = await provider.getPRMetadata();
  log.info(
    { mrIid: metadata.id, source: metadata.sourceBranch, target: metadata.targetBranch },
    "reviewing MR",
  );

  const conventionFile = await fetchConventionFile(
    (path, ref) => provider.getFileContent(path, ref),
    metadata.targetBranch,
  );
  if (conventionFile) {
    reviewConfig.conventionFile = conventionFile;
  }

  // read incremental marker + prior context before deleting old bot comments —
  // otherwise we lose the sha and the carry-forward state
  let lastReviewedSha: string | null = null;
  let priorContext: PriorReviewContext | null = null;
  if (incrementalReview && metadata.headSha) {
    try {
      lastReviewedSha = await provider.getLastReviewedSha();
    } catch (err) {
      log.warn({ err }, "failed to read last-reviewed sha, falling back to full review");
    }
    if (lastReviewedSha) {
      try {
        priorContext = await provider.getPriorReviewContext();
      } catch (err) {
        log.warn({ err }, "failed to read prior review context; continuing without it");
      }
    }
  }

  if (lastReviewedSha && metadata.headSha && lastReviewedSha === metadata.headSha) {
    log.info({ sha: metadata.headSha }, "head sha matches last reviewed sha, skipping review");
    return 0;
  }

  await provider.deleteExistingBotComments();

  let rawPatches: FilePatch[] | null = null;
  let incrementalUsed = false;
  if (lastReviewedSha && metadata.headSha) {
    const incremental = await provider.getDiffSinceSha(lastReviewedSha, metadata.headSha);
    if (incremental) {
      rawPatches = incremental;
      incrementalUsed = true;
      log.info(
        { lastReviewedSha, headSha: metadata.headSha, files: incremental.length },
        "running incremental review",
      );
    }
  }

  rawPatches ??= await provider.getDiff();

  const filtered = filterFiles(rawPatches, reviewConfig.ignorePatterns);
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

  if (incrementalUsed && reviewable.length === 0 && metadata.headSha) {
    log.info(
      { lastReviewedSha, headSha: metadata.headSha },
      "no reviewable changes in incremental delta, skipping LLM review",
    );
    await provider.postSummaryComment("No reviewable changes since the last review.", {
      lastReviewedSha: metadata.headSha,
    });
    return 0;
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
          "renamed MR title to conventional commit format",
        );
        metadata.title = titleResult.title;
      }
    } catch (err) {
      log.warn({ err }, "failed to rename MR title, continuing with review");
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
          "generated MR description",
        );
      }
    } catch (err) {
      log.warn({ err }, "failed to generate MR description, continuing with review");
    }
  }

  const ticketRefs = remapBareRefsToGitLab(
    extractTicketRefs(metadata.description, metadata.sourceBranch),
  );

  let linkedRefs: TicketRef[] = [];
  try {
    const linkedIds = await provider.getLinkedIssueIids();
    const existingIds = new Set(ticketRefs.filter((r) => r.source === "gitlab").map((r) => r.id));
    linkedRefs = linkedIds
      .filter((id) => !existingIds.has(id))
      .map((id) => ({ id, source: "gitlab" as const }));
  } catch (err) {
    log.warn({ err }, "failed to fetch linked issues from GitLab, continuing with extracted refs");
  }
  const allRefs = [...ticketRefs, ...linkedRefs];

  const ticketProviders = buildTicketProviders(
    config.apiBaseUrl,
    config.token,
    config.isJobToken,
    config.projectPath,
    process.env,
  );

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
        reviewConfig,
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
      reviewConfig,
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
    metadata.headSha
      ? {
          lastReviewedSha: metadata.headSha,
          priorContext: buildPriorContextFromReview(review),
        }
      : undefined,
  );

  const inlineCandidates = review.findings.filter((f) => f.line > 0);
  const { anchored: inlineFindings, dropped } = filterAnchorableFindings(
    inlineCandidates,
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
  if (inlineFindings.length > 0) {
    await provider.postInlineComments(inlineFindings);
  }

  log.info(
    { inlineComments: inlineFindings.length, droppedAnchors: dropped.length },
    "posted summary and inline comments",
  );

  if (failOnCritical && criticalCount > 0) {
    log.warn({ criticalCount }, "failing pipeline due to critical issues");
    return 1;
  }
  return 0;
}

async function main(): Promise<number> {
  configureGlobalHttp();

  // GitLab CI runs this CLI on every pipeline; only proceed when triggered by an MR event.
  const eventType = process.env.CI_PIPELINE_SOURCE;
  if (eventType && eventType !== "merge_request_event" && !process.env.CI_MERGE_REQUEST_IID) {
    log.info(
      { eventType },
      "not a merge_request_event pipeline and CI_MERGE_REQUEST_IID is unset, skipping",
    );
    return 0;
  }

  const config = parseConfig();
  return await runReview(config);
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  main()
    .then((code) => flushLogger(() => process.exit(code)))
    .catch((err: unknown) => {
      log.fatal({ err }, "fatal error");
      flushLogger(() => process.exit(2));
    });
}
