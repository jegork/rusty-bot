import { describe, it, expect, afterEach } from "vitest";
import {
  buildSystemPrompt,
  buildUserMessage,
  buildCachedSystemMessages,
} from "../agent/prompts.js";
import { ReviewOutputSchema } from "../agent/schema.js";
import type { ReviewConfig, PRMetadata, PriorReviewContext, TicketInfo } from "../types.js";

const baseConfig: ReviewConfig = {
  style: "balanced",
  focusAreas: ["security", "bugs"],
  ignorePatterns: [],
};

const prMetadata: PRMetadata = {
  id: "42",
  title: "Add user authentication",
  description: "Implements JWT-based auth flow",
  author: "dev123",
  sourceBranch: "feature/auth",
  targetBranch: "main",
  url: "https://github.com/org/repo/pull/42",
};

describe("buildSystemPrompt", () => {
  it("includes base prompt content", () => {
    const prompt = buildSystemPrompt(baseConfig);
    expect(prompt).toContain("Rusty Bot");
    expect(prompt).toContain("code reviewer");
  });

  it("includes balanced style instructions", () => {
    const prompt = buildSystemPrompt({ ...baseConfig, style: "balanced" });
    expect(prompt).toContain("BALANCED");
    expect(prompt).toContain("confident");
  });

  it("includes strict style instructions", () => {
    const prompt = buildSystemPrompt({ ...baseConfig, style: "strict" });
    expect(prompt).toContain("STRICT");
    expect(prompt).toContain("every evidence-backed issue");
    expect(prompt).not.toContain("better to flag a false positive");
  });

  it("includes negative review constraints", () => {
    const prompt = buildSystemPrompt(baseConfig);
    expect(prompt).toContain("Do not report:");
    expect(prompt).toContain("Formatting-only");
    expect(prompt).toContain("Generic maintainability advice");
    expect(prompt).toContain("Missing tests unless");
    expect(prompt).toContain("Severity-inflated findings");
  });

  it("includes anti-meta-narrative summary rules and the failure-mode phrases to avoid", () => {
    const prompt = buildSystemPrompt(baseConfig);
    expect(prompt).toContain("Summary writing rules");
    // pin the specific failure-mode phrases observed in production runs so future
    // edits to the prompt don't accidentally drop them
    expect(prompt).toContain("investigation is in progress");
    expect(prompt).toContain("tool call history shows");
    expect(prompt).toContain("no input was provided");
    // anti-pattern guidance the model must follow
    expect(prompt).toContain("Do NOT describe your own investigation process");
    // counter-hallucination: if the model thinks the diff is missing, treat the
    // prompt as source of truth instead of writing "no diff was provided"
    expect(prompt).toContain("treat the diff as the source of truth");
  });

  it("includes lenient style instructions", () => {
    const prompt = buildSystemPrompt({ ...baseConfig, style: "lenient" });
    expect(prompt).toContain("LENIENT");
    expect(prompt).toContain("critical bugs");
  });

  it("includes roast style instructions", () => {
    const prompt = buildSystemPrompt({ ...baseConfig, style: "roast" });
    expect(prompt).toContain("ROAST");
    expect(prompt).toContain("witty");
  });

  it("includes thorough style instructions", () => {
    const prompt = buildSystemPrompt({ ...baseConfig, style: "thorough" });
    expect(prompt).toContain("THOROUGH");
    expect(prompt).toContain("Summarize intent");
    expect(prompt).toContain("Trace execution paths");
    expect(prompt).toContain("Check invariants");
    expect(prompt).toContain("Evaluate edge cases");
    expect(prompt).toContain("Assess blast radius");
  });

  it("thorough style enforces reasoning before findings", () => {
    const prompt = buildSystemPrompt({ ...baseConfig, style: "thorough" });
    const reasoningIdx = prompt.indexOf("Step 1: Summarize intent");
    const findingsIdx = prompt.indexOf("Step 7: Produce findings");
    expect(reasoningIdx).toBeGreaterThan(-1);
    expect(findingsIdx).toBeGreaterThan(reasoningIdx);
  });

  it("all 5 styles produce distinct prompts", () => {
    const styles = ["strict", "balanced", "lenient", "roast", "thorough"] as const;
    const prompts = styles.map((style) => buildSystemPrompt({ ...baseConfig, style }));
    for (let i = 0; i < prompts.length; i++) {
      for (let j = i + 1; j < prompts.length; j++) {
        expect(prompts[i]).not.toBe(prompts[j]);
      }
    }
  });

  it("includes selected focus area instructions", () => {
    const prompt = buildSystemPrompt({
      ...baseConfig,
      focusAreas: ["security", "performance"],
    });
    expect(prompt).toContain("SECURITY VULNERABILITIES");
    expect(prompt).toContain("PERFORMANCE ISSUES");
    expect(prompt).not.toContain("BUG DETECTION");
  });

  it("includes all focus areas when none specified", () => {
    const prompt = buildSystemPrompt({
      ...baseConfig,
      focusAreas: [],
    });
    expect(prompt).toContain("SECURITY VULNERABILITIES");
    expect(prompt).toContain("PERFORMANCE ISSUES");
    expect(prompt).toContain("BUG DETECTION");
    expect(prompt).toContain("CODE STYLE");
    expect(prompt).toContain("TEST COVERAGE");
    expect(prompt).toContain("DOCUMENTATION");
  });

  it("all 6 focus areas produce distinct sections", () => {
    const areas = ["security", "performance", "bugs", "style", "tests", "docs"] as const;
    const prompts = areas.map((area) => buildSystemPrompt({ ...baseConfig, focusAreas: [area] }));
    for (let i = 0; i < prompts.length; i++) {
      for (let j = i + 1; j < prompts.length; j++) {
        expect(prompts[i]).not.toBe(prompts[j]);
      }
    }
  });

  it("includes convention file content when provided", () => {
    const prompt = buildSystemPrompt({
      ...baseConfig,
      conventionFile: "Always check for SQL injection in raw queries",
    });
    expect(prompt).toContain("Always check for SQL injection in raw queries");
    expect(prompt).toContain("repository maintainer");
  });

  it("omits convention instructions section when not provided", () => {
    const prompt = buildSystemPrompt(baseConfig);
    expect(prompt).not.toContain("repository maintainer");
  });
});

describe("buildCachedSystemMessages", () => {
  afterEach(() => {
    delete process.env.RUSTY_PROMPT_CACHE;
  });

  it("wraps the prompt with anthropic ephemeral cacheControl by default", () => {
    const messages = buildCachedSystemMessages("hello");
    expect(messages).toEqual([
      {
        role: "system",
        content: "hello",
        providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
      },
    ]);
  });

  it("omits providerOptions when RUSTY_PROMPT_CACHE=false (kill switch)", () => {
    process.env.RUSTY_PROMPT_CACHE = "false";
    const messages = buildCachedSystemMessages("hello");
    expect(messages).toEqual([{ role: "system", content: "hello" }]);
  });

  it("omits providerOptions when Anthropic cache control is unsupported", () => {
    const messages = buildCachedSystemMessages("hello", { anthropicCacheControl: false });
    expect(messages).toEqual([{ role: "system", content: "hello" }]);
  });

  it("treats unrecognized RUSTY_PROMPT_CACHE values as enabled", () => {
    process.env.RUSTY_PROMPT_CACHE = "yes";
    const messages = buildCachedSystemMessages("hello");
    expect(messages[0].providerOptions?.anthropic?.cacheControl.type).toBe("ephemeral");
  });
});

describe("buildUserMessage", () => {
  it("includes PR metadata", () => {
    const msg = buildUserMessage("diff content", prMetadata);
    expect(msg).toContain("Add user authentication");
    expect(msg).toContain("dev123");
    expect(msg).toContain("feature/auth");
    expect(msg).toContain("main");
  });

  it("includes PR description", () => {
    const msg = buildUserMessage("diff content", prMetadata);
    expect(msg).toContain("JWT-based auth flow");
  });

  it("omits description section when empty", () => {
    const msg = buildUserMessage("diff content", {
      ...prMetadata,
      description: "",
    });
    expect(msg).not.toContain("**Description:**");
  });

  it("includes diff content", () => {
    const msg = buildUserMessage("+ added line\n- removed line", prMetadata);
    expect(msg).toContain("+ added line");
    expect(msg).toContain("- removed line");
  });

  it("includes ticket context when provided", () => {
    const tickets: TicketInfo[] = [
      {
        id: "AUTH-42",
        title: "Implement JWT authentication",
        description: "Users should be able to log in with JWT tokens",
        acceptanceCriteria: "- Login endpoint returns JWT\n- Token validated on protected routes",
        labels: ["feature", "auth"],
        source: "jira",
      },
    ];
    const msg = buildUserMessage("diff", prMetadata, tickets);
    expect(msg).toContain("Linked Tickets");
    expect(msg).toContain("AUTH-42");
    expect(msg).toContain("Implement JWT authentication");
    expect(msg).toContain("Acceptance Criteria");
    expect(msg).toContain("feature, auth");
    expect(msg).toContain("structured ticketCompliance output");
    expect(msg).toContain(
      "use `not_addressed` only when the visible changes clearly do not satisfy the requirement",
    );
    expect(msg).toContain("use `unclear`");
  });

  it("omits ticket section when no tickets provided", () => {
    const msg = buildUserMessage("diff", prMetadata);
    expect(msg).not.toContain("Linked Tickets");
  });

  it("omits ticket section when empty array", () => {
    const msg = buildUserMessage("diff", prMetadata, []);
    expect(msg).not.toContain("Linked Tickets");
  });

  it("includes other PR files section when provided", () => {
    const msg = buildUserMessage("diff", prMetadata, undefined, undefined, [
      "src/config.ts",
      "src/utils.ts",
    ]);
    expect(msg).toContain("Other Files Changed in This PR");
    expect(msg).toContain("`src/config.ts`");
    expect(msg).toContain("`src/utils.ts`");
    expect(msg).toContain("Do NOT report observations");
  });

  it("instructs the LLM to consider other PR files for ticket compliance", () => {
    const msg = buildUserMessage("diff", prMetadata, undefined, undefined, ["tests/test_auth.py"]);
    expect(msg).toContain("ticket compliance");
  });

  it("omits other PR files section when not provided", () => {
    const msg = buildUserMessage("diff", prMetadata);
    expect(msg).not.toContain("Other Files Changed");
  });

  it("omits other PR files section when empty array", () => {
    const msg = buildUserMessage("diff", prMetadata, undefined, undefined, []);
    expect(msg).not.toContain("Other Files Changed");
  });

  it("places other PR files section before the diff", () => {
    const msg = buildUserMessage("diff content here", prMetadata, undefined, undefined, [
      "other.ts",
    ]);
    const otherFilesIdx = msg.indexOf("Other Files Changed");
    const diffIdx = msg.indexOf("## Diff");
    expect(otherFilesIdx).toBeLessThan(diffIdx);
  });

  it("includes 'Files in this chunk' section when chunkFiles is provided", () => {
    const msg = buildUserMessage("diff", prMetadata, undefined, undefined, undefined, undefined, [
      "packages/core/src/title/parse.ts",
      "packages/core/src/title/schema.ts",
    ]);
    expect(msg).toContain("## Files in this chunk");
    expect(msg).toContain("`packages/core/src/title/parse.ts`");
    expect(msg).toContain("`packages/core/src/title/schema.ts`");
    expect(msg).toContain("Copy each path exactly as written");
  });

  it("omits 'Files in this chunk' section when chunkFiles is empty", () => {
    const msg = buildUserMessage(
      "diff",
      prMetadata,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
    );
    expect(msg).not.toContain("## Files in this chunk");
  });

  it("omits 'Files in this chunk' section when chunkFiles is undefined", () => {
    const msg = buildUserMessage("diff", prMetadata);
    expect(msg).not.toContain("## Files in this chunk");
  });

  it("places 'Files in this chunk' before the diff", () => {
    const msg = buildUserMessage(
      "diff content here",
      prMetadata,
      undefined,
      undefined,
      undefined,
      undefined,
      ["src/foo.ts"],
    );
    const chunkIdx = msg.indexOf("## Files in this chunk");
    const diffIdx = msg.indexOf("## Diff");
    expect(chunkIdx).toBeGreaterThan(-1);
    expect(chunkIdx).toBeLessThan(diffIdx);
  });

  it("includes ranked context before the diff when provided", () => {
    const msg = buildUserMessage(
      "diff content here",
      prMetadata,
      undefined,
      undefined,
      undefined,
      undefined,
      ["src/foo.ts"],
      "## Graph-ranked Context\n### src/bar.ts",
    );

    const contextIdx = msg.indexOf("## Graph-ranked Context");
    const diffIdx = msg.indexOf("## Diff");
    expect(contextIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeLessThan(diffIdx);
  });
});

describe("ReviewOutputSchema", () => {
  it("validates well-formed output", () => {
    const valid = {
      summary: "Clean PR with minor issues",
      recommendation: "address_before_merge" as const,
      findings: [
        {
          file: "src/auth.ts",
          line: 15,
          endLine: null,
          severity: "warning" as const,
          category: "security" as const,
          message: "Missing rate limiting on login endpoint",
          suggestedFix: "",
        },
      ],
      ticketCompliance: [],
      missingTests: [],
      observations: [],
      filesReviewed: ["src/auth.ts"],
    };
    const result = ReviewOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("validates output with suggested fix", () => {
    const valid = {
      summary: "Found a bug",
      recommendation: "critical_issues" as const,
      findings: [
        {
          file: "src/index.ts",
          line: 10,
          endLine: null,
          severity: "critical" as const,
          category: "bugs" as const,
          message: "Off-by-one error",
          suggestedFix: "Change < to <=",
        },
      ],
      ticketCompliance: [
        {
          ticketId: "BUG-1",
          requirement: "Handle the inclusive upper bound correctly",
          status: "addressed" as const,
          evidence: "Comparison now uses <=",
        },
      ],
      missingTests: [],
      observations: [],
      filesReviewed: ["src/index.ts"],
    };
    const result = ReviewOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("validates finding without suggestedFix (structural issues)", () => {
    const valid = {
      summary: "Resource leak found",
      recommendation: "address_before_merge" as const,
      findings: [
        {
          file: "src/parser.ts",
          line: 42,
          endLine: 80,
          severity: "critical" as const,
          category: "bugs" as const,
          message: "WASM objects leaked on early return paths — wrap in try/finally",
          suggestedFix: null,
        },
      ],
      ticketCompliance: [],
      missingTests: [],
      observations: [],
      filesReviewed: ["src/parser.ts"],
    };
    const result = ReviewOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects invalid recommendation", () => {
    const invalid = {
      summary: "ok",
      recommendation: "maybe",
      findings: [],
      ticketCompliance: [],
      observations: [],
      filesReviewed: [],
    };
    const result = ReviewOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects invalid severity", () => {
    const invalid = {
      summary: "ok",
      recommendation: "looks_good",
      findings: [
        {
          file: "x.ts",
          line: 1,
          severity: "info",
          category: "bugs",
          message: "something",
        },
      ],
      ticketCompliance: [],
      observations: [],
      filesReviewed: [],
    };
    const result = ReviewOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects invalid category", () => {
    const invalid = {
      summary: "ok",
      recommendation: "looks_good",
      findings: [
        {
          file: "x.ts",
          line: 1,
          severity: "warning",
          category: "vibes",
          message: "something",
        },
      ],
      ticketCompliance: [],
      observations: [],
      filesReviewed: [],
    };
    const result = ReviewOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    const result = ReviewOutputSchema.safeParse({ summary: "ok" });
    expect(result.success).toBe(false);
  });

  it("validates empty findings and observations", () => {
    const valid = {
      summary: "Looks great!",
      recommendation: "looks_good" as const,
      findings: [],
      ticketCompliance: [],
      missingTests: [],
      observations: [],
      filesReviewed: ["src/index.ts"],
    };
    const result = ReviewOutputSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects invalid ticket compliance status", () => {
    const invalid = {
      summary: "ok",
      recommendation: "looks_good",
      findings: [],
      ticketCompliance: [
        {
          requirement: "Do the thing",
          status: "done",
        },
      ],
      observations: [],
      filesReviewed: [],
    };
    const result = ReviewOutputSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });
});

describe("buildUserMessage with priorContext", () => {
  const priorContext: PriorReviewContext = {
    summary: "PR adds JWT auth flow with refresh tokens.",
    recommendation: "address_before_merge",
    findings: [
      {
        file: "src/auth.ts",
        line: 17,
        severity: "critical",
        message: "missing csrf check",
      },
    ],
  };

  function buildWithPriorContext(ctx?: PriorReviewContext) {
    return buildUserMessage(
      "diff content",
      prMetadata,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ctx,
    );
  }

  it("renders the prior-context section when provided", () => {
    const msg = buildWithPriorContext(priorContext);
    expect(msg).toContain("## Prior review context");
    expect(msg).toContain(priorContext.summary);
    expect(msg).toContain("Previous recommendation:** address_before_merge");
  });

  it("does not render the section when prior context is omitted (no leak)", () => {
    const msg = buildWithPriorContext(undefined);
    expect(msg).not.toContain("## Prior review context");
  });

  it("instructs the agent to describe the WHOLE PR in its summary", () => {
    const msg = buildWithPriorContext(priorContext);
    expect(msg).toContain("WHOLE PR");
  });

  it("places prior context before the diff so the agent reads it as background", () => {
    const msg = buildWithPriorContext(priorContext);
    const ctxIdx = msg.indexOf("## Prior review context");
    const diffIdx = msg.indexOf("## Diff");
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(diffIdx).toBeGreaterThan(ctxIdx);
  });

  it("renders each prior finding with file, line, severity, and message", () => {
    const msg = buildWithPriorContext(priorContext);
    expect(msg).toContain("`src/auth.ts`:17 (critical) — missing csrf check");
  });

  it("omits the issues list when prior context has no findings", () => {
    const msg = buildWithPriorContext({ ...priorContext, findings: [] });
    expect(msg).not.toContain("Issues already surfaced");
  });

  it("renders the files-already-reviewed section when filesReviewed is populated", () => {
    const msg = buildWithPriorContext({
      ...priorContext,
      filesReviewed: [
        "packages/ui/src/components/StopButton.tsx",
        "apps/web/src/features/live-viewer/hooks.ts",
      ],
    });
    expect(msg).toContain("Files already covered by the prior review");
    expect(msg).toContain("`packages/ui/src/components/StopButton.tsx`");
    expect(msg).toContain("`apps/web/src/features/live-viewer/hooks.ts`");
    // pin the failure-mode-fix wording so the model knows not to flag missing ticket scope
    expect(msg).toContain("do NOT flag it as missing");
  });

  it("omits the files-already-reviewed section when filesReviewed is missing (legacy markers)", () => {
    const msg = buildWithPriorContext(priorContext);
    expect(msg).not.toContain("Files already covered by the prior review");
  });

  it("omits the files-already-reviewed section when filesReviewed is an empty array", () => {
    const msg = buildWithPriorContext({ ...priorContext, filesReviewed: [] });
    expect(msg).not.toContain("Files already covered by the prior review");
  });
});
