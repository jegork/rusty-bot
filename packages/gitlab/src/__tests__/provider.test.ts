import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GitLabProvider } from "../provider.js";
import type { Finding } from "@rusty-bot/core";

const API_BASE = "https://gitlab.example.com/api/v4";
const PROJECT = "group/sub/project";
const MR_IID = 42;
const TOKEN = "test-token";

const PROJECT_ENC = encodeURIComponent(PROJECT);
const MR_BASE = `${API_BASE}/projects/${PROJECT_ENC}/merge_requests/${MR_IID}`;

function createProvider(): GitLabProvider {
  return new GitLabProvider({
    apiBaseUrl: API_BASE,
    projectId: PROJECT,
    mergeRequestIid: MR_IID,
    token: TOKEN,
  });
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
  } as Response;
}

function textResponse(body: string, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    statusText: ok ? "OK" : "Not Found",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(body),
    headers: new Headers(),
  } as Response;
}

describe("GitLabProvider", () => {
  let provider: GitLabProvider;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    provider = createProvider();
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getPRMetadata", () => {
    it("maps the GitLab MR payload to PRMetadata", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          iid: 42,
          title: "feat: add widget",
          description: "adds a widget",
          source_branch: "feature/widget",
          target_branch: "main",
          sha: "abc123def456",
          web_url: "https://gitlab.example.com/group/sub/project/-/merge_requests/42",
          author: { username: "alice", name: "Alice" },
          diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" },
        }),
      );

      const md = await provider.getPRMetadata();
      expect(md).toEqual({
        id: "42",
        title: "feat: add widget",
        description: "adds a widget",
        author: "alice",
        sourceBranch: "feature/widget",
        targetBranch: "main",
        url: "https://gitlab.example.com/group/sub/project/-/merge_requests/42",
        headSha: "abc123def456",
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        MR_BASE,
        expect.objectContaining({
          headers: expect.objectContaining({ "PRIVATE-TOKEN": TOKEN }),
        }),
      );
    });

    it("uses JOB-TOKEN header when isJobToken is set", async () => {
      const jobProvider = new GitLabProvider({
        apiBaseUrl: API_BASE,
        projectId: PROJECT,
        mergeRequestIid: MR_IID,
        token: "job-tok",
        isJobToken: true,
      });
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          iid: 1,
          title: "t",
          description: null,
          source_branch: "s",
          target_branch: "t",
        }),
      );
      await jobProvider.getPRMetadata();
      const call = fetchSpy.mock.calls[0]?.[1] as { headers: Record<string, string> };
      expect(call.headers).toMatchObject({ "JOB-TOKEN": "job-tok" });
      expect(call.headers).not.toHaveProperty("PRIVATE-TOKEN");
    });
  });

  describe("getDiff", () => {
    it("parses paginated /diffs response into FilePatch[] with hunk content", async () => {
      // page 1 with 2 entries (less than per_page → no follow-up page expected)
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([
          {
            old_path: "src/a.ts",
            new_path: "src/a.ts",
            diff: "@@ -1,2 +1,3 @@\n line1\n+added\n line2\n",
          },
          {
            old_path: "src/gone.ts",
            new_path: "src/gone.ts",
            deleted_file: true,
            diff: "",
          },
        ]),
      );
      // diff_refs lookup (ensureDiffRefs) — single MR endpoint
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          iid: 42,
          title: "t",
          description: null,
          source_branch: "s",
          target_branch: "main",
          diff_refs: { base_sha: "b", start_sha: "s", head_sha: "h" },
        }),
      );

      const patches = await provider.getDiff();
      expect(patches).toHaveLength(1);
      expect(patches[0]).toMatchObject({
        path: "src/a.ts",
        additions: 1,
        deletions: 0,
        isBinary: false,
      });
      expect(patches[0].hunks[0].newStart).toBe(1);
      expect(patches[0].hunks[0].newLines).toBe(3);

      const firstUrl = fetchSpy.mock.calls[0]?.[0] as string;
      expect(firstUrl).toBe(`${MR_BASE}/diffs?per_page=50&page=1&unidiff=true`);
    });

    it("loops pagination until a short page is returned", async () => {
      // page 1: full page (per_page=50) → keep going
      const page1 = Array.from({ length: 50 }, (_, i) => ({
        old_path: `src/f${i}.ts`,
        new_path: `src/f${i}.ts`,
        diff: `@@ -1 +1,2 @@\n line\n+added${i}\n`,
      }));
      fetchSpy.mockResolvedValueOnce(jsonResponse(page1));
      // page 2: short page → stop after this
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([
          {
            old_path: "src/last.ts",
            new_path: "src/last.ts",
            diff: "@@ -1 +1,2 @@\n x\n+y\n",
          },
        ]),
      );
      // ensureDiffRefs
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          iid: 42,
          title: "t",
          description: null,
          source_branch: "s",
          target_branch: "main",
        }),
      );

      const patches = await provider.getDiff();
      expect(patches).toHaveLength(51);
      const page2Url = fetchSpy.mock.calls[1]?.[0] as string;
      expect(page2Url).toBe(`${MR_BASE}/diffs?per_page=50&page=2&unidiff=true`);
    });

    it("flags binary files instead of trying to parse the diff", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([
          {
            old_path: "image.png",
            new_path: "image.png",
            diff: "Binary files a/image.png and b/image.png differ\n",
          },
        ]),
      );
      // ensureDiffRefs
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          iid: 42,
          title: "t",
          description: null,
          source_branch: "s",
          target_branch: "main",
        }),
      );
      const patches = await provider.getDiff();
      expect(patches[0]).toMatchObject({ path: "image.png", isBinary: true, hunks: [] });
    });
  });

  describe("getDiffSinceSha", () => {
    it("calls /repository/compare with unidiff=true and parses .diffs[]", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          diffs: [
            {
              old_path: "src/a.ts",
              new_path: "src/a.ts",
              diff: "@@ -1 +1,2 @@\n line\n+added\n",
            },
            {
              old_path: "src/removed.ts",
              new_path: "src/removed.ts",
              deleted_file: true,
              diff: "",
            },
          ],
        }),
      );

      const patches = await provider.getDiffSinceSha("aaa1111", "bbb2222");
      expect(patches).not.toBeNull();
      expect(patches).toHaveLength(1);
      expect(patches?.[0].path).toBe("src/a.ts");
      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain("/repository/compare?from=aaa1111&to=bbb2222&unidiff=true");
    });

    it("returns [] when from === to without making a request", async () => {
      const patches = await provider.getDiffSinceSha("same", "same");
      expect(patches).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe("getLastReviewedSha", () => {
    it("walks notes newest-first and returns the embedded sha", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([
          {
            id: 3,
            body: "<!-- rusty-bot-review -->\n<!-- rusty-bot:last-sha:fee1baadf00d1234567890abcdef1234567890ab -->\nsummary",
          },
          {
            id: 2,
            body: "<!-- rusty-bot-review -->\n<!-- rusty-bot:last-sha:0123456789abcdef0123456789abcdef01234567 -->\nold summary",
          },
          { id: 1, body: "human comment", system: false },
        ]),
      );

      const sha = await provider.getLastReviewedSha();
      expect(sha).toBe("fee1baadf00d1234567890abcdef1234567890ab");
    });

    it("ignores system notes and returns null when none have a marker", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([
          { id: 1, body: "<!-- rusty-bot-review -->\nno sha here" },
          { id: 2, system: true, body: "<!-- rusty-bot:last-sha:abc1234 -->" },
        ]),
      );
      const sha = await provider.getLastReviewedSha();
      expect(sha).toBeNull();
    });
  });

  describe("postSummaryComment", () => {
    it("posts a note with the bot marker and last-sha marker", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 99 }));
      await provider.postSummaryComment("hello", { lastReviewedSha: "abc1234" });

      const url = fetchSpy.mock.calls[0]?.[0] as string;
      const init = fetchSpy.mock.calls[0]?.[1] as { method: string; body: string };
      expect(url).toBe(`${MR_BASE}/notes`);
      expect(init.method).toBe("POST");
      const body = JSON.parse(init.body) as { body: string };
      expect(body.body).toContain("<!-- rusty-bot-review -->");
      expect(body.body).toContain("<!-- rusty-bot:last-sha:abc1234 -->");
      expect(body.body).toContain("hello");
    });
  });

  describe("postInlineComments", () => {
    it("posts a discussion with diff position when refs are cached", async () => {
      // first call: getPRMetadata to populate diff_refs
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          iid: 42,
          title: "t",
          description: null,
          source_branch: "s",
          target_branch: "main",
          diff_refs: { base_sha: "B", start_sha: "S", head_sha: "H" },
        }),
      );
      await provider.getPRMetadata();

      fetchSpy.mockResolvedValueOnce(jsonResponse({ id: "discussion-1" }));

      const finding: Finding = {
        file: "src/a.ts",
        line: 5,
        endLine: null,
        severity: "warning",
        category: "bugs",
        message: "be careful",
        suggestedFix: null,
      };
      await provider.postInlineComments([finding]);

      const lastCall = fetchSpy.mock.calls[1];
      expect(lastCall?.[0]).toBe(`${MR_BASE}/discussions`);
      const body = JSON.parse((lastCall?.[1] as { body: string }).body) as {
        body: string;
        position: Record<string, unknown>;
      };
      expect(body.position).toMatchObject({
        position_type: "text",
        base_sha: "B",
        start_sha: "S",
        head_sha: "H",
        new_path: "src/a.ts",
        new_line: 5,
      });
      expect(body.body).toContain("<!-- rusty-bot-review -->");
    });

    it("falls back to a top-level note when diff_refs are unavailable", async () => {
      // metadata fetch (called by ensureDiffRefs) — no diff_refs
      fetchSpy.mockResolvedValueOnce(
        jsonResponse({
          iid: 42,
          title: "t",
          description: null,
          source_branch: "s",
          target_branch: "main",
        }),
      );
      // fallback note POST
      fetchSpy.mockResolvedValueOnce(jsonResponse({ id: 1 }));

      const finding: Finding = {
        file: "src/a.ts",
        line: 5,
        endLine: null,
        severity: "warning",
        category: "bugs",
        message: "be careful",
        suggestedFix: null,
      };
      await provider.postInlineComments([finding]);

      const lastUrl = fetchSpy.mock.calls.at(-1)?.[0] as string;
      expect(lastUrl).toBe(`${MR_BASE}/notes`);
    });
  });

  describe("deleteExistingBotComments", () => {
    it("deletes bot-authored notes from each discussion", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([
          {
            id: "d1",
            notes: [
              { id: 10, body: "<!-- rusty-bot-review -->\nsummary" },
              { id: 11, body: "human reply" },
            ],
          },
          {
            id: "d2",
            notes: [{ id: 20, body: "<!-- rusty-bot-review -->\ninline", system: false }],
          },
        ]),
      );
      // delete responses
      fetchSpy.mockResolvedValue(jsonResponse({}));

      await provider.deleteExistingBotComments();
      const deleteCalls = fetchSpy.mock.calls.filter(
        (c) => (c[1] as { method?: string } | undefined)?.method === "DELETE",
      );
      expect(deleteCalls).toHaveLength(2);
      expect(deleteCalls[0]?.[0]).toBe(`${MR_BASE}/notes/10`);
      expect(deleteCalls[1]?.[0]).toBe(`${MR_BASE}/notes/20`);
    });
  });

  describe("getFileContent", () => {
    it("fetches raw file content for a ref", async () => {
      fetchSpy.mockResolvedValueOnce(textResponse("file body"));
      const content = await provider.getFileContent("src/a.ts", "feature/x");
      expect(content).toBe("file body");
      const url = fetchSpy.mock.calls[0]?.[0] as string;
      expect(url).toContain(`/repository/files/${encodeURIComponent("src/a.ts")}/raw`);
      expect(url).toContain(`ref=${encodeURIComponent("feature/x")}`);
    });

    it("returns null on non-200", async () => {
      fetchSpy.mockResolvedValueOnce(textResponse("nope", false));
      const content = await provider.getFileContent("missing.ts", "main");
      expect(content).toBeNull();
    });
  });

  describe("searchCode", () => {
    it("maps blob results", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse([{ path: "a.ts", startline: 3, data: "foo()" }]));

      expect(await provider.searchCode("foo")).toEqual([
        { file: "a.ts", line: 3, content: "foo()" },
      ]);
    });

    it("returns [] for a valid empty response", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse([]));

      expect(await provider.searchCode("foo")).toEqual([]);
    });

    it("throws failed for a non-ok response", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ message: "boom" }, false, 500));

      await expect(provider.searchCode("foo")).rejects.toMatchObject({
        name: "SearchUnavailableError",
        reason: "failed",
      });
    });

    it("throws rate_limited for a 429", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ message: "slow down" }, false, 429));

      await expect(provider.searchCode("foo")).rejects.toMatchObject({ reason: "rate_limited" });
    });

    it("throws failed on a network error", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("ECONNRESET"));

      await expect(provider.searchCode("foo")).rejects.toMatchObject({ reason: "failed" });
    });

    it("throws failed on a schema mismatch", async () => {
      fetchSpy.mockResolvedValueOnce(jsonResponse({ not: "an array" }));

      await expect(provider.searchCode("foo")).rejects.toMatchObject({ reason: "failed" });
    });
  });

  describe("getLinkedIssueIids", () => {
    it("returns full references when present, else iid as string", async () => {
      fetchSpy.mockResolvedValueOnce(
        jsonResponse([{ iid: 5, references: { full: "group/proj#5" } }, { iid: 6 }]),
      );
      const ids = await provider.getLinkedIssueIids();
      expect(ids).toEqual(["group/proj#5", "6"]);
    });

    it("returns empty array on error", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("boom"));
      expect(await provider.getLinkedIssueIids()).toEqual([]);
    });
  });
});
