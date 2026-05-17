import { Agent } from "@mastra/core/agent";
import type { ToolsInput } from "@mastra/core/agent";
import { generateText, Output } from "ai";
import type { z } from "zod";
import { ReviewOutputSchema, SkimReviewOutputSchema } from "./schema.js";
import { buildSystemPrompt, buildUserMessage, buildCachedSystemMessages } from "./prompts.js";
import {
  resolveModelConfig,
  resolveModelConfigWithOverride,
  resolveModel,
  getModelDisplayName,
  resolveModelSettings,
  resolveDefaultAgentOptions,
  resolveJsonPromptInjection,
  supportsAnthropicCacheControl,
  applyModelConstraints,
} from "./model.js";
import type { ModelConfig, ModelSettings } from "./model.js";
import type {
  ReviewConfig,
  PRMetadata,
  TicketInfo,
  ReviewResult,
  GitProvider,
  PriorReviewContext,
} from "../types.js";
import type { OpenGrepFinding } from "../opengrep/types.js";
import { createSearchCodeTool, createGetFileContextTool } from "./tools.js";
import { ToolCache } from "./tool-cache.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "review" });

const STRUCTURED_OUTPUT_VALIDATION_ERROR_ID = "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED";

function isStructuredOutputValidationError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "id" in err &&
    err.id === STRUCTURED_OUTPUT_VALIDATION_ERROR_ID
  );
}

// AI SDK marks transient upstream failures (headers timeout, 5xx, connection reset)
// with isRetryable=true. Mastra's internal pRetry handles per-request retries; this
// catches the case where its retries exhausted within a single tight timeout window
// and gives the caller a fresh request budget.
/** retryable HTTP statuses for upstream LLM calls — 408 (timeout), 425 (early
 * data), 429 (rate limit), and the 5xx server-side band. matches the ai-sdk's
 * APICallError convention so other providers downstream of mastra get the
 * same treatment. */
function isRetryableStatus(status: unknown): boolean {
  if (typeof status !== "number") return false;
  if (status === 408 || status === 425 || status === 429) return true;
  return status >= 500 && status < 600;
}

/** ai-sdk-ollama's OllamaError doesn't set ai-sdk's `isRetryable` marker, so
 * an upstream 503 from Ollama Cloud (e.g. "Server overloaded") falls through
 * pRetry's filter today. duck-type the error and look for ollama-js's
 * `status_code` (snake_case) on either the error itself or its `cause`. */
function isOllamaRetryableError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { name?: unknown; status_code?: unknown; cause?: unknown };
  if (e.name !== "OllamaError" && e.name !== "ResponseError") return false;
  if (isRetryableStatus(e.status_code)) return true;
  const cause = e.cause as { status_code?: unknown } | undefined;
  return isRetryableStatus(cause?.status_code);
}

function isTransientRetryableError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  if ("isRetryable" in err && (err as { isRetryable?: unknown }).isRetryable === true) {
    return true;
  }
  return isOllamaRetryableError(err);
}

const TRANSIENT_RETRY_BACKOFF_MS = [500, 2_000];

function readMaxTransientRetries(): number {
  const raw = process.env.RUSTY_LLM_MAX_RETRIES;
  if (raw === undefined) return TRANSIENT_RETRY_BACKOFF_MS.length;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return TRANSIENT_RETRY_BACKOFF_MS.length;
  return Math.min(Math.floor(n), TRANSIENT_RETRY_BACKOFF_MS.length);
}

// caps how many tool-use rounds an agent can run before mastra forces it to
// produce a final answer. unset = mastra's default. matters most for Anthropic
// models, which can otherwise fan out parallel tool calls indefinitely and
// terminate with finishReason="tool-calls" and zero text — defeating the
// structured-output contract.
function readLlmMaxSteps(): number | undefined {
  const raw = process.env.RUSTY_LLM_MAX_STEPS;
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}

/**
 * gated by `RUSTY_LOG_AGENT_STEPS=true`. when on, every agent step emits a
 * log line with `stepNumber`, `finishReason`, `toolCallCount`, and token
 * usage. lets us tell whether a long-running pass is making forward progress
 * (steady stream of `finishReason="tool-calls"` then a final `"stop"`) or
 * spinning in a tool-call loop without ever stopping. defaults to no-op so
 * the perf cost in production is zero.
 *
 * see FOLLOWUPS #3 (the Kimi tool-call termination diagnosis) and the
 * consensus quality writeup — this is the missing diagnostic for both.
 */
function buildStepLogger(bindings: Record<string, unknown>): ((step: unknown) => void) | undefined {
  if (process.env.RUSTY_LOG_AGENT_STEPS !== "true") return undefined;
  let stepNumber = 0;
  return (step) => {
    if (typeof step !== "object" || step === null) return;
    const s = step as {
      finishReason?: unknown;
      toolCalls?: { length?: number };
      usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number };
      warnings?: unknown[];
    };
    log.info(
      {
        ...bindings,
        stepNumber,
        finishReason: s.finishReason,
        toolCallCount: s.toolCalls?.length ?? 0,
        totalTokens: s.usage?.totalTokens,
        inputTokens: s.usage?.inputTokens,
        outputTokens: s.usage?.outputTokens,
        warningCount: Array.isArray(s.warnings) ? s.warnings.length : 0,
      },
      "agent step finished",
    );
    stepNumber++;
  };
}

// when set, mastra runs a separate structuring agent on top of the main
// review agent's output: the main agent produces freeform prose (with tools
// available, no schema pressure) and a cheap structuring model translates
// that prose into the schema-conformant JSON. eliminates the entire class of
// `finishReason: "tool-calls"` failures because the main agent isn't on the
// schema-output path at all. the structuring model handles the JSON.
function readLlmStructuringModel(): string | undefined {
  const raw = process.env.RUSTY_LLM_STRUCTURING_MODEL;
  if (raw === undefined || raw === "") return undefined;
  return raw;
}

// captures the fields most useful for diagnosing why r.object came back
// undefined: did the model truncate (finishReason: "length"), did it emit
// text wrapped in code fences, or did it pick a tool-call path the parser
// didn't expect? we cap text snippets so a multi-megabyte response can't
// blow up the log line.
const FAILED_RESPONSE_TEXT_PREVIEW_CHARS = 400;

function summarizeFailedResponse(r: unknown): Record<string, unknown> {
  const resp = r as {
    finishReason?: unknown;
    text?: unknown;
    reasoning?: unknown;
    warnings?: unknown;
    toolCalls?: unknown;
    usage?: { totalTokens?: unknown; outputTokens?: unknown };
  };
  const text = typeof resp.text === "string" ? resp.text : undefined;
  const reasoning = typeof resp.reasoning === "string" ? resp.reasoning : undefined;
  const toolCallCount = Array.isArray(resp.toolCalls) ? resp.toolCalls.length : undefined;
  const warningCount = Array.isArray(resp.warnings) ? resp.warnings.length : undefined;
  return {
    finishReason: resp.finishReason,
    textLength: text?.length ?? 0,
    textPreview: text?.slice(0, FAILED_RESPONSE_TEXT_PREVIEW_CHARS),
    reasoningLength: reasoning?.length,
    toolCallCount,
    warningCount,
    warnings: warningCount && warningCount > 0 ? resp.warnings : undefined,
    outputTokens: resp.usage?.outputTokens,
    totalTokens: resp.usage?.totalTokens,
  };
}

interface StructurerRetryUsage {
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface StructurerRetryResult {
  object: unknown;
  usage?: StructurerRetryUsage;
}

/**
 * Retry just the structuring step on the reviewer's prose. The agent
 * already produced `prose` (the expensive part — multi-step tool-using
 * trajectory). When the primary structurer returned no object, retrying
 * with the same prose at the structurer level is ~$0.005 vs ~$0.10 for a
 * full reviewer reroll. The agent's tool trajectory and bias toward
 * extractable prose are preserved across the cheap retry.
 *
 * Returns null when the retry itself fails — caller falls through to the
 * existing expensive retry path so we still get the previous behavior as
 * a backstop.
 */
async function retryStructurerOnProse(
  prose: string,
  schema: z.ZodType,
  structuringConfig: ModelConfig,
  bindings: Record<string, unknown>,
): Promise<StructurerRetryResult | null> {
  try {
    const result = await generateText({
      model: resolveModel(structuringConfig),
      output: Output.object({ schema }),
      prompt:
        "Convert the following code review into the requested JSON structure. " +
        "Preserve every finding, observation, and field exactly as written.\n\n" +
        prose,
    });
    log.info(
      {
        ...bindings,
        structurerRetryTokens: result.usage.totalTokens,
      },
      "structurer-only retry succeeded after primary returned no object",
    );
    return { object: result.output, usage: result.usage };
  } catch (err) {
    log.warn(
      { ...bindings, err },
      "structurer-only retry also failed; falling back to full reviewer reroll",
    );
    return null;
  }
}

/** merge the structurer-only retry's usage into the original Mastra response.
 * preserves the original response shape so downstream consumers see one
 * coherent usage object that reflects the actual tokens billed. */
function augmentResponseWithStructurerRetry<T extends { usage?: StructurerRetryUsage }>(
  original: T,
  retry: StructurerRetryResult,
): T & { object: unknown } {
  const origUsage = original.usage ?? {};
  const retryUsage = retry.usage ?? {};
  const sumOpt = (a?: number, b?: number): number | undefined => {
    if (a === undefined && b === undefined) return undefined;
    return (a ?? 0) + (b ?? 0);
  };
  return {
    ...original,
    object: retry.object,
    usage: {
      ...origUsage,
      totalTokens: sumOpt(origUsage.totalTokens, retryUsage.totalTokens),
      inputTokens: sumOpt(origUsage.inputTokens, retryUsage.inputTokens),
      outputTokens: sumOpt(origUsage.outputTokens, retryUsage.outputTokens),
    },
  };
}

async function generateWithStructuredOutputRetry<T>(
  fn: () => Promise<T>,
  bindings: Record<string, unknown> = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isStructuredOutputValidationError(err)) throw err;
    log.warn(
      { ...bindings, err },
      "structured output validation failed, retrying once before giving up on this pass",
    );
    return await fn();
  }
}

async function generateWithTransientRetry<T>(
  fn: () => Promise<T>,
  bindings: Record<string, unknown> = {},
): Promise<T> {
  const maxRetries = readMaxTransientRetries();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientRetryableError(err) || attempt === maxRetries) throw err;
      const backoffMs = TRANSIENT_RETRY_BACKOFF_MS[attempt];
      log.warn(
        { ...bindings, err, attempt: attempt + 1, maxRetries, backoffMs },
        "transient LLM error, retrying after backoff",
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
  throw lastErr;
}

export type ReviewTier = "skim" | "deep-review";

export interface RunReviewOptions {
  provider?: GitProvider;
  sourceRef?: string;
  extraTools?: ToolsInput;
  languageSummary?: string;
  tier?: ReviewTier;
  /** Files changed in the PR but not present in the current review chunk. */
  otherPrFiles?: string[];
  /** Files actually present in the current review chunk; used to constrain finding paths. */
  chunkFiles?: string[];
  /** OpenGrep findings to feed to the LLM for triage. */
  openGrepFindings?: OpenGrepFinding[];
  /** Ranked dependency context selected under a token budget for deep review. */
  rankedContext?: string;
  /** PR-wide context carried forward from a previous review (incremental re-reviews only). */
  priorContext?: PriorReviewContext;
  /** override used by consensus pass planning; defaults to RUSTY_LLM_MODEL. */
  modelConfig?: ModelConfig;
  /** override used by consensus pass planning; defaults to review env settings. */
  modelSettings?: ModelSettings;
}

function buildTools(options?: RunReviewOptions): ToolsInput {
  if (options?.tier === "skim") return {};

  const tools: ToolsInput = {};
  if (options?.provider) {
    const cache = new ToolCache(options.provider, options.sourceRef ?? "HEAD");
    tools.searchCode = createSearchCodeTool(cache);
    if (options.sourceRef) {
      tools.getFileContext = createGetFileContextTool(cache);
    }
  }
  return tools;
}

export async function runReview(
  config: ReviewConfig,
  diff: string,
  prMetadata: PRMetadata,
  ticketContext?: TicketInfo[],
  options?: RunReviewOptions,
): Promise<ReviewResult> {
  const tier = options?.tier ?? "deep-review";
  const systemPrompt = buildSystemPrompt(config);
  const userMessage = buildUserMessage(
    diff,
    prMetadata,
    ticketContext,
    options?.languageSummary,
    options?.otherPrFiles,
    options?.openGrepFindings,
    options?.chunkFiles,
    tier === "deep-review" ? options?.rankedContext : undefined,
    options?.priorContext,
  );
  const modelConfig = options?.modelConfig ?? resolveModelConfig();
  const modelName = getModelDisplayName(modelConfig);

  const builtInTools = buildTools(options);
  const extraTools = tier === "skim" ? {} : (options?.extraTools ?? {});

  const defaultOptions = resolveDefaultAgentOptions(modelConfig);

  const agent = new Agent({
    id: "review-agent",
    name: "Rusty Bot Reviewer",
    instructions: () =>
      buildCachedSystemMessages(systemPrompt, {
        anthropicCacheControl: supportsAnthropicCacheControl(modelConfig),
      }),
    model: () => resolveModel(modelConfig),
    tools: { ...builtInTools, ...extraTools },
    ...(defaultOptions && { defaultOptions }),
  });

  const schema = tier === "skim" ? SkimReviewOutputSchema : ReviewOutputSchema;

  const rawModelSettings = options?.modelSettings ?? resolveModelSettings("review");
  const modelSettings = applyModelConstraints(modelConfig, rawModelSettings);
  // when the structuring model is set, it owns the JSON output, so we evaluate
  // jsonPromptInjection against ITS capabilities rather than the main model's.
  // the main model just writes prose; whether to use native json_schema vs
  // prompt-injected JSON is the structurer's problem.
  const structuringModelOverride = readLlmStructuringModel();
  const structuringConfig = structuringModelOverride
    ? resolveModelConfigWithOverride(structuringModelOverride)
    : undefined;
  const jsonPromptInjection = resolveJsonPromptInjection(structuringConfig ?? modelConfig);
  const structuringModel = structuringConfig ? resolveModel(structuringConfig) : undefined;
  const maxSteps = readLlmMaxSteps();
  // when capping steps we ALSO have to force the final step to be tool-free,
  // otherwise tool-happy models (Anthropic in particular) burn the whole budget
  // on tool calls and end with finishReason="tool-calls" and no text — which
  // produces no structured output and the pass fails. stripping tools on the
  // last allowed step guarantees the model emits a final answer. the anti-meta-
  // narrative rules that prevent "investigation is in progress" / "no input was
  // provided" summaries live in the base system prompt (see prompts/base.txt)
  // so they apply at every step, not just the forced-termination one — the
  // failure mode also fires when the model stops voluntarily.
  const prepareStep =
    maxSteps !== undefined
      ? ({ stepNumber }: { stepNumber: number }) => {
          if (stepNumber >= maxSteps - 1) {
            return { toolChoice: "none" as const, activeTools: [] };
          }
        }
      : undefined;
  const logBindings = {
    model: modelName,
    tier,
    ...(structuringConfig && { structuringModel: getModelDisplayName(structuringConfig) }),
  };
  const onStepFinish = buildStepLogger(logBindings);
  const response = await generateWithTransientRetry(
    () =>
      generateWithStructuredOutputRetry(async () => {
        const r = await agent.generate(userMessage, {
          structuredOutput: {
            schema,
            jsonPromptInjection,
            ...(structuringModel && { model: structuringModel }),
          },
          ...(Object.keys(modelSettings).length > 0 && { modelSettings }),
          ...(maxSteps !== undefined && { maxSteps }),
          ...(prepareStep && { prepareStep }),
          ...(onStepFinish && { onStepFinish }),
        });
        // mastra's prompt-injected JSON path can silently return object:undefined
        // when the model emits unparseable text instead of throwing the schema
        // validation error. surface it as one so the retry wrapper picks it up.
        // typed cast because mastra's return type marks .object as always defined.
        if (!(r as { object?: unknown }).object) {
          log.warn(
            { ...logBindings, ...summarizeFailedResponse(r) },
            "structured output produced no object — captured diagnostic snapshot",
          );

          // CHEAP RETRY: structurer-only on the reviewer's prose. The expensive
          // tool trajectory already ran and produced text — re-running the whole
          // agent.generate (the existing fallback below) costs ~20× more than
          // just retrying the structurer on the cached prose. Only fires when
          // a structuring model is configured AND we actually have prose to
          // restructure. On failure, falls through to the existing retry path.
          const proseFromR = (r as { text?: unknown }).text;
          if (structuringConfig && typeof proseFromR === "string" && proseFromR.length > 0) {
            const retried = await retryStructurerOnProse(
              proseFromR,
              schema,
              structuringConfig,
              logBindings,
            );
            if (retried) {
              return augmentResponseWithStructurerRetry(
                r as { usage?: StructurerRetryUsage },
                retried,
              ) as typeof r;
            }
          }

          const err = new Error(
            "structured output parser returned no object (model likely emitted text outside the JSON block or truncated)",
          );
          (err as Error & { id?: string }).id = STRUCTURED_OUTPUT_VALIDATION_ERROR_ID;
          throw err;
        }
        return r;
      }, logBindings),
    logBindings,
  );

  const parsed = response.object;
  const usage = response.usage as {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
  };
  const totalTokens = usage.totalTokens ?? 0;

  if (totalTokens === 0) {
    // some upstream providers (notably non-OpenAI Azure Foundry deployments)
    // return chat-completions responses without a populated usage block, so the
    // ai-sdk parser collapses every token field to undefined. dump the raw shape
    // once per occurrence so we can tell missing usage apart from a zero-cost
    // cache hit and adapt the parser if the field is just nested somewhere else.
    const diag = response as {
      usage?: unknown;
      warnings?: unknown;
      providerMetadata?: unknown;
    };
    log.warn(
      {
        ...logBindings,
        rawUsage: diag.usage,
        warnings: diag.warnings,
        providerMetadata: diag.providerMetadata,
      },
      "review pass returned zero total tokens — capturing diagnostic snapshot",
    );
  }

  log.info(
    {
      ...logBindings,
      tokens: totalTokens,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      reasoningTokens: usage.reasoningTokens,
    },
    "review pass complete",
  );

  return {
    summary: parsed.summary,
    recommendation: parsed.recommendation,
    findings: parsed.findings.map((f) => ({
      ...f,
      suggestedFix: ((f as Record<string, unknown>).suggestedFix as string | null) ?? null,
    })),
    observations: parsed.observations,
    ticketCompliance:
      "ticketCompliance" in parsed
        ? ((parsed as Record<string, unknown>).ticketCompliance as ReviewResult["ticketCompliance"])
        : [],
    missingTests:
      "missingTests" in parsed
        ? ((parsed as Record<string, unknown>).missingTests as ReviewResult["missingTests"])
        : [],
    filesReviewed: parsed.filesReviewed,
    modelUsed: modelName,
    tokenCount: totalTokens,
  };
}
