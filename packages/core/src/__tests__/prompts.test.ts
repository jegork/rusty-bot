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
