import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FilePatch, Finding, PRMetadata, ReviewConfig } from "../types.js";

// the agent constructor is the last point where rusty-bot controls what reaches
// the provider, so capture its options and stop before any network call
interface CapturedAgentOptions {
  id: string;
  model: () => unknown;
  defaultOptions?: { providerOptions?: Record<string, unknown> };
}

const captured: CapturedAgentOptions[] = [];
const STOP = "agent constructed";

vi.mock("@mastra/core/agent", () => ({
  Agent: vi.fn().mockImplementation(function (opts: CapturedAgentOptions) {
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

function lastAgent(id: string): CapturedAgentOptions {
  const agent = captured.findLast((a) => a.id === id);
  if (!agent) throw new Error(`agent ${id} was not constructed`);
  return agent;
}

describe("model:effort suffix reaches the agent", () => {
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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("review: sends the effort in providerOptions and the base id as the model", async () => {
    vi.stubEnv("RUSTY_LLM_MODEL", "openrouter/openai/gpt-6-luna:xhigh");
    await expect(runReview(reviewConfig, "diff", prMetadata)).rejects.toThrow(STOP);

    const agent = lastAgent("review-agent");
    expect(agent.model()).toBe("openrouter/openai/gpt-6-luna");
    expect(agent.defaultOptions).toEqual({
      providerOptions: { openrouter: { reasoning: { effort: "xhigh" } } },
    });
  });

  it("judge: uses the effort from the judge model override", async () => {
    vi.stubEnv("RUSTY_LLM_MODEL", "anthropic/claude-sonnet-4-6");
    await expect(
      judgeFindings([finding], patches, {
        enabled: true,
        threshold: 6,
        model: "openrouter/x/y:batch:high",
      }),
    ).rejects.toThrow(STOP);

    const agent = lastAgent("review-judge");
    expect(agent.model()).toBe("openrouter/x/y:batch");
    expect(agent.defaultOptions).toEqual({
      providerOptions: { openrouter: { reasoning: { effort: "high" } } },
    });
  });

  it("triage: uses the effort from RUSTY_LLM_TRIAGE_MODEL", async () => {
    vi.stubEnv("RUSTY_LLM_TRIAGE_MODEL", "openrouter/google/gemini-3-flash:minimal");
    await expect(runTriage(patches)).rejects.toThrow(STOP);

    const agent = lastAgent("triage-agent");
    expect(agent.model()).toBe("openrouter/google/gemini-3-flash");
    expect(agent.defaultOptions).toEqual({
      providerOptions: { openrouter: { reasoning: { effort: "minimal" } } },
    });
  });

  it("title and description: use the effort from RUSTY_LLM_MODEL", async () => {
    vi.stubEnv("RUSTY_LLM_MODEL", "openrouter/openai/gpt-6-luna:low");
    await expect(generateConventionalTitle(patches, prMetadata)).rejects.toThrow(STOP);
    await expect(generatePRDescription(patches, prMetadata)).rejects.toThrow(STOP);

    for (const id of ["title-agent", "description-agent"]) {
      const agent = lastAgent(id);
      expect(agent.model()).toBe("openrouter/openai/gpt-6-luna");
      expect(agent.defaultOptions).toEqual({
        providerOptions: { openrouter: { reasoning: { effort: "low" } } },
      });
    }
  });

  it("review: keeps requesty auto_cache when no effort is set", async () => {
    vi.stubEnv("RUSTY_LLM_MODEL", "requesty/anthropic/claude-sonnet-4-6");
    await expect(runReview(reviewConfig, "diff", prMetadata)).rejects.toThrow(STOP);

    expect(lastAgent("review-agent").defaultOptions).toEqual({
      providerOptions: { requesty: { auto_cache: true } },
    });
  });

  it("review: fails before building an agent for an unsupported provider", async () => {
    vi.stubEnv("RUSTY_LLM_MODEL", "anthropic/claude-sonnet-4-6:high");
    await expect(runReview(reviewConfig, "diff", prMetadata)).rejects.toThrow(
      /only supported for openrouter\//,
    );
    expect(captured).toHaveLength(0);
  });
});
