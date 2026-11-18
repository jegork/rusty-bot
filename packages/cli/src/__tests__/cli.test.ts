import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as RustyBotCore from "@rusty-bot/core";
import type { FilePatch } from "@rusty-bot/core";
import { runTriagedReview } from "@rusty-bot/core";
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
// files and folders on the base ref; the head ref has none, so a read from it shows up as missing
const baseTree = vi.hoisted(() => {
  const files: Record<string, string> = {};
  const dirs: Record<string, string[]> = {};
  return { files, dirs };
});

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
      getFileContent: vi.fn(async (path: string, ref: string) =>
        ref === "base" ? (baseTree.files[path] ?? null) : null,
      ),
      listDirectory: vi.fn(async (path: string, ref: string) =>
        ref === "base" && baseTree.dirs[path]
          ? baseTree.dirs[path].map((name) => ({ name, type: "dir" }))
          : null,
      ),
      checkout: vi.fn().mockResolvedValue(fakeCheckout),
    };
  }),
}));

vi.mock("@rusty-bot/core", async (importOriginal) => {
  const actual = await importOriginal<typeof RustyBotCore>();
  return {
    ...actual,
    fetchConventionFile: vi.fn().mockResolvedValue(null),
    loadMcpServerConfigsFromEnv: vi.fn().mockResolvedValue([]),
    runTriagedReview: vi.fn().mockResolvedValue({
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
    vi.clearAllMocks();
    baseTree.files = {};
    baseTree.dirs = {};
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  it("sends a deletion-only file to review instead of dropping it", async () => {
    const code = await run(args);

    expect(code).toBe(0);
    const reviewed = vi.mocked(runTriagedReview).mock.calls[0]?.[0].patches;
    expect(reviewed?.map((p) => p.path)).toEqual(["src/auth/check.ts"]);
    expect(reviewed?.[0].deletions).toBe(2);
  });

  it("passes the provider's checkout into the review options", async () => {
    await run(args);

    expect(vi.mocked(runTriagedReview).mock.calls[0]?.[0].options.checkout).toBe(fakeCheckout);
  });

  it("passes skills from the base ref, in the folders .rusty-bot.json names, into the review", async () => {
    baseTree.files = {
      ".rusty-bot.json": JSON.stringify({ skills: { paths: ["docs/skills"] } }),
      "docs/skills/migrations/SKILL.md":
        "---\nname: migrations\ndescription: Use for migrations.\n---\nRules.\n",
    };
    baseTree.dirs = { "docs/skills": ["migrations"] };

    await run(args);

    const options = vi.mocked(runTriagedReview).mock.calls[0]?.[0].options;
    expect(options?.skills?.ref).toBe("base");
    expect(options?.skills?.skills.map((s) => s.name)).toEqual(["migrations"]);
  });

  it("passes no skills when the base ref has none", async () => {
    await run(args);

    expect(vi.mocked(runTriagedReview).mock.calls[0]?.[0].options).not.toHaveProperty("skills");
  });

  it("fails the run on a malformed .rusty-bot.json, naming the file", async () => {
    baseTree.files = { ".rusty-bot.json": '{"skills": {"folders": []}}' };

    await expect(run(args)).rejects.toThrow(/\.rusty-bot\.json/);
    expect(runTriagedReview).not.toHaveBeenCalled();
  });
});
