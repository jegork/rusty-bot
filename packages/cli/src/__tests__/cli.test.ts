import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as RustyBotCore from "@rusty-bot/core";
import type { FilePatch } from "@rusty-bot/core";
import { runMultiCallReview } from "@rusty-bot/core";
import { run } from "../cli.js";
import type { CliArgs } from "../args.js";

const deletionOnly: FilePatch = {
  path: "src/auth/check.ts",
  additions: 0,
  deletions: 2,
  isBinary: false,
  hunks: [
    {
      oldStart: 10,
      oldLines: 4,
      newStart: 10,
      newLines: 2,
      content:
        " function handler() {\n-  if (!user.isAdmin) throw new Error('forbidden');\n-  audit(user);\n   return ok();",
    },
  ],
};

const fakeCheckout = vi.hoisted(() => ({ tree: "abc", approximate: false }));

vi.mock("../local-provider.js", () => ({
  LocalGitProvider: vi.fn(function () {
    return {
      getPRMetadata: vi.fn().mockResolvedValue({
        title: "t",
        description: "",
        author: "a",
        sourceBranch: "head",
        targetBranch: "base",
        headSha: "abc",
      }),
      getDiff: vi.fn().mockResolvedValue([deletionOnly]),
      getFileContent: vi.fn().mockResolvedValue(null),
      checkout: vi.fn().mockResolvedValue(fakeCheckout),
    };
  }),
}));

vi.mock("@rusty-bot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof RustyBotCore>();
  return {
    ...actual,
    isCascadeEnabled: vi.fn(() => false),
    fetchConventionFile: vi.fn().mockResolvedValue(null),
    loadMcpServerConfigsFromEnv: vi.fn().mockResolvedValue([]),
    runMultiCallReview: vi.fn().mockResolvedValue({
      summary: "ok",
      findings: [],
      recommendation: "approve",
    }),
  };
});

const args: CliArgs = {
  repoPath: ".",
  baseRef: "base",
  headRef: "head",
  style: "balanced",
  focusAreas: ["bugs"],
  ignorePatterns: [],
  format: "json",
  failOnCritical: false,
  flagScopeCreep: false,
  help: false,
};

describe("run", () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("sends a deletion-only file to review instead of dropping it", async () => {
    const code = await run(args);

    expect(code).toBe(0);
    const reviewed = vi.mocked(runMultiCallReview).mock.calls[0]?.[0];
    expect(reviewed?.map((p) => p.path)).toEqual(["src/auth/check.ts"]);
    expect(reviewed?.[0].deletions).toBe(2);
  });

  it("passes the provider's checkout into the review options", async () => {
    await run(args);

    expect(vi.mocked(runMultiCallReview).mock.calls[0]?.[4]?.checkout).toBe(fakeCheckout);
  });
});
