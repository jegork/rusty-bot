#!/usr/bin/env node
import {
  configureGlobalHttp,
  expandContext,
  fetchConventionFile,
  filterAnchorableFindings,
  filterFiles,
  flushLogger,
  formatInlineComment,
  formatSummaryComment,
  isCascadeEnabled,
  loadMcpServerConfigsFromEnv,
  logger,
  runCascadeReview,
  runMultiCallReview,
  runTriage,
  splitByClassification,
  stripDeletionOnlyHunks,
  summarizeLanguages,
  type Finding,
  type ReviewConfig,
  type ReviewResult,
} from "@rusty-bot/core";
import { LocalGitProvider } from "./local-provider.js";
import { parseArgs, HELP_TEXT, type CliArgs } from "./args.js";

const log = logger.child({ package: "cli" });

const MAX_TOKENS = 60_000;

function renderInlineFindings(findings: Finding[]): string {
  if (findings.length === 0) return "";
  const lines: string[] = ["", "## Inline findings", ""];
  for (const f of findings) {
    const range = f.endLine && f.endLine !== f.line ? `${f.line}-${f.endLine}` : `${f.line}`;
    lines.push(`### \`${f.file}:${range}\``);
    lines.push("");
    lines.push(formatInlineComment(f));
    lines.push("");
  }
  return lines.join("\n");
}

export async function run(args: CliArgs): Promise<number> {
  const provider = new LocalGitProvider({
    repoPath: args.repoPath,
    baseRef: args.baseRef,
    headRef: args.headRef,
  });

  const reviewConfig: ReviewConfig = {
    style: args.style,
    focusAreas: args.focusAreas,
    ignorePatterns: args.ignorePatterns,
    flagScopeCreep: args.flagScopeCreep,
  };

  const metadata = await provider.getPRMetadata();
  log.info(
    { base: metadata.targetBranch, head: metadata.sourceBranch, sha: metadata.headSha },
    "reviewing local diff",
  );

  const conventionFile = await fetchConventionFile(
    (path, ref) => provider.getFileContent(path, ref),
    metadata.targetBranch,
  );
  if (conventionFile) {
    reviewConfig.conventionFile = conventionFile;
  }

  const rawPatches = await provider.getDiff();
  if (rawPatches.length === 0) {
    log.info("no changes between base and head");
    process.stdout.write("No changes between base and head.\n");
    return 0;
  }

  const filtered = filterFiles(rawPatches, reviewConfig.ignorePatterns);
  const reviewable = stripDeletionOnlyHunks(filtered);
  log.info({ total: rawPatches.length, reviewed: reviewable.length }, "files changed");

  if (reviewable.length === 0) {
    process.stdout.write("No reviewable changes after filtering.\n");
    return 0;
  }

  const languageSummary = summarizeLanguages(reviewable);
  const mcpServers = await loadMcpServerConfigsFromEnv();

  let review: ReviewResult | undefined;

  if (isCascadeEnabled()) {
    log.info({ fileCount: reviewable.length }, "cascade enabled, running triage");

    let triageResult;
    try {
      triageResult = await runTriage(reviewable);
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

      review = await runCascadeReview(skim, expandedDeep, reviewConfig, metadata, undefined, {
        provider,
        sourceRef: metadata.sourceBranch,
        languageSummary,
        mcpServers,
        maxTokens: MAX_TOKENS,
      });

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

    review = await runMultiCallReview(expanded, reviewConfig, metadata, undefined, {
      provider,
      sourceRef: metadata.sourceBranch,
      languageSummary,
      mcpServers,
      maxTokens: MAX_TOKENS,
    });
  }

  const criticalCount = review.findings.filter((f) => f.severity === "critical").length;
  log.info(
    {
      findings: review.findings.length,
      critical: criticalCount,
      recommendation: review.recommendation,
    },
    "review complete",
  );

  if (args.format === "json") {
    process.stdout.write(JSON.stringify(review, null, 2) + "\n");
  } else {
    const summary = formatSummaryComment(review);
    const inlineCandidates = review.findings.filter((f) => f.line > 0);
    const { anchored } = filterAnchorableFindings(inlineCandidates, reviewable);
    process.stdout.write(summary);
    process.stdout.write(renderInlineFindings(anchored));
    if (!summary.endsWith("\n")) process.stdout.write("\n");
  }

  if (args.failOnCritical && criticalCount > 0) {
    return 1;
  }
  return 0;
}

async function main(): Promise<number> {
  configureGlobalHttp();

  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP_TEXT}`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return 0;
  }

  return await run(args);
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
