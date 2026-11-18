import { describe, expect, it, vi } from "vitest";
import {
  fetchRepoConfig,
  fetchRiskPrompt,
  parseRepoConfig,
  REPO_CONFIG_FILENAME,
} from "../repo-config.js";

describe("parseRepoConfig skills section", () => {
  it("fills the defaults for an empty skills section", () => {
    expect(parseRepoConfig('{"skills": {}}')).toEqual({
      skills: { enabled: true, paths: [".rusty-bot/skills", ".skills"] },
    });
  });

  it("keeps the configured paths in order, replacing the defaults", () => {
    const config = parseRepoConfig('{"skills": {"paths": [".claude/skills", "docs/skills"]}}');
    expect(config.skills?.paths).toEqual([".claude/skills", "docs/skills"]);
  });

  it.each([
    ["an absolute path", "/etc/skills"],
    ["a windows drive path", "C:/skills"],
    ["a parent segment", "../shared/skills"],
    ["a parent segment in the middle", "docs/../../skills"],
    ["an empty string", ""],
    ["a backslash", "docs\\skills"],
  ])("rejects %s in skills.paths", (_label, path) => {
    expect(() => parseRepoConfig(JSON.stringify({ skills: { paths: [path] } }))).toThrow(
      /skills\.paths/,
    );
  });

  it("rejects an empty paths array", () => {
    expect(() => parseRepoConfig('{"skills": {"paths": []}}')).toThrow(/skills\.paths/);
  });

  it("rejects unknown keys inside skills", () => {
    expect(() => parseRepoConfig('{"skills": {"folders": [".skills"]}}')).toThrow(
      /invalid repo config/,
    );
  });
});

describe("parseRepoConfig", () => {
  it("fills the risk defaults for a minimal section", () => {
    expect(parseRepoConfig('{"risk": {}}')).toEqual({
      risk: { enabled: true, labelPrefix: "risk:", requireLabel: true },
    });
  });

  it("keeps the vocabulary and the prompt file when given", () => {
    const config = parseRepoConfig(
      JSON.stringify({
        risk: { requireLabel: false, reasons: ["authz"], promptFile: ".rusty-bot/risk.md" },
      }),
    );
    expect(config.risk).toMatchObject({
      enabled: true,
      requireLabel: false,
      reasons: ["authz"],
      promptFile: ".rusty-bot/risk.md",
    });
  });

  it("no longer accepts inline instructions", () => {
    expect(() => parseRepoConfig('{"risk": {"instructions": "x"}}')).toThrow(/invalid repo config/);
    expect(() => parseRepoConfig('{"risk": {"promptFile": ""}}')).toThrow(/promptFile/);
  });

  it("accepts an empty object as no policy at all", () => {
    expect(parseRepoConfig("{}")).toEqual({});
  });

  it("rejects unknown keys so a typo cannot silently disable a policy", () => {
    expect(() => parseRepoConfig('{"risk": {"requireLabels": false}}')).toThrow(
      /invalid repo config/,
    );
    expect(() => parseRepoConfig('{"risks": {}}')).toThrow(/invalid repo config/);
  });

  it("rejects an empty label prefix and empty reason tags", () => {
    expect(() => parseRepoConfig('{"risk": {"labelPrefix": ""}}')).toThrow(/labelPrefix/);
    expect(() => parseRepoConfig('{"risk": {"reasons": [""]}}')).toThrow(/reasons/);
  });

  it("names the file on invalid JSON", () => {
    expect(() => parseRepoConfig("{not json")).toThrow(`${REPO_CONFIG_FILENAME}: invalid JSON`);
  });
});

describe("fetchRepoConfig", () => {
  it("reads the file from the given ref", async () => {
    const getFileContent = vi.fn().mockResolvedValue('{"risk": {"enabled": false}}');
    await expect(fetchRepoConfig(getFileContent, "main")).resolves.toEqual({
      risk: { enabled: false, labelPrefix: "risk:", requireLabel: true },
    });
    expect(getFileContent).toHaveBeenCalledWith(REPO_CONFIG_FILENAME, "main");
  });

  it("returns null when the file does not exist", async () => {
    await expect(fetchRepoConfig(async () => null, "main")).resolves.toBeNull();
  });

  it("fails the run on a transport error rather than reviewing without the policy", async () => {
    await expect(
      fetchRepoConfig(async () => {
        throw new Error("503");
      }, "main"),
    ).rejects.toThrow("503");
  });

  it("throws when the file exists but is malformed", async () => {
    await expect(fetchRepoConfig(async () => '{"risk": 1}', "main")).rejects.toThrow(
      /invalid repo config/,
    );
  });
});

describe("fetchRiskPrompt", () => {
  it("reads the rubric from the given ref", async () => {
    const getFileContent = vi.fn().mockResolvedValue("# our rubric");
    await expect(fetchRiskPrompt(getFileContent, "main", ".rusty-bot/risk.md")).resolves.toBe(
      "# our rubric",
    );
    expect(getFileContent).toHaveBeenCalledWith(".rusty-bot/risk.md", "main");
  });

  it("throws when the configured file is missing or empty", async () => {
    await expect(fetchRiskPrompt(async () => null, "main", "risk.md")).rejects.toThrow(
      'risk.promptFile "risk.md" not found on main',
    );
    await expect(fetchRiskPrompt(async () => "  \n", "main", "risk.md")).rejects.toThrow(
      /not found/,
    );
  });

  it("fails the run on a transport error rather than assessing against the default rubric", async () => {
    await expect(
      fetchRiskPrompt(
        async () => {
          throw new Error("503");
        },
        "main",
        "risk.md",
      ),
    ).rejects.toThrow("503");
  });
});
