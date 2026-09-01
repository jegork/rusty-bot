import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import {
  resolveModelConfig,
  resolveModelConfigWithOverride,
  resolveModel,
  getModelDisplayName,
  resolveModelSettings,
  resolveDefaultAgentOptions,
  resolveJsonPromptInjection,
  applyModelConstraints,
} from "./model.js";
import type { FilePatch, Finding, Hunk, ReviewResult } from "../types.js";
import { logger } from "../logger.js";
import { deriveMergedRecommendation } from "./recommendation.js";

const EXCERPT_NO_HUNK =
  "[no matching hunk for this finding — line is outside the diff or the file isn't in the PR]";

function findOverlappingHunks(hunks: Hunk[], line: number, endLine: number): Hunk[] {
  return hunks.filter((h) => {
    const hStart = h.newStart;
    const hEnd = h.newStart + h.newLines - 1;
    return hStart <= endLine && hEnd >= line;
  });
}

function formatHunkExcerpt(hunk: Hunk): string[] {
  const lines = hunk.content.split("\n");
  // mirrors compress.ts formatHunks: context, additions, and sibling signatures
  // go into the new-side block; removals into the old-side block. context is
  // emitted exactly once — the model can still read removals from the old
  // block via their line numbers without re-reading every context line.
  const oldRemovedLines: string[] = [];
  const newSideLines: string[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (const line of lines) {
    if (line.startsWith("-")) {
      oldRemovedLines.push(`${oldLine} ${line}`);
      oldLine++;
    } else if (line.startsWith("+")) {
      newSideLines.push(`${newLine} ${line}`);
      newLine++;
    } else if (line.startsWith("\\")) {
      continue;
    } else if (line.startsWith("~")) {
      // sibling-signature annotation: emit once on the new side without
      // advancing counters
      newSideLines.push(line);
    } else {
      // unchanged context: advance both counters, emit only on the new side
      newSideLines.push(`${newLine} ${line}`);
      oldLine++;
      newLine++;
    }
  }
  const parts: string[] = [];
  if (newSideLines.length > 0) {
    parts.push("__new hunk__");
    parts.push(...newSideLines);
  }
  if (oldRemovedLines.length > 0) {
    parts.push("__old hunk__");
    parts.push(...oldRemovedLines);
  }
  return parts;
}

export function buildFindingExcerpt(patches: readonly FilePatch[], finding: Finding): string {
  const patch = patches.find((p) => p.path === finding.file);
  if (!patch) return EXCERPT_NO_HUNK;
  const endLine = finding.endLine ?? finding.line;
  const hunks = findOverlappingHunks(patch.hunks, finding.line, endLine);
  if (hunks.length === 0) return EXCERPT_NO_HUNK;
  const parts: string[] = [`## ${patch.path}`];
  for (const h of hunks) parts.push(...formatHunkExcerpt(h));
  return parts.join("\n");
}

const log = logger.child({ module: "judge" });

export interface JudgeConfig {
  enabled: boolean;
  /** minimum confidence score (0–10) to keep a finding. defaults to 6 */
  threshold: number;
  /** override model for the judge (e.g. a cheaper one). falls back to RUSTY_LLM_MODEL */
  model?: string;
}

interface JudgeEvaluation {
  index: number;
  confidence: number;
  reasoning: string;
}

const EvaluationSchema = z.object({
  index: z.number().describe("zero-based index of the finding being evaluated"),
  confidence: z
    .number()
    .min(0)
    .max(10)
    .describe(
      "confidence that this finding is a real, actionable issue (0 = certainly wrong, 10 = certainly correct)",
    ),
  reasoning: z.string().describe("one sentence explaining the confidence score"),
});

const JudgeOutputSchema = z.object({
  evaluations: z
    .array(EvaluationSchema)
    .describe("one evaluation per finding, in the same order as the input"),
});

const JUDGE_SYSTEM_PROMPT = `You are a skeptical code review quality judge. Your job is to reject weak findings, not to confirm them. Default to rejection unless the finding is clearly correct, grounded in the provided diff, and worth surfacing to a developer.

For each finding you receive, rate your confidence from 0 to 10 that the finding is correct and worth surfacing to a developer:

- 10: directly proven by the diff, with a concrete production or security impact
- 9: clearly correct and actionable, with strong evidence in the diff
- 7-8: likely correct, grounded, and worth developer attention
- 4-6: plausible but uncertain, incomplete, or not clearly worth surfacing
- 1-3: likely wrong, speculative, severity-inflated, or nitpicking
- 0: clearly hallucinated or factually incorrect

Reject or heavily penalize findings that are:
- claiming something is unused/missing without evidence
- flagging standard patterns as bugs (e.g. intentional fallthrough, optional chaining on purpose)
- suggesting changes that would break the code
- duplicating another finding with different wording
- nitpicking style when the review didn't ask for style feedback
- hallucinated line numbers or code references that don't match the diff
- about code outside the reviewed diff/chunk unless the finding explains why the changed code creates the issue
- missing-test complaints without a concrete changed behavior, edge case, or regression risk
- generic maintainability advice without a specific consequence
- severity-inflated findings where a suggestion or observation is labeled as warning/critical
- suggested fixes that contain prose, omit required surrounding syntax, or would not directly replace the target lines

You MUST return exactly one evaluation per finding, in the same order they were provided.`;

function formatFindingsForJudge(
  findings: readonly Finding[],
  patches: readonly FilePatch[],
): string {
  const parts: string[] = ["## Findings to evaluate\n"];

  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    const lineRange = f.endLine ? `${f.line}-${f.endLine}` : `${f.line}`;
    parts.push(`### Finding ${i}`);
    parts.push(`- **File:** ${f.file}`);
    parts.push(`- **Line:** ${lineRange}`);
    parts.push(`- **Severity:** ${f.severity}`);
    parts.push(`- **Category:** ${f.category}`);
    parts.push(`- **Message:** ${f.message}`);
    if (f.suggestedFix) {
      parts.push(`- **Suggested fix:**\n\`\`\`\n${f.suggestedFix}\n\`\`\``);
    }
    parts.push(`- **Diff context:**\n\`\`\`\n${buildFindingExcerpt(patches, f)}\n\`\`\``);
    parts.push("");
  }

  return parts.join("\n");
}

function resolveJudgeModel(judgeModelOverride?: string) {
  // override must go through the full resolution chain so azure-openai/ prefix
  // + API key + resource name get wrapped in createAzure() — otherwise the
  // raw string is handed to mastra's model router which doesn't know the
  // azure-openai provider
  const config = judgeModelOverride
    ? resolveModelConfigWithOverride(judgeModelOverride)
    : resolveModelConfig();
  return {
    displayName: getModelDisplayName(config),
    config,
  };
}

export function resolveJudgeConfig(): JudgeConfig {
  const enabled = process.env.RUSTY_JUDGE_ENABLED;
  const threshold = process.env.RUSTY_JUDGE_THRESHOLD;
  const model = process.env.RUSTY_JUDGE_MODEL;

  return {
    enabled: enabled === "true" || enabled === "1",
    threshold: threshold && !Number.isNaN(Number(threshold)) ? Number(threshold) : 6,
    model: model || undefined,
  };
}

export interface JudgeResult {
  accepted: Finding[];
  rejected: Finding[];
  evaluations: JudgeEvaluation[];
  tokenCount: number;
}

export async function judgeFindings(
  findings: readonly Finding[],
  patches: readonly FilePatch[],
  config: JudgeConfig,
): Promise<JudgeResult> {
  if (!config.enabled || findings.length === 0) {
    return { accepted: [...findings], rejected: [], evaluations: [], tokenCount: 0 };
  }

  const { displayName, config: modelConfig } = resolveJudgeModel(config.model);

  log.info(
    { findingCount: findings.length, model: displayName, threshold: config.threshold },
    "running judge pass",
  );

  const defaultOptions = resolveDefaultAgentOptions(modelConfig);
  const agent = new Agent({
    id: "review-judge",
    name: "Rusty Bot Judge",
    instructions: () => JUDGE_SYSTEM_PROMPT,
    model: () => resolveModel(modelConfig),
    ...(defaultOptions && { defaultOptions }),
  });

  const userMessage = formatFindingsForJudge(findings, patches);

  let evaluations: JudgeEvaluation[];
  let tokenCount = 0;
  try {
    const modelSettings = applyModelConstraints(modelConfig, resolveModelSettings("judge"));
    const jsonPromptInjection = resolveJsonPromptInjection(modelConfig);
    const response = await agent.generate(userMessage, {
      structuredOutput: { schema: JudgeOutputSchema, jsonPromptInjection },
      ...(Object.keys(modelSettings).length > 0 && { modelSettings }),
    });
    evaluations = response.object.evaluations;
    tokenCount = response.usage.totalTokens ?? 0;
  } catch (err) {
    log.warn({ err }, "judge pass failed, keeping all findings");
    return { accepted: [...findings], rejected: [], evaluations: [], tokenCount: 0 };
  }

  // build a lookup so we handle models returning fewer or out-of-order evaluations
  const evalByIndex = new Map(evaluations.map((e) => [e.index, e]));
  const accepted: Finding[] = [];
  const rejected: Finding[] = [];
  const rejectedWithEval: { finding: Finding; evaluation: JudgeEvaluation }[] = [];
  const resolvedEvaluations: JudgeEvaluation[] = [];

  for (let i = 0; i < findings.length; i++) {
    const evaluation = evalByIndex.get(i);
    const resolved: JudgeEvaluation = evaluation ?? {
      index: i,
      confidence: config.threshold,
      reasoning: "no evaluation returned",
    };
    resolvedEvaluations.push(resolved);

    if (resolved.confidence >= config.threshold) {
      accepted.push(findings[i]);
    } else {
      rejected.push(findings[i]);
      rejectedWithEval.push({ finding: findings[i], evaluation: resolved });
    }
  }

  for (const { finding, evaluation } of rejectedWithEval) {
    log.debug(
      {
        file: finding.file,
        line: finding.line,
        severity: finding.severity,
        confidence: evaluation.confidence,
        reasoning: evaluation.reasoning,
      },
      "finding filtered by judge",
    );
  }

  log.info(
    { accepted: accepted.length, rejected: rejected.length, total: findings.length, tokenCount },
    "judge pass complete",
  );

  return { accepted, rejected, evaluations: resolvedEvaluations, tokenCount };
}

export async function judgeReviewResult(
  result: ReviewResult,
  patches: readonly FilePatch[],
  config: JudgeConfig,
): Promise<ReviewResult> {
  if (!config.enabled) {
    return result;
  }

  const { accepted, rejected, tokenCount } = await judgeFindings(result.findings, patches, config);

  // the judge never evaluated pass votes, only findings — so an elevated
  // recommendation survives judging regardless of what happens to the findings
  const elevated = result.consensusMetadata?.recommendationElevated ? [result.recommendation] : [];
  const recommendation = deriveMergedRecommendation(accepted, elevated);

  return {
    ...result,
    findings: accepted,
    recommendation,
    filteredCount: rejected.length,
    judgeTokenCount: tokenCount,
  };
}
