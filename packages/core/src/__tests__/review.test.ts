import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as AiModule from "ai";
import type { ReviewConfig, PRMetadata } from "../types.js";
import { toGenerateTextResult, type FakeResponse } from "./fake-generate-text.js";

// generateText calls for the reviewer model ("test-model") land in generateMock;
// calls for any other model (the structuring model) land in generateTextMock
const generateMock = vi.fn();
const generateTextMock = vi.fn();
const REVIEWER_MODEL = "test-model";
const logMock = vi.hoisted(() => {
  const m: Record<string, unknown> = {};
  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) m[level] = vi.fn();
  m.child = () => m;
  return m as Record<"info" | "warn" | "error", ReturnType<typeof vi.fn>> & {
    child: () => unknown;
  };
});

vi.mock("../logger.js", () => ({
  logger: logMock,
  flushLogger: vi.fn(),
}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    generateText: async (opts: Record<string, unknown>) => {
      const mock = opts.model === REVIEWER_MODEL ? generateMock : generateTextMock;
      return toGenerateTextResult(opts, (await mock(opts)) as FakeResponse | undefined, actual);
    },
    // opaque marker so tests can read back the schema handed to Output.object
    Output: { ...actual.Output, object: (opts: unknown) => ({ __output: opts }) },
  };
});

function maxStepsOf(opts: Record<string, unknown>): number {
  const stopWhen = opts.stopWhen as (o: { steps: unknown[] }) => boolean;
  for (let n = 1; n <= 100; n++) {
    if (stopWhen({ steps: Array.from({ length: n }) })) return n;
  }
  throw new Error("stopWhen never stopped");
}

const resolveJsonPromptInjectionMock = vi.fn(() => false);

vi.mock("../agent/model.js", () => ({
  resolveModelConfig: vi.fn(() => ({ type: "router", model: "test-model" })),
  resolveModelConfigWithOverride: vi.fn((model: string) => ({ type: "router", model })),
  resolveModel: vi.fn((config: { type: string; model?: string }) =>
    config.type === "router" ? (config.model ?? REVIEWER_MODEL) : REVIEWER_MODEL,
  ),
  getModelDisplayName: vi.fn((config: { type: string; model?: string }) =>
    config.type === "router" ? (config.model ?? "test-model") : "test-model",
  ),
  resolveModelSettings: vi.fn(() => ({})),
  resolveProviderOptions: vi.fn(() => undefined),
  resolveJsonPromptInjection: resolveJsonPromptInjectionMock,
  supportsAnthropicCacheControl: vi.fn(() => false),
  applyModelConstraints: vi.fn((_config, settings) => settings),
}));

const { runReview } = await import("../agent/review.js");

class TaggedError extends Error {
  id: string;
  constructor(id: string, message: string) {
    super(message);
    this.id = id;
  }
}

const prMetadata: PRMetadata = {
  id: "1",
  title: "test",
  description: "",
  author: "dev",
  sourceBranch: "feat",
  targetBranch: "main",
  url: "https://example.com/pr/1",
};

const config: ReviewConfig = {
  style: "balanced",
  focusAreas: [],
  ignorePatterns: [],
};

function makeValidResponse() {
  return {
    object: {
      summary: "looks fine",
      recommendation: "looks_good",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: ["a.ts"],
    },
    usage: { totalTokens: 100 },
  };
}

describe("runReview retry on STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", () => {
  beforeEach(() => {
    generateMock.mockReset();
  });

  it("retries once when first attempt throws STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", async () => {
    generateMock
      .mockRejectedValueOnce(
        new TaggedError(
          "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
          "Structured output validation failed: root: Invalid input: expected object, received undefined",
        ),
      )
      .mockResolvedValueOnce(makeValidResponse());

    const result = await runReview(config, "diff", prMetadata);

    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(result.recommendation).toBe("looks_good");
  });

  it("does not retry on errors that are not structured output validation failures", async () => {
    generateMock.mockRejectedValueOnce(new Error("API rate limit"));

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow("API rate limit");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry on a tagged error with a different id", async () => {
    generateMock.mockRejectedValueOnce(new TaggedError("AGENT_STREAM_ERROR", "stream died"));

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow("stream died");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("throws when both the initial attempt and the retry fail the same way", async () => {
    generateMock.mockRejectedValue(
      new TaggedError(
        "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
        "Structured output validation failed again",
      ),
    );

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow(
      "Structured output validation failed again",
    );
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("retries at most once (caps at 2 attempts, not more)", async () => {
    generateMock.mockRejectedValue(
      new TaggedError("STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", "failure"),
    );

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow();
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("succeeds on the first attempt without retrying when the model returns a valid object", async () => {
    generateMock.mockResolvedValueOnce(makeValidResponse());

    const result = await runReview(config, "diff", prMetadata);
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(result.recommendation).toBe("looks_good");
  });

  it("propagates the original error unchanged when the retry also fails with a different error", async () => {
    generateMock
      .mockRejectedValueOnce(
        new TaggedError(
          "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
          "first-attempt-validation-failure",
        ),
      )
      .mockRejectedValueOnce(new Error("provider timeout"));

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow("provider timeout");
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("retries when the generation returns no object instead of throwing", async () => {
    // the prompt-injected JSON path (and a run whose last step was not "stop")
    // returns object:undefined instead of throwing. we should synthesize a
    // validation error so the retry wrapper picks it up.
    generateMock
      .mockResolvedValueOnce({ object: undefined, usage: { totalTokens: 50 } })
      .mockResolvedValueOnce(makeValidResponse());

    const result = await runReview(config, "diff", prMetadata);

    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(result.recommendation).toBe("looks_good");
  });

  it("throws a clear error when both attempts return response.object=undefined", async () => {
    generateMock.mockResolvedValue({ object: undefined, usage: { totalTokens: 50 } });

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow(
      /structured output parser returned no object/,
    );
    expect(generateMock).toHaveBeenCalledTimes(2);
  });
});

describe("runReview structurer-only retry", () => {
  const validParsedReview = makeValidResponse().object;
  // the structuring model's first pass over the prose produced no object; every
  // structuring-model run has this primary call before the cheap retry
  const primaryStructurerMiss = { usage: {} };

  beforeEach(() => {
    generateMock.mockReset();
    generateTextMock.mockReset();
    delete process.env.RUSTY_LLM_STRUCTURING_MODEL;
  });

  afterEach(() => {
    delete process.env.RUSTY_LLM_STRUCTURING_MODEL;
    delete process.env.RUSTY_LLM_MAX_RETRIES;
  });

  it("uses structurer-only retry on cached prose instead of rerunning the full agent", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock.mockResolvedValueOnce({
      text: "the reviewer's prose that the structurer failed to parse",
      usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
    });
    generateTextMock.mockResolvedValueOnce(primaryStructurerMiss).mockResolvedValueOnce({
      output: validParsedReview,
      usage: { totalTokens: 30, inputTokens: 25, outputTokens: 5 },
    });

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    // expensive reviewer generation called ONCE (not twice as the legacy path did)
    expect(generateMock).toHaveBeenCalledTimes(1);
    // primary structuring call, then the cheap retry took over
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(generateTextMock.mock.calls[1][0].prompt).toBe(
      "the reviewer's prose that the structurer failed to parse",
    );
  });

  it("falls back to the full agent reroll when structurer-only retry also fails", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock
      .mockResolvedValueOnce({ text: "first-attempt prose", usage: { totalTokens: 100 } })
      .mockResolvedValueOnce({ text: "second-attempt prose", usage: { totalTokens: 100 } });
    generateTextMock
      .mockResolvedValueOnce(primaryStructurerMiss)
      .mockRejectedValueOnce(new Error("structurer threw on retry"))
      .mockResolvedValueOnce({ output: validParsedReview, usage: { totalTokens: 30 } });

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    // first attempt: primary + one cheap retry; second attempt: primary succeeds
    expect(generateTextMock).toHaveBeenCalledTimes(3);
    // when the cheap retry failed, existing expensive retry path kicked in
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT attempt structurer-only retry when no structuring model is configured", async () => {
    // legacy path: no RUSTY_LLM_STRUCTURING_MODEL → existing 2-attempt retry only
    generateMock
      .mockResolvedValueOnce({
        object: undefined,
        text: "some prose",
        usage: { totalTokens: 50 },
      })
      .mockResolvedValueOnce(makeValidResponse());

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT attempt structurer-only retry when reviewer returned no prose", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock
      .mockResolvedValueOnce({ text: "", usage: { totalTokens: 30 } })
      .mockResolvedValueOnce({ text: "prose", usage: { totalTokens: 100 } });
    generateTextMock.mockResolvedValueOnce({ output: validParsedReview, usage: {} });

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    // no prose → no structuring call at all for the first attempt, straight to
    // the expensive reroll; the only structurer call is the reroll's primary
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock.mock.calls[0][0].prompt).toBe("prose");
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("merges structurer-only retry token usage into the reported total", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock.mockResolvedValueOnce({
      text: "the reviewer's prose",
      usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
    });
    generateTextMock.mockResolvedValueOnce(primaryStructurerMiss).mockResolvedValueOnce({
      output: validParsedReview,
      usage: { totalTokens: 30, inputTokens: 25, outputTokens: 5 },
    });

    const result = await runReview(config, "diff", prMetadata);

    // tokenCount should include both the agent's tokens AND the structurer retry's tokens
    expect(result.tokenCount).toBe(130);
  });

  it("counts the primary structuring call's tokens too", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock.mockResolvedValueOnce({ text: "prose", usage: { totalTokens: 100 } });
    generateTextMock.mockResolvedValueOnce({
      output: validParsedReview,
      usage: { totalTokens: 7 },
    });

    const result = await runReview(config, "diff", prMetadata);

    expect(result.tokenCount).toBe(107);
  });

  it("still throws when structurer-only retry succeeds with a non-schema-conforming object via the validation error path", async () => {
    // verifies that a throw from the cheap structurer retry is caught and falls
    // through to the full retry, and that the pass fails once both are spent.
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock
      .mockResolvedValueOnce({ text: "prose", usage: { totalTokens: 50 } })
      .mockResolvedValueOnce({ text: "more prose", usage: { totalTokens: 50 } });
    // per expensive attempt: primary structuring call misses, cheap retry throws
    generateTextMock
      .mockResolvedValueOnce(primaryStructurerMiss)
      .mockRejectedValueOnce(new Error("schema validation failed"))
      .mockResolvedValueOnce(primaryStructurerMiss)
      .mockRejectedValueOnce(new Error("schema validation failed"));

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow(
      /structured output parser returned no object/,
    );
    // each expensive attempt should try the cheap structurer retry once
    expect(generateTextMock).toHaveBeenCalledTimes(4);
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("goes to the cheap retry when the primary structuring call fails schema validation", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock.mockResolvedValueOnce({ text: "prose", usage: { totalTokens: 100 } });
    generateTextMock
      .mockRejectedValueOnce(
        new TaggedError("STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", "did not match schema"),
      )
      .mockResolvedValueOnce({ output: validParsedReview, usage: {} });

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).toHaveBeenCalledTimes(2);
  });

  it("does not swallow a transient error from the primary structuring call", async () => {
    process.env.RUSTY_LLM_MAX_RETRIES = "0";
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock.mockResolvedValueOnce({ text: "prose", usage: { totalTokens: 100 } });
    generateTextMock.mockRejectedValueOnce(
      Object.assign(new Error("structurer 503"), { isRetryable: true }),
    );

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow("structurer 503");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });
});

describe("runReview jsonPromptInjection forwarding", () => {
  beforeEach(() => {
    generateMock.mockReset();
    resolveJsonPromptInjectionMock.mockReset();
  });

  it("requests no native output when the resolver picks prompt-injected JSON", async () => {
    resolveJsonPromptInjectionMock.mockReturnValueOnce(true);
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const callArgs = generateMock.mock.calls[0][0];
    expect(callArgs.output).toBeUndefined();
  });

  it("requests native output when the resolver picks native structured output", async () => {
    resolveJsonPromptInjectionMock.mockReturnValueOnce(false);
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const callArgs = generateMock.mock.calls[0][0];
    expect(callArgs.output).toBeDefined();
  });
});

describe("runReview ranked context", () => {
  beforeEach(() => {
    generateMock.mockReset();
  });

  it("includes ranked context for deep-review calls", async () => {
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata, undefined, {
      tier: "deep-review",
      rankedContext: "## Graph-ranked Context\n### src/helper.ts",
    });

    expect(generateMock.mock.calls[0][0].prompt).toContain("## Graph-ranked Context");
  });

  it("omits ranked context for skim calls", async () => {
    generateMock.mockResolvedValueOnce({
      object: {
        summary: "looks fine",
        recommendation: "looks_good",
        findings: [],
        observations: [],
        filesReviewed: ["a.ts"],
      },
      usage: { totalTokens: 100 },
    });

    await runReview(config, "diff", prMetadata, undefined, {
      tier: "skim",
      rankedContext: "## Graph-ranked Context\n### src/helper.ts",
    });

    expect(generateMock.mock.calls[0][0].prompt).not.toContain("## Graph-ranked Context");
  });
});

class FakeApiCallError extends Error {
  isRetryable: boolean;
  constructor(message: string, isRetryable: boolean) {
    super(message);
    this.name = "AI_APICallError";
    this.isRetryable = isRetryable;
  }
}

/** matches the shape thrown by ai-sdk-ollama: an OllamaError wrapping a
 * ResponseError whose status_code (snake_case, ollama-js convention) is the
 * upstream HTTP status. set `directStatusCode` to put status_code directly on
 * the OllamaError instead of via cause — both shapes have been observed. */
class FakeOllamaError extends Error {
  cause?: { status_code: number };
  status_code?: number;
  constructor(message: string, statusCode: number, options: { directStatusCode?: boolean } = {}) {
    super(message);
    this.name = "OllamaError";
    if (options.directStatusCode) {
      this.status_code = statusCode;
    } else {
      this.cause = { status_code: statusCode };
    }
  }
}

describe("runReview retry on transient LLM errors", () => {
  beforeEach(() => {
    generateMock.mockReset();
    delete process.env.RUSTY_LLM_MAX_RETRIES;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function settle<T>(promise: Promise<T>): Promise<T> {
    // attach a noop rejection handler so vitest doesn't flag this as
    // an unhandled rejection while the test suite is awaiting timers
    promise.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    return promise;
  }

  it("retries when the call throws an isRetryable=true error", async () => {
    generateMock
      .mockRejectedValueOnce(new FakeApiCallError("Headers Timeout Error", true))
      .mockResolvedValueOnce(makeValidResponse());

    const result = await settle(runReview(config, "diff", prMetadata));

    expect(generateMock).toHaveBeenCalledTimes(2);
    expect(result.recommendation).toBe("looks_good");
  });

  it("does not retry an error with isRetryable=false", async () => {
    generateMock.mockRejectedValueOnce(new FakeApiCallError("auth failed", false));

    await expect(settle(runReview(config, "diff", prMetadata))).rejects.toThrow("auth failed");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry generic errors that lack the isRetryable marker", async () => {
    generateMock.mockRejectedValueOnce(new Error("misc network glitch"));

    await expect(settle(runReview(config, "diff", prMetadata))).rejects.toThrow(
      "misc network glitch",
    );
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("retries up to the default cap (3 attempts total) before giving up", async () => {
    generateMock.mockRejectedValue(new FakeApiCallError("upstream timeout", true));

    await expect(settle(runReview(config, "diff", prMetadata))).rejects.toThrow("upstream timeout");
    expect(generateMock).toHaveBeenCalledTimes(3);
  });

  it("respects RUSTY_LLM_MAX_RETRIES=0 (no retries)", async () => {
    process.env.RUSTY_LLM_MAX_RETRIES = "0";
    generateMock.mockRejectedValueOnce(new FakeApiCallError("upstream timeout", true));

    await expect(settle(runReview(config, "diff", prMetadata))).rejects.toThrow("upstream timeout");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("clamps RUSTY_LLM_MAX_RETRIES above the built-in backoff schedule", async () => {
    process.env.RUSTY_LLM_MAX_RETRIES = "99";
    generateMock.mockRejectedValue(new FakeApiCallError("upstream timeout", true));

    await expect(settle(runReview(config, "diff", prMetadata))).rejects.toThrow("upstream timeout");
    // built-in schedule has 2 retry slots so total attempts = 1 + 2 = 3
    expect(generateMock).toHaveBeenCalledTimes(3);
  });

  it("ignores a non-numeric RUSTY_LLM_MAX_RETRIES and uses the default", async () => {
    process.env.RUSTY_LLM_MAX_RETRIES = "abc";
    generateMock
      .mockRejectedValueOnce(new FakeApiCallError("upstream timeout", true))
      .mockResolvedValueOnce(makeValidResponse());

    await settle(runReview(config, "diff", prMetadata));
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("treats a transient retry as compatible with the structured-output retry", async () => {
    generateMock
      .mockRejectedValueOnce(new FakeApiCallError("upstream timeout", true))
      .mockRejectedValueOnce(
        new TaggedError("STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", "validation failed once"),
      )
      .mockResolvedValueOnce(makeValidResponse());

    await settle(runReview(config, "diff", prMetadata));
    expect(generateMock).toHaveBeenCalledTimes(3);
  });

  it("retries an OllamaError 503 from cause.status_code (Ollama Cloud overload)", async () => {
    generateMock
      .mockRejectedValueOnce(new FakeOllamaError("Server overloaded, please retry shortly", 503))
      .mockResolvedValueOnce(makeValidResponse());

    await settle(runReview(config, "diff", prMetadata));
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("retries an OllamaError 429 (rate limited)", async () => {
    generateMock
      .mockRejectedValueOnce(new FakeOllamaError("Too many requests", 429))
      .mockResolvedValueOnce(makeValidResponse());

    await settle(runReview(config, "diff", prMetadata));
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("retries an OllamaError with status_code set directly on the error (not via cause)", async () => {
    generateMock
      .mockRejectedValueOnce(new FakeOllamaError("Bad gateway", 502, { directStatusCode: true }))
      .mockResolvedValueOnce(makeValidResponse());

    await settle(runReview(config, "diff", prMetadata));
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("retries a ResponseError 503 (the inner ollama-js error name) directly", async () => {
    const inner = Object.assign(new Error("upstream overloaded"), {
      name: "ResponseError",
      status_code: 503,
    });
    generateMock.mockRejectedValueOnce(inner).mockResolvedValueOnce(makeValidResponse());

    await settle(runReview(config, "diff", prMetadata));
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry an OllamaError with a non-retryable status (e.g. 400 bad request)", async () => {
    generateMock.mockRejectedValueOnce(new FakeOllamaError("model not found", 404));

    await expect(settle(runReview(config, "diff", prMetadata))).rejects.toThrow("model not found");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an OllamaError with no status_code anywhere", async () => {
    const orphan = Object.assign(new Error("malformed upstream response"), {
      name: "OllamaError",
    });
    generateMock.mockRejectedValueOnce(orphan);

    await expect(settle(runReview(config, "diff", prMetadata))).rejects.toThrow(
      "malformed upstream response",
    );
    expect(generateMock).toHaveBeenCalledTimes(1);
  });
});

describe("RUSTY_LLM_MAX_STEPS", () => {
  const FORCED = { toolChoice: "none", activeTools: [] };

  beforeEach(() => {
    generateMock.mockReset();
    delete process.env.RUSTY_LLM_MAX_STEPS;
  });

  async function captureGenerateOpts() {
    generateMock.mockReset();
    generateMock.mockResolvedValueOnce(makeValidResponse());
    await runReview(config, "diff", prMetadata);
    return generateMock.mock.calls[0][0] as Record<string, unknown>;
  }

  // probes well past the cap so a hook that fires late (or never) is caught too
  function forcedSteps(opts: Record<string, unknown>): number[] {
    expect(opts.prepareStep).toBeTypeOf("function");
    const prepareStep = opts.prepareStep as (a: { stepNumber: number }) => unknown;
    const forced: number[] = [];
    for (let stepNumber = 0; stepNumber < 40; stepNumber++) {
      const result = prepareStep({ stepNumber });
      if (result === undefined) continue;
      expect(result, `step ${stepNumber}`).toEqual(FORCED);
      forced.push(stepNumber);
    }
    return forced;
  }

  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

  it("defaults to 20 steps with only the last one (step 19) forced tool-free when env is unset", async () => {
    const opts = await captureGenerateOpts();

    // the step cap is the only bound on the tool loop, so it must always be set
    expect(maxStepsOf(opts)).toBe(20);
    expect(forcedSteps(opts)).toEqual(range(19, 40));
  });

  it("forces step 4 (and only from there on) when set to 5", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "5";
    const opts = await captureGenerateOpts();

    expect(maxStepsOf(opts)).toBe(5);
    expect(forcedSteps(opts)).toEqual(range(4, 40));
  });

  it("an explicit value above the default wins over it", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "30";
    const opts = await captureGenerateOpts();

    expect(maxStepsOf(opts)).toBe(30);
    expect(forcedSteps(opts)).toEqual(range(29, 40));
  });

  it("prepareStep does NOT override the system prompt — the anti-meta-narrative rules live in base.txt so they apply at every step (not just the forced-termination one)", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "5";
    const opts = await captureGenerateOpts();

    const prepareStep = opts.prepareStep as (a: { stepNumber: number }) => unknown;
    expect(prepareStep({ stepNumber: 4 })).not.toHaveProperty("system");
  });

  it("with maxSteps=1 the first step is already forced tool-free", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "1";
    const opts = await captureGenerateOpts();

    expect(maxStepsOf(opts)).toBe(1);
    expect(forcedSteps(opts)).toEqual(range(0, 40));
  });

  it("floors fractional values", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "3.7";
    const opts = await captureGenerateOpts();

    expect(maxStepsOf(opts)).toBe(3);
    expect(forcedSteps(opts)).toEqual(range(2, 40));
  });

  it.each(["", "0", "-3", "-100", "abc", "0.5", "Infinity", "NaN"])(
    "falls back to the default of 20 for invalid value %j",
    async (raw) => {
      process.env.RUSTY_LLM_MAX_STEPS = raw;
      const opts = await captureGenerateOpts();

      expect(maxStepsOf(opts)).toBe(20);
      expect(forcedSteps(opts)).toEqual(range(19, 40));
    },
  );
});

describe("RUSTY_LLM_STRUCTURING_MODEL", () => {
  beforeEach(() => {
    generateMock.mockReset();
    generateTextMock.mockReset();
    resolveJsonPromptInjectionMock.mockReset();
    resolveJsonPromptInjectionMock.mockImplementation(() => false);
    delete process.env.RUSTY_LLM_STRUCTURING_MODEL;
  });

  afterEach(() => {
    delete process.env.RUSTY_LLM_STRUCTURING_MODEL;
  });

  it("does not call a structuring model when env is unset", async () => {
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    expect(generateTextMock).not.toHaveBeenCalled();
    const opts = generateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.output).toBeDefined();
  });

  it("hands the reviewer's prose to the structuring model when env is set", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "azure-openai/gpt-5.4-mini";
    generateMock.mockResolvedValueOnce({ text: "reviewer prose", usage: { totalTokens: 100 } });
    generateTextMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    // the reviewer writes prose with tools and no schema; the structurer gets the schema
    const reviewerOpts = generateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(reviewerOpts.output).toBeUndefined();
    expect(reviewerOpts.tools).toBeDefined();
    const structurerOpts = generateTextMock.mock.calls[0][0] as Record<string, unknown>;
    expect(structurerOpts.model).toBe("azure-openai/gpt-5.4-mini");
    expect(structurerOpts.prompt).toBe("reviewer prose");
    expect(structurerOpts.output).toBeDefined();
  });

  it("evaluates jsonPromptInjection against the structuring model when set", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "azure-openai/gpt-5.4-mini";
    generateMock.mockResolvedValueOnce(makeValidResponse());
    generateTextMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    expect(resolveJsonPromptInjectionMock).toHaveBeenCalledTimes(1);
    expect(resolveJsonPromptInjectionMock).toHaveBeenLastCalledWith({
      type: "router",
      model: "azure-openai/gpt-5.4-mini",
    });
  });

  it("falls back to evaluating jsonPromptInjection against the main model when env is unset", async () => {
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    expect(resolveJsonPromptInjectionMock).toHaveBeenCalledTimes(1);
    expect(resolveJsonPromptInjectionMock).toHaveBeenLastCalledWith({
      type: "router",
      model: "test-model",
    });
  });

  it("ignores empty string", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("RUSTY_LOG_AGENT_STEPS", () => {
  beforeEach(() => {
    generateMock.mockReset();
    delete process.env.RUSTY_LOG_AGENT_STEPS;
  });

  it("does NOT pass onStepFinish when the flag is unset (no perf cost in production)", async () => {
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.onStepFinish).toBeUndefined();
  });

  it("does NOT pass onStepFinish when the flag is set to anything other than 'true'", async () => {
    process.env.RUSTY_LOG_AGENT_STEPS = "1"; // not 'true' literally
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.onStepFinish).toBeUndefined();
  });

  it("passes a function-typed onStepFinish callback when the flag is exactly 'true'", async () => {
    process.env.RUSTY_LOG_AGENT_STEPS = "true";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.onStepFinish).toBeTypeOf("function");
  });

  it("the onStepFinish callback increments stepNumber across calls", async () => {
    process.env.RUSTY_LOG_AGENT_STEPS = "true";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][0] as Record<string, unknown>;
    const onStepFinish = opts.onStepFinish as (step: unknown) => void;

    // exercising the callback should not throw on any of: well-shaped step,
    // step with missing optional fields, non-object step, null step.
    expect(() =>
      onStepFinish({
        finishReason: "tool-calls",
        toolCalls: [{}, {}],
        usage: { totalTokens: 1234, inputTokens: 1000, outputTokens: 234 },
        warnings: [],
      }),
    ).not.toThrow();
    expect(() => onStepFinish({ finishReason: "stop" })).not.toThrow();
    expect(() => onStepFinish(null)).not.toThrow();
    expect(() => onStepFinish("not an object")).not.toThrow();
  });
});

describe("runReview empty provider response", () => {
  beforeEach(() => {
    generateMock.mockReset();
    generateTextMock.mockReset();
    delete process.env.RUSTY_LLM_STRUCTURING_MODEL;
  });

  it("fails the pass without retrying when the provider returns nothing at all", async () => {
    generateMock.mockResolvedValue({
      object: undefined,
      text: "",
      toolCalls: [],
      usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0 },
    });

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow(
      "provider returned an empty completion",
    );
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("treats a wholly absent usage block as an empty completion", async () => {
    generateMock.mockResolvedValue({ object: undefined, text: "", toolCalls: [] });

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow(
      "provider returned an empty completion",
    );
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("skips the structurer-only retry too — there is no prose to restructure", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock.mockResolvedValue({
      object: undefined,
      text: "",
      usage: { totalTokens: 0, inputTokens: 0 },
    });

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow(
      "provider returned an empty completion",
    );
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("still retries when the model billed input tokens but emitted no parseable object", async () => {
    // the model read the prompt and produced something — that's a parsing
    // failure, not a dead upstream, so the existing retry must still apply.
    generateMock
      .mockResolvedValueOnce({
        object: undefined,
        text: "",
        usage: { totalTokens: 900, inputTokens: 900, outputTokens: 0 },
      })
      .mockResolvedValueOnce(makeValidResponse());

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("does not treat a zero-usage response carrying text as empty", async () => {
    generateMock
      .mockResolvedValueOnce({
        object: undefined,
        text: "prose the parser choked on",
        usage: { totalTokens: 0, inputTokens: 0 },
      })
      .mockResolvedValueOnce(makeValidResponse());

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("does not treat a zero-usage response carrying tool calls as empty", async () => {
    generateMock
      .mockResolvedValueOnce({
        object: undefined,
        text: "",
        toolCalls: [{ toolName: "search_code" }],
        usage: { totalTokens: 0, inputTokens: 0 },
      })
      .mockResolvedValueOnce(makeValidResponse());

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    expect(generateMock).toHaveBeenCalledTimes(2);
  });
});

describe("runReview tool-loop exhaustion", () => {
  beforeEach(() => {
    generateMock.mockReset();
    generateTextMock.mockReset();
    delete process.env.RUSTY_LLM_STRUCTURING_MODEL;
    delete process.env.RUSTY_LLM_MAX_STEPS;
  });

  function toolLoopResponse(stepCount: number) {
    return {
      object: undefined,
      text: "",
      finishReason: "tool-calls",
      toolCalls: [{ toolName: "search_code" }],
      steps: Array.from({ length: stepCount }, () => ({})),
      usage: { totalTokens: 900, inputTokens: 900, outputTokens: 10 },
    };
  }

  it("fails fast without rerunning the trajectory when the step budget was spent on tool calls", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "4";
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock.mockResolvedValue(toolLoopResponse(4));

    await expect(runReview(config, "diff", prMetadata)).rejects.toMatchObject({
      id: "TOOL_LOOP_EXHAUSTED",
    });
    expect(generateMock).toHaveBeenCalledTimes(1);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("keeps the existing retry when tool calls ended the attempt before the budget ran out", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "4";
    generateMock
      .mockResolvedValueOnce(toolLoopResponse(3))
      .mockResolvedValueOnce(makeValidResponse());

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the existing retry when the budget was spent but the model produced text", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "4";
    generateMock
      .mockResolvedValueOnce({ ...toolLoopResponse(4), text: "some prose" })
      .mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    expect(generateMock).toHaveBeenCalledTimes(2);
  });
});

describe("runReview error log hygiene", () => {
  beforeEach(() => {
    generateMock.mockReset();
    logMock.warn.mockReset();
    delete process.env.RUSTY_LLM_MAX_RETRIES;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs a summary of a transient LLM error without the request or response bodies", async () => {
    const err = Object.assign(new Error("Gateway Timeout"), {
      name: "AI_APICallError",
      isRetryable: true,
      statusCode: 504,
      url: "https://openrouter.ai/api/v1/chat/completions",
      requestBodyValues: { messages: ["SECRET-DIFF-CONTENT"] },
      responseBody: "SECRET-RESPONSE-BODY",
    });
    generateMock.mockRejectedValueOnce(err).mockResolvedValueOnce(makeValidResponse());

    const run = runReview(config, "diff", prMetadata);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    const call = logMock.warn.mock.calls.find(
      ([, msg]) => msg === "transient LLM error, retrying after backoff",
    );
    expect(call).toBeDefined();
    const serialized = JSON.stringify(call![0]);
    expect(serialized).not.toContain("SECRET-DIFF-CONTENT");
    expect(serialized).not.toContain("SECRET-RESPONSE-BODY");
    expect(call![0].err).toMatchObject({
      name: "AI_APICallError",
      message: "Gateway Timeout",
      statusCode: 504,
      isRetryable: true,
    });
  });

  it("truncates very long error messages", async () => {
    const err = Object.assign(new Error("x".repeat(5000)), { isRetryable: true });
    generateMock.mockRejectedValueOnce(err).mockResolvedValueOnce(makeValidResponse());

    const run = runReview(config, "diff", prMetadata);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    const call = logMock.warn.mock.calls.find(
      ([, msg]) => msg === "transient LLM error, retrying after backoff",
    );
    expect(call![0].err.message.length).toBeLessThan(600);
  });
});

describe("runReview step log attempts", () => {
  beforeEach(() => {
    generateMock.mockReset();
    logMock.info.mockReset();
    vi.useFakeTimers();
    process.env.RUSTY_LOG_AGENT_STEPS = "true";
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.RUSTY_LOG_AGENT_STEPS;
  });

  it("restarts stepNumber at 0 and bumps attempt on a transient retry", async () => {
    const step = { finishReason: "tool-calls", toolCalls: [{}], usage: {}, warnings: [] };
    generateMock.mockImplementation(async (opts: Record<string, unknown>) => {
      const onStepFinish = opts.onStepFinish as (s: unknown) => void;
      onStepFinish(step);
      onStepFinish(step);
      if (generateMock.mock.calls.length === 1) {
        throw Object.assign(new Error("upstream"), { isRetryable: true });
      }
      return makeValidResponse();
    });

    const run = runReview(config, "diff", prMetadata);
    await vi.advanceTimersByTimeAsync(10_000);
    await run;

    const steps = logMock.info.mock.calls
      .filter(([, msg]) => msg === "agent step finished")
      .map(([o]) => ({ attempt: o.attempt, stepNumber: o.stepNumber }));
    expect(steps).toEqual([
      { attempt: 1, stepNumber: 0 },
      { attempt: 1, stepNumber: 1 },
      { attempt: 2, stepNumber: 0 },
      { attempt: 2, stepNumber: 1 },
    ]);
  });
});

describe("runReview scope creep", () => {
  beforeEach(() => {
    generateMock.mockReset();
  });

  it("requests scopeCreep in the schema and returns it when the flag is on", async () => {
    generateMock.mockResolvedValueOnce({
      object: {
        ...makeValidResponse().object,
        scopeCreep: [{ file: "a.ts", description: "unrelated rename" }],
      },
      usage: { totalTokens: 100 },
    });

    const result = await runReview({ ...config, flagScopeCreep: true }, "diff", prMetadata);

    const schema = generateMock.mock.calls[0][0].output.__output.schema;
    expect(schema.shape).toHaveProperty("scopeCreep");
    expect(result.scopeCreep).toEqual([{ file: "a.ts", description: "unrelated rename" }]);
  });

  it("keeps the base schema and leaves scopeCreep undefined when the flag is off", async () => {
    generateMock.mockResolvedValueOnce(makeValidResponse());

    const result = await runReview(config, "diff", prMetadata);

    const schema = generateMock.mock.calls[0][0].output.__output.schema;
    expect(schema.shape).not.toHaveProperty("scopeCreep");
    expect(result.scopeCreep).toBeUndefined();
  });

  it("never requests scopeCreep on the skim tier", async () => {
    generateMock.mockResolvedValueOnce({
      object: {
        summary: "looks fine",
        recommendation: "looks_good",
        findings: [],
        observations: [],
        filesReviewed: ["a.ts"],
      },
      usage: { totalTokens: 100 },
    });

    await runReview({ ...config, flagScopeCreep: true }, "diff", prMetadata, undefined, {
      tier: "skim",
    });

    const schema = generateMock.mock.calls[0][0].output.__output.schema;
    expect(schema.shape).not.toHaveProperty("scopeCreep");
  });
});

describe("runReview pass time budget", () => {
  beforeEach(() => {
    generateMock.mockReset();
    delete process.env.RUSTY_REVIEW_PASS_TIMEOUT_MS;
    delete process.env.RUSTY_REVIEW_DEADLINE_MS;
    delete process.env.RUSTY_LLM_MAX_RETRIES;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.RUSTY_REVIEW_PASS_TIMEOUT_MS;
  });

  const hang = () => new Promise<never>(() => undefined);

  function track<T>(promise: Promise<T>) {
    const outcome: { error?: unknown; value?: T; settled: boolean } = { settled: false };
    promise.then(
      (value) => {
        outcome.value = value;
        outcome.settled = true;
      },
      (error: unknown) => {
        outcome.error = error;
        outcome.settled = true;
      },
    );
    return outcome;
  }

  it("rejects with REVIEW_PASS_TIMEOUT when generate never settles", async () => {
    process.env.RUSTY_REVIEW_PASS_TIMEOUT_MS = "1000";
    generateMock.mockImplementation(hang);

    const outcome = track(runReview(config, "diff", prMetadata));
    await vi.advanceTimersByTimeAsync(999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(outcome.settled).toBe(true);
    expect((outcome.error as { id?: string }).id).toBe("REVIEW_PASS_TIMEOUT");
  });

  it("aborts the signal handed to generate when the budget runs out", async () => {
    process.env.RUSTY_REVIEW_PASS_TIMEOUT_MS = "1000";
    generateMock.mockImplementation(hang);

    const outcome = track(runReview(config, "diff", prMetadata));
    await vi.advanceTimersByTimeAsync(0);
    const signal = generateMock.mock.calls[0][0].abortSignal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);

    expect(signal.aborted).toBe(true);
    expect(outcome.settled).toBe(true);
  });

  it("does not retry a structured-output failure that lands after the budget", async () => {
    process.env.RUSTY_REVIEW_PASS_TIMEOUT_MS = "1000";
    generateMock.mockImplementation(
      () =>
        new Promise((_, reject) =>
          setTimeout(
            () =>
              reject(
                new TaggedError(
                  "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
                  "Structured output validation failed",
                ),
              ),
            1500,
          ),
        ),
    );

    const outcome = track(runReview(config, "diff", prMetadata));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect((outcome.error as { id?: string }).id).toBe("REVIEW_PASS_TIMEOUT");
  });

  it("does not retry a transient error once the budget ran out during backoff", async () => {
    process.env.RUSTY_REVIEW_PASS_TIMEOUT_MS = "300";
    generateMock.mockRejectedValue(new FakeApiCallError("upstream timeout", true));

    const outcome = track(runReview(config, "diff", prMetadata));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(generateMock).toHaveBeenCalledTimes(1);
    expect((outcome.error as { id?: string }).id).toBe("REVIEW_PASS_TIMEOUT");
  });

  it("leaves a pass that finishes inside the budget untouched", async () => {
    process.env.RUSTY_REVIEW_PASS_TIMEOUT_MS = "1000";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    const outcome = track(runReview(config, "diff", prMetadata));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(outcome.error).toBeUndefined();
    expect(outcome.value?.recommendation).toBe("looks_good");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it.each(["abc", "-5", "0"])("falls back to the 8 minute default for %j", async (raw) => {
    process.env.RUSTY_REVIEW_PASS_TIMEOUT_MS = raw;
    generateMock.mockImplementation(hang);

    const outcome = track(runReview(config, "diff", prMetadata));
    await vi.advanceTimersByTimeAsync(479_999);
    expect(outcome.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect((outcome.error as { id?: string }).id).toBe("REVIEW_PASS_TIMEOUT");
  });

  it("rejects without calling the model when the review deadline already passed", async () => {
    const outcome = track(
      runReview(config, "diff", prMetadata, undefined, { deadlineAt: Date.now() - 1 }),
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(generateMock).not.toHaveBeenCalled();
    expect((outcome.error as { id?: string }).id).toBe("REVIEW_PASS_TIMEOUT");
  });

  it("caps the pass budget at the remaining review deadline", async () => {
    generateMock.mockImplementation(hang);

    const outcome = track(
      runReview(config, "diff", prMetadata, undefined, { deadlineAt: Date.now() + 2_000 }),
    );
    await vi.advanceTimersByTimeAsync(2_000);

    expect((outcome.error as { id?: string }).id).toBe("REVIEW_PASS_TIMEOUT");
  });
});

describe("runReview with a local checkout", () => {
  beforeEach(() => {
    generateMock.mockReset();
  });

  function systemText(opts: Record<string, unknown>): string {
    return (opts.system as { content: string }[]).map((m) => m.content).join("\n");
  }

  it("offers both tools from the checkout without a provider or sourceRef and drops the pre-merge note", async () => {
    generateMock.mockResolvedValueOnce(makeValidResponse());
    const checkout = { approximate: false, grep: vi.fn(), readFile: vi.fn() } as any;

    await runReview(config, "diff", prMetadata, undefined, { checkout });

    const opts = generateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(opts.tools as object).sort()).toEqual(["getFileContext", "searchCode"]);
    expect(systemText(opts)).not.toContain("may reflect pre-merge content");
  });

  it("keeps the pre-merge note for provider-backed tools", async () => {
    generateMock.mockResolvedValueOnce(makeValidResponse());
    const provider = { searchCode: vi.fn(), getFileContent: vi.fn() } as any;

    await runReview(config, "diff", prMetadata, undefined, { provider, sourceRef: "feat" });

    const opts = generateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(opts.tools as object).sort()).toEqual(["getFileContext", "searchCode"]);
    expect(systemText(opts)).toContain("may reflect pre-merge content");
  });

  it("still gives the skim tier no tools when a checkout exists", async () => {
    generateMock.mockResolvedValueOnce(makeValidResponse());
    const checkout = { approximate: false, grep: vi.fn(), readFile: vi.fn() } as any;

    await runReview(config, "diff", prMetadata, undefined, { checkout, tier: "skim" });

    const opts = generateMock.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys((opts.tools as object | undefined) ?? {})).toEqual([]);
  });
});
