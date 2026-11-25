import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilePatch, Finding, PRMetadata, ReviewResult } from "../types.js";

const mocks = vi.hoisted(() => ({
  generateStructured: vi.fn(),
  judgeFindings: vi.fn(),
  resolveJudgeConfig: vi.fn(),
  resolveReviewPassModelConfigs: vi.fn(() => [
    {
      config: { type: "router", model: "review-model" },
      settings: { temperature: 0.3 },
      displayName: "review-model",
    },
  ]),
}));

vi.mock("../agent/generate.js", () => ({ generateStructured: mocks.generateStructured }));
vi.mock("../agent/judge.js", () => ({
  judgeFindings: mocks.judgeFindings,
  resolveJudgeConfig: mocks.resolveJudgeConfig,
}));
vi.mock("../agent/model.js", () => ({
  resolveReviewPassModelConfigs: mocks.resolveReviewPassModelConfigs,
}));

const { applyDesignPass, runDesignPass, isDesignPassEnabled, DESIGN_FINDING_PREFIX } =
  await import("../agent/design-pass.js");

function patch(path: string): FilePatch {
  return {
    path,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, content: "+a\n+b" }],
    additions: 2,
    deletions: 0,
    isBinary: false,
  };
}

const PATCHES = [patch("web/EditOrgForm.tsx"), patch("web/EditUserForm.tsx"), patch("api/repo.py")];
const META: PRMetadata = {
  id: "1",
  title: "feat: orgs",
  description: "adds org editing",
  author: "dev",
  sourceBranch: "f",
  targetBranch: "main",
  url: "u",
};

function designFinding(overrides: Record<string, unknown> = {}) {
  return {
    file: "web/EditOrgForm.tsx",
    line: 1,
    endLine: null,
    severity: "warning",
    category: "bugs",
    message: "each form handles an org switch differently",
    failureMode: "switching org mid-edit saves the record into the new org from one form only",
    relatedLocations: [{ file: "web/EditUserForm.tsx", line: 2 }],
    ...overrides,
  };
}

function modelReturns(findings: unknown[], totalTokens = 100) {
  mocks.generateStructured.mockResolvedValueOnce({ object: { findings }, usage: { totalTokens } });
}

function review(
  findings: Finding[] = [],
  recommendation: ReviewResult["recommendation"] = "looks_good",
) {
  return {
    summary: "s",
    recommendation,
    findings,
    observations: [],
    ticketCompliance: [],
    missingTests: [],
    filesReviewed: [],
    modelUsed: "m",
    tokenCount: 1,
  } satisfies ReviewResult;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveJudgeConfig.mockReturnValue({ enabled: true, threshold: 6 });
  mocks.judgeFindings.mockImplementation((findings: Finding[]) =>
    Promise.resolve({ accepted: findings, rejected: [], evaluations: [], tokenCount: 50 }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isDesignPassEnabled", () => {
  it("is off unless the flag is literally true", () => {
    expect(isDesignPassEnabled()).toBe(false);
    vi.stubEnv("RUSTY_DESIGN_PASS", "1");
    expect(isDesignPassEnabled()).toBe(false);
    vi.stubEnv("RUSTY_DESIGN_PASS", "true");
    expect(isDesignPassEnabled()).toBe(true);
  });
});

describe("runDesignPass", () => {
  it("sends the whole PR and the five-pattern prompt to the single-pass review model", async () => {
    modelReturns([]);

    const result = await runDesignPass(PATCHES, META, 10_000);

    expect(result).toEqual({ findings: [], tokenCount: 100, modelUsed: "review-model" });
    expect(mocks.resolveReviewPassModelConfigs).toHaveBeenCalledWith(1);
    const call = mocks.generateStructured.mock.calls[0][0] as {
      system: string;
      prompt: string;
      modelConfig: unknown;
      settings: unknown;
    };
    expect(call.modelConfig).toEqual({ type: "router", model: "review-model" });
    expect(call.settings).toEqual({ temperature: 0.3 });
    expect(call.system).toContain("same concern implemented several ways");
    expect(call.system).toContain("More locking is not a fix");
    expect(call.system).toContain("MUST name a concrete failure mode");
    for (const p of PATCHES) expect(call.prompt).toContain(`- \`${p.path}\``);
    expect(call.prompt).toContain("<untrusted-diff");
  });

  it("marks the finding, appends the failure mode, and never offers a suggested fix", async () => {
    modelReturns([designFinding()]);

    const { findings } = await runDesignPass(PATCHES, META, 10_000);

    expect(findings).toEqual([
      {
        file: "web/EditOrgForm.tsx",
        line: 1,
        endLine: null,
        severity: "warning",
        category: "bugs",
        message: `${DESIGN_FINDING_PREFIX}each form handles an org switch differently\n\nFailure mode: switching org mid-edit saves the record into the new org from one form only`,
        suggestedFix: null,
        relatedLocations: [{ file: "web/EditUserForm.tsx", line: 2 }],
      },
    ]);
  });

  it("drops findings without a failure mode or outside the PR", async () => {
    modelReturns([
      designFinding({ failureMode: "   " }),
      designFinding({ file: "unchanged/helper.py" }),
      designFinding({ file: "api/repo.py", category: "security" }),
    ]);

    const { findings } = await runDesignPass(PATCHES, META, 10_000);

    expect(findings.map((f) => f.file)).toEqual(["api/repo.py"]);
  });

  it("keeps only related locations on PR files, and not the finding's own spot", async () => {
    modelReturns([
      designFinding({
        relatedLocations: [
          { file: "web/EditOrgForm.tsx", line: 1 },
          { file: "outside.ts", line: 3 },
        ],
      }),
    ]);

    const { findings } = await runDesignPass(PATCHES, META, 10_000);

    expect(findings[0]).not.toHaveProperty("relatedLocations");
  });

  it("caps the findings at five", async () => {
    modelReturns(Array.from({ length: 8 }, (_, i) => designFinding({ line: i + 1 })));
    const { findings } = await runDesignPass(PATCHES, META, 10_000);
    expect(findings).toHaveLength(5);
  });

  it("tells the model which files did not fit in the budget", async () => {
    modelReturns([]);
    const big = {
      ...patch("big.ts"),
      hunks: [{ ...patch("x").hunks[0], content: "+x\n".repeat(5000) }],
    };
    await runDesignPass([...PATCHES, big], META, 50);
    const call = mocks.generateStructured.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toMatch(/\d+ of these files did not fit in the diff below/);
  });

  it("throws when the model returns nothing parseable", async () => {
    mocks.generateStructured.mockResolvedValueOnce({ object: undefined, usage: {} });
    await expect(runDesignPass(PATCHES, META, 10_000)).rejects.toThrow();
  });
});

describe("applyDesignPass", () => {
  it("does not run without the judge, so one model's opinion is never published unchecked", async () => {
    mocks.resolveJudgeConfig.mockReturnValue({ enabled: false, threshold: 6 });
    const before = review();

    expect(await applyDesignPass(before, PATCHES, META, 10_000)).toBe(before);
    expect(mocks.generateStructured).not.toHaveBeenCalled();
  });

  it("publishes what the judge confirms, with the design rubric and the existing findings as duplicates", async () => {
    modelReturns([designFinding(), designFinding({ file: "api/repo.py", severity: "critical" })]);
    mocks.judgeFindings.mockImplementationOnce((findings: Finding[]) =>
      Promise.resolve({
        accepted: [findings[1]],
        rejected: [findings[0]],
        evaluations: [],
        tokenCount: 50,
      }),
    );
    const existing: Finding = { ...(designFinding() as unknown as Finding), message: "other" };

    const result = await applyDesignPass(review([existing]), PATCHES, META, 10_000);

    const [, , , options] = mocks.judgeFindings.mock.calls[0] as [
      unknown,
      unknown,
      unknown,
      { alreadyReported: Finding[]; rubric: string },
    ];
    expect(options.alreadyReported).toEqual([existing]);
    expect(options.rubric).toContain("single reviewer that read the whole pull request");
    expect(result.findings.map((f) => f.file)).toEqual(["web/EditOrgForm.tsx", "api/repo.py"]);
    expect(result.recommendation).toBe("critical_issues");
    expect(result.designPass).toEqual({ raised: 2, published: 1, tokenCount: 150 });
  });

  it("publishes nothing when the judge call fails (it would otherwise keep everything)", async () => {
    modelReturns([designFinding()]);
    mocks.judgeFindings.mockImplementationOnce((findings: Finding[]) =>
      Promise.resolve({
        accepted: findings,
        rejected: [],
        evaluations: [],
        tokenCount: 0,
        failed: true,
      }),
    );

    const result = await applyDesignPass(review(), PATCHES, META, 10_000);

    expect(result.findings).toEqual([]);
    expect(result.recommendation).toBe("looks_good");
    expect(result.designPass?.published).toBe(0);
  });

  it("records an empty pass without calling the judge", async () => {
    modelReturns([], 70);

    const result = await applyDesignPass(review(), PATCHES, META, 10_000);

    expect(mocks.judgeFindings).not.toHaveBeenCalled();
    expect(result.designPass).toEqual({ raised: 0, published: 0, tokenCount: 70 });
  });

  it("keeps the review unchanged when the design pass throws", async () => {
    mocks.generateStructured.mockRejectedValueOnce(new Error("upstream 500"));
    const before = review([], "address_before_merge");

    expect(await applyDesignPass(before, PATCHES, META, 10_000)).toBe(before);
  });

  it("never lowers the existing recommendation", async () => {
    modelReturns([designFinding({ severity: "suggestion" })]);

    const result = await applyDesignPass(review([], "address_before_merge"), PATCHES, META, 10_000);

    expect(result.recommendation).toBe("address_before_merge");
  });
});
