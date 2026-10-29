import {
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  stepCountIs,
  type PrepareStepFunction,
  type ToolSet,
} from "ai";
import { z } from "zod";
import {
  resolveJsonPromptInjection,
  resolveModel,
  resolveProviderOptions,
  type ModelConfig,
  type ModelSettings,
} from "./model.js";
import type { CachedSystemMessage } from "./prompts.js";

export const STRUCTURED_OUTPUT_VALIDATION_ERROR_ID = "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED";

export interface StructuredCall<T> {
  modelConfig: ModelConfig;
  system: string | CachedSystemMessage[];
  prompt: string;
  schema: z.ZodType<T>;
  settings: ModelSettings;
  tools?: ToolSet;
  /** defaults to 1 */
  maxSteps?: number;
  prepareStep?: PrepareStepFunction;
  onStepFinish?: (step: unknown) => void;
  abortSignal?: AbortSignal;
}

type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;

export interface ProseResult {
  text: string;
  finishReason: GenerateTextResult["finishReason"];
  /** summed over every step, not just the last one */
  usage: GenerateTextResult["totalUsage"];
  toolCalls: GenerateTextResult["toolCalls"];
  warnings: GenerateTextResult["warnings"];
  reasoning: string | undefined;
  response: GenerateTextResult["response"];
  steps: GenerateTextResult["steps"];
  providerMetadata: GenerateTextResult["providerMetadata"];
}

export interface StructuredResult<T> extends ProseResult {
  /** undefined when the model produced no parseable object (see generateStructured) */
  object: T | undefined;
}

const JSON_INSTRUCTION =
  "\n\nRespond with exactly one JSON object that conforms to this JSON Schema. No prose before or after it, no code fences.\n";

function toSystemMessages(system: string | CachedSystemMessage[]): CachedSystemMessage[] {
  return typeof system === "string" ? [{ role: "system", content: system }] : system;
}

function appendToLastSystemMessage(
  messages: CachedSystemMessage[],
  suffix: string,
): CachedSystemMessage[] {
  if (messages.length === 0) return [{ role: "system", content: suffix.trimStart() }];
  const last = messages[messages.length - 1];
  return [...messages.slice(0, -1), { ...last, content: last.content + suffix }];
}

export function extractJsonObject(text: string): unknown {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

function toProseResult(r: GenerateTextResult): ProseResult {
  return {
    text: r.text,
    finishReason: r.finishReason,
    usage: r.totalUsage,
    toolCalls: r.toolCalls,
    warnings: r.warnings,
    reasoning: r.reasoningText,
    response: r.response,
    steps: r.steps,
    providerMetadata: r.providerMetadata,
  };
}

function baseCall(call: Omit<StructuredCall<unknown>, "schema">, system: CachedSystemMessage[]) {
  return {
    model: resolveModel(call.modelConfig),
    system,
    prompt: call.prompt,
    providerOptions: resolveProviderOptions(call.modelConfig),
    ...call.settings,
    stopWhen: stepCountIs(call.maxSteps ?? 1),
    ...(call.tools && { tools: call.tools }),
    ...(call.prepareStep && { prepareStep: call.prepareStep }),
    ...(call.onStepFinish && { onStepFinish: call.onStepFinish }),
    ...(call.abortSignal && { abortSignal: call.abortSignal }),
  };
}

function toValidationError(err: NoObjectGeneratedError): Error {
  const tagged = new Error(err.message, { cause: err });
  (tagged as Error & { id?: string }).id = STRUCTURED_OUTPUT_VALIDATION_ERROR_ID;
  return tagged;
}

export async function generateProse(
  call: Omit<StructuredCall<unknown>, "schema">,
): Promise<ProseResult> {
  const r = await generateText(baseCall(call, toSystemMessages(call.system)));
  return toProseResult(r);
}

/**
 * the single place that decides native (`response_format: json_schema`) vs
 * prompt-injected JSON. native parse/validation failures throw an error tagged
 * STRUCTURED_OUTPUT_VALIDATION_ERROR_ID; a run whose last step did not finish
 * with "stop" (tool-calls, length, other) and injected-path text that holds no
 * valid object both come back as `object: undefined` so callers can tell the
 * failure modes apart from the rest of the result.
 */
export async function generateStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
  const system = toSystemMessages(call.system);

  if (resolveJsonPromptInjection(call.modelConfig)) {
    const schemaJson = JSON.stringify(z.toJSONSchema(call.schema));
    const r = await generateText(
      baseCall(call, appendToLastSystemMessage(system, JSON_INSTRUCTION + schemaJson)),
    );
    const parsed = call.schema.safeParse(extractJsonObject(r.text));
    return { ...toProseResult(r), object: parsed.success ? parsed.data : undefined };
  }

  let r: GenerateTextResult;
  try {
    r = await generateText({
      ...baseCall(call, system),
      output: Output.object({ schema: call.schema }),
    });
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) throw toValidationError(err);
    throw err;
  }
  let object: T | undefined;
  try {
    object = r.output as T;
  } catch (err) {
    // the sdk only parses output when the last step finished with "stop"
    if (!NoOutputGeneratedError.isInstance(err)) throw err;
  }
  return { ...toProseResult(r), object };
}
