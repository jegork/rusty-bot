import type { Octokit } from "octokit";
import type { FocusArea, IssueFetcher, TicketProvider, TicketRef } from "@rusty-bot/core";
import {
  parseDiff,
  filterFiles,
  stripDeletionOnlyHunks,
  expandContext,
  summarizeLanguages,
  extractTicketRefs,
  resolveTicketsWithStatus,
  runMultiCallReview,
  runCascadeReview,
  formatSummaryComment,
  fetchConventionFile,
  GitHubTicketProvider,
  JiraTicketProvider,
  LinearTicketProvider,
  loadMcpServerConfigsFromEnv,
  logger,
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
} from "@rusty-bot/core";
import { GitHubProvider } from "./provider.js";
import { getRepoConfig, saveReview, getSetting, type ReviewRecord } from "./storage.js";

const log = logger.child({ package: "github" });

export function createOctokitIssueFetcher(octokit: Octokit): IssueFetcher {
  return async (owner, repo, issueNumber) => {
    try {
      const { data } = await octokit.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
        owner,
        repo,
        issue_number: issueNumber,
      });
      return data;
    } catch (err: unknown) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      log.warn({ err, owner, repo, issueNumber }, "installation token issue fetch failed");
      return null;
    }
  };
}
const MAX_DIFF_TOKENS = 60_000;
const ALL_FOCUS_AREAS: FocusArea[] = ["security", "performance", "bugs", "style", "tests", "docs"];

async function buildTicketProviders(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<Map<string, TicketProvider>> {
  const providers = new Map<string, TicketProvider>();

  const ghToken = await getSetting("github_token");
  if (ghToken) {
    providers.set("github", new GitHubTicketProvider({ token: ghToken, owner, repo }));
  } else {
    providers.set(
      "github",
      new GitHubTicketProvider({
        owner,
        repo,
        issueFetcher: createOctokitIssueFetcher(octokit),
      }),
    );
  }

  const jiraUrl = await getSetting("jira_base_url");
  const jiraEmail = await getSetting("jira_email");
  const jiraToken = await getSetting("jira_api_token");
  if (jiraUrl && jiraEmail && jiraToken) {
    providers.set(
      "jira",
      new JiraTicketProvider({ baseUrl: jiraUrl, email: jiraEmail, apiToken: jiraToken }),
    );
  }

  const linearKey = await getSetting("linear_api_key");
  if (linearKey) {
    providers.set("linear", new LinearTicketProvider({ apiKey: linearKey }));
  }

  return providers;
}

export async function orchestrateReview(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  installationId: number;
}): Promise<void> {
  const { octokit, owner, repo, pullNumber } = params;

  try {
    const repoConfig = await getRepoConfig(owner, repo);

    const provider = new GitHubProvider({ octokit, owner, repo, pullNumber });

    await provider.deleteExistingBotComments();

    const [metadata, rawDiff] = await Promise.all([
      provider.getPRMetadata(),
      provider.getRawDiff(),
    ]);

    const conventionFile = await fetchConventionFile(
      (path, ref) => provider.getFileContent(path, ref),
      metadata.targetBranch,
    );

    const config = {
      style: repoConfig?.style ?? ("balanced" as const),
      focusAreas: repoConfig?.focusAreas ?? ALL_FOCUS_AREAS,
      ignorePatterns: repoConfig?.ignorePatterns ?? [],
      ...(conventionFile ? { conventionFile } : {}),
      flagScopeCreep: process.env.RUSTY_FLAG_SCOPE_CREEP === "true",
    };

    const patches = parseDiff(rawDiff);
    const filtered = filterFiles(patches, config.ignorePatterns);
    const reviewable = stripDeletionOnlyHunks(filtered);

    const shouldRenameTitle =
      repoConfig?.renameTitleToConventional ??
      process.env.RUSTY_RENAME_TITLE_TO_CONVENTIONAL === "true";

    if (shouldRenameTitle) {
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

    const shouldGenerate =
      repoConfig?.generateDescription ?? process.env.RUSTY_GENERATE_DESCRIPTION === "true";

    if (shouldGenerate) {
      try {
        if (shouldGenerateDescription(metadata.description)) {
          const descResult = await generatePRDescription(
            reviewable,
            metadata,
            metadata.description,
          );
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
      const linkedIssueNumbers = await provider.getLinkedIssueNumbers();
      const existingGhIds = new Set(
        ticketRefs.filter((r) => r.source === "github").map((r) => r.id),
      );
      linkedRefs = linkedIssueNumbers
        .filter((n) => !existingGhIds.has(String(n)))
        .map((n) => ({ id: String(n), source: "github" }));
    } catch (err) {
      log.warn(
        { err },
        "failed to fetch linked issues from GitHub, continuing with extracted refs",
      );
    }
    const allRefs = [...ticketRefs, ...linkedRefs];

    const ticketProviders = await buildTicketProviders(octokit, owner, repo);
    const { tickets, status: ticketResolution } = await resolveTicketsWithStatus(
      allRefs,
      ticketProviders,
    );

    const languageSummary = summarizeLanguages(reviewable);
    const mcpServers = await loadMcpServerConfigsFromEnv();

    const openGrepResult = await runOpenGrep(extractChangedFilePaths(reviewable), {
      config: process.env.RUSTY_OPENGREP_RULES ?? "auto",
    });
    const openGrepFindings =
      openGrepResult.findings.length > 0 ? openGrepResult.findings : undefined;
    if (openGrepResult.error) {
      log.warn(
        { error: openGrepResult.error },
        "opengrep pre-scan failed, review will proceed without its findings",
      );
    } else if (openGrepResult.available) {
      log.info({ findingCount: openGrepResult.findings.length }, "opengrep pre-scan complete");
    }

    let result;

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

        // only expand context for deep-review files
        const expandedDeep = await expandContext(deepReview, (path) =>
          provider.getFileContent(path, metadata.sourceBranch),
        );

        result = await runCascadeReview(skim, expandedDeep, config, metadata, tickets, {
          provider,
          sourceRef: metadata.sourceBranch,
          languageSummary,
          mcpServers,
          maxTokens: MAX_DIFF_TOKENS,
          openGrepFindings,
        });

        result.triageStats = {
          filesSkipped: skip.length,
          filesSkimmed: skim.length,
          filesDeepReviewed: deepReview.length,
          triageModelUsed: triageResult.modelUsed,
          triageTokenCount: triageResult.tokenCount,
        };
      }
    }

    if (!result) {
      // non-cascade path or cascade fallback
      const expanded = await expandContext(reviewable, (path) =>
        provider.getFileContent(path, metadata.sourceBranch),
      );

      result = await runMultiCallReview(expanded, config, metadata, tickets, {
        provider,
        sourceRef: metadata.sourceBranch,
        languageSummary,
        mcpServers,
        maxTokens: MAX_DIFF_TOKENS,
        openGrepFindings,
      });
    }

    result.openGrepStats = {
      available: openGrepResult.available,
      findingCount: openGrepResult.rawCount,
      ...(openGrepResult.error ? { error: openGrepResult.error } : {}),
    };

    const summary = formatSummaryComment(result, { ticketResolution });
    await provider.postSummaryComment(summary);

    const inlineCandidates = result.findings.filter((f) => f.line > 0);
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

    const review: ReviewRecord = {
      id: `${owner}-${repo}-${pullNumber}-${Date.now()}`,
      owner,
      repo,
      prNumber: pullNumber,
      timestamp: new Date().toISOString(),
      findingsCount: result.findings.length,
      criticalCount: result.findings.filter((f) => f.severity === "critical").length,
      warningCount: result.findings.filter((f) => f.severity === "warning").length,
      suggestionCount: result.findings.filter((f) => f.severity === "suggestion").length,
      modelUsed: result.modelUsed,
      tokenCount: result.tokenCount,
      recommendation: result.recommendation,
      prUrl: metadata.url,
      ...(result.triageStats
        ? {
            triageModelUsed: result.triageStats.triageModelUsed,
            triageTokenCount: result.triageStats.triageTokenCount,
            filesSkipped: result.triageStats.filesSkipped,
            filesSkimmed: result.triageStats.filesSkimmed,
            filesDeepReviewed: result.triageStats.filesDeepReviewed,
          }
        : {}),
    };

    await saveReview(review);

    log.info({ owner, repo, pullNumber }, "review completed");
  } catch (err) {
    log.error({ owner, repo, pullNumber, err }, "review failed");
  }
}
