import type { Octokit } from "octokit";
import type { FocusArea, ReviewConfig, ReviewPlatform, TicketProvider } from "@rusty-bot/core";
import {
  ReviewStyleSchema,
  GitHubTicketProvider,
  JiraTicketProvider,
  LinearTicketProvider,
  logger,
  flushLogger,
  configureGlobalHttp,
  headShaIncremental,
  runPrReview,
} from "@rusty-bot/core";
import { GitHubProvider, RustyOctokit, createOctokitIssueFetcher } from "@rusty-bot/github";
import {
  readEventPayload,
  parseOwnerRepo,
  extractPullNumber,
  shouldSkipEvent,
  type PullRequestEvent,
} from "./event.js";

const log = logger.child({ package: "github-action" });

const MAX_TOKENS = 60_000;
const ALL_FOCUS_AREAS: FocusArea[] = ["security", "performance", "bugs", "style", "tests", "docs"];

export interface ActionConfig {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  token: string;
  review: ReviewConfig;
  failOnCritical: boolean;
  generateDescription: boolean;
  renameTitleToConventional: boolean;
  incrementalReview: boolean;
}

interface ParseConfigOptions {
  event: PullRequestEvent;
  env?: NodeJS.ProcessEnv;
}

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  "azure-openai": "AZURE_OPENAI_API_KEY",
};

function assertLlmCredentials(env: NodeJS.ProcessEnv): void {
  if (env.RUSTY_LLM_BASE_URL || env.RUSTY_AZURE_RESOURCE_NAME) {
    return;
  }

  const model = env.RUSTY_LLM_MODEL ?? "anthropic/claude-sonnet-4-20250514";
  const provider = model.split("/")[0]?.toLowerCase();
  if (!provider) return;

  const requiredKey = PROVIDER_API_KEY_ENV[provider];
  if (!requiredKey || env[requiredKey]) return;

  throw new Error(
    `RUSTY_LLM_MODEL is set to "${model}" but ${requiredKey} is missing. Provide the matching API key, or set RUSTY_LLM_BASE_URL / RUSTY_AZURE_RESOURCE_NAME for alternative providers.`,
  );
}

export function parseConfig({ event, env = process.env }: ParseConfigOptions): ActionConfig {
  const token = env.GITHUB_TOKEN ?? env.INPUT_GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;

  if (!token || !repository) {
    const missing: string[] = [];
    if (!token) missing.push("GITHUB_TOKEN");
    if (!repository) missing.push("GITHUB_REPOSITORY");
    throw new Error(`missing required env vars: ${missing.join(", ")}`);
  }

  assertLlmCredentials(env);

  const { owner, repo } = parseOwnerRepo(repository);

  const pullNumber = extractPullNumber(event);
  if (pullNumber == null) {
    throw new Error(
      "could not determine pull request number from event payload — is this a pull_request event?",
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
  const generateDescription = env.RUSTY_GENERATE_DESCRIPTION === "true";
  const renameTitleToConventional = env.RUSTY_RENAME_TITLE_TO_CONVENTIONAL === "true";
  const incrementalReview = env.RUSTY_INCREMENTAL_REVIEW !== "false";
  const flagScopeCreep = env.RUSTY_FLAG_SCOPE_CREEP === "true";

  const octokit = new RustyOctokit({ auth: token });

  return {
    octokit,
    owner,
    repo,
    pullNumber,
    token,
    review: {
      style: parsedStyle.data,
      focusAreas: focusAreas.length > 0 ? focusAreas : ALL_FOCUS_AREAS,
      ignorePatterns,
      flagScopeCreep,
    },
    failOnCritical,
    generateDescription,
    renameTitleToConventional,
    incrementalReview,
  };
}

function buildTicketProviders(
  octokit: Octokit,
  owner: string,
  repo: string,
  env: NodeJS.ProcessEnv,
): Map<string, TicketProvider> {
  const providers = new Map<string, TicketProvider>();

  providers.set(
    "github",
    new GitHubTicketProvider({
      owner,
      repo,
      issueFetcher: createOctokitIssueFetcher(octokit),
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

export function buildPlatform(config: ActionConfig): ReviewPlatform {
  const { octokit, owner, repo, pullNumber } = config;
  const provider = new GitHubProvider({ octokit, owner, repo, pullNumber });
  return {
    label: "PR",
    provider,
    config: config.review,
    failOnCritical: config.failOnCritical,
    incrementalReview: config.incrementalReview,
    renameTitleToConventional: config.renameTitleToConventional,
    generateDescription: config.generateDescription,
    maxTokens: MAX_TOKENS,
    // actions/checkout leaves the merge commit on disk; the PR head is fetched with the job token
    workspacePath: process.env.GITHUB_WORKSPACE,
    fetchAuthHeader: "basic " + Buffer.from(`x-access-token:${config.token}`).toString("base64"),
    incremental: headShaIncremental(provider),
    ticketSource: "github",
    getLinkedTicketIds: async () => (await provider.getLinkedIssueNumbers()).map(String),
    buildTicketProviders: () => buildTicketProviders(octokit, owner, repo, process.env),
  };
}

export async function runAction(config: ActionConfig): Promise<number> {
  return runPrReview(buildPlatform(config));
}

async function main(): Promise<number> {
  configureGlobalHttp();

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    throw new Error("GITHUB_EVENT_PATH is not set — this CLI must run inside a GitHub Action");
  }

  const event = await readEventPayload(eventPath);

  const skip = shouldSkipEvent(event);
  if (skip.skip) {
    log.info({ reason: skip.reason }, "skipping review");
    return 0;
  }

  const config = parseConfig({ event });
  return await runAction(config);
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  // node won't exit on its own once main() resolves — the pino async transport
  // worker, ai-sdk connection pools, and any leftover libsql/mcp handles keep
  // the event loop alive. flush logs and force-exit on every termination path.
  main()
    .then((code) => flushLogger(() => process.exit(code)))
    .catch((err: unknown) => {
      log.fatal({ err }, "fatal error");
      flushLogger(() => process.exit(2));
    });
}
