import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildUserMessage } from "../agent/prompts.js";
import type { PRMetadata, ReviewConfig } from "../types.js";

const config: ReviewConfig = {
  style: "balanced",
  focusAreas: [],
  ignorePatterns: [],
};

const metadata: PRMetadata = {
  id: "1",
  title: "t",
  description: "",
  author: "a",
  sourceBranch: "feature",
  targetBranch: "main",
  url: "https://example.com/pr/1",
};

const TOOL_NOTE = "searchCode results for those files may reflect pre-merge content";
const STALE_NOTE = "may be stale (pre-merge content)";

function userMessage(searchScope?: "pr-head" | "remote") {
  return buildUserMessage(
    "diff",
    metadata,
    undefined,
    undefined,
    ["src/other.ts"],
    undefined,
    undefined,
    undefined,
    undefined,
    searchScope,
  );
}

describe("search scope in prompts", () => {
  it("keeps the pre-merge notes when the scope is omitted", () => {
    expect(buildSystemPrompt(config, "deep-review")).toContain(TOOL_NOTE);
    expect(userMessage()).toContain(STALE_NOTE);
  });

  it("keeps the pre-merge notes for a remote search", () => {
    expect(buildSystemPrompt(config, "deep-review", "remote")).toContain(TOOL_NOTE);
    expect(userMessage("remote")).toContain(STALE_NOTE);
  });

  it("drops the pre-merge notes when search runs on the PR head", () => {
    const system = buildSystemPrompt(config, "deep-review", "pr-head");
    const user = userMessage("pr-head");

    expect(system).not.toContain(TOOL_NOTE);
    expect(system).not.toContain("{{other_files_tool_note}}");
    expect(user).not.toContain(STALE_NOTE);
    expect(user).toContain("src/other.ts");
  });

  it("never mentions searchCode on the skim tier, whatever the scope", () => {
    expect(buildSystemPrompt(config, "skim", "remote")).not.toContain(TOOL_NOTE);
    expect(buildSystemPrompt(config, "skim", "pr-head")).not.toContain(TOOL_NOTE);
  });
});

describe("CodeGraph tools in the system prompt", () => {
  const PREFER = "Prefer findSymbol / exploreCode over repeated searchCode calls";

  it("advertises them only when they are registered", () => {
    const withTools = buildSystemPrompt(config, "deep-review", "pr-head", true);

    expect(withTools).toContain("**findSymbol**");
    expect(withTools).toContain("**exploreCode**");
    expect(withTools).toContain(PREFER);
  });

  it("stays silent about them by default", () => {
    for (const prompt of [
      buildSystemPrompt(config, "deep-review"),
      buildSystemPrompt(config, "deep-review", "pr-head"),
      buildSystemPrompt(config, "deep-review", "pr-head", false),
    ]) {
      expect(prompt).not.toContain("findSymbol");
      expect(prompt).not.toContain("exploreCode");
    }
  });

  it("never offers them to the skim tier, even if asked to", () => {
    const skim = buildSystemPrompt(config, "skim", "pr-head", true);

    expect(skim).not.toContain("findSymbol");
    expect(skim).not.toContain("exploreCode");
    expect(skim).toContain("You have NO tools");
  });
});

describe("risk assessment in the system prompt", () => {
  it("asks for the riskAssessment object only when enabled, and only on the deep tier", () => {
    const on = { ...config, assessRisk: true };
    expect(buildSystemPrompt(on, "deep-review")).toContain("A riskAssessment object");
    expect(buildSystemPrompt(on, "deep-review")).toContain("Risk assessment is enabled.");
    expect(buildSystemPrompt(on, "skim")).not.toContain("riskAssessment");
    expect(buildSystemPrompt(config, "deep-review")).not.toContain("riskAssessment");
    expect(buildSystemPrompt(config, "deep-review")).not.toContain(
      "{{risk_assessment_instructions}}",
    );
  });

  it("keeps the scope creep requirement when both optional sections are on", () => {
    const prompt = buildSystemPrompt(
      { ...config, assessRisk: true, flagScopeCreep: true },
      "deep-review",
    );
    expect(prompt).toContain("A scopeCreep list");
    expect(prompt).toContain("A riskAssessment object");
  });
});

describe("repository risk rubric in the system prompt", () => {
  it("replaces the default prose with the repo rubric and always appends the answer contract", () => {
    const on = {
      ...config,
      assessRisk: true,
      riskReasons: ["authz", "financial-figures"],
      riskPrompt: "OUR RUBRIC: one prod org, scope counts customers",
    };
    const prompt = buildSystemPrompt(on, "deep-review");
    expect(prompt).toContain("OUR RUBRIC: one prod org, scope counts customers");
    expect(prompt).not.toContain("Risk assessment is enabled.");
    expect(prompt).toContain('"one_user" (one user or one screen)');
    expect(prompt).toContain("do not let it affect the merge recommendation");
    expect(prompt).toContain('Use only these reason tags: "authz", "financial-figures".');
    expect(prompt.indexOf("OUR RUBRIC")).toBeLessThan(prompt.indexOf('"one_user"'));

    const off = buildSystemPrompt({ ...on, assessRisk: false }, "deep-review");
    expect(off).not.toContain("OUR RUBRIC");
    expect(off).not.toContain("Use only these reason tags");
  });

  it("uses the default prose with the same contract when the repo supplies none", () => {
    const prompt = buildSystemPrompt(
      { ...config, assessRisk: true, riskPrompt: "  " },
      "deep-review",
    );
    expect(prompt).toContain("Risk assessment is enabled.");
    expect(prompt).toContain('"one_user" (one user or one screen)');
    expect(prompt).not.toContain("Use only these reason tags");
  });
});
