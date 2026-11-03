import { afterEach, describe, expect, it, vi } from "vitest";
import type { TicketRef } from "@rusty-bot/core";
import { buildPlatform, remapBareRefsToGitLab, type GitLabCliConfig } from "../cli.js";

const makeConfig = (): GitLabCliConfig => ({
  provider: { getLinkedIssueIids: vi.fn().mockResolvedValue(["3"]) } as never,
  review: { style: "balanced", focusAreas: [], ignorePatterns: [] },
  failOnCritical: true,
  incrementalReview: true,
  apiBaseUrl: "https://gitlab.test/api/v4",
  token: "t",
  isJobToken: false,
  projectPath: "group/proj",
});

describe("buildPlatform", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses CI_PROJECT_DIR, and the job token as a basic auth header, for the checkout", () => {
    vi.stubEnv("CI_PROJECT_DIR", "/builds/group/proj");
    vi.stubEnv("CI_JOB_TOKEN", "job-token");

    const platform = buildPlatform(makeConfig());

    expect(platform.workspacePath).toBe("/builds/group/proj");
    const encoded = platform.fetchAuthHeader?.replace(/^basic /, "");
    expect(Buffer.from(encoded ?? "", "base64").toString()).toBe("gitlab-ci-token:job-token");
  });

  it("sends no auth header without a job token", () => {
    vi.stubEnv("CI_JOB_TOKEN", undefined);

    expect(buildPlatform(makeConfig()).fetchAuthHeader).toBeUndefined();
  });

  it("calls changes MRs and resolves linked issues as gitlab tickets", async () => {
    const platform = buildPlatform(makeConfig());

    expect(platform).toMatchObject({ label: "MR", ticketSource: "gitlab", maxTokens: 120_000 });
    await expect(platform.getLinkedTicketIds()).resolves.toEqual(["3"]);
  });
});

describe("remapBareRefsToGitLab", () => {
  it("claims bare numeric refs but leaves cross-repo and other sources alone", () => {
    const refs: TicketRef[] = [
      { id: "12", source: "github" },
      { id: "acme/repo#3", source: "github" },
      { id: "ABC-1", source: "jira" },
    ];

    expect(remapBareRefsToGitLab(refs).map((r) => r.source)).toEqual(["gitlab", "github", "jira"]);
  });
});
