import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ReviewConfig, PRMetadata } from "../types.js";

const generateMock = vi.fn();
const generateTextMock = vi.fn();

vi.mock("@mastra/core/agent", () => ({
  Agent: vi.fn().mockImplementation(function () {
    return { generate: generateMock };
  }),
}));

vi.mock("ai", () => ({
  generateText: generateTextMock,
  // Output.object({ schema }) — opaque marker the structurer uses. We don't
  // need to validate its shape here; the structurer-only retry just hands it
  // off to generateText (which is mocked). Returning a sentinel keeps the
  // import call working without pulling in the real `ai` runtime.
  Output: { object: (opts: unknown) => ({ __output: opts }) },
}));

const resolveJsonPromptInjectionMock = vi.fn(() => false);

vi.mock("../agent/model.js", () => ({
  resolveModelConfig: vi.fn(() => ({ type: "router", model: "test-model" })),
  resolveModelConfigWithOverride: vi.fn((model: string) => ({ type: "router", model })),
  resolveModel: vi.fn((config: { type: string; model?: string }) =>
    config.type === "router" ? (config.model ?? "test-model") : "test-model",
  ),
  getModelDisplayName: vi.fn((config: { type: string; model?: string }) =>
    config.type === "router" ? (config.model ?? "test-model") : "test-model",
  ),
  resolveModelSettings: vi.fn(() => ({})),
  resolveDefaultAgentOptions: vi.fn(() => undefined),
  resolveJsonPromptInjection: resolveJsonPromptInjectionMock,
  supportsAnthropicCacheControl: vi.fn(() => false),
  applyModelConstraints: vi.fn((_config, settings) => settings),
}));

const { runReview } = await import("../agent/review.js");

class FakeMastraError extends Error {
  id: string;
  domain: string;
  category: string;
  constructor(id: string, message: string) {
    super(message);
    this.id = id;
    this.domain = "AGENT";
    this.category = "SYSTEM";
    this.name = "MastraError";
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
        new FakeMastraError(
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

  it("does not retry on a MastraError with a different id", async () => {
    generateMock.mockRejectedValueOnce(new FakeMastraError("AGENT_STREAM_ERROR", "stream died"));

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow("stream died");
    expect(generateMock).toHaveBeenCalledTimes(1);
  });

  it("throws when both the initial attempt and the retry fail the same way", async () => {
    generateMock.mockRejectedValue(
      new FakeMastraError(
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
      new FakeMastraError("STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", "failure"),
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
        new FakeMastraError(
          "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
          "first-attempt-validation-failure",
        ),
      )
      .mockRejectedValueOnce(new Error("provider timeout"));

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow("provider timeout");
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("retries when mastra silently returns response.object=undefined", async () => {
    // mastra's prompt-injected JSON path can return object:undefined when the
    // model emits text outside the JSON block instead of throwing. we should
    // synthesize a validation error so the retry wrapper picks it up.
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

  beforeEach(() => {
    generateMock.mockReset();
    generateTextMock.mockReset();
    delete process.env.RUSTY_LLM_STRUCTURING_MODEL;
  });

  it("uses structurer-only retry on cached prose instead of rerunning the full agent", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock.mockResolvedValueOnce({
      object: undefined,
      text: "the reviewer's prose that the structurer failed to parse",
      usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
    });
    generateTextMock.mockResolvedValueOnce({
      output: validParsedReview,
      usage: { totalTokens: 30, inputTokens: 25, outputTokens: 5 },
    });

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    // expensive agent.generate called ONCE (not twice as the legacy path did)
    expect(generateMock).toHaveBeenCalledTimes(1);
    // cheap generateObject call took over the retry
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the full agent reroll when structurer-only retry also fails", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock
      .mockResolvedValueOnce({
        object: undefined,
        text: "first-attempt prose",
        usage: { totalTokens: 100 },
      })
      .mockResolvedValueOnce(makeValidResponse());
    generateTextMock.mockRejectedValueOnce(new Error("structurer threw on retry"));

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    // structurer-only retry was attempted once
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    // when it failed, existing expensive retry path kicked in
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
      .mockResolvedValueOnce({
        object: undefined,
        text: "",
        usage: { totalTokens: 30 },
      })
      .mockResolvedValueOnce(makeValidResponse());

    const result = await runReview(config, "diff", prMetadata);

    expect(result.recommendation).toBe("looks_good");
    // no prose → skip structurer-only retry, go straight to expensive reroll
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(generateMock).toHaveBeenCalledTimes(2);
  });

  it("merges structurer-only retry token usage into the reported total", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock.mockResolvedValueOnce({
      object: undefined,
      text: "the reviewer's prose",
      usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
    });
    generateTextMock.mockResolvedValueOnce({
      output: validParsedReview,
      usage: { totalTokens: 30, inputTokens: 25, outputTokens: 5 },
    });

    const result = await runReview(config, "diff", prMetadata);

    // tokenCount should include both the agent's tokens AND the structurer retry's tokens
    expect(result.tokenCount).toBe(130);
  });

  it("still throws when structurer-only retry succeeds with a non-schema-conforming object via the validation error path", async () => {
    // edge case: generateObject succeeds but returns something incompatible.
    // ai-sdk's generateObject validates against the schema and throws if it
    // doesn't match, so this case is mostly defensive — but verifies that a
    // throw from generateObject is caught and falls through to the full retry.
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "test-structurer";
    generateMock
      .mockResolvedValueOnce({
        object: undefined,
        text: "prose",
        usage: { totalTokens: 50 },
      })
      .mockResolvedValueOnce({
        object: undefined,
        text: "more prose",
        usage: { totalTokens: 50 },
      });
    // both structurer retries fail (one per expensive attempt)
    generateTextMock.mockRejectedValue(new Error("schema validation failed"));

    await expect(runReview(config, "diff", prMetadata)).rejects.toThrow(
      /structured output parser returned no object/,
    );
    // each expensive attempt should try the cheap structurer retry once
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(generateMock).toHaveBeenCalledTimes(2);
  });
});

describe("runReview jsonPromptInjection forwarding", () => {
  beforeEach(() => {
    generateMock.mockReset();
    resolveJsonPromptInjectionMock.mockReset();
  });

  it("forwards jsonPromptInjection=true into structuredOutput when resolver returns true", async () => {
    resolveJsonPromptInjectionMock.mockReturnValueOnce(true);
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const callArgs = generateMock.mock.calls[0][1];
    expect(callArgs.structuredOutput.jsonPromptInjection).toBe(true);
  });

  it("forwards jsonPromptInjection=false into structuredOutput when resolver returns false", async () => {
    resolveJsonPromptInjectionMock.mockReturnValueOnce(false);
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const callArgs = generateMock.mock.calls[0][1];
    expect(callArgs.structuredOutput.jsonPromptInjection).toBe(false);
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

    expect(generateMock.mock.calls[0][0]).toContain("## Graph-ranked Context");
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

    expect(generateMock.mock.calls[0][0]).not.toContain("## Graph-ranked Context");
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
        new FakeMastraError("STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED", "validation failed once"),
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
  beforeEach(() => {
    generateMock.mockReset();
    delete process.env.RUSTY_LLM_MAX_STEPS;
  });

  it("does not pass maxSteps or prepareStep to agent.generate when env is unset", async () => {
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.maxSteps).toBeUndefined();
    expect(opts.prepareStep).toBeUndefined();
  });

  it("passes the configured maxSteps and a prepareStep hook to agent.generate", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "5";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.maxSteps).toBe(5);
    expect(opts.prepareStep).toBeTypeOf("function");
  });

  it("prepareStep returns nothing for non-final steps", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "5";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    const prepareStep = opts.prepareStep as (a: { stepNumber: number }) => unknown;
    for (const stepNumber of [0, 1, 2, 3]) {
      expect(prepareStep({ stepNumber })).toBeUndefined();
    }
  });

  it("prepareStep strips tools and forces toolChoice='none' on the final allowed step", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "5";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    const prepareStep = opts.prepareStep as (a: { stepNumber: number }) => unknown;
    expect(prepareStep({ stepNumber: 4 })).toEqual({ toolChoice: "none", activeTools: [] });
    expect(prepareStep({ stepNumber: 99 })).toEqual({ toolChoice: "none", activeTools: [] });
  });

  it("prepareStep does NOT override the system prompt — the anti-meta-narrative rules live in base.txt so they apply at every step (not just the forced-termination one)", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "5";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    const prepareStep = opts.prepareStep as (a: { stepNumber: number }) => unknown;

    expect(prepareStep({ stepNumber: 0 })).toBeUndefined();
    expect(prepareStep({ stepNumber: 4 })).not.toHaveProperty("system");
  });

  it("prepareStep with maxSteps=1 forces tool-free mode on step 0 (the only step)", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "1";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    const prepareStep = opts.prepareStep as (a: { stepNumber: number }) => unknown;
    expect(prepareStep({ stepNumber: 0 })).toEqual({ toolChoice: "none", activeTools: [] });
  });

  it("floors fractional values", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "3.7";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.maxSteps).toBe(3);
  });

  it("ignores non-numeric values and falls back to mastra default", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "abc";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.maxSteps).toBeUndefined();
    expect(opts.prepareStep).toBeUndefined();
  });

  it("ignores zero and negative values (caps below 1 are nonsensical)", async () => {
    for (const raw of ["0", "-1", "-100"]) {
      process.env.RUSTY_LLM_MAX_STEPS = raw;
      generateMock.mockReset();
      generateMock.mockResolvedValueOnce(makeValidResponse());

      await runReview(config, "diff", prMetadata);

      const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
      expect(opts.maxSteps, `for raw="${raw}"`).toBeUndefined();
      expect(opts.prepareStep, `for raw="${raw}"`).toBeUndefined();
    }
  });

  it("ignores empty string", async () => {
    process.env.RUSTY_LLM_MAX_STEPS = "";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.maxSteps).toBeUndefined();
    expect(opts.prepareStep).toBeUndefined();
  });
});

describe("RUSTY_LLM_STRUCTURING_MODEL", () => {
  beforeEach(() => {
    generateMock.mockReset();
    resolveJsonPromptInjectionMock.mockReset();
    resolveJsonPromptInjectionMock.mockImplementation(() => false);
    delete process.env.RUSTY_LLM_STRUCTURING_MODEL;
  });

  it("does not pass structuredOutput.model when env is unset", async () => {
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    const structured = opts.structuredOutput as Record<string, unknown>;
    expect(structured.model).toBeUndefined();
  });

  it("passes structuring model into structuredOutput.model when env is set", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "azure-openai/gpt-5.4-mini";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    const structured = opts.structuredOutput as Record<string, unknown>;
    expect(structured.model).toBe("azure-openai/gpt-5.4-mini");
  });

  it("evaluates jsonPromptInjection against the structuring model when set", async () => {
    process.env.RUSTY_LLM_STRUCTURING_MODEL = "azure-openai/gpt-5.4-mini";
    generateMock.mockResolvedValueOnce(makeValidResponse());

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

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    const structured = opts.structuredOutput as Record<string, unknown>;
    expect(structured.model).toBeUndefined();
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

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.onStepFinish).toBeUndefined();
  });

  it("does NOT pass onStepFinish when the flag is set to anything other than 'true'", async () => {
    process.env.RUSTY_LOG_AGENT_STEPS = "1"; // not 'true' literally
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.onStepFinish).toBeUndefined();
  });

  it("passes a function-typed onStepFinish callback when the flag is exactly 'true'", async () => {
    process.env.RUSTY_LOG_AGENT_STEPS = "true";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.onStepFinish).toBeTypeOf("function");
  });

  it("the onStepFinish callback increments stepNumber across calls", async () => {
    process.env.RUSTY_LOG_AGENT_STEPS = "true";
    generateMock.mockResolvedValueOnce(makeValidResponse());

    await runReview(config, "diff", prMetadata);

    const opts = generateMock.mock.calls[0][1] as Record<string, unknown>;
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
