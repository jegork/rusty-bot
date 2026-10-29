import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";
import type * as AiModule from "ai";
import type * as ModelModule from "../agent/model.js";
import type { ModelConfig } from "../agent/model.js";

const generateText = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return { ...actual, generateText };
});

vi.mock("../agent/model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ModelModule>();
  return { ...actual, resolveModel: vi.fn(() => ({ modelId: "fake" })) };
});

const { NoObjectGeneratedError, NoOutputGeneratedError } = await import("ai");
const {
  generateStructured,
  generateProse,
  extractJsonObject,
  STRUCTURED_OUTPUT_VALIDATION_ERROR_ID,
} = await import("../agent/generate.js");

const schema = z.object({ verdict: z.enum(["keep", "drop"]), score: z.number() });

// openai/ is on the native structured-output list, ollama/ is not
const nativeConfig: ModelConfig = { type: "router", model: "openai/gpt-x" };
const injectedConfig: ModelConfig = { type: "ollama", model: "llama3" };

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

function fakeResult(overrides: Record<string, unknown> = {}) {
  const base = {
    text: "",
    finishReason: "stop",
    usage,
    totalUsage: usage,
    toolCalls: [],
    warnings: [],
    reasoningText: undefined,
    response: { id: "r" },
    steps: [{}],
    providerMetadata: undefined,
    ...overrides,
  };
  return base;
}

function lastCall(): Record<string, unknown> {
  const call = generateText.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
  if (!call) throw new Error("generateText was not called");
  return call;
}

beforeEach(() => {
  generateText.mockReset();
  vi.unstubAllEnvs();
});

describe("generateStructured native path", () => {
  it("passes output and a step-count stop condition, and returns the parsed output", async () => {
    generateText.mockResolvedValue(fakeResult({ output: { verdict: "keep", score: 1 } }));

    const r = await generateStructured({
      modelConfig: nativeConfig,
      system: "sys",
      prompt: "p",
      schema,
      settings: {},
      maxSteps: 4,
    });

    expect(r.object).toEqual({ verdict: "keep", score: 1 });
    const call = lastCall();
    expect(call.output).toBeDefined();
    expect(call.stopWhen).toBeTypeOf("function");
    expect(call.system).toEqual([{ role: "system", content: "sys" }]);
    expect(call.prompt).toBe("p");
  });

  it("stops after exactly maxSteps steps", async () => {
    generateText.mockResolvedValue(fakeResult({ output: { verdict: "keep", score: 1 } }));
    await generateStructured({
      modelConfig: nativeConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: {},
      maxSteps: 3,
    });
    const stopWhen = lastCall().stopWhen as (o: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: [{}, {}] })).toBe(false);
    expect(stopWhen({ steps: [{}, {}, {}] })).toBe(true);
  });

  it("defaults to a single step when maxSteps is omitted", async () => {
    generateText.mockResolvedValue(fakeResult({ output: { verdict: "keep", score: 1 } }));
    await generateStructured({
      modelConfig: nativeConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: {},
    });
    const stopWhen = lastCall().stopWhen as (o: { steps: unknown[] }) => boolean;
    expect(stopWhen({ steps: [{}] })).toBe(true);
  });

  it("rethrows NoObjectGeneratedError as the tagged validation error with the original as cause", async () => {
    const original = new NoObjectGeneratedError({
      message: "No object generated: response did not match schema.",
      text: "{}",
      response: { id: "r", timestamp: new Date(), modelId: "m" },
      usage: { ...usage } as never,
      finishReason: "stop",
    });
    generateText.mockRejectedValue(original);

    const err = await generateStructured({
      modelConfig: nativeConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: {},
    }).catch((e: unknown) => e);

    expect((err as { id?: string }).id).toBe(STRUCTURED_OUTPUT_VALIDATION_ERROR_ID);
    expect((err as Error).cause).toBe(original);
  });

  it("returns object undefined when the last step did not finish with stop", async () => {
    const result = fakeResult({ finishReason: "tool-calls", toolCalls: [{ toolName: "x" }] });
    Object.defineProperty(result, "output", {
      get() {
        throw new NoOutputGeneratedError();
      },
    });
    generateText.mockResolvedValue(result);

    const r = await generateStructured({
      modelConfig: nativeConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: {},
    });
    expect(r.object).toBeUndefined();
    expect(r.finishReason).toBe("tool-calls");
    expect(r.toolCalls).toHaveLength(1);
  });

  it("does not swallow unrelated errors", async () => {
    generateText.mockRejectedValue(Object.assign(new Error("503"), { isRetryable: true }));
    await expect(
      generateStructured({
        modelConfig: nativeConfig,
        system: "s",
        prompt: "p",
        schema,
        settings: {},
      }),
    ).rejects.toMatchObject({ message: "503", isRetryable: true });
  });

  it("honours RUSTY_LLM_JSON_PROMPT_INJECTION for a natively capable model", async () => {
    vi.stubEnv("RUSTY_LLM_JSON_PROMPT_INJECTION", "openai/*");
    generateText.mockResolvedValue(fakeResult({ text: '{"verdict":"drop","score":2}' }));
    const r = await generateStructured({
      modelConfig: nativeConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: {},
    });
    expect(lastCall().output).toBeUndefined();
    expect(r.object).toEqual({ verdict: "drop", score: 2 });
  });
});

describe("generateStructured injected path", () => {
  it("sends no output and appends the json schema to the last system message", async () => {
    generateText.mockResolvedValue(fakeResult({ text: '{"verdict":"keep","score":3}' }));

    await generateStructured({
      modelConfig: injectedConfig,
      system: [
        { role: "system", content: "first" },
        { role: "system", content: "second" },
      ],
      prompt: "p",
      schema,
      settings: {},
    });

    const call = lastCall();
    expect(call.output).toBeUndefined();
    const system = call.system as { content: string }[];
    expect(system[0].content).toBe("first");
    expect(system[1].content.startsWith("second\n\n")).toBe(true);
    expect(system[1].content.endsWith(JSON.stringify(z.toJSONSchema(schema)))).toBe(true);
  });

  it("parses an object wrapped in code fences and surrounding prose", async () => {
    generateText.mockResolvedValue(
      fakeResult({ text: 'here you go:\n```json\n{"verdict":"drop","score":7}\n```\nthanks' }),
    );
    const r = await generateStructured({
      modelConfig: injectedConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: {},
    });
    expect(r.object).toEqual({ verdict: "drop", score: 7 });
  });

  it("returns object undefined for text without valid json", async () => {
    generateText.mockResolvedValue(fakeResult({ text: "I could not finish the review {oops" }));
    const r = await generateStructured({
      modelConfig: injectedConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: {},
    });
    expect(r.object).toBeUndefined();
    expect(r.text).toBe("I could not finish the review {oops");
  });

  it("returns object undefined for json that does not match the schema", async () => {
    generateText.mockResolvedValue(fakeResult({ text: '{"verdict":"maybe","score":1}' }));
    const r = await generateStructured({
      modelConfig: injectedConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: {},
    });
    expect(r.object).toBeUndefined();
  });

  it("returns object undefined for empty text", async () => {
    generateText.mockResolvedValue(fakeResult({ text: "", totalUsage: {} }));
    const r = await generateStructured({
      modelConfig: injectedConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: {},
    });
    expect(r.object).toBeUndefined();
  });
});

describe("generateStructured call shape", () => {
  it("passes cached system messages through with their providerOptions intact", async () => {
    generateText.mockResolvedValue(fakeResult({ output: { verdict: "keep", score: 1 } }));
    const cached = [
      {
        role: "system" as const,
        content: "big static prompt",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" as const } } },
      },
    ];
    await generateStructured({
      modelConfig: nativeConfig,
      system: cached,
      prompt: "p",
      schema,
      settings: {},
    });
    expect(lastCall().system).toEqual(cached);
  });

  it("keeps providerOptions on the cached message when the schema is appended", async () => {
    generateText.mockResolvedValue(fakeResult({ text: '{"verdict":"keep","score":1}' }));
    await generateStructured({
      modelConfig: injectedConfig,
      system: [
        {
          role: "system",
          content: "big",
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        },
      ],
      prompt: "p",
      schema,
      settings: {},
    });
    const [msg] = lastCall().system as { providerOptions?: unknown }[];
    expect(msg.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });

  it("spreads settings onto the call", async () => {
    generateText.mockResolvedValue(fakeResult({ output: { verdict: "keep", score: 1 } }));
    await generateStructured({
      modelConfig: nativeConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: { temperature: 0, topP: 0.9 },
    });
    expect(lastCall().temperature).toBe(0);
    expect(lastCall().topP).toBe(0.9);
  });

  it("sends the provider options resolved for the model", async () => {
    generateText.mockResolvedValue(fakeResult({ output: { verdict: "keep", score: 1 } }));
    await generateStructured({
      modelConfig: { type: "router", model: "openrouter/openai/gpt-x", reasoningEffort: "high" },
      system: "s",
      prompt: "p",
      schema,
      settings: {},
    });
    expect(lastCall().providerOptions).toEqual({ openrouter: { reasoning: { effort: "high" } } });
  });

  it("forwards tools, prepareStep, onStepFinish and the abort signal", async () => {
    generateText.mockResolvedValue(fakeResult({ output: { verdict: "keep", score: 1 } }));
    const tools = { searchCode: {} } as never;
    const prepareStep = vi.fn();
    const onStepFinish = vi.fn();
    const controller = new AbortController();
    await generateStructured({
      modelConfig: nativeConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: {},
      tools,
      prepareStep,
      onStepFinish,
      abortSignal: controller.signal,
    });
    const call = lastCall();
    expect(call.tools).toBe(tools);
    expect(call.prepareStep).toBe(prepareStep);
    expect(call.onStepFinish).toBe(onStepFinish);
    expect(call.abortSignal).toBe(controller.signal);
  });

  it("reports usage summed over all steps, not just the last one", async () => {
    generateText.mockResolvedValue(
      fakeResult({
        output: { verdict: "keep", score: 1 },
        usage: { totalTokens: 5 },
        totalUsage: { totalTokens: 50 },
      }),
    );
    const r = await generateStructured({
      modelConfig: nativeConfig,
      system: "s",
      prompt: "p",
      schema,
      settings: {},
    });
    expect(r.usage.totalTokens).toBe(50);
  });
});

describe("generateProse", () => {
  it("sends no output and no schema instruction even for prompt-injected models", async () => {
    generateText.mockResolvedValue(fakeResult({ text: "prose review" }));
    const r = await generateProse({
      modelConfig: injectedConfig,
      system: "sys",
      prompt: "p",
      settings: {},
    });
    expect(r.text).toBe("prose review");
    expect(lastCall().output).toBeUndefined();
    expect(lastCall().system).toEqual([{ role: "system", content: "sys" }]);
  });
});

describe("extractJsonObject", () => {
  it("returns undefined when there is no closing brace after the opening one", () => {
    expect(extractJsonObject("} {")).toBeUndefined();
  });

  it("spans from the first opening to the last closing brace", () => {
    expect(extractJsonObject('a {"x":{"y":1}} b')).toEqual({ x: { y: 1 } });
  });
});
