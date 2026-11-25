import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryEntry, GitProvider } from "../types.js";
import type { RepoSkill } from "../skills.js";
import { countTokens } from "../diff/compress.js";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock("../logger.js", () => ({
  logger: { ...log, child: () => log },
  flushLogger: vi.fn(),
}));

const { discoverSkills, renderSkillsListing, SKILLS_LISTING_TOKEN_BUDGET, MAX_SKILLS } =
  await import("../skills.js");

type Tree = Record<string, string>;

/** a provider backed by an in-memory file tree per ref; only what discovery needs */
function fakeProvider(trees: Record<string, Tree>, overrides: Partial<GitProvider> = {}) {
  const listDirectory = vi.fn(
    async (path: string, ref: string): Promise<DirectoryEntry[] | null> => {
      const tree = trees[ref] ?? {};
      const prefix = `${path}/`;
      const children = new Map<string, DirectoryEntry["type"]>();
      for (const file of Object.keys(tree)) {
        if (!file.startsWith(prefix)) continue;
        const [head, ...rest] = file.slice(prefix.length).split("/");
        children.set(head, rest.length > 0 ? "dir" : "file");
      }
      if (children.size === 0) return null;
      return [...children].map(([name, type]) => ({ name, type }));
    },
  );
  const getFileContent = vi.fn(
    async (path: string, ref: string): Promise<string | null> => trees[ref]?.[path] ?? null,
  );
  return {
    getDiff: vi.fn(),
    getPRMetadata: vi.fn(),
    searchCode: vi.fn(),
    postSummaryComment: vi.fn(),
    postInlineComments: vi.fn(),
    deleteExistingBotComments: vi.fn(),
    updatePRDescription: vi.fn(),
    updatePRTitle: vi.fn(),
    listDirectory,
    getFileContent,
    ...overrides,
  } as GitProvider & {
    listDirectory: typeof listDirectory;
    getFileContent: typeof getFileContent;
  };
}

function skillFile(name: string, description: string, body = "# Rules\nDo the thing.") {
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`;
}

function skillsEvent() {
  const call = log.info.mock.calls.find((c) => c[1] === "skills discovery");
  expect(call).toBeDefined();
  return call?.[0] as Record<string, unknown>;
}

const DEFAULTS = { enabled: true, paths: [".rusty-bot/skills", ".skills"] };

describe("discoverSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RUSTY_SKILLS;
  });
  afterEach(() => {
    delete process.env.RUSTY_SKILLS;
  });

  it("searches the default folders when the config has no skills section", async () => {
    const provider = fakeProvider({
      main: {
        ".rusty-bot/skills/migrations/SKILL.md": skillFile("migrations", "Use for migrations."),
        ".skills/auth/SKILL.md": skillFile("auth", "Use for auth."),
      },
    });

    const index = await discoverSkills(provider, "main", undefined);

    expect(index?.skills.map((s) => s.name)).toEqual(["migrations", "auth"]);
    expect(index?.skills[0]).toEqual({
      name: "migrations",
      description: "Use for migrations.",
      dir: ".rusty-bot/skills/migrations",
    });
    expect(provider.listDirectory.mock.calls.map((c) => c[0])).toEqual([
      ".rusty-bot/skills",
      ".skills",
    ]);
    expect(skillsEvent()).toMatchObject({
      ref: "main",
      paths: [".rusty-bot/skills", ".skills"],
      discovered: 2,
      skipped: [],
      truncated: 0,
      listing: "full",
      omittedFromListing: [],
    });
  });

  it("searches only the configured paths, which replace the defaults", async () => {
    const provider = fakeProvider({
      main: {
        ".skills/ignored/SKILL.md": skillFile("ignored", "Not searched."),
        ".claude/skills/shared/SKILL.md": skillFile("shared", "Shared with Claude Code."),
      },
    });

    const index = await discoverSkills(provider, "main", {
      enabled: true,
      paths: [".claude/skills"],
    });

    expect(index?.skills.map((s) => s.name)).toEqual(["shared"]);
    expect(provider.listDirectory.mock.calls.map((c) => c[0])).toEqual([".claude/skills"]);
  });

  it("makes no provider calls when disabled in the config", async () => {
    const provider = fakeProvider({ main: {} });

    expect(await discoverSkills(provider, "main", { ...DEFAULTS, enabled: false })).toBeNull();
    expect(provider.listDirectory).not.toHaveBeenCalled();
    expect(provider.getFileContent).not.toHaveBeenCalled();
    expect(skillsEvent()).toMatchObject({ outcome: "disabled", reason: "config" });
  });

  it("makes no provider calls when RUSTY_SKILLS=false, whatever the config says", async () => {
    process.env.RUSTY_SKILLS = "false";
    const provider = fakeProvider({ main: {} });

    expect(await discoverSkills(provider, "main", DEFAULTS)).toBeNull();
    expect(provider.listDirectory).not.toHaveBeenCalled();
    expect(skillsEvent()).toMatchObject({ outcome: "disabled", reason: "RUSTY_SKILLS=false" });
  });

  it("records the provider's reason when it cannot list folders", async () => {
    const provider = fakeProvider(
      { main: {} },
      {
        listDirectory: undefined,
        listDirectoryUnavailable: "job token cannot list folders; set RUSTY_GITLAB_TOKEN",
      },
    );

    expect(await discoverSkills(provider, "main", DEFAULTS)).toBeNull();
    expect(provider.getFileContent).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(skillsEvent()).toMatchObject({
      outcome: "unsupported",
      reason: "job token cannot list folders; set RUSTY_GITLAB_TOKEN",
    });
  });

  it("records a generic reason for a provider without listDirectory", async () => {
    const provider = fakeProvider({ main: {} }, { listDirectory: undefined });

    expect(await discoverSkills(provider, "main", DEFAULTS)).toBeNull();
    expect(skillsEvent()).toMatchObject({ outcome: "unsupported" });
  });

  it("keeps the first path's skill on a duplicate name and warns naming both locations", async () => {
    const provider = fakeProvider({
      main: {
        ".rusty-bot/skills/auth/SKILL.md": skillFile("auth", "First."),
        ".skills/auth-copy/SKILL.md": skillFile("auth", "Second."),
      },
    });

    const index = await discoverSkills(provider, "main", DEFAULTS);

    expect(index?.skills).toEqual([
      { name: "auth", description: "First.", dir: ".rusty-bot/skills/auth" },
    ]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [fields] = log.warn.mock.calls[0] as [Record<string, unknown>];
    expect(JSON.stringify(fields)).toContain(".rusty-bot/skills/auth");
    expect(JSON.stringify(fields)).toContain(".skills/auth-copy");
  });

  it.each([
    ["no frontmatter", "# Just markdown\nNo header here.\n"],
    ["invalid YAML", "---\nname: [unclosed\ndescription: x\n---\nbody\n"],
    ["frontmatter that is not a mapping", "---\n- a\n- b\n---\nbody\n"],
    ["an unterminated frontmatter block", "---\nname: x\ndescription: y\nbody\n"],
    ["a missing description", "---\nname: no-description\n---\nbody\n"],
    ["a name with uppercase", skillFile("Database-Migrations", "x")],
    ["a name with spaces", skillFile("database migrations", "x")],
    ["a name longer than 64", skillFile("a".repeat(65), "x")],
    ["a description longer than 1024", skillFile("long-description", "d".repeat(1025))],
    ["an empty body", skillFile("empty-body", "x", "  \n\n")],
  ])("skips a skill with %s, warns once, and still loads the rest", async (_label, content) => {
    const provider = fakeProvider({
      main: {
        ".skills/bad/SKILL.md": content,
        ".skills/good/SKILL.md": skillFile("good", "Fine."),
      },
    });

    const index = await discoverSkills(provider, "main", DEFAULTS);

    expect(index?.skills.map((s) => s.name)).toEqual(["good"]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ path: ".skills/bad" });
    expect(skillsEvent()).toMatchObject({
      discovered: 1,
      skipped: [{ path: ".skills/bad", reason: expect.any(String) as string }],
    });
  });

  it("skips a folder without SKILL.md and a loose file next to the skill folders", async () => {
    const provider = fakeProvider({
      main: {
        ".skills/no-skill-file/notes.md": "notes",
        ".skills/README.md": "readme",
        ".skills/good/SKILL.md": skillFile("good", "Fine."),
      },
    });

    const index = await discoverSkills(provider, "main", DEFAULTS);

    expect(index?.skills.map((s) => s.name)).toEqual(["good"]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toMatchObject({ path: ".skills/no-skill-file" });
  });

  it("only scans one level deep", async () => {
    const provider = fakeProvider({
      main: { ".skills/group/nested/SKILL.md": skillFile("nested", "Too deep.") },
    });

    expect(await discoverSkills(provider, "main", DEFAULTS)).toBeNull();
    expect(provider.getFileContent).toHaveBeenCalledWith(".skills/group/SKILL.md", "main");
    expect(provider.getFileContent).not.toHaveBeenCalledWith(
      ".skills/group/nested/SKILL.md",
      expect.anything(),
    );
  });

  it("keeps 40 of 41 valid skills and logs how many were left out", async () => {
    const tree: Tree = {};
    for (let i = 0; i < MAX_SKILLS + 1; i++) {
      const name = `skill-${String(i).padStart(2, "0")}`;
      tree[`.skills/${name}/SKILL.md`] = skillFile(name, `Use for area ${i}.`);
    }
    const provider = fakeProvider({ main: tree });

    const index = await discoverSkills(provider, "main", DEFAULTS);

    expect(index?.skills).toHaveLength(40);
    expect(index?.skills.at(-1)?.name).toBe("skill-39");
    expect(provider.getFileContent).toHaveBeenCalledTimes(40);
    expect(skillsEvent()).toMatchObject({ discovered: 40, truncated: 1 });
  });

  it("still discovers the other paths when listing one path throws", async () => {
    const provider = fakeProvider({
      main: { ".skills/good/SKILL.md": skillFile("good", "Fine.") },
    });
    const inner = provider.listDirectory.getMockImplementation();
    provider.listDirectory.mockImplementation(async (path, ref) => {
      if (path === ".rusty-bot/skills") throw new Error("HTTP 500");
      return inner?.(path, ref) ?? null;
    });

    const index = await discoverSkills(provider, "main", DEFAULTS);

    expect(index?.skills.map((s) => s.name)).toEqual(["good"]);
    expect(skillsEvent()).toMatchObject({
      skipped: [
        { path: ".rusty-bot/skills", reason: expect.stringContaining("HTTP 500") as string },
      ],
    });
  });

  it("skips a skill whose SKILL.md read throws and keeps the others", async () => {
    const provider = fakeProvider({
      main: {
        ".skills/flaky/SKILL.md": skillFile("flaky", "x"),
        ".skills/good/SKILL.md": skillFile("good", "Fine."),
      },
    });
    const inner = provider.getFileContent.getMockImplementation();
    provider.getFileContent.mockImplementation(async (path, ref) => {
      if (path.startsWith(".skills/flaky")) throw new Error("socket hang up");
      return inner?.(path, ref) ?? null;
    });

    const index = await discoverSkills(provider, "main", DEFAULTS);

    expect(index?.skills.map((s) => s.name)).toEqual(["good"]);
  });

  it("returns null without throwing when every listing throws", async () => {
    const provider = fakeProvider({ main: {} });
    provider.listDirectory.mockRejectedValue(new Error("network down"));

    await expect(discoverSkills(provider, "main", DEFAULTS)).resolves.toBeNull();
    expect(skillsEvent()).toMatchObject({ outcome: "none", discovered: 0 });
  });

  it("returns null when no folder exists, which is the existing behaviour", async () => {
    const provider = fakeProvider({ main: {} });

    expect(await discoverSkills(provider, "main", DEFAULTS)).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reads listings and files only from the ref it was given", async () => {
    const provider = fakeProvider({
      main: { ".skills/target/SKILL.md": skillFile("target", "On the target branch.") },
      "feature/x": { ".skills/rewritten/SKILL.md": skillFile("rewritten", "From the PR.") },
    });

    const index = await discoverSkills(provider, "main", DEFAULTS);

    expect(index?.ref).toBe("main");
    expect(index?.skills.map((s) => s.name)).toEqual(["target"]);
    for (const call of [
      ...provider.listDirectory.mock.calls,
      ...provider.getFileContent.mock.calls,
    ]) {
      expect(call[1]).toBe("main");
    }
  });

  it("collapses whitespace in a multi-line description so the listing stays one line per skill", async () => {
    const provider = fakeProvider({
      main: {
        ".skills/folded/SKILL.md":
          "---\nname: folded\ndescription: |\n  Line one.\n  Line two.\n---\nbody\n",
      },
    });

    const index = await discoverSkills(provider, "main", DEFAULTS);

    expect(index?.skills[0]?.description).toBe("Line one. Line two.");
  });
});

function skill(i: number, description: string): RepoSkill {
  return { name: `skill-${String(i).padStart(2, "0")}`, description, dir: `.skills/s${i}` };
}

const SENTENCE =
  "Rules for SQL migrations covering reversibility, table locking, backfills and index creation. ";

function prose(length: number): string {
  return SENTENCE.repeat(Math.ceil(length / SENTENCE.length))
    .slice(0, length)
    .trim();
}

function descriptionLines(text: string): string[] {
  return text
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(l.indexOf(" — ") + 3));
}

describe("renderSkillsListing", () => {
  it("renders a small set in full with the heading and the instruction", () => {
    const result = renderSkillsListing([
      skill(1, "Use for migrations."),
      skill(2, "Use for auth."),
    ]);

    expect(result.listing).toBe("full");
    expect(result.omittedFromListing).toEqual([]);
    expect(result.text).toContain("Available repository skills");
    expect(result.text).toContain(
      "When the diff touches an area a skill covers, call loadSkill before reporting findings there.",
    );
    expect(result.text).toContain("- skill-01 — Use for migrations.");
    expect(result.listingTokens).toBe(countTokens(result.text));
  });

  it("shortens every description when the full set is just over budget", () => {
    // 12 x 1024 characters is just over 3000 counted tokens
    const skills = Array.from({ length: 12 }, (_, i) => skill(i, prose(1024)));
    const full = renderSkillsListing(skills, Infinity);
    expect(full.listingTokens).toBeGreaterThan(SKILLS_LISTING_TOKEN_BUDGET);

    const result = renderSkillsListing(skills);

    expect(result.listing).toBe("shortened");
    expect(result.omittedFromListing).toEqual([]);
    expect(result.listingTokens).toBeLessThanOrEqual(SKILLS_LISTING_TOKEN_BUDGET);
    for (const line of descriptionLines(result.text)) {
      expect(line).toBe(SENTENCE.trim());
    }
  });

  it("cuts a long first sentence to 200 characters at a word boundary with an ellipsis", () => {
    const words = "migrations ".repeat(200).trim();
    const skills = Array.from({ length: 12 }, (_, i) => skill(i, words.slice(0, 1024)));

    const result = renderSkillsListing(skills);

    expect(result.listing).toBe("shortened");
    for (const line of descriptionLines(result.text)) {
      expect(line.length).toBeLessThanOrEqual(200);
      expect(line.endsWith("migrations…")).toBe(true);
    }
  });

  it("cuts a single 1024-character word to 200 characters", () => {
    const skills = Array.from({ length: 12 }, (_, i) => skill(i, "x".repeat(1024)));

    const result = renderSkillsListing(skills);

    for (const line of descriptionLines(result.text)) {
      expect(line.length).toBe(200);
      expect(line.endsWith("…")).toBe(true);
    }
  });

  function maxSkills() {
    return Array.from({ length: 40 }, (_, i) => ({
      ...skill(i, "x".repeat(1024)),
      name: `${"area".padEnd(61, "-")}-${String(i).padStart(2, "0")}`,
    }));
  }

  it("fits 40 skills at the maximum name and description length within budget", () => {
    const skills = maxSkills();
    expect(skills[0]?.name).toHaveLength(64);

    const result = renderSkillsListing(skills);

    // the shortened form caps each line at ~270 characters, so the cap of 40
    // skills cannot reach truncation under the default budget
    expect(result.listing).toBe("shortened");
    expect(result.listingTokens).toBeLessThanOrEqual(SKILLS_LISTING_TOKEN_BUDGET);
    expect(result.omittedFromListing).toEqual([]);
  });

  it("truncates in discovery order when even the shortened set is over budget", () => {
    const skills = maxSkills();
    const budget = 1500;

    const result = renderSkillsListing(skills, budget);

    expect(result.listing).toBe("truncated");
    expect(result.listingTokens).toBeLessThanOrEqual(budget);
    expect(result.listingTokens).toBe(countTokens(result.text));
    const listed = result.text
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2, l.indexOf(" — ")));
    expect(listed.length).toBeGreaterThan(0);
    expect(listed).toEqual(skills.slice(0, listed.length).map((s) => s.name));
    expect(result.omittedFromListing).toEqual(skills.slice(listed.length).map((s) => s.name));
    // one more line would have overflowed
    const nextLine = `- ${skills[listed.length]?.name} — ${"x".repeat(199)}…`;
    expect(countTokens(`${result.text}\n${nextLine}`)).toBeGreaterThan(budget);
  });

  it("lists 15 skills with 300-character descriptions in full", () => {
    const skills = Array.from({ length: 15 }, (_, i) => skill(i, prose(300)));

    const result = renderSkillsListing(skills);

    expect(result.listing).toBe("full");
    expect(result.listingTokens).toBeLessThanOrEqual(SKILLS_LISTING_TOKEN_BUDGET);
  });

  it("inserts descriptions with backticks and template braces literally", () => {
    const result = renderSkillsListing([skill(1, "Use `{{diff}}` and $& as-is.")]);

    expect(result.text).toContain("- skill-01 — Use `{{diff}}` and $& as-is.");
  });
});
