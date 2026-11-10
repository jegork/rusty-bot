import type {
  FocusArea,
  IncrementalStrategy,
  ReviewConfig,
  ReviewPlatform,
  TicketProvider,
} from "@rusty-bot/core";
import {
  ReviewStyleSchema,
  AzureDevOpsTicketProvider,
  logger,
  flushLogger,
  configureGlobalHttp,
  runPrReview,
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
  const flagScopeCreep = process.env.RUSTY_FLAG_SCOPE_CREEP === "true";

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
      flagScopeCreep,
    },
    failOnCritical,
    incrementalReview,
    env: { orgUrl, project, accessToken },
  };
}

export function iterationIncremental(provider: AzureDevOpsProvider): IncrementalStrategy {
  return {
    async readState(_metadata, enabled) {
      if (!enabled) {
        try {
          return { lastReviewed: null, current: await provider.getLatestIterationId() };
        } catch (err) {
          log.warn({ err }, "failed to read latest iteration id, marker will not be embedded");
          return { lastReviewed: null, current: null };
        }
      }
      try {
        const [lastReviewed, current] = await Promise.all([
          provider.getLastReviewedIteration(),
          provider.getLatestIterationId(),
        ]);
        return { lastReviewed, current };
      } catch (err) {
        log.warn({ err }, "failed to read iteration state, falling back to full review");
        return { lastReviewed: null, current: null };
      }
    },
    getDiffSince: (lastReviewed) => provider.getDiffSinceIteration(lastReviewed),
    marker: (current) => ({ lastReviewedIteration: current }),
  };
}

export function buildPlatform(parsed: ReturnType<typeof parseConfig>): ReviewPlatform {
  const { provider, config, failOnCritical, incrementalReview, env } = parsed;
  return {
    label: "PR",
    provider,
    config,
    failOnCritical,
    incrementalReview,
    renameTitleToConventional: process.env.RUSTY_RENAME_TITLE_TO_CONVENTIONAL === "true",
    generateDescription: process.env.RUSTY_GENERATE_DESCRIPTION === "true",
    maxTokens: MAX_TOKENS,
    // the pipeline's shallow checkout is the merge commit; the PR head is fetched with System.AccessToken
    workspacePath: process.env.BUILD_SOURCESDIRECTORY,
    fetchAuthHeader: `bearer ${env.accessToken}`,
    incremental: iterationIncremental(provider),
    ticketSource: "azure-devops",
    getLinkedTicketIds: () => provider.getLinkedWorkItemIds(),
    riskPolicy: {
      enabled: process.env.RUSTY_RISK_ASSESSMENT === "true",
      labelPrefix: process.env.RUSTY_RISK_LABEL_PREFIX ?? "risk:",
      requireLabel: process.env.RUSTY_RISK_REQUIRE_LABEL !== "false",
    },
    buildTicketProviders: (refs) => {
      const providers = new Map<string, TicketProvider>();
      if (refs.some((r) => r.source === "azure-devops")) {
        providers.set(
          "azure-devops",
          new AzureDevOpsTicketProvider({
            orgUrl: env.orgUrl,
            project: env.project,
            pat: env.accessToken,
          }),
        );
      }
      return providers;
    },
  };
}

export async function main(): Promise<number> {
  configureGlobalHttp();
  return runPrReview(buildPlatform(parseConfig()));
}

// only run when invoked directly, not when imported in tests
const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  main()
    .then((code) => flushLogger(() => process.exit(code)))
    .catch((err: unknown) => {
      log.fatal({ err }, "fatal error");
      flushLogger(() => process.exit(2));
    });
}
