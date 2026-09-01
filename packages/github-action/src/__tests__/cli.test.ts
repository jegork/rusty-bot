import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Octokit } from "octokit";
import type * as RustyBotCore from "@rusty-bot/core";
import type { FilePatch, OpenGrepFinding, PRMetadata } from "@rusty-bot/core";
import {
  isCascadeEnabled,
  parseDiff,
  runOpenGrep,
  runTriage,
  runCascadeReview,
} from "@rusty-bot/core";
import { GitHubProvider, createOctokitIssueFetcher } from "@rusty-bot/github";
import { parseConfig, runAction, type ActionConfig } from "../cli.js";
import type { PullRequestEvent } from "../event.js";

vi.mock("@rusty-bot/github", () => ({
  GitHubProvider: vi.fn(),
  createOctokitIssueFetcher: vi.fn(() => vi.fn()),
}));

vi.mock("@rusty-bot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof RustyBotCore>();
  return {
    ...actual,
    isCascadeEnabled: vi.fn(),
    parseDiff: vi.fn(),
    runOpenGrep: vi.fn(),
    runTriage: vi.fn(),
    runCascadeReview: vi.fn(),
  };
});

const BASE_EVENT: PullRequestEvent = {
  action: "opened",
  pull_request: { number: 42, draft: false },
};

function makeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const defaults: Record<string, string> = {
    GITHUB_TOKEN: "ghs_abc123",
    GITHUB_REPOSITORY: "jegork/rusty-bot",
    ANTHROPIC_API_KEY: "sk-ant-test",
  };
  const merged: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in overrides)) merged[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) merged[k] = v;
  }
  return merged;
}

describe("parseConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("parses a minimal valid config", () => {
    const config = parseConfig({ event: BASE_EVENT, env: makeEnv() });
    expect(config.owner).toBe("jegork");
    expect(config.repo).toBe("rusty-bot");
    expect(config.pullNumber).toBe(42);
    expect(config.token).toBe("ghs_abc123");
    expect(config.review.style).toBe("balanced");
    expect(config.review.focusAreas).toEqual([
      "security",
      "performance",
      "bugs",
      "style",
      "tests",
      "docs",
    ]);
    expect(config.failOnCritical).toBe(true);
    expect(config.generateDescription).toBe(false);
    expect(config.renameTitleToConventional).toBe(false);
    expect(config.incrementalReview).toBe(true);
  });

  it("throws when GITHUB_TOKEN is missing", () => {
    expect(() =>
      parseConfig({ event: BASE_EVENT, env: makeEnv({ GITHUB_TOKEN: undefined }) }),
    ).toThrow("GITHUB_TOKEN");
  });

  it("throws when GITHUB_REPOSITORY is missing", () => {
    expect(() =>
      parseConfig({ event: BASE_EVENT, env: makeEnv({ GITHUB_REPOSITORY: undefined }) }),
    ).toThrow("GITHUB_REPOSITORY");
  });

  it("lists all missing vars when both are absent", () => {
    expect(() =>
      parseConfig({
        event: BASE_EVENT,
        env: makeEnv({ GITHUB_TOKEN: undefined, GITHUB_REPOSITORY: undefined }),
      }),
    ).toThrow(/GITHUB_TOKEN, GITHUB_REPOSITORY/);
  });

  it("falls back to INPUT_GITHUB_TOKEN when GITHUB_TOKEN is not set", () => {
    const config = parseConfig({
      event: BASE_EVENT,
      env: makeEnv({ GITHUB_TOKEN: undefined, INPUT_GITHUB_TOKEN: "ghp_fallback" }),
    });
    expect(config.token).toBe("ghp_fallback");
  });

  it("throws when GITHUB_REPOSITORY is malformed", () => {
    expect(() =>
      parseConfig({ event: BASE_EVENT, env: makeEnv({ GITHUB_REPOSITORY: "no-slash" }) }),
    ).toThrow('must be in the form "owner/repo"');
  });

  it("throws when the pull request number cannot be determined", () => {
    expect(() => parseConfig({ event: { action: "synchronize" }, env: makeEnv() })).toThrow(
      "could not determine pull request number",
    );
  });

  it("uses top-level event.number when pull_request is absent", () => {
    const config = parseConfig({ event: { action: "opened", number: 7 }, env: makeEnv() });
    expect(config.pullNumber).toBe(7);
  });

  it("parses review style and rejects invalid values", () => {
    expect(
      parseConfig({ event: BASE_EVENT, env: makeEnv({ RUSTY_REVIEW_STYLE: "strict" }) }).review
        .style,
    ).toBe("strict");

    expect(() =>
      parseConfig({ event: BASE_EVENT, env: makeEnv({ RUSTY_REVIEW_STYLE: "bogus" }) }),
    ).toThrow("invalid review style: bogus");
  });

  it("parses focus areas and filters empties / whitespace", () => {
    const config = parseConfig({
      event: BASE_EVENT,
      env: makeEnv({ RUSTY_FOCUS_AREAS: "security, , performance ," }),
    });
    expect(config.review.focusAreas).toEqual(["security", "performance"]);
  });

  it("defaults focus areas to all six when RUSTY_FOCUS_AREAS is absent or empty", () => {
    const defaulted = parseConfig({ event: BASE_EVENT, env: makeEnv() }).review.focusAreas;
    expect(defaulted).toHaveLength(6);

    const emptyString = parseConfig({
      event: BASE_EVENT,
      env: makeEnv({ RUSTY_FOCUS_AREAS: "" }),
    }).review.focusAreas;
    expect(emptyString).toHaveLength(6);

    const onlyCommas = parseConfig({
      event: BASE_EVENT,
      env: makeEnv({ RUSTY_FOCUS_AREAS: ",,," }),
    }).review.focusAreas;
    expect(onlyCommas).toHaveLength(6);
  });

  it("filters unknown focus area values out and keeps the valid ones", () => {
    const config = parseConfig({
      event: BASE_EVENT,
      env: makeEnv({ RUSTY_FOCUS_AREAS: "security,bogus,bugs,YOLO" }),
    });
    expect(config.review.focusAreas).toEqual(["security", "bugs"]);
  });

  it("falls back to all focus areas when every provided value is invalid", () => {
    const config = parseConfig({
      event: BASE_EVENT,
      env: makeEnv({ RUSTY_FOCUS_AREAS: "bogus,YOLO" }),
    });
    expect(config.review.focusAreas).toHaveLength(6);
  });

  it("parses ignore patterns", () => {
    const config = parseConfig({
      event: BASE_EVENT,
      env: makeEnv({ RUSTY_IGNORE_PATTERNS: "*.lock,dist/**" }),
    });
    expect(config.review.ignorePatterns).toEqual(["*.lock", "dist/**"]);
  });

  it("respects RUSTY_FAIL_ON_CRITICAL=false", () => {
    const config = parseConfig({
      event: BASE_EVENT,
      env: makeEnv({ RUSTY_FAIL_ON_CRITICAL: "false" }),
    });
    expect(config.failOnCritical).toBe(false);
  });

  it("treats any non-false RUSTY_FAIL_ON_CRITICAL as true", () => {
    for (const value of ["true", "1", "yes", "anything"]) {
      const config = parseConfig({
        event: BASE_EVENT,
        env: makeEnv({ RUSTY_FAIL_ON_CRITICAL: value }),
      });
      expect(config.failOnCritical).toBe(true);
    }
  });

  describe("LLM credential validation", () => {
    it("throws when the model provider's API key env var is missing", () => {
      expect(() =>
        parseConfig({ event: BASE_EVENT, env: makeEnv({ ANTHROPIC_API_KEY: undefined }) }),
      ).toThrow(/ANTHROPIC_API_KEY is missing/);
    });

    it("validates against the provider prefix of RUSTY_LLM_MODEL, not the default", () => {
      expect(() =>
        parseConfig({
          event: BASE_EVENT,
          env: makeEnv({
            ANTHROPIC_API_KEY: undefined,
            RUSTY_LLM_MODEL: "openai/gpt-4o",
          }),
        }),
      ).toThrow(/OPENAI_API_KEY is missing/);

      expect(() =>
        parseConfig({
          event: BASE_EVENT,
          env: makeEnv({
            ANTHROPIC_API_KEY: undefined,
            RUSTY_LLM_MODEL: "openai/gpt-4o",
            OPENAI_API_KEY: "sk-openai",
          }),
        }),
      ).not.toThrow();
    });

    it("skips key validation when RUSTY_LLM_BASE_URL is set (custom endpoint)", () => {
      expect(() =>
        parseConfig({
          event: BASE_EVENT,
          env: makeEnv({
            ANTHROPIC_API_KEY: undefined,
            RUSTY_LLM_BASE_URL: "http://localhost:4000/v1",
          }),
        }),
      ).not.toThrow();
    });

    it("skips key validation for Azure managed identity", () => {
      expect(() =>
        parseConfig({
          event: BASE_EVENT,
          env: makeEnv({
            ANTHROPIC_API_KEY: undefined,
            RUSTY_AZURE_RESOURCE_NAME: "my-resource",
          }),
        }),
      ).not.toThrow();
    });

    it("skips key validation for unknown provider prefixes (router-handled)", () => {
      expect(() =>
        parseConfig({
          event: BASE_EVENT,
          env: makeEnv({
            ANTHROPIC_API_KEY: undefined,
            RUSTY_LLM_MODEL: "requesty/google/gemini-3.1-flash-lite-preview",
          }),
        }),
      ).not.toThrow();
    });
  });

  it("enables description generation only on exact 'true'", () => {
    expect(
      parseConfig({
        event: BASE_EVENT,
        env: makeEnv({ RUSTY_GENERATE_DESCRIPTION: "true" }),
      }).generateDescription,
    ).toBe(true);

    expect(
      parseConfig({
        event: BASE_EVENT,
        env: makeEnv({ RUSTY_GENERATE_DESCRIPTION: "1" }),
      }).generateDescription,
    ).toBe(false);

    expect(parseConfig({ event: BASE_EVENT, env: makeEnv() }).generateDescription).toBe(false);
  });

  it("enables incremental review by default and disables only on explicit 'false'", () => {
    expect(parseConfig({ event: BASE_EVENT, env: makeEnv() }).incrementalReview).toBe(true);

    expect(
      parseConfig({
        event: BASE_EVENT,
        env: makeEnv({ RUSTY_INCREMENTAL_REVIEW: "false" }),
      }).incrementalReview,
    ).toBe(false);

    for (const value of ["true", "1", "yes", ""]) {
      const config = parseConfig({
        event: BASE_EVENT,
        env: makeEnv({ RUSTY_INCREMENTAL_REVIEW: value }),
      });
      expect(config.incrementalReview).toBe(true);
    }
  });

  it("enables conventional title rename only on exact 'true'", () => {
    expect(
      parseConfig({
        event: BASE_EVENT,
        env: makeEnv({ RUSTY_RENAME_TITLE_TO_CONVENTIONAL: "true" }),
      }).renameTitleToConventional,
    ).toBe(true);

    expect(
      parseConfig({
        event: BASE_EVENT,
        env: makeEnv({ RUSTY_RENAME_TITLE_TO_CONVENTIONAL: "1" }),
      }).renameTitleToConventional,
    ).toBe(false);

    expect(parseConfig({ event: BASE_EVENT, env: makeEnv() }).renameTitleToConventional).toBe(
      false,
    );
  });
});

describe("runAction cascade triage wiring", () => {
  const METADATA: PRMetadata = {
    id: "1",
    title: "feat: add stuff",
    description: "",
    author: "octocat",
    sourceBranch: "feature/x",
    targetBranch: "main",
    url: "https://github.com/acme/repo/pull/1",
    headSha: "abc123",
  };

  const FIXTURE_PATCH: FilePatch = {
    path: "src/index.ts",
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        content: "+added line\n context line",
      },
    ],
    additions: 1,
    deletions: 0,
    isBinary: false,
  };

  const OPEN_GREP_FINDING: OpenGrepFinding = {
    ruleId: "test-rule",
    file: "src/index.ts",
    startLine: 1,
    endLine: 1,
    message: "test finding",
    severity: "error",
  };

  function makeMockProvider() {
    return {
      getPRMetadata: vi.fn().mockResolvedValue(METADATA),
      getFileContent: vi.fn().mockResolvedValue(null),
      deleteExistingBotComments: vi.fn().mockResolvedValue(undefined),
      getRawDiff: vi.fn().mockResolvedValue(""),
      getLinkedIssueNumbers: vi.fn().mockResolvedValue([]),
      postSummaryComment: vi.fn().mockResolvedValue(undefined),
      postInlineComments: vi.fn().mockResolvedValue(undefined),
      updatePRTitle: vi.fn().mockResolvedValue(undefined),
      updatePRDescription: vi.fn().mockResolvedValue(undefined),
      getLastReviewedSha: vi.fn().mockResolvedValue(null),
      getDiffSinceSha: vi.fn().mockResolvedValue(null),
      getPriorReviewContext: vi.fn().mockResolvedValue(null),
    };
  }

  beforeEach(() => {
    vi.mocked(GitHubProvider).mockImplementation(function (this: GitHubProvider) {
      return Object.assign(this, makeMockProvider()) as unknown as GitHubProvider;
    });
    vi.mocked(createOctokitIssueFetcher).mockReturnValue(vi.fn());
    vi.mocked(isCascadeEnabled).mockReturnValue(true);
    vi.mocked(parseDiff).mockReturnValue([FIXTURE_PATCH]);
    vi.mocked(runOpenGrep).mockResolvedValue({
      available: true,
      findings: [OPEN_GREP_FINDING],
      rawCount: 1,
    });
    vi.mocked(runTriage).mockResolvedValue({
      files: [{ path: FIXTURE_PATCH.path, classification: "deep-review", reason: "test" }],
      modelUsed: "test-triage-model",
      tokenCount: 50,
    });
    vi.mocked(runCascadeReview).mockResolvedValue({
      summary: "test summary",
      findings: [],
      observations: [],
      ticketCompliance: [],
      missingTests: [],
      filesReviewed: [FIXTURE_PATCH.path],
      recommendation: "looks_good",
      modelUsed: "test-review-model",
      tokenCount: 100,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes opengrep findings to runTriage when the cascade path runs", async () => {
    const config: ActionConfig = {
      octokit: new Octokit({ auth: "test-token" }),
      owner: "acme",
      repo: "repo",
      pullNumber: 1,
      token: "test-token",
      review: { style: "balanced", focusAreas: ["security"], ignorePatterns: [] },
      failOnCritical: true,
      generateDescription: false,
      renameTitleToConventional: false,
      incrementalReview: false,
    };

    await runAction(config);

    expect(runTriage).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ path: FIXTURE_PATCH.path })]),
      [OPEN_GREP_FINDING],
    );
  });
});
