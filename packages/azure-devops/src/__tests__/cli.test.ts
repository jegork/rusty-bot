import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PRMetadata } from "@rusty-bot/core";
import { AzureDevOpsProvider } from "../provider.js";
import { buildPlatform, parseConfig } from "../cli.js";

vi.mock("../provider.js", () => ({ AzureDevOpsProvider: vi.fn() }));

const METADATA = {} as PRMetadata;

function useProvider(methods: Record<string, unknown> = {}) {
  vi.mocked(AzureDevOpsProvider).mockImplementation(function (this: AzureDevOpsProvider) {
    return Object.assign(this, methods) as unknown as AzureDevOpsProvider;
  });
}

describe("buildPlatform", () => {
  beforeEach(() => {
    vi.stubEnv("SYSTEM_PULLREQUEST_PULLREQUESTID", "7");
    vi.stubEnv("SYSTEM_TEAMFOUNDATIONCOLLECTIONURI", "https://dev.azure.com/acme/");
    vi.stubEnv("SYSTEM_TEAMPROJECT", "proj");
    vi.stubEnv("BUILD_REPOSITORY_NAME", "repo");
    vi.stubEnv("SYSTEM_ACCESSTOKEN", "ado-token");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  const platform = () => buildPlatform(parseConfig());

  it("uses BUILD_SOURCESDIRECTORY, and System.AccessToken as a bearer header, for the checkout", () => {
    useProvider();
    vi.stubEnv("BUILD_SOURCESDIRECTORY", "/__w/1/s");

    expect(platform().workspacePath).toBe("/__w/1/s");
    expect(platform().fetchAuthHeader).toBe("bearer ado-token");
  });

  it("has no workspace when BUILD_SOURCESDIRECTORY is unset", () => {
    useProvider();
    vi.stubEnv("BUILD_SOURCESDIRECTORY", undefined);

    expect(platform().workspacePath).toBeUndefined();
  });

  it("reads the title and description switches and allows the larger diff budget", () => {
    useProvider();
    vi.stubEnv("RUSTY_RENAME_TITLE_TO_CONVENTIONAL", "true");
    vi.stubEnv("RUSTY_GENERATE_DESCRIPTION", "1");

    expect(platform()).toMatchObject({
      label: "PR",
      renameTitleToConventional: true,
      generateDescription: false,
      maxTokens: 120_000,
      ticketSource: "azure-devops",
    });
  });

  it("only offers the work item provider when a ref needs it", () => {
    useProvider();

    expect(platform().buildTicketProviders([]).size).toBe(0);
    expect([
      ...platform()
        .buildTicketProviders([{ id: "1", source: "azure-devops" }])
        .keys(),
    ]).toEqual(["azure-devops"]);
  });

  describe("iteration tracking", () => {
    it("reads the last reviewed and latest iterations", async () => {
      useProvider({
        getLastReviewedIteration: vi.fn().mockResolvedValue("6"),
        getLatestIterationId: vi.fn().mockResolvedValue("7"),
      });

      await expect(platform().incremental.readState(METADATA, true)).resolves.toEqual({
        lastReviewed: "6",
        current: "7",
      });
    });

    it("falls back to a full review, with no marker, when reading iterations throws", async () => {
      useProvider({
        getLastReviewedIteration: vi.fn().mockRejectedValue(new Error("api down")),
        getLatestIterationId: vi.fn().mockResolvedValue("7"),
      });

      await expect(platform().incremental.readState(METADATA, true)).resolves.toEqual({
        lastReviewed: null,
        current: null,
      });
    });

    it("still reads the latest iteration when incremental review is off, so a marker is embedded", async () => {
      const getLastReviewedIteration = vi.fn();
      useProvider({
        getLastReviewedIteration,
        getLatestIterationId: vi.fn().mockResolvedValue("7"),
      });

      await expect(platform().incremental.readState(METADATA, false)).resolves.toEqual({
        lastReviewed: null,
        current: "7",
      });
      expect(getLastReviewedIteration).not.toHaveBeenCalled();
    });

    it("embeds no marker when the latest iteration cannot be read and incremental is off", async () => {
      useProvider({ getLatestIterationId: vi.fn().mockRejectedValue(new Error("api down")) });

      await expect(platform().incremental.readState(METADATA, false)).resolves.toEqual({
        lastReviewed: null,
        current: null,
      });
    });

    it("diffs by iteration and marks the iteration as reviewed", async () => {
      const getDiffSinceIteration = vi.fn().mockResolvedValue([]);
      useProvider({ getDiffSinceIteration });
      const { incremental } = platform();

      await incremental.getDiffSince("6", null);

      expect(getDiffSinceIteration).toHaveBeenCalledWith("6");
      expect(incremental.marker("7")).toEqual({ lastReviewedIteration: "7" });
    });
  });
});

describe("risk policy env fallback", () => {
  beforeEach(() => {
    vi.stubEnv("SYSTEM_PULLREQUEST_PULLREQUESTID", "7");
    vi.stubEnv("SYSTEM_TEAMFOUNDATIONCOLLECTIONURI", "https://dev.azure.com/acme/");
    vi.stubEnv("SYSTEM_TEAMPROJECT", "proj");
    vi.stubEnv("BUILD_REPOSITORY_NAME", "repo");
    vi.stubEnv("SYSTEM_ACCESSTOKEN", "ado-token");
    useProvider();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("is off by default with the standard prefix and enforcement on", () => {
    expect(buildPlatform(parseConfig()).riskPolicy).toEqual({
      enabled: false,
      labelPrefix: "risk:",
      requireLabel: true,
    });
  });

  it("reads the three env switches", () => {
    vi.stubEnv("RUSTY_RISK_ASSESSMENT", "true");
    vi.stubEnv("RUSTY_RISK_LABEL_PREFIX", "Risk/");
    vi.stubEnv("RUSTY_RISK_REQUIRE_LABEL", "false");
    expect(buildPlatform(parseConfig()).riskPolicy).toEqual({
      enabled: true,
      labelPrefix: "Risk/",
      requireLabel: false,
    });
  });
});
