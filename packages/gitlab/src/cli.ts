import type {
  FocusArea,
  ReviewConfig,
  ReviewPlatform,
  TicketProvider,
  TicketRef,
} from "@rusty-bot/core";
import {
  ReviewStyleSchema,
  GitLabTicketProvider,
  JiraTicketProvider,
  LinearTicketProvider,
  logger,
  flushLogger,
  configureGlobalHttp,
  headShaIncremental,
  runPrReview,
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
  const flagScopeCreep = env.RUSTY_FLAG_SCOPE_CREEP === "true";

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
      flagScopeCreep,
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
export function remapBareRefsToGitLab(refs: TicketRef[]): TicketRef[] {
  return refs.map((ref) => {
    if (ref.source !== "github") return ref;
    if (ref.id.includes("/")) return ref; // owner/repo#N — not a bare ref, leave as github
    if (!/^\d+$/.test(ref.id)) return ref;
    return { ...ref, source: "gitlab" };
  });
}

export function buildPlatform(config: GitLabCliConfig): ReviewPlatform {
  const { provider } = config;
  // merge-request pipelines usually check out the source head already; the fetch is best effort
  const jobToken = process.env.CI_JOB_TOKEN;
  return {
    label: "MR",
    provider,
    config: config.review,
    failOnCritical: config.failOnCritical,
    incrementalReview: config.incrementalReview,
    renameTitleToConventional: process.env.RUSTY_RENAME_TITLE_TO_CONVENTIONAL === "true",
    generateDescription: process.env.RUSTY_GENERATE_DESCRIPTION === "true",
    maxTokens: MAX_TOKENS,
    workspacePath: process.env.CI_PROJECT_DIR,
    fetchAuthHeader: jobToken
      ? "basic " + Buffer.from(`gitlab-ci-token:${jobToken}`).toString("base64")
      : undefined,
    incremental: headShaIncremental(provider),
    ticketSource: "gitlab",
    getLinkedTicketIds: () => provider.getLinkedIssueIids(),
    normalizeTicketRefs: remapBareRefsToGitLab,
    buildTicketProviders: () =>
      buildTicketProviders(
        config.apiBaseUrl,
        config.token,
        config.isJobToken,
        config.projectPath,
        process.env,
      ),
  };
}

export async function runReview(config: GitLabCliConfig): Promise<number> {
  return runPrReview(buildPlatform(config));
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
