import type { ToolSet } from "ai";
import type { z } from "zod";
import {
  ReviewOutputSchema,
  ScopeCreepReviewOutputSchema,
  SkimReviewOutputSchema,
} from "./schema.js";
import { buildSystemPrompt, buildUserMessage, buildCachedSystemMessages } from "./prompts.js";
import {
  resolveModelConfig,
  resolveModelConfigWithOverride,
  getModelDisplayName,
  resolveModelSettings,
  supportsAnthropicCacheControl,
  applyModelConstraints,
} from "./model.js";
import type { ModelConfig, ModelSettings } from "./model.js";
import {
  generateProse,
  generateStructured,
  STRUCTURED_OUTPUT_VALIDATION_ERROR_ID,
  type ProseResult,
  type StructuredCall,
  type StructuredResult,
} from "./generate.js";
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

const EMPTY_PROVIDER_RESPONSE_ERROR_ID = "EMPTY_PROVIDER_RESPONSE";

export const TOOL_LOOP_EXHAUSTED_ERROR_ID = "TOOL_LOOP_EXHAUSTED";

const MAX_LOGGED_ERROR_MESSAGE_CHARS = 500;

/**
 * the ai-sdk's APICallError carries `requestBodyValues` (system prompt, convention
 * files, the whole diff) and `responseBody`. logging the error object dumps all of
 * it into the ci log, so log this summary instead. only affects what is logged.
 */
function summarizeLlmError(err: unknown): Record<string, unknown> {
  if (typeof err !== "object" || err === null) return { message: String(err) };
  const e = err as Record<string, unknown>;
  const message = typeof e.message === "string" ? e.message : undefined;
  return {
    name: e.name,
    message:
      message && message.length > MAX_LOGGED_ERROR_MESSAGE_CHARS
        ? `${message.slice(0, MAX_LOGGED_ERROR_MESSAGE_CHARS)}…`
        : message,
    statusCode: e.statusCode,
    isRetryable: e.isRetryable,
    url: e.url,
    provider: e.provider,
  };
}

/**
 * a tool-calls finish with no text after the full step budget means the provider
 * ignored the tool-free final step. re-running the identical trajectory fails the
 * same way, and there is no prose for a structurer-only retry either.
 */
function isToolLoopExhausted(r: unknown, maxSteps: number): boolean {
  const resp = r as { finishReason?: unknown; text?: unknown; steps?: unknown };
  if (resp.finishReason !== "tool-calls") return false;
  if (typeof resp.text === "string" && resp.text.length > 0) return false;
  return Array.isArray(resp.steps) && resp.steps.length >= maxSteps;
}

function isStructuredOutputValidationError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "id" in err &&
    err.id === STRUCTURED_OUTPUT_VALIDATION_ERROR_ID
  );
}

/**
 * distinguishes "the provider gave us nothing" from "the model emitted text we
 * couldn't parse". an upstream failure behind a gateway surfaces as a 200 whose
 * choice carries no content, no tool calls and — critically — no usage block at
 * all, which the ai-sdk collapses to finishReason "other" with every token
 * counter at zero. openrouter does this for gemini-3 reasoning models whose
 * thought signatures don't survive its /chat/completions shim: the provider
 * strips the unsigned reasoning_details, the model gets an empty assistant turn
 * back, and every subsequent step returns empty too.
 *
 * zero INPUT tokens is the discriminator — a model that merely produced
 * unparseable text still bills for the prompt it read. retrying an empty
 * completion costs a full multi-step trajectory and never succeeds, so callers
 * fail the pass immediately rather than paying for it twice.
 */
function isEmptyProviderResponse(r: unknown): boolean {
  const resp = r as {
    text?: unknown;
    toolCalls?: unknown;
    usage?: { totalTokens?: unknown; inputTokens?: unknown };
  };
  if (typeof resp.text === "string" && resp.text.length > 0) return false;
  if (Array.isArray(resp.toolCalls) && resp.toolCalls.length > 0) return false;
  const usage = resp.usage;
  if (!usage) return true;
  const noTotal = usage.totalTokens === 0 || usage.totalTokens === undefined;
  const noInput = usage.inputTokens === 0 || usage.inputTokens === undefined;
  return noTotal && noInput;
}

// AI SDK marks transient upstream failures (headers timeout, 5xx, connection reset)
// with isRetryable=true. generateText's own maxRetries handles per-request retries; this
// catches the case where its retries exhausted within a single tight timeout window
// and gives the caller a fresh request budget.
/** retryable HTTP statuses for upstream LLM calls — 408 (timeout), 425 (early
 * data), 429 (rate limit), and the 5xx server-side band. matches the ai-sdk's
 * APICallError convention so providers that don't set isRetryable get the
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

const DEFAULT_LLM_MAX_STEPS = 20;

// caps how many tool-use rounds an agent can run before it is forced to
// produce a final answer. unset/invalid = 20. the cap is the only bound on the
// tool loop (it becomes stepCountIs(maxSteps)), and the last allowed step is
// forced tool-free by prepareStep so the run ends with text instead of
// finishReason="tool-calls" and zero text.
function readLlmMaxSteps(): number {
  const raw = process.env.RUSTY_LLM_MAX_STEPS;
  if (raw === undefined || raw === "") return DEFAULT_LLM_MAX_STEPS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LLM_MAX_STEPS;
  return Math.floor(n);
}

const DEFAULT_REVIEW_PASS_TIMEOUT_MS = 480_000;
export const REVIEW_PASS_TIMEOUT_ERROR_ID = "REVIEW_PASS_TIMEOUT";

function readPositiveMs(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}

// wall-clock budget for one runReview call, retries included. unset/invalid = 8 minutes.
export function readReviewPassTimeoutMs(): number {
  return readPositiveMs("RUSTY_REVIEW_PASS_TIMEOUT_MS") ?? DEFAULT_REVIEW_PASS_TIMEOUT_MS;
}

// optional review-wide budget; unset/invalid = no deadline.
export function readReviewDeadlineMs(): number | undefined {
  return readPositiveMs("RUSTY_REVIEW_DEADLINE_MS");
}

export function isReviewPassTimeoutError(err: unknown): boolean {
  return (err as { id?: unknown } | null)?.id === REVIEW_PASS_TIMEOUT_ERROR_ID;
}

function createReviewPassTimeoutError(budgetMs: number): Error {
  const err = new Error(`review pass exceeded its ${budgetMs}ms time budget`);
  (err as Error & { id?: string }).id = REVIEW_PASS_TIMEOUT_ERROR_ID;
  return err;
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
function buildStepLogger(
  bindings: Record<string, unknown>,
  attempt: number,
): ((step: unknown) => void) | undefined {
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
        attempt,
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

// when set, a separate structuring call runs on top of the main review
// agent's output: the main agent produces freeform prose (with tools
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

// the summarized fields above are all post-parse, so they can't tell us what the
// gateway actually sent. on the empty-completion path that raw body is the only
// place the upstream failure is named (openrouter puts the provider's own error
// and its unmapped finish_reason there), so we dump a capped slice of it.
const RAW_RESPONSE_BODY_PREVIEW_CHARS = 2000;

function previewRawResponseBody(r: unknown): string | undefined {
  const body = (r as { response?: { body?: unknown } }).response?.body;
  if (body === undefined) return undefined;
  try {
    return JSON.stringify(body).slice(0, RAW_RESPONSE_BODY_PREVIEW_CHARS);
  } catch {
    return undefined;
  }
}

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

const STRUCTURER_PROMPT =
  "Convert the following code review into the requested JSON structure. " +
  "Preserve every finding, observation, and field exactly as written.";

/**
 * reviewer writes prose with tools, then the structuring model turns it into
 * the schema. an empty transcript skips the structurer: there is nothing to
 * convert, and its tokens would hide an empty completion from
 * isEmptyProviderResponse. a structurer that produces no valid object leaves
 * `object` undefined so the caller's cheap structurer-only retry gets its turn.
 */
async function generateProseThenStructure(
  call: Omit<StructuredCall<unknown>, "schema">,
  schema: z.ZodType,
  structuringConfig: ModelConfig,
): Promise<StructuredResult<unknown>> {
  const prose: ProseResult = await generateProse(call);
  if (prose.text.length === 0) return { ...prose, object: undefined };
  try {
    const structured = await generateStructured({
      modelConfig: structuringConfig,
      system: STRUCTURER_PROMPT,
      prompt: prose.text,
      schema,
      settings: {},
      ...(call.abortSignal && { abortSignal: call.abortSignal }),
    });
    return augmentResponseWithStructurerRetry(prose, structured);
  } catch (err) {
    if (!isStructuredOutputValidationError(err)) throw err;
    return { ...prose, object: undefined };
  }
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
    const result = await generateStructured({
      modelConfig: structuringConfig,
      system: STRUCTURER_PROMPT,
      prompt: prose,
      schema,
      settings: {},
    });
    if (result.object === undefined) throw new Error("structurer returned no parseable object");
    log.info(
      {
        ...bindings,
        structurerRetryTokens: result.usage.totalTokens,
      },
      "structurer-only retry succeeded after primary returned no object",
    );
    return { object: result.object, usage: result.usage };
  } catch (err) {
    log.warn(
      { ...bindings, err: summarizeLlmError(err) },
      "structurer-only retry also failed; falling back to full reviewer reroll",
    );
    return null;
  }
}

/** merge a structuring call's usage into the reviewer's response.
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

interface RetryGuard {
  /** aborted once the pass budget is spent; no further attempt may start after that. */
  signal: AbortSignal;
  bindings: Record<string, unknown>;
}

async function generateWithStructuredOutputRetry<T>(
  fn: () => Promise<T>,
  { signal, bindings }: RetryGuard,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!isStructuredOutputValidationError(err) || signal.aborted) throw err;
    log.warn(
      { ...bindings, err: summarizeLlmError(err) },
      "structured output validation failed, retrying once before giving up on this pass",
    );
    return await fn();
  }
}

async function generateWithTransientRetry<T>(
  fn: () => Promise<T>,
  { signal, bindings }: RetryGuard,
): Promise<T> {
  const maxRetries = readMaxTransientRetries();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientRetryableError(err) || attempt === maxRetries || signal.aborted) throw err;
      const backoffMs = TRANSIENT_RETRY_BACKOFF_MS[attempt];
      log.warn(
        { ...bindings, err: summarizeLlmError(err), attempt: attempt + 1, maxRetries, backoffMs },
        "transient LLM error, retrying after backoff",
      );
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      signal.throwIfAborted();
    }
  }
  throw lastErr;
}

export type ReviewTier = "skim" | "deep-review";

export interface RunReviewOptions {
  provider?: GitProvider;
  sourceRef?: string;
  extraTools?: ToolSet;
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
  /** epoch ms after which no pass may keep running; stamped from RUSTY_REVIEW_DEADLINE_MS. */
  deadlineAt?: number;
  /** search/file cache shared by every pass of one review; created at the multi-call entry points. */
  toolCache?: ToolCache;
}

function buildTools(options?: RunReviewOptions): ToolSet {
  if (options?.tier === "skim") return {};

  const tools: ToolSet = {};
  if (options?.provider) {
    const cache = options.toolCache ?? new ToolCache(options.provider, options.sourceRef ?? "HEAD");
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
  const budgetMs = Math.min(
    readReviewPassTimeoutMs(),
    options?.deadlineAt === undefined ? Infinity : options.deadlineAt - Date.now(),
  );
  if (budgetMs <= 0) throw createReviewPassTimeoutError(budgetMs);
  const systemPrompt = buildSystemPrompt(config, tier);
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

  const systemMessages = buildCachedSystemMessages(systemPrompt, {
    anthropicCacheControl: supportsAnthropicCacheControl(modelConfig),
  });
  const tools = { ...builtInTools, ...extraTools };

  const schema =
    tier === "skim"
      ? SkimReviewOutputSchema
      : config.flagScopeCreep === true
        ? ScopeCreepReviewOutputSchema
        : ReviewOutputSchema;

  const rawModelSettings = options?.modelSettings ?? resolveModelSettings("review");
  const modelSettings = applyModelConstraints(modelConfig, rawModelSettings);
  // when the structuring model is set, it owns the JSON output, so the native
  // json_schema vs prompt-injected JSON decision (made inside
  // generateStructured) follows ITS capabilities rather than the main model's.
  // the main model just writes prose.
  const structuringModelOverride = readLlmStructuringModel();
  const structuringConfig = structuringModelOverride
    ? resolveModelConfigWithOverride(structuringModelOverride)
    : undefined;
  const maxSteps = readLlmMaxSteps();
  // the final allowed step has to be tool-free, otherwise tool-happy models
  // (Anthropic in particular) burn the whole budget on tool calls and end with finishReason="tool-calls" and no text — which
  // produces no structured output and the pass fails. stripping tools on the
  // last allowed step guarantees the model emits a final answer. the anti-meta-
  // narrative rules that prevent "investigation is in progress" / "no input was
  // provided" summaries live in the base system prompt (see prompts/base.txt)
  // so they apply at every step, not just the forced-termination one — the
  // failure mode also fires when the model stops voluntarily.
  const prepareStep = ({ stepNumber }: { stepNumber: number }) => {
    if (stepNumber >= maxSteps - 1) {
      return { toolChoice: "none" as const, activeTools: [] };
    }
  };
  const logBindings = {
    model: modelName,
    tier,
    ...(structuringConfig && { structuringModel: getModelDisplayName(structuringConfig) }),
  };
  let generateAttempt = 0;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // providers can ignore the abort signal, so the pass is also raced against it
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = createReviewPassTimeoutError(budgetMs);
      log.warn({ ...logBindings, budgetMs }, "review pass exceeded its time budget, aborting");
      controller.abort(err);
      reject(err);
    }, budgetMs);
  });
  const retryGuard: RetryGuard = { signal: controller.signal, bindings: logBindings };
  const generation = generateWithTransientRetry(
    () =>
      generateWithStructuredOutputRetry(async () => {
        generateAttempt++;
        const onStepFinish = buildStepLogger(logBindings, generateAttempt);
        const call = {
          modelConfig,
          system: systemMessages,
          prompt: userMessage,
          settings: modelSettings,
          tools,
          maxSteps,
          prepareStep,
          abortSignal: controller.signal,
          ...(onStepFinish && { onStepFinish }),
        };
        const r = structuringConfig
          ? await generateProseThenStructure(call, schema, structuringConfig)
          : await generateStructured<unknown>({ ...call, schema });
        // the prompt-injected path, a run whose last step was not "stop", and a
        // structurer that produced nothing all come back as object:undefined
        // rather than throwing. surface it as the schema validation error so
        // the retry wrapper picks it up.
        if (!r.object) {
          log.warn(
            { ...logBindings, ...summarizeFailedResponse(r) },
            "structured output produced no object — captured diagnostic snapshot",
          );

          // an empty completion is an upstream failure, not a parsing problem.
          // both retry paths below re-run the model, so letting one through
          // burns a second full trajectory on a call that returned nothing the
          // first time. fail the pass now and let the tier/consensus layer
          // decide whether the review can survive without it.
          if (isEmptyProviderResponse(r)) {
            log.error(
              {
                ...logBindings,
                ...summarizeFailedResponse(r),
                providerMetadata: (r as { providerMetadata?: unknown }).providerMetadata,
                rawResponseBody: previewRawResponseBody(r),
              },
              "provider returned an empty completion — failing pass without retry",
            );
            const emptyErr = new Error(
              "provider returned an empty completion (no text, no tool calls, no token usage) — the upstream model produced nothing",
            );
            (emptyErr as Error & { id?: string }).id = EMPTY_PROVIDER_RESPONSE_ERROR_ID;
            throw emptyErr;
          }

          if (isToolLoopExhausted(r, maxSteps)) {
            const steps = (r as { steps: unknown[] }).steps.length;
            log.warn(
              {
                ...logBindings,
                steps,
                toolCallCount: (r as { toolCalls?: unknown[] }).toolCalls?.length ?? 0,
              },
              "step budget spent on tool calls with no final answer — failing pass without retry",
            );
            const loopErr = new Error(
              `model spent all ${maxSteps} steps on tool calls and never produced a final answer (provider likely ignored the tool-free final step)`,
            );
            (loopErr as Error & { id?: string }).id = TOOL_LOOP_EXHAUSTED_ERROR_ID;
            throw loopErr;
          }

          // CHEAP RETRY: structurer-only on the reviewer's prose. The expensive
          // tool trajectory already ran and produced text — re-running the whole
          // reviewer generation (the existing fallback below) costs ~20× more than
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
              return augmentResponseWithStructurerRetry(r, retried);
            }
          }

          const err = new Error(
            "structured output parser returned no object (model likely emitted text outside the JSON block or truncated)",
          );
          (err as Error & { id?: string }).id = STRUCTURED_OUTPUT_VALIDATION_ERROR_ID;
          throw err;
        }
        return r;
      }, retryGuard),
    retryGuard,
  );
  let response: Awaited<typeof generation>;
  try {
    response = await Promise.race([generation, timedOut]);
  } finally {
    clearTimeout(timer);
  }

  const parsed = response.object as z.infer<typeof schema>;
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
    ...("scopeCreep" in parsed && {
      scopeCreep: (parsed as Record<string, unknown>).scopeCreep as ReviewResult["scopeCreep"],
    }),
  };
}
