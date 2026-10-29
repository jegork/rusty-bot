import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOctokitIssueFetcher } from "../issue-fetcher.js";
import type { Octokit } from "octokit";
import { logger } from "@rusty-bot/core";

function createMockOctokit() {
  return {
    request: vi.fn(),
    graphql: vi.fn(),
  } as unknown as Octokit & {
    request: ReturnType<typeof vi.fn>;
  };
}

describe("createOctokitIssueFetcher", () => {
  let octokit: ReturnType<typeof createMockOctokit>;
  let fetcher: ReturnType<typeof createOctokitIssueFetcher>;

  beforeEach(() => {
    octokit = createMockOctokit();
    fetcher = createOctokitIssueFetcher(octokit);
  });

  it("returns issue data on success", async () => {
    const issueData = { number: 42, title: "test", body: "desc", labels: [] };
    octokit.request.mockResolvedValueOnce({ data: issueData });

    const result = await fetcher("acme", "widgets", 42);
    expect(result).toEqual(issueData);
    expect(octokit.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      { owner: "acme", repo: "widgets", issue_number: 42 },
    );
  });

  it("returns null silently on 404", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(vi.fn());
    octokit.request.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));

    const result = await fetcher("o", "r", 999);
    expect(result).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null and logs warning on 403", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(vi.fn());
    octokit.request.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));

    const result = await fetcher("o", "r", 1);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", issueNumber: 1 }),
      "installation token issue fetch failed",
    );
    warn.mockRestore();
  });

  it("returns null and logs warning on 401", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(vi.fn());
    octokit.request.mockRejectedValueOnce(
      Object.assign(new Error("Unauthorized"), { status: 401 }),
    );

    const result = await fetcher("o", "r", 5);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "o", repo: "r", issueNumber: 5 }),
      "installation token issue fetch failed",
    );
    warn.mockRestore();
  });

  it("returns null and logs warning on rate limit (429)", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(vi.fn());
    octokit.request.mockRejectedValueOnce(
      Object.assign(new Error("rate limit exceeded"), { status: 429 }),
    );

    const result = await fetcher("o", "r", 10);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns null and logs warning on errors without status", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(vi.fn());
    octokit.request.mockRejectedValueOnce(new Error("network failure"));

    const result = await fetcher("o", "r", 1);
    expect(result).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
