import { describe, it, expect } from "vitest";
import { formatSummaryComment } from "../formatter/summary.js";
import { formatInlineComment } from "../formatter/inline.js";
import type { ReviewResult, Finding } from "../types.js";

function makeReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    summary: "Overall the code looks solid.",
    recommendation: "address_before_merge",
    findings: [],
    observations: [],
    ticketCompliance: [],
    missingTests: [],
    filesReviewed: [],
    modelUsed: "gpt-4o",
    tokenCount: 12345,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/index.ts",
    line: 10,
    endLine: null,
    severity: "warning",
    category: "bugs",
    message: "Possible null dereference",
    suggestedFix: null,
    ...overrides,
  };
}

describe("formatSummaryComment", () => {
  it("renders a full summary with all severity levels", () => {
    const review = makeReview({
      findings: [
        makeFinding({
          severity: "critical",
          file: "src/auth.ts",
          line: 42,
          message: "SQL injection risk",
        }),
        makeFinding({
          severity: "warning",
          file: "src/utils.ts",
          line: 15,
          message: "Unused variable",
        }),
        makeFinding({
          severity: "suggestion",
          file: "src/helpers.ts",
          line: 88,
          message: "Consider extracting method",
        }),
      ],
      observations: [
        {
          file: "src/legacy.ts",
          line: 125,
          severity: "warning",
          category: "security",
          message: "Hardcoded secret",
        },
      ],
      filesReviewed: ["src/auth.ts", "src/utils.ts", "src/helpers.ts"],
      modelUsed: "claude-opus-4-20250514",
      tokenCount: 50000,
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("# Code Review Summary");
    expect(result).toContain("**Status:** 3 Issues Found");
    expect(result).toContain("**Recommendation:** Address before merge");
    expect(result).toContain("| CRITICAL | 1 |");
    expect(result).toContain("| WARNING | 1 |");
    expect(result).toContain("| SUGGESTION | 1 |");
    expect(result).toContain("| `src/auth.ts` | 42 | SQL injection risk |");
    expect(result).toContain("| `src/utils.ts` | 15 | Unused variable |");
    expect(result).toContain("Other Observations (not in diff)");
    expect(result).toContain("| `src/legacy.ts` | 125 | Hardcoded secret |");
    expect(result).toContain("Files Reviewed (3 files)");
    expect(result).toContain("- `src/auth.ts` - 1 issues");
    expect(result).toContain("Overall the code looks solid.");
    expect(result).toContain("Reviewed by claude-opus-4-20250514 · 50000 tokens");
  });

  it("renders all distinct pass models in the footer when consensus ran multiple models", () => {
    const review = makeReview({
      modelUsed: "openai/gpt-5-mini",
      tokenCount: 30000,
      consensusMetadata: {
        passes: 3,
        threshold: 2,

        effectiveThreshold: 2,

        degraded: false,
        agreementRate: 0.6,
        recommendationElevated: false,
        passRecommendations: ["looks_good", "looks_good", "address_before_merge"],
        passModels: ["openai/gpt-5-mini", "moonshot/kimi-k2.5", "minimaxi/MiniMax-M2.7"],
        failedPasses: 0,
      },
    });

    const result = formatSummaryComment(review);

    expect(result).toContain(
      "Reviewed by openai/gpt-5-mini, moonshot/kimi-k2.5, minimaxi/MiniMax-M2.7 · 30000 tokens",
    );
  });

  it("dedupes pass models when the same model ran multiple passes", () => {
    const review = makeReview({
      modelUsed: "anthropic/claude-sonnet-4-6",
      consensusMetadata: {
        passes: 3,
        threshold: 2,

        effectiveThreshold: 2,

        degraded: false,
        agreementRate: 1,
        recommendationElevated: false,
        passRecommendations: ["looks_good", "looks_good", "looks_good"],
        passModels: [
          "anthropic/claude-sonnet-4-6",
          "anthropic/claude-sonnet-4-6",
          "anthropic/claude-sonnet-4-6",
        ],
        failedPasses: 0,
      },
    });

    const footerLine = formatSummaryComment(review)
      .split("\n")
      .find((l) => l.startsWith("Reviewed by "));
    expect(footerLine).toBeDefined();
    const occurrences = footerLine!.match(/anthropic\/claude-sonnet-4-6/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("falls back to modelUsed in the footer when consensusMetadata is absent", () => {
    const review = makeReview({
      modelUsed: "openai/gpt-5-mini",
      tokenCount: 12345,
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("Reviewed by openai/gpt-5-mini · 12345 tokens");
  });

  it("falls back to modelUsed when passModels is an empty array", () => {
    const review = makeReview({
      modelUsed: "openai/gpt-5-mini",
      tokenCount: 12345,
      consensusMetadata: {
        passes: 1,
        threshold: 1,

        effectiveThreshold: 1,

        degraded: false,
        agreementRate: 1,
        recommendationElevated: false,
        passRecommendations: ["looks_good"],
        passModels: [],
        failedPasses: 0,
      },
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("Reviewed by openai/gpt-5-mini · 12345 tokens");
  });

  it("credits only successfulPassModels when a configured pass failed", () => {
    // exactly the BuildFind #527 case: configured 3 passes, openrouter/xai/grok-4.3
    // is an invalid model id → pass 2 dies. The summary should NOT credit grok.
    const review = makeReview({
      modelUsed: "ollama/deepseek-v4-flash:cloud",
      tokenCount: 112622,
      consensusMetadata: {
        passes: 3,
        threshold: 2,
        effectiveThreshold: 2,
        degraded: false,
        agreementRate: 0,
        recommendationElevated: false,
        passRecommendations: ["address_before_merge", "address_before_merge"],
        passModels: [
          "ollama/deepseek-v4-flash:cloud",
          "openrouter/xai/grok-4.3",
          "ollama/kimi-k2.6:cloud",
        ],
        successfulPassModels: ["ollama/deepseek-v4-flash:cloud", "ollama/kimi-k2.6:cloud"],
        failedPasses: 1,
      },
    });

    const footerLine = formatSummaryComment(review)
      .split("\n")
      .find((l) => l.startsWith("Reviewed by "));
    expect(footerLine).toBeDefined();
    expect(footerLine).toContain("ollama/deepseek-v4-flash:cloud");
    expect(footerLine).toContain("ollama/kimi-k2.6:cloud");
    // the failed model must NOT appear in the credit line
    expect(footerLine).not.toContain("openrouter/xai/grok-4.3");
    // and the consensus annotation should note the failure
    expect(footerLine).toContain("consensus 3 passes (1 failed)");
  });

  it("falls back to passModels for older metadata without successfulPassModels", () => {
    // backward-compat: existing serialized metadata predating the new field
    // should still render — fall back to passModels (current behavior preserved).
    const review = makeReview({
      modelUsed: "openai/gpt-5-mini",
      tokenCount: 30000,
      consensusMetadata: {
        passes: 2,
        threshold: 2,
        effectiveThreshold: 2,
        degraded: false,
        agreementRate: 1,
        recommendationElevated: false,
        passRecommendations: ["looks_good", "looks_good"],
        passModels: ["openai/gpt-5-mini", "anthropic/claude-sonnet-4-6"],
        // successfulPassModels intentionally absent
        failedPasses: 0,
      },
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("Reviewed by openai/gpt-5-mini, anthropic/claude-sonnet-4-6");
  });

  it("annotates degraded reviews in the consensus footer line", () => {
    const review = makeReview({
      modelUsed: "openai/gpt-5-mini",
      tokenCount: 20000,
      consensusMetadata: {
        passes: 2,
        threshold: 2,
        effectiveThreshold: 1,
        degraded: true,
        agreementRate: 1,
        recommendationElevated: false,
        passRecommendations: ["looks_good"],
        passModels: ["openai/gpt-5-mini", "anthropic/claude-sonnet-4-6"],
        successfulPassModels: ["openai/gpt-5-mini"],
        failedPasses: 1,
      },
    });

    const footerLine = formatSummaryComment(review)
      .split("\n")
      .find((l) => l.startsWith("Reviewed by "));
    expect(footerLine).toBeDefined();
    expect(footerLine).toContain("Reviewed by openai/gpt-5-mini");
    expect(footerLine).not.toContain("claude-sonnet");
    expect(footerLine).toContain("consensus 2 passes (1 failed)");
    expect(footerLine).toContain("degraded — judge filtering only");
  });

  it("renders a judge-failure note instead of token/filtered counts when judgeStatus is failed", () => {
    const review = makeReview({
      modelUsed: "openai/gpt-5-mini",
      tokenCount: 5000,
      judgeStatus: "failed",
      judgeTokenCount: 0,
      filteredCount: 0,
    });

    const footerLine = formatSummaryComment(review)
      .split("\n")
      .find((l) => l.startsWith("Reviewed by "));
    expect(footerLine).toBeDefined();
    expect(footerLine).toContain("judge pass failed — findings unfiltered");
    expect(footerLine).not.toContain("tokens (judge)");
    expect(footerLine).not.toContain("low-confidence findings filtered");
  });

  it("renders a clean review with zero findings", () => {
    const review = makeReview({
      recommendation: "looks_good",
      findings: [],
      observations: [],
      filesReviewed: ["src/app.ts"],
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("**Status:** 0 Issues Found");
    expect(result).toContain("**Recommendation:** Looks good!");
    expect(result).toContain("| CRITICAL | 0 |");
    expect(result).toContain("| WARNING | 0 |");
    expect(result).toContain("| SUGGESTION | 0 |");
    expect(result).toContain("No issues found.");
    expect(result).not.toContain("Other Observations");
    expect(result).toContain("- `src/app.ts` - 0 issues");
  });

  it("renders only one severity level when others are empty", () => {
    const review = makeReview({
      recommendation: "critical_issues",
      findings: [
        makeFinding({ severity: "critical", message: "Memory leak" }),
        makeFinding({
          severity: "critical",
          file: "src/db.ts",
          line: 99,
          message: "Connection not closed",
        }),
      ],
      filesReviewed: ["src/index.ts", "src/db.ts"],
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("**Recommendation:** Critical issues found");
    expect(result).toContain("CRITICAL");
    expect(result).toContain("| CRITICAL | 2 |");
    // warning/suggestion tables should be omitted from Issue Details
    const detailsSection = result.split("Issue Details")[1].split("</details>")[0];
    expect(detailsSection).not.toMatch(/^WARNING$/m);
    expect(detailsSection).not.toMatch(/^SUGGESTION$/m);
  });

  it("includes observations section when observations exist", () => {
    const review = makeReview({
      observations: [
        {
          file: "src/old.ts",
          line: 200,
          severity: "suggestion",
          category: "style",
          message: "Dead code",
        },
      ],
      filesReviewed: ["src/main.ts"],
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("Other Observations (not in diff)");
    expect(result).toContain("Issues found in unchanged code that cannot receive inline comments:");
    expect(result).toContain("| `src/old.ts` | 200 | Dead code |");
  });

  it("omits observations section when no observations", () => {
    const review = makeReview({ observations: [] });
    const result = formatSummaryComment(review);
    expect(result).not.toContain("Other Observations");
  });

  it("renders ticket compliance as a structured checklist", () => {
    const review = makeReview({
      ticketCompliance: [
        {
          ticketId: "AUTH-42",
          requirement: "Login endpoint returns a JWT",
          status: "addressed",
          evidence: "auth.ts adds token signing in the login handler",
        },
        {
          ticketId: "AUTH-42",
          requirement: "Protected routes validate the JWT",
          status: "partially_addressed",
          evidence: "Middleware verifies tokens, but one admin route is still bypassed",
        },
      ],
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("Ticket Compliance (2 requirements)");
    expect(result).toContain("| Ticket | Requirement | Status | Evidence |");
    expect(result).toContain("| AUTH-42 | Login endpoint returns a JWT | Addressed |");
    expect(result).toContain(
      "| AUTH-42 | Protected routes validate the JWT | Partially addressed |",
    );
  });

  it("omits ticket compliance section when there are no linked ticket checks", () => {
    const review = makeReview({ ticketCompliance: [] });
    const result = formatSummaryComment(review);
    expect(result).not.toContain("Ticket Compliance");
  });

  it("renders ticket fetch status when linked tickets were detected", () => {
    const review = makeReview();
    const result = formatSummaryComment(review, {
      ticketResolution: {
        totalRefsFound: 2,
        refsConsidered: 2,
        refsSkippedByLimit: 0,
        fetched: 1,
        consideredMissingProvider: 0,
        consideredFetchFailed: 1,
      },
    });

    expect(result).toContain("## Ticket Fetch");
    expect(result).toContain("Fetched 1 of 2 linked ticket(s). 1 failed to fetch.");
  });

  it("explains when ticket refs were found but could not be fetched", () => {
    const review = makeReview();
    const result = formatSummaryComment(review, {
      ticketResolution: {
        totalRefsFound: 1,
        refsConsidered: 1,
        refsSkippedByLimit: 0,
        fetched: 0,
        consideredMissingProvider: 1,
        consideredFetchFailed: 0,
      },
    });

    expect(result).toContain(
      "Found 1 linked ticket reference(s), but no matching ticket provider was configured.",
    );
  });

  it("reports both missing providers and failed fetches when some tickets were fetched", () => {
    const review = makeReview();
    const result = formatSummaryComment(review, {
      ticketResolution: {
        totalRefsFound: 4,
        refsConsidered: 3,
        refsSkippedByLimit: 1,
        fetched: 1,
        consideredMissingProvider: 1,
        consideredFetchFailed: 1,
      },
    });

    expect(result).toContain(
      "Fetched 1 of 3 linked ticket(s) (found 4, reviewed first 3). 1 skipped due to missing provider, 1 failed to fetch.",
    );
  });

  it("reports explicit fetch failures when no tickets could be fetched", () => {
    const review = makeReview();
    const result = formatSummaryComment(review, {
      ticketResolution: {
        totalRefsFound: 2,
        refsConsidered: 2,
        refsSkippedByLimit: 0,
        fetched: 0,
        consideredMissingProvider: 0,
        consideredFetchFailed: 2,
      },
    });

    expect(result).toContain("Found 2 linked ticket reference(s), but 2 fetches failed.");
  });

  it("handles a single file reviewed", () => {
    const review = makeReview({
      filesReviewed: ["single-file.ts"],
      findings: [makeFinding({ file: "single-file.ts" })],
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("Files Reviewed (1 files)");
    expect(result).toContain("- `single-file.ts` - 1 issues");
  });

  it("handles very long file paths", () => {
    const longPath = "src/modules/deeply/nested/folder/structure/that/goes/on/and/on/component.tsx";
    const review = makeReview({
      findings: [makeFinding({ file: longPath, line: 1, message: "issue here" })],
      filesReviewed: [longPath],
    });

    const result = formatSummaryComment(review);

    expect(result).toContain(`\`${longPath}\``);
    expect(result).toContain(`- \`${longPath}\` - 1 issues`);
  });

  it("counts issues per file correctly when multiple findings in same file", () => {
    const review = makeReview({
      findings: [
        makeFinding({ file: "a.ts", line: 1, severity: "warning" }),
        makeFinding({ file: "a.ts", line: 5, severity: "critical" }),
        makeFinding({ file: "b.ts", line: 10, severity: "suggestion" }),
      ],
      filesReviewed: ["a.ts", "b.ts", "c.ts"],
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("- `a.ts` - 2 issues");
    expect(result).toContain("- `b.ts` - 1 issues");
    expect(result).toContain("- `c.ts` - 0 issues");
  });
});

describe("formatInlineComment", () => {
  it("renders an inline comment with suggested fix", () => {
    const finding = makeFinding({
      severity: "critical",
      category: "security",
      message: "Unsanitized user input",
      suggestedFix: "const safe = sanitize(input);",
    });

    const result = formatInlineComment(finding);

    expect(result).toContain("**CRITICAL** (security)");
    expect(result).toContain("Unsanitized user input");
    expect(result).toContain("```suggestion\nconst safe = sanitize(input);\n```");
  });

  it("renders an inline comment without suggested fix", () => {
    const finding = makeFinding({
      severity: "suggestion",
      category: "style",
      message: "Consider using const instead of let",
    });

    const result = formatInlineComment(finding);

    expect(result).toContain("**SUGGESTION** (style)");
    expect(result).toContain("Consider using const instead of let");
    expect(result).not.toContain("```suggestion");
  });

  it("renders warning severity correctly", () => {
    const finding = makeFinding({
      severity: "warning",
      category: "performance",
      message: "O(n^2) complexity in loop",
    });

    const result = formatInlineComment(finding);

    expect(result).toContain("**WARNING** (performance)");
    expect(result).toContain("O(n^2) complexity in loop");
  });

  it("handles multiline suggested fix", () => {
    const finding = makeFinding({
      suggestedFix: "const a = 1;\nconst b = 2;\nreturn a + b;",
    });

    const result = formatInlineComment(finding);

    expect(result).toContain("```suggestion\nconst a = 1;\nconst b = 2;\nreturn a + b;\n```");
  });

  it("falls back to plain code block when suggestedFix contains prose", () => {
    const finding = makeFinding({
      suggestedFix:
        "Derive the query-data type from the actual query. For example: setQueriesData<FolderContents>({...}) where FolderContents matches the real cache shape.",
    });

    const result = formatInlineComment(finding);

    expect(result).not.toContain("```suggestion");
    expect(result).toContain("**Suggested fix:**");
    expect(result).toContain("```\nDerive the query-data type");
  });

  it("uses suggestion block for code even with short comments in it", () => {
    const finding = makeFinding({
      suggestedFix: "// use parameterized queries\nconst result = db.query(sql, [param]);",
    });

    const result = formatInlineComment(finding);

    expect(result).toContain("```suggestion");
  });
});

describe("formatSummaryComment with missing tests", () => {
  it("renders a collapsible missing tests section", () => {
    const review = makeReview({
      missingTests: [
        {
          file: "src/auth.ts",
          description: "edge case: empty credentials object should throw ValidationError",
        },
        {
          file: "src/db.ts",
          description: "error path: connection timeout should propagate a typed error",
        },
        {
          file: "src/auth.ts",
          description: "boundary: maxRetries=0 should skip retry logic entirely",
        },
      ],
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("Missing Tests (3 suggested test cases)");
    expect(result).toContain("| File | Suggested Test Case |");
    expect(result).toContain(
      "| `src/auth.ts` | edge case: empty credentials object should throw ValidationError |",
    );
    expect(result).toContain(
      "| `src/db.ts` | error path: connection timeout should propagate a typed error |",
    );
    expect(result).toContain(
      "| `src/auth.ts` | boundary: maxRetries=0 should skip retry logic entirely |",
    );
  });

  it("omits missing tests section when array is empty", () => {
    const review = makeReview({ missingTests: [] });
    const result = formatSummaryComment(review);
    expect(result).not.toContain("Missing Tests");
  });

  it("sanitizes pipe characters in test descriptions", () => {
    const review = makeReview({
      missingTests: [
        {
          file: "src/parser.ts",
          description: "union type A | B should be handled without narrowing error",
        },
      ],
    });

    const result = formatSummaryComment(review);
    expect(result).toContain("union type A \\| B should be handled without narrowing error");
  });

  it("renders missing tests section after ticket compliance and before files reviewed", () => {
    const review = makeReview({
      ticketCompliance: [
        {
          ticketId: "FEAT-1",
          requirement: "Add login",
          status: "addressed",
          evidence: "login.ts implemented",
        },
      ],
      missingTests: [
        {
          file: "src/login.ts",
          description: "error path: invalid password returns 401",
        },
      ],
      filesReviewed: ["src/login.ts"],
    });

    const result = formatSummaryComment(review);

    const complianceIdx = result.indexOf("Ticket Compliance");
    const missingTestsIdx = result.indexOf("Missing Tests");
    const filesIdx = result.indexOf("Files Reviewed");

    expect(complianceIdx).toBeLessThan(missingTestsIdx);
    expect(missingTestsIdx).toBeLessThan(filesIdx);
  });
});

describe("formatSummaryComment with dropped findings", () => {
  it("renders a collapsible dropped findings section", () => {
    const review = makeReview({
      droppedFindings: [
        {
          file: "src/parser.ts",
          line: 42,
          severity: "warning",
          message: "potential resource leak in WASM cleanup",
          voteCount: 1,
        },
        {
          file: "src/utils.ts",
          line: 15,
          severity: "suggestion",
          message: "consider extracting helper function",
          voteCount: 1,
        },
      ],
      consensusMetadata: {
        passes: 3,
        threshold: 2,

        effectiveThreshold: 2,

        degraded: false,
        agreementRate: 0.5,
        recommendationElevated: false,
        passRecommendations: ["looks_good", "looks_good", "looks_good"],
        failedPasses: 0,
      },
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("Filtered findings (2 dropped by consensus, voted below threshold)");
    expect(result).toContain("| `src/parser.ts` | 42 | warning |");
    expect(result).toContain("| 1/3 |");
    expect(result).toContain("| `src/utils.ts` | 15 | suggestion |");
  });

  it("omits dropped findings section when droppedFindings is undefined", () => {
    const review = makeReview({ droppedFindings: undefined });
    const result = formatSummaryComment(review);
    expect(result).not.toContain("Filtered findings");
  });

  it("omits dropped findings section when droppedFindings is empty", () => {
    const review = makeReview({
      droppedFindings: [],
      consensusMetadata: {
        passes: 3,
        threshold: 2,

        effectiveThreshold: 2,

        degraded: false,
        agreementRate: 1,
        recommendationElevated: false,
        passRecommendations: ["looks_good", "looks_good", "looks_good"],
        failedPasses: 0,
      },
    });
    const result = formatSummaryComment(review);
    expect(result).not.toContain("Filtered findings");
  });

  it("sanitizes pipe characters in dropped finding messages", () => {
    const review = makeReview({
      droppedFindings: [
        {
          file: "src/a.ts",
          line: 1,
          severity: "warning",
          message: "use a | b instead of a || b",
          voteCount: 1,
        },
      ],
      consensusMetadata: {
        passes: 3,
        threshold: 2,

        effectiveThreshold: 2,

        degraded: false,
        agreementRate: 0.5,
        recommendationElevated: false,
        passRecommendations: ["looks_good", "looks_good", "looks_good"],
        failedPasses: 0,
      },
    });

    const result = formatSummaryComment(review);
    expect(result).toContain("use a \\| b instead of a \\|\\| b");
  });
});

describe("formatSummaryComment with elevated recommendation but no surviving findings", () => {
  function makeElevatedReview(overrides: Partial<ReviewResult> = {}): ReviewResult {
    return makeReview({
      recommendation: "address_before_merge",
      findings: [],
      droppedFindings: [
        {
          file: "src/dao.ts",
          line: 120,
          severity: "warning",
          message: "race path can return empty conflicts payload",
          voteCount: 1,
        },
        {
          file: "src/router.ts",
          line: 55,
          severity: "warning",
          message: "partial RBAC grants on mid-loop failure",
          voteCount: 1,
        },
        {
          file: "src/dao.ts",
          line: 200,
          severity: "suggestion",
          message: "bulk create ignores folder_id",
          voteCount: 1,
        },
      ],
      consensusMetadata: {
        passes: 3,
        threshold: 2,

        effectiveThreshold: 2,

        degraded: false,
        agreementRate: 0,
        recommendationElevated: true,
        passRecommendations: [
          "address_before_merge",
          "address_before_merge",
          "address_before_merge",
        ],
        failedPasses: 0,
      },
      ...overrides,
    });
  }

  it("renders a prominent Elevated Concerns section (expanded, not collapsed)", () => {
    const result = formatSummaryComment(makeElevatedReview());

    expect(result).toContain("## Elevated Concerns (3)");
    expect(result).toContain("threshold of 2/3 passes");
    expect(result).toContain("| `src/dao.ts` | 120 | warning |");
    expect(result).toContain("| `src/router.ts` | 55 | warning |");
    expect(result).toContain("| 1/3 |");
    // not wrapped in a <details> block (no unclosed <details> before the section)
    const elevatedIdx = result.indexOf("## Elevated Concerns");
    const preceding = result.slice(0, elevatedIdx);
    const lastDetailsOpen = preceding.lastIndexOf("<details>");
    const lastDetailsClose = preceding.lastIndexOf("</details>");
    expect(lastDetailsClose).toBeGreaterThanOrEqual(lastDetailsOpen);
  });

  it("suppresses the collapsed Filtered findings section to avoid duplication", () => {
    const result = formatSummaryComment(makeElevatedReview());
    expect(result).not.toContain("Filtered findings");
  });

  it("annotates the status line to point readers to the elevated concerns", () => {
    const result = formatSummaryComment(makeElevatedReview());
    expect(result).toContain(
      "**Status:** 0 Issues Found — 3 elevated concerns below | **Recommendation:** Address before merge",
    );
  });

  it("uses singular wording when exactly one concern is elevated", () => {
    const review = makeElevatedReview({
      droppedFindings: [
        {
          file: "src/a.ts",
          line: 1,
          severity: "warning",
          message: "lone concern",
          voteCount: 1,
        },
      ],
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("1 elevated concern below");
    expect(result).not.toContain("1 elevated concerns below");
    expect(result).toContain("## Elevated Concerns (1)");
  });

  it("places the prominent section before Overview so the zero-count table reads as context", () => {
    const result = formatSummaryComment(makeElevatedReview());
    const elevatedIdx = result.indexOf("## Elevated Concerns");
    const overviewIdx = result.indexOf("## Overview");
    expect(elevatedIdx).toBeGreaterThan(-1);
    expect(elevatedIdx).toBeLessThan(overviewIdx);
  });

  it("sanitizes pipe characters in elevated concern messages", () => {
    const review = makeElevatedReview({
      droppedFindings: [
        {
          file: "src/a.ts",
          line: 1,
          severity: "warning",
          message: "prefer a | b over a || b",
          voteCount: 1,
        },
      ],
    });

    const result = formatSummaryComment(review);
    expect(result).toContain("prefer a \\| b over a \\|\\| b");
  });

  it("falls back to the collapsed Filtered findings section when findings survived", () => {
    // surviving findings + dropped findings + elevated flag false
    // (this is the pre-existing behavior; the new section only kicks in when findings.length === 0)
    const review = makeElevatedReview({
      findings: [makeFinding({ severity: "warning" })],
      consensusMetadata: {
        passes: 3,
        threshold: 2,

        effectiveThreshold: 2,

        degraded: false,
        agreementRate: 0.5,
        recommendationElevated: false,
        passRecommendations: ["looks_good", "address_before_merge", "address_before_merge"],
        failedPasses: 0,
      },
    });

    const result = formatSummaryComment(review);

    expect(result).not.toContain("## Elevated Concerns");
    expect(result).toContain("Filtered findings");
    expect(result).not.toContain("elevated concern below");
    expect(result).not.toContain("elevated concerns below");
  });

  it("falls back to the collapsed Filtered findings section when elevation did not fire", () => {
    // dropped findings exist, zero surviving findings, but recommendationElevated is false
    const review = makeElevatedReview({
      recommendation: "looks_good",
      consensusMetadata: {
        passes: 3,
        threshold: 2,

        effectiveThreshold: 2,

        degraded: false,
        agreementRate: 0,
        recommendationElevated: false,
        passRecommendations: ["looks_good", "looks_good", "looks_good"],
        failedPasses: 0,
      },
    });

    const result = formatSummaryComment(review);

    expect(result).not.toContain("## Elevated Concerns");
    expect(result).toContain("Filtered findings");
  });
});

describe("formatSummaryComment with consensus metadata in footer", () => {
  it("includes consensus pass count and agreement rate in footer", () => {
    const review = makeReview({
      consensusMetadata: {
        passes: 3,
        threshold: 2,

        effectiveThreshold: 2,

        degraded: false,
        agreementRate: 0.67,
        recommendationElevated: false,
        passRecommendations: ["looks_good", "looks_good", "address_before_merge"],
        failedPasses: 0,
      },
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("consensus 3 passes");
    expect(result).toContain("67% agreement");
    expect(result).not.toContain("recommendation elevated");
  });

  it("shows elevated recommendation note when recommendationElevated is true", () => {
    const review = makeReview({
      consensusMetadata: {
        passes: 3,
        threshold: 2,

        effectiveThreshold: 2,

        degraded: false,
        agreementRate: 1,
        recommendationElevated: true,
        passRecommendations: [
          "address_before_merge",
          "address_before_merge",
          "address_before_merge",
        ],
        failedPasses: 0,
      },
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("recommendation elevated from pass votes");
  });

  it("omits consensus metadata from footer when not present", () => {
    const review = makeReview();
    const result = formatSummaryComment(review);
    expect(result).not.toContain("consensus");
    expect(result).not.toContain("agreement");
  });
});

describe("formatSummaryComment with triage stats", () => {
  it("includes triage section when triageStats is present", () => {
    const review: ReviewResult = {
      summary: "Looks good.",
      recommendation: "looks_good",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: ["src/index.ts"],
      modelUsed: "claude-sonnet-4",
      tokenCount: 5000,
      triageStats: {
        filesSkipped: 3,
        filesSkimmed: 2,
        filesDeepReviewed: 5,
        triageModelUsed: "claude-haiku-3",
        triageTokenCount: 800,
      },
    };

    const result = formatSummaryComment(review);
    expect(result).toContain("Triage Summary");
    expect(result).toContain("Skipped");
    expect(result).toContain("3");
    expect(result).toContain("Skimmed");
    expect(result).toContain("2");
    expect(result).toContain("Deep Reviewed");
    expect(result).toContain("5");
    expect(result).toContain("claude-haiku-3");
    expect(result).toContain("800 tokens");
  });

  it("omits triage section when triageStats is not present", () => {
    const review: ReviewResult = {
      summary: "OK",
      recommendation: "looks_good",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: [],
      modelUsed: "gpt-4o",
      tokenCount: 1000,
    };

    const result = formatSummaryComment(review);
    expect(result).not.toContain("Triage Summary");
  });

  it("triage section appears before overview section", () => {
    const review: ReviewResult = {
      summary: "Fine.",
      recommendation: "looks_good",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: [],
      modelUsed: "test",
      tokenCount: 100,
      triageStats: {
        filesSkipped: 1,
        filesSkimmed: 1,
        filesDeepReviewed: 1,
        triageModelUsed: "haiku",
        triageTokenCount: 50,
      },
    };

    const result = formatSummaryComment(review);
    const triageIdx = result.indexOf("Triage Summary");
    const overviewIdx = result.indexOf("## Overview");
    expect(triageIdx).toBeLessThan(overviewIdx);
  });
});

describe("formatSummaryComment scope creep", () => {
  it("renders a visible section with one row per out-of-scope change", () => {
    const review = makeReview({
      scopeCreep: [
        { file: "src/utils.ts", description: "renames helpers unrelated to the login fix" },
        { file: "package.json", description: "bumps eslint | prettier with no related change" },
      ],
    });

    const result = formatSummaryComment(review);

    expect(result).toContain("## Scope Creep (2 out-of-scope changes)");
    expect(result).toContain("| `src/utils.ts` | renames helpers unrelated to the login fix |");
    expect(result).toContain("bumps eslint \\| prettier with no related change");
    expect(result).not.toContain("<summary>Scope Creep");
  });

  it("uses the singular label for a single entry", () => {
    const review = makeReview({
      scopeCreep: [{ file: "src/utils.ts", description: "unrelated rename" }],
    });
    expect(formatSummaryComment(review)).toContain("## Scope Creep (1 out-of-scope change)");
  });

  it("omits the section when scopeCreep is absent or empty", () => {
    expect(formatSummaryComment(makeReview())).not.toContain("Scope Creep");
    expect(formatSummaryComment(makeReview({ scopeCreep: [] }))).not.toContain("Scope Creep");
  });

  it("places scope creep after issue details and before the collapsible detail sections", () => {
    const review = makeReview({
      findings: [makeFinding()],
      scopeCreep: [{ file: "src/utils.ts", description: "unrelated rename" }],
      missingTests: [{ file: "src/a.ts", description: "edge case: empty input" }],
    });
    const result = formatSummaryComment(review);
    expect(result.indexOf("Issue Details")).toBeLessThan(result.indexOf("Scope Creep"));
    expect(result.indexOf("Scope Creep")).toBeLessThan(result.indexOf("Missing Tests"));
  });
});
