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
import { normalizePath } from "./multi-call.js";

const EXCERPT_NO_HUNK =
  "(no diff excerpt available for this finding — judge it on its own merits; absence of an excerpt is not evidence against it)";

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
  const patch = patches.find((p) => normalizePath(p.path) === normalizePath(finding.file));
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
  index: z.number().int().min(0).describe("zero-based index of the finding being evaluated"),
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

const TRUTHY_VALUES = ["true", "1", "yes"];

function resolveEnabled(raw: string | undefined): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  if (TRUTHY_VALUES.includes(normalized)) return true;
  log.warn({ value: raw }, "unrecognized RUSTY_JUDGE_ENABLED value, treating judge as disabled");
  return false;
}

function resolveThreshold(raw: string | undefined): number {
  if (!raw || Number.isNaN(Number(raw))) return 6;
  const parsed = Number(raw);
  const clamped = Math.min(10, Math.max(0, parsed));
  if (clamped !== parsed) {
    log.warn({ value: raw, clamped }, "RUSTY_JUDGE_THRESHOLD out of the 0-10 range, clamping");
  }
  return clamped;
}

export function resolveJudgeConfig(): JudgeConfig {
  const enabled = process.env.RUSTY_JUDGE_ENABLED;
  const threshold = process.env.RUSTY_JUDGE_THRESHOLD;
  const model = process.env.RUSTY_JUDGE_MODEL;

  return {
    enabled: resolveEnabled(enabled),
    threshold: resolveThreshold(threshold),
    model: model || undefined,
  };
}

export interface JudgeResult {
  accepted: Finding[];
  rejected: Finding[];
  evaluations: JudgeEvaluation[];
  tokenCount: number;
  /** set only when the judge call errored or returned unusable evaluations; callers should treat this as fail-open, not as a healthy zero-filter run */
  failed?: true;
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
    // default to temperature 0 for reproducible scores; env vars (spread after)
    // and hard provider locks (applied by applyModelConstraints) still win
    const modelSettings = applyModelConstraints(modelConfig, {
      temperature: 0,
      ...resolveModelSettings("judge"),
    });
    const jsonPromptInjection = resolveJsonPromptInjection(modelConfig);
    const response = await agent.generate(userMessage, {
      structuredOutput: { schema: JudgeOutputSchema, jsonPromptInjection },
      ...(Object.keys(modelSettings).length > 0 && { modelSettings }),
    });
    evaluations = response.object.evaluations;
    tokenCount = response.usage.totalTokens ?? 0;
  } catch (err) {
    log.warn({ err }, "judge pass failed, keeping all findings");
    return { accepted: [...findings], rejected: [], evaluations: [], tokenCount: 0, failed: true };
  }

  // build a lookup so we handle models returning fewer, out-of-order, or
  // malformed evaluations. out-of-range indices are dropped (and counted);
  // duplicate indices keep the last evaluation seen for that index.
  let duplicateCount = 0;
  let outOfRangeCount = 0;
  const evalByIndex = new Map<number, JudgeEvaluation>();
  for (const e of evaluations) {
    if (e.index >= findings.length) {
      outOfRangeCount++;
      continue;
    }
    if (evalByIndex.has(e.index)) duplicateCount++;
    evalByIndex.set(e.index, e);
  }
  if (duplicateCount > 0 || outOfRangeCount > 0) {
    log.warn(
      {
        duplicateCount,
        outOfRangeCount,
        evaluationCount: evaluations.length,
        findingCount: findings.length,
      },
      "judge returned malformed evaluation indices",
    );
  }

  // every returned evaluation pointed outside the finding list — most likely
  // 1-based indexing from the model. none of the scores can be trusted, so
  // fail open the same way a thrown call does.
  if (evaluations.length > 0 && evalByIndex.size === 0) {
    log.warn(
      { evaluationCount: evaluations.length, findingCount: findings.length },
      "judge returned no usable evaluations (all indices out of range) — treating as judge failure",
    );
    return { accepted: [...findings], rejected: [], evaluations: [], tokenCount: 0, failed: true };
  }

  if (evaluations.length !== findings.length) {
    log.warn(
      { evaluationCount: evaluations.length, findingCount: findings.length },
      "judge returned a different number of evaluations than findings",
    );
  }

  const accepted: Finding[] = [];
  const rejected: Finding[] = [];
  const rejectedWithEval: { finding: Finding; evaluation: JudgeEvaluation }[] = [];
  const resolvedEvaluations: JudgeEvaluation[] = [];
  const scoreLogEntries: {
    file: string;
    line: number;
    severity: Finding["severity"];
    category: Finding["category"];
    voteCount: number | undefined;
    confidence: number;
    accepted: boolean;
    defaulted: boolean;
    reasoning: string;
  }[] = [];

  for (let i = 0; i < findings.length; i++) {
    const evaluation = evalByIndex.get(i);
    const defaulted = !evaluation;
    const resolved: JudgeEvaluation = evaluation ?? {
      index: i,
      confidence: config.threshold,
      reasoning: "no evaluation returned — accepted by default",
    };
    resolvedEvaluations.push(resolved);

    // a finding with no evaluation is fail-open: never dropped for lack of a score
    const isAccepted = defaulted || resolved.confidence >= config.threshold;
    if (isAccepted) {
      accepted.push(findings[i]);
    } else {
      rejected.push(findings[i]);
      rejectedWithEval.push({ finding: findings[i], evaluation: resolved });
    }

    scoreLogEntries.push({
      file: findings[i].file,
      line: findings[i].line,
      severity: findings[i].severity,
      category: findings[i].category,
      voteCount: findings[i].voteCount,
      confidence: resolved.confidence,
      accepted: isAccepted,
      defaulted,
      reasoning: resolved.reasoning,
    });
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

  // gated by RUSTY_LOG_JUDGE_SCORES=true. emits every per-finding score (not
  // just rejections) so the threshold can actually be calibrated from data —
  // see FOLLOWUPS.md item 2. info level (not debug) since this is the whole
  // point of the flag. no diff/suggestedFix content, so output stays safe to
  // export as an artifact.
  if (process.env.RUSTY_LOG_JUDGE_SCORES === "true") {
    log.info(
      { model: displayName, threshold: config.threshold, evaluations: scoreLogEntries },
      "judge per-finding scores",
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

  const { accepted, rejected, tokenCount, failed } = await judgeFindings(
    result.findings,
    patches,
    config,
  );

  // when consensus elevated the recommendation based on pass votes (not findings),
  // and there are no findings for the judge to evaluate, preserve it
  const shouldPreserveElevated =
    accepted.length === 0 && result.consensusMetadata?.recommendationElevated === true;

  const criticalCount = accepted.filter((f) => f.severity === "critical").length;
  const recommendation = shouldPreserveElevated
    ? result.recommendation
    : criticalCount > 0
      ? ("critical_issues" as const)
      : accepted.length > 0
        ? ("address_before_merge" as const)
        : ("looks_good" as const);

  return {
    ...result,
    findings: accepted,
    recommendation,
    judgeStatus: failed ? "failed" : "ok",
    // a failed judge kept every finding — filteredCount/judgeTokenCount would
    // render as "0 filtered · 0 tokens", indistinguishable from a healthy
    // no-op run. leave them undefined so the footer can tell the difference.
    ...(failed ? {} : { filteredCount: rejected.length, judgeTokenCount: tokenCount }),
  };
}
