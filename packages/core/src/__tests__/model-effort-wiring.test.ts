import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as AiModule from "ai";
import type { FilePatch, Finding, PRMetadata, ReviewConfig } from "../types.js";

// generateText is the last point where rusty-bot controls what reaches the
// provider, so capture its options and stop before any network call
interface CapturedCall {
  model: { modelId: string };
  providerOptions?: Record<string, unknown>;
}

const captured: CapturedCall[] = [];
const STOP = "generateText called";

vi.mock("ai", async (importOriginal) => ({
  ...(await importOriginal<typeof AiModule>()),
  generateText: vi.fn((opts: CapturedCall) => {
    captured.push(opts);
    throw new Error(STOP);
  }),
}));

const { runReview } = await import("../agent/review.js");
const { judgeFindings } = await import("../agent/judge.js");
const { runTriage } = await import("../triage/triage.js");
const { generateConventionalTitle } = await import("../title/generate.js");
const { generatePRDescription } = await import("../description/generate.js");

const patches: FilePatch[] = [
  {
    path: "src/app.ts",
    additions: 1,
    deletions: 0,
    isBinary: false,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, content: "+const x = 1;" }],
  },
];

const prMetadata: PRMetadata = {
  id: "1",
  title: "test",
  description: "",
  author: "dev",
  sourceBranch: "feat",
  targetBranch: "main",
  url: "https://example.com/pr/1",
};

const reviewConfig: ReviewConfig = { style: "balanced", focusAreas: [], ignorePatterns: [] };

const finding: Finding = {
  file: "src/app.ts",
  line: 1,
  endLine: null,
  severity: "warning",
  category: "bugs",
  message: "m",
  suggestedFix: "",
};

function onlyCall(): CapturedCall {
  expect(captured).toHaveLength(1);
  return captured[0];
}

describe("model:effort suffix reaches generateText", () => {
  beforeEach(() => {
    captured.length = 0;
    for (const key of [
      "RUSTY_LLM_MODEL",
      "RUSTY_LLM_TRIAGE_MODEL",
      "RUSTY_LLM_BASE_URL",
      "RUSTY_PROMPT_CACHE",
    ]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("OPENROUTER_API_KEY", "k");
    vi.stubEnv("REQUESTY_API_KEY", "k");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("review: sends the effort in providerOptions and the base id as the model", async () => {
    vi.stubEnv("RUSTY_LLM_MODEL", "openrouter/openai/gpt-6-luna:xhigh");
    await expect(runReview(reviewConfig, "diff", prMetadata)).rejects.toThrow(STOP);

    const call = onlyCall();
    expect(call.model.modelId).toBe("openai/gpt-6-luna");
    expect(call.providerOptions).toEqual({ openrouter: { reasoning: { effort: "xhigh" } } });
  });

  it("judge: uses the effort from the judge model override", async () => {
    vi.stubEnv("RUSTY_LLM_MODEL", "anthropic/claude-sonnet-4-6");
    // the judge fails open, so the stop surfaces as a failed pass rather than a throw
    const result = await judgeFindings([finding], patches, {
      enabled: true,
      threshold: 6,
      model: "openrouter/x/y:batch:high",
    });
    expect(result.failed).toBe(true);

    const call = onlyCall();
    expect(call.model.modelId).toBe("x/y:batch");
    expect(call.providerOptions).toEqual({ openrouter: { reasoning: { effort: "high" } } });
  });

  it("triage: uses the effort from RUSTY_LLM_TRIAGE_MODEL", async () => {
    vi.stubEnv("RUSTY_LLM_TRIAGE_MODEL", "openrouter/google/gemini-3-flash:minimal");
    await expect(runTriage(patches)).rejects.toThrow(STOP);

    const call = onlyCall();
    expect(call.model.modelId).toBe("google/gemini-3-flash");
    expect(call.providerOptions).toEqual({ openrouter: { reasoning: { effort: "minimal" } } });
  });

  it("title and description: use the effort from RUSTY_LLM_MODEL", async () => {
    vi.stubEnv("RUSTY_LLM_MODEL", "openrouter/openai/gpt-6-luna:low");
    await expect(generateConventionalTitle(patches, prMetadata)).rejects.toThrow(STOP);
    await expect(generatePRDescription(patches, prMetadata)).rejects.toThrow(STOP);

    expect(captured).toHaveLength(2);
    for (const call of captured) {
      expect(call.model.modelId).toBe("openai/gpt-6-luna");
      expect(call.providerOptions).toEqual({ openrouter: { reasoning: { effort: "low" } } });
    }
  });

  it("review: keeps requesty auto_cache when no effort is set", async () => {
    vi.stubEnv("RUSTY_LLM_MODEL", "requesty/anthropic/claude-sonnet-4-6");
    await expect(runReview(reviewConfig, "diff", prMetadata)).rejects.toThrow(STOP);

    const call = onlyCall();
    expect(call.model.modelId).toBe("anthropic/claude-sonnet-4-6");
    expect(call.providerOptions).toEqual({ requesty: { auto_cache: true } });
  });

  it("review: fails before calling the model for an unsupported provider", async () => {
    vi.stubEnv("RUSTY_LLM_MODEL", "anthropic/claude-sonnet-4-6:high");
    await expect(runReview(reviewConfig, "diff", prMetadata)).rejects.toThrow(
      /only supported for openrouter\//,
    );
    expect(captured).toHaveLength(0);
  });
});
