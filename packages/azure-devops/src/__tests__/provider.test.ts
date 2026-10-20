import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AzureDevOpsProvider, truncatePRDescription } from "../provider.js";
import type { Finding } from "@rusty-bot/core";

const ORG_URL = "https://dev.azure.com/test-org";
const PROJECT = "test-project";
const REPO_NAME = "test-repo";
const PULL_REQUEST_ID = 42;
const ACCESS_TOKEN = "test-token";

const BASE_URL = `${ORG_URL}/${PROJECT}/_apis/git/repositories/${REPO_NAME}`;
const API_VERSION = "api-version=7.0";

function createProvider(): AzureDevOpsProvider {
  return new AzureDevOpsProvider({
    orgUrl: ORG_URL,
    project: PROJECT,
    repoName: REPO_NAME,
    pullRequestId: PULL_REQUEST_ID,
    accessToken: ACCESS_TOKEN,
  });
}

function mockFetchResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
  } as Response;
}

function mockFileContentResponse(body: string, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    statusText: ok ? "OK" : "Bad Request",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(body),
    headers: new Headers(),
  } as Response;
}

describe("AzureDevOpsProvider", () => {
  let provider: AzureDevOpsProvider;
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
    it("maps ado response to PRMetadata", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          pullRequestId: 42,
          title: "feat: add widget",
          description: "adds a new widget component",
          createdBy: { displayName: "Test User", uniqueName: "test@example.com" },
          sourceRefName: "refs/heads/feature/widget",
          targetRefName: "refs/heads/main",
          url: "https://dev.azure.com/test-org/_apis/git/repositories/test-repo/pullRequests/42",
          repository: { webUrl: "https://dev.azure.com/test-org/test-project/_git/test-repo" },
        }),
      );

      const metadata = await provider.getPRMetadata();

      expect(metadata).toEqual({
        id: "42",
        title: "feat: add widget",
        description: "adds a new widget component",
        author: "test@example.com",
        sourceBranch: "feature/widget",
        targetBranch: "main",
        url: `${ORG_URL}/${PROJECT}/_git/${REPO_NAME}/pullrequest/${PULL_REQUEST_ID}`,
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/pullRequests/${PULL_REQUEST_ID}?${API_VERSION}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${ACCESS_TOKEN}`,
          }),
        }),
      );
    });

    it("handles null description", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          pullRequestId: 1,
          title: "pr",
          description: null,
          createdBy: { displayName: "User", uniqueName: "u@e.com" },
          sourceRefName: "refs/heads/src",
          targetRefName: "refs/heads/dst",
          url: "",
          repository: { webUrl: "" },
        }),
      );

      const metadata = await provider.getPRMetadata();
      expect(metadata.description).toBe("");
    });

    it("falls back to displayName when uniqueName is missing", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          pullRequestId: 1,
          title: "pr",
          description: "",
          createdBy: { displayName: "Some User" },
          sourceRefName: "refs/heads/src",
          targetRefName: "refs/heads/dst",
          url: "",
          repository: { webUrl: "" },
        }),
      );

      const metadata = await provider.getPRMetadata();
      expect(metadata.author).toBe("Some User");
    });

    it("handles missing createdBy entirely", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          pullRequestId: 1,
          title: "pr",
          description: "",
          createdBy: null,
          sourceRefName: "refs/heads/src",
          targetRefName: "refs/heads/dst",
          url: "",
          repository: { webUrl: "" },
        }),
      );

      const metadata = await provider.getPRMetadata();
      expect(metadata.author).toBe("");
    });

    it("throws on API error", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ message: "not found" }, false, 404));

      await expect(provider.getPRMetadata()).rejects.toThrow("Azure DevOps API error 404");
    });
  });

  describe("postSummaryComment", () => {
    it("sends correct payload with bot marker", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));

      await provider.postSummaryComment("## Review\nLooks good!");

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/pullRequests/${PULL_REQUEST_ID}/threads?${API_VERSION}`,
        expect.objectContaining({
          method: "POST",
        }),
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.comments[0].content).toBe("<!-- rusty-bot-review -->\n## Review\nLooks good!");
      expect(body.comments[0].parentCommentId).toBe(0);
      expect(body.comments[0].commentType).toBe(1);
      expect(body.status).toBe(1);
    });

    it("handles empty markdown", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));

      await provider.postSummaryComment("");

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.comments[0].content).toBe("<!-- rusty-bot-review -->\n");
    });

    it("embeds the last-iteration marker when provided", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));

      await provider.postSummaryComment("## Review", { lastReviewedIteration: "7" });

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.comments[0].content).toContain("<!-- rusty-bot-review -->");
      expect(body.comments[0].content).toContain("<!-- rusty-bot:last-iteration:7 -->");
      expect(body.comments[0].content).toContain("## Review");
    });
  });

  describe("getLastReviewedIteration", () => {
    it("returns null when no threads have the marker", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            {
              id: 1,
              comments: [{ id: 1, content: "<!-- rusty-bot-review -->\nold review" }],
            },
            { id: 2, comments: [{ id: 2, content: "human comment" }] },
          ],
        }),
      );
      const id = await provider.getLastReviewedIteration();
      expect(id).toBeNull();
    });

    it("extracts the iteration id from the newest bot thread", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            {
              id: 1,
              comments: [
                {
                  id: 1,
                  content:
                    "<!-- rusty-bot-review -->\n<!-- rusty-bot:last-iteration:3 -->\nReview 1",
                },
              ],
            },
            { id: 2, comments: [{ id: 2, content: "intermediate human comment" }] },
            {
              id: 3,
              comments: [
                {
                  id: 3,
                  content:
                    "<!-- rusty-bot-review -->\n<!-- rusty-bot:last-iteration:7 -->\nReview 2",
                },
              ],
            },
          ],
        }),
      );
      const id = await provider.getLastReviewedIteration();
      expect(id).toBe("7");
    });

    it("ignores the marker when no comment in the thread carries the bot marker", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            {
              id: 1,
              comments: [
                {
                  id: 1,
                  content: "<!-- rusty-bot:last-iteration:7 -->",
                },
              ],
            },
          ],
        }),
      );
      const id = await provider.getLastReviewedIteration();
      expect(id).toBeNull();
    });
  });

  describe("getDiffSinceIteration", () => {
    it("returns null when sinceIterationId is not numeric", async () => {
      const patches = await provider.getDiffSinceIteration("not-a-number");
      expect(patches).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("returns an empty array when sinceIteration equals the latest iteration", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            { id: 5, sourceRefCommit: { commitId: "aaa" } },
            { id: 7, sourceRefCommit: { commitId: "bbb" } },
          ],
        }),
      );
      const patches = await provider.getDiffSinceIteration("7");
      expect(patches).toEqual([]);
    });

    it("returns null when the since iteration is missing or has no source commit", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            { id: 5, sourceRefCommit: { commitId: "aaa" } },
            { id: 7, sourceRefCommit: { commitId: "bbb" } },
          ],
        }),
      );
      const missing = await provider.getDiffSinceIteration("99");
      expect(missing).toBeNull();

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            { id: 5, sourceRefCommit: null },
            { id: 7, sourceRefCommit: { commitId: "bbb" } },
          ],
        }),
      );
      const noCommit = await provider.getDiffSinceIteration("5");
      expect(noCommit).toBeNull();
    });

    it("queries the changes endpoint with $compareTo and builds patches from commit-pinned content", async () => {
      // call 1: list iterations
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            { id: 5, sourceRefCommit: { commitId: "old-sha" } },
            { id: 7, sourceRefCommit: { commitId: "new-sha" } },
          ],
        }),
      );
      // call 2: changes since iteration 5
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          changeEntries: [
            {
              changeType: "edit",
              item: { path: "/src/foo.ts", gitObjectType: "blob" },
            },
          ],
        }),
      );
      // call 3: new content at new-sha
      fetchSpy.mockResolvedValueOnce(mockFileContentResponse("line1\nline2 changed\nline3\n"));
      // call 4: old content at old-sha
      fetchSpy.mockResolvedValueOnce(mockFileContentResponse("line1\nline2\nline3\n"));

      const patches = await provider.getDiffSinceIteration("5");

      expect(patches).not.toBeNull();
      expect(patches).toHaveLength(1);
      expect(patches?.[0].path).toBe("src/foo.ts");
      expect(patches?.[0].hunks.length).toBeGreaterThan(0);

      const changesUrl = fetchSpy.mock.calls[1][0] as string;
      expect(changesUrl).toContain(`/iterations/7/changes`);
      expect(changesUrl).toContain("$compareTo=5");

      const newContentUrl = fetchSpy.mock.calls[2][0] as string;
      expect(newContentUrl).toContain("versionDescriptor.versionType=commit");
      expect(newContentUrl).toContain("versionDescriptor.version=new-sha");

      const oldContentUrl = fetchSpy.mock.calls[3][0] as string;
      expect(oldContentUrl).toContain("versionDescriptor.versionType=commit");
      expect(oldContentUrl).toContain("versionDescriptor.version=old-sha");
    });

    it("returns null when the iterations request errors", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ message: "boom" }, false, 500));
      const patches = await provider.getDiffSinceIteration("5");
      expect(patches).toBeNull();
    });
  });

  describe("postInlineComments", () => {
    it("creates threads with correct threadContext for each finding", async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      const findings: Finding[] = [
        {
          file: "src/index.ts",
          line: 10,
          endLine: null,
          severity: "critical",
          category: "security",
          message: "SQL injection risk",
          suggestedFix: "use parameterized queries",
        },
        {
          file: "src/utils.ts",
          line: 25,
          endLine: null,
          severity: "suggestion",
          category: "style",
          message: "prefer const",
          suggestedFix: null,
        },
      ];

      await provider.postInlineComments(findings);

      expect(fetchSpy).toHaveBeenCalledTimes(2);

      const firstBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(firstBody.threadContext.filePath).toBe("/src/index.ts");
      expect(firstBody.threadContext.rightFileStart).toEqual({ line: 10, offset: 1 });
      expect(firstBody.threadContext.rightFileEnd).toEqual({ line: 11, offset: 1 });
      expect(firstBody.comments[0].content).toContain("<!-- rusty-bot-review -->");
      expect(firstBody.comments[0].content).toContain("SQL injection risk");
      expect(firstBody.comments[0].content).toContain("```suggestion");

      const secondBody = JSON.parse(fetchSpy.mock.calls[1][1].body);
      expect(secondBody.threadContext.filePath).toBe("/src/utils.ts");
      expect(secondBody.threadContext.rightFileStart.line).toBe(25);
      expect(secondBody.comments[0].content).not.toContain("```suggestion");
    });

    it("uses endLine for rightFileEnd when finding spans multiple lines", async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      const findings: Finding[] = [
        {
          file: "src/config.ts",
          line: 5,
          endLine: 12,
          severity: "warning",
          category: "bugs",
          message: "duplicate entries",
          suggestedFix: "const plugins = [\n  'react',\n  'vitest',\n];",
        },
      ];

      await provider.postInlineComments(findings);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.threadContext.rightFileStart).toEqual({ line: 5, offset: 1 });
      expect(body.threadContext.rightFileEnd).toEqual({ line: 13, offset: 1 });
    });

    it("falls back to line when endLine is null", async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      const findings: Finding[] = [
        {
          file: "src/index.ts",
          line: 42,
          endLine: null,
          severity: "warning",
          category: "bugs",
          message: "issue",
          suggestedFix: null,
        },
      ];

      await provider.postInlineComments(findings);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.threadContext.rightFileStart).toEqual({ line: 42, offset: 1 });
      expect(body.threadContext.rightFileEnd).toEqual({ line: 43, offset: 1 });
    });

    it("anchors single-line suggestion so the full line is replaced, not inserted", async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      await provider.postInlineComments([
        {
          file: "pyproject.toml",
          line: 58,
          endLine: null,
          severity: "warning",
          category: "security",
          message: "wildcard version pinning",
          suggestedFix: 'cryptography = "^43.0.3"',
        },
      ]);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      const { rightFileStart, rightFileEnd } = body.threadContext;
      // a zero-width range (start == end) makes ado insert the suggestion at col 1
      // instead of replacing the line, concatenating the fix with the original content
      expect(rightFileStart).not.toEqual(rightFileEnd);
    });

    it("anchors multi-line suggestion to the end of the last line when content is cached", async () => {
      const fileContent = [
        "const plugins = [",
        "  'react',",
        "  'vitest',",
        "  'unused',",
        "];",
      ].join("\n");

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          pullRequestId: 42,
          title: "",
          description: "",
          createdBy: { displayName: "U", uniqueName: "u@e.com" },
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          repository: { webUrl: "" },
        }),
      );
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ value: [{ id: 1 }] }));
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          changeEntries: [
            { changeType: "edit", item: { path: "/src/config.ts", gitObjectType: "blob" } },
          ],
        }),
      );
      fetchSpy.mockResolvedValueOnce(mockFileContentResponse(fileContent));
      fetchSpy.mockResolvedValueOnce(mockFileContentResponse("old"));

      await provider.getDiff();

      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      await provider.postInlineComments([
        {
          file: "src/config.ts",
          line: 2,
          endLine: 4,
          severity: "warning",
          category: "bugs",
          message: "drop unused plugin entry",
          suggestedFix: "  'react',\n  'vitest',",
        },
      ]);

      const threadCall = fetchSpy.mock.calls.find((args: unknown[]) => {
        const init = args[1] as RequestInit | undefined;
        return init?.method === "POST" && (args[0] as string).includes("/threads?");
      });
      expect(threadCall).toBeDefined();

      const body = JSON.parse((threadCall![1] as RequestInit & { body: string }).body);
      expect(body.threadContext.rightFileStart).toEqual({ line: 2, offset: 1 });
      expect(body.threadContext.rightFileEnd).toEqual({
        line: 4,
        offset: "  'unused',".length,
      });
    });

    it("falls back to next-line anchor for empty target lines to avoid a zero-width range", async () => {
      const fileContent = ["first", "", "third"].join("\n");

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          pullRequestId: 42,
          title: "",
          description: "",
          createdBy: { displayName: "U", uniqueName: "u@e.com" },
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          repository: { webUrl: "" },
        }),
      );
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ value: [{ id: 1 }] }));
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          changeEntries: [
            { changeType: "edit", item: { path: "/src/file.ts", gitObjectType: "blob" } },
          ],
        }),
      );
      fetchSpy.mockResolvedValueOnce(mockFileContentResponse(fileContent));
      fetchSpy.mockResolvedValueOnce(mockFileContentResponse("old"));

      await provider.getDiff();

      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      await provider.postInlineComments([
        {
          file: "src/file.ts",
          line: 2,
          endLine: null,
          severity: "suggestion",
          category: "style",
          message: "add content here",
          suggestedFix: "// new content",
        },
      ]);

      const threadCall = fetchSpy.mock.calls.find((args: unknown[]) => {
        const init = args[1] as RequestInit | undefined;
        return init?.method === "POST" && (args[0] as string).includes("/threads?");
      });
      expect(threadCall).toBeDefined();

      const body = JSON.parse((threadCall![1] as RequestInit & { body: string }).body);
      expect(body.threadContext.rightFileEnd).toEqual({ line: 3, offset: 1 });
    });

    it("anchors single-line suggestion within the target line so the trailing newline is preserved", async () => {
      const fileContent = [
        "{",
        '  "rules": {',
        '    "typescript/no-floating-promises": "off",',
        '    "@typescript-eslint/ban-ts-comment": "error",',
        "  }",
        "}",
      ].join("\n");

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          pullRequestId: 42,
          title: "",
          description: "",
          createdBy: { displayName: "U", uniqueName: "u@e.com" },
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          repository: { webUrl: "" },
        }),
      );
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ value: [{ id: 1 }] }));
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          changeEntries: [
            { changeType: "edit", item: { path: "/.oxlintrc.json", gitObjectType: "blob" } },
          ],
        }),
      );
      fetchSpy.mockResolvedValueOnce(mockFileContentResponse(fileContent));
      fetchSpy.mockResolvedValueOnce(mockFileContentResponse("old"));

      await provider.getDiff();

      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      await provider.postInlineComments([
        {
          file: ".oxlintrc.json",
          line: 3,
          endLine: null,
          severity: "warning",
          category: "bugs",
          message: "disabling this rule removes protection",
          suggestedFix: '    "typescript/no-floating-promises": "error",',
        },
      ]);

      const threadCall = fetchSpy.mock.calls.find((args: unknown[]) => {
        const init = args[1] as RequestInit | undefined;
        if (init?.method !== "POST") return false;
        const url = args[0] as string;
        return url.includes("/threads?");
      });
      expect(threadCall).toBeDefined();

      const body = JSON.parse((threadCall![1] as RequestInit & { body: string }).body);
      const targetLineLength = '    "typescript/no-floating-promises": "off",'.length;
      expect(body.threadContext.rightFileStart).toEqual({ line: 3, offset: 1 });
      expect(body.threadContext.rightFileEnd).toEqual({ line: 3, offset: targetLineLength });
    });

    it("excludes trailing carriage returns from offsets when file uses crlf line endings", async () => {
      const targetLine = '    "typescript/no-floating-promises": "off",';
      const fileContent = ["{", '  "rules": {', targetLine, "  }", "}"].join("\r\n");

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          pullRequestId: 42,
          title: "",
          description: "",
          createdBy: { displayName: "U", uniqueName: "u@e.com" },
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          repository: { webUrl: "" },
        }),
      );
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ value: [{ id: 1 }] }));
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          changeEntries: [
            { changeType: "edit", item: { path: "/.oxlintrc.json", gitObjectType: "blob" } },
          ],
        }),
      );
      fetchSpy.mockResolvedValueOnce(mockFileContentResponse(fileContent));
      fetchSpy.mockResolvedValueOnce(mockFileContentResponse("old"));

      await provider.getDiff();

      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      await provider.postInlineComments([
        {
          file: ".oxlintrc.json",
          line: 3,
          endLine: null,
          severity: "warning",
          category: "bugs",
          message: "disabling this rule removes protection",
          suggestedFix: '    "typescript/no-floating-promises": "error",',
        },
      ]);

      const threadCall = fetchSpy.mock.calls.find((args: unknown[]) => {
        const init = args[1] as RequestInit | undefined;
        return init?.method === "POST" && (args[0] as string).includes("/threads?");
      });
      expect(threadCall).toBeDefined();

      const body = JSON.parse((threadCall![1] as RequestInit & { body: string }).body);
      // offset must equal raw line length without the trailing \r; otherwise ado
      // extends the anchor past the visible content and the suggestion leaves behind a cr
      expect(body.threadContext.rightFileEnd).toEqual({ line: 3, offset: targetLine.length });
    });

    it("skips API call when findings array is empty", async () => {
      await provider.postInlineComments([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("prepends leading slash to file paths", async () => {
      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      await provider.postInlineComments([
        {
          file: "deep/nested/file.ts",
          line: 1,
          endLine: null,
          severity: "warning",
          category: "bugs",
          message: "bug",
          suggestedFix: null,
        },
      ]);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.threadContext.filePath).toBe("/deep/nested/file.ts");
    });
  });

  describe("deleteExistingBotComments", () => {
    it("closes only threads containing the bot marker", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            {
              id: 1,
              comments: [{ id: 1, content: "<!-- rusty-bot-review -->\nold review" }],
              status: 1,
            },
            { id: 2, comments: [{ id: 2, content: "human comment" }], status: 1 },
            {
              id: 3,
              comments: [{ id: 3, content: "another <!-- rusty-bot-review --> comment" }],
              status: 1,
            },
          ],
        }),
      );

      // patch responses
      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      await provider.deleteExistingBotComments();

      const patchCalls = fetchSpy.mock.calls.filter(
        (args: unknown[]) => (args[1] as RequestInit)?.method === "PATCH",
      );

      expect(patchCalls).toHaveLength(2);
      expect(patchCalls[0][0]).toContain("/threads/1?");
      expect(patchCalls[1][0]).toContain("/threads/3?");

      const patchBody = JSON.parse(patchCalls[0][1].body);
      expect(patchBody.status).toBe(4);
    });

    it("does nothing when there are no bot threads", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [{ id: 1, comments: [{ id: 1, content: "normal comment" }], status: 1 }],
        }),
      );

      await provider.deleteExistingBotComments();

      const patchCalls = fetchSpy.mock.calls.filter(
        (args: unknown[]) => (args[1] as RequestInit)?.method === "PATCH",
      );
      expect(patchCalls).toHaveLength(0);
    });

    it("handles threads with empty comments array", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            { id: 1, comments: [], status: 1 },
            {
              id: 2,
              comments: [{ id: 1, content: "<!-- rusty-bot-review -->\nreview" }],
              status: 1,
            },
          ],
        }),
      );

      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      await provider.deleteExistingBotComments();

      const patchCalls = fetchSpy.mock.calls.filter(
        (args: unknown[]) => (args[1] as RequestInit)?.method === "PATCH",
      );
      expect(patchCalls).toHaveLength(1);
      expect(patchCalls[0][0]).toContain("/threads/2?");
    });

    it("handles empty thread list", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ value: [] }));

      await provider.deleteExistingBotComments();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("handles threads with missing status field", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            {
              id: 1,
              comments: [{ id: 1, content: "<!-- rusty-bot-review -->\nold" }],
            },
            { id: 2, comments: [{ id: 2, content: "system thread" }] },
          ],
        }),
      );

      fetchSpy.mockResolvedValue(mockFetchResponse({}));

      await provider.deleteExistingBotComments();

      const patchCalls = fetchSpy.mock.calls.filter(
        (args: unknown[]) => (args[1] as RequestInit)?.method === "PATCH",
      );
      expect(patchCalls).toHaveLength(1);
      expect(patchCalls[0][0]).toContain("/threads/1?");
    });
  });

  describe("searchCode", () => {
    it("maps search results", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ results: [{ path: "/src/a.ts" }] }));

      expect(await provider.searchCode("foo")).toEqual([
        { file: "src/a.ts", line: 0, content: "" },
      ]);
    });

    it("returns [] for a valid empty response", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ results: [] }));

      expect(await provider.searchCode("foo")).toEqual([]);
    });

    it("throws failed for a non-ok response", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}, false, 500));

      await expect(provider.searchCode("foo")).rejects.toMatchObject({
        name: "SearchUnavailableError",
        reason: "failed",
      });
    });

    it("throws rate_limited for a 429 and reads retry-after", async () => {
      const res = mockFetchResponse({}, false, 429);
      (res as { headers: Headers }).headers = new Headers({ "retry-after": "7" });
      fetchSpy.mockResolvedValueOnce(res);

      await expect(provider.searchCode("foo")).rejects.toMatchObject({
        reason: "rate_limited",
        retryAfterMs: 7_000,
      });
    });

    it("throws failed on a network error", async () => {
      fetchSpy.mockRejectedValueOnce(new Error("ECONNRESET"));

      await expect(provider.searchCode("foo")).rejects.toMatchObject({ reason: "failed" });
    });

    it("throws failed on a schema mismatch", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ results: "nope" }));

      await expect(provider.searchCode("foo")).rejects.toMatchObject({ reason: "failed" });
    });
  });

  describe("getLinkedWorkItemIds", () => {
    it("returns work item ids from the PR work items endpoint", async () => {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [
            { id: "9952", url: "https://dev.azure.com/org/proj/_apis/wit/workItems/9952" },
            { id: "1001", url: "https://dev.azure.com/org/proj/_apis/wit/workItems/1001" },
          ],
        }),
      );

      const ids = await provider.getLinkedWorkItemIds();

      expect(ids).toEqual(["9952", "1001"]);
      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/pullRequests/${PULL_REQUEST_ID}/workitems?${API_VERSION}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: `Bearer ${ACCESS_TOKEN}`,
          }),
        }),
      );
    });

    it("returns empty array when no work items are linked", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ value: [] }));

      const ids = await provider.getLinkedWorkItemIds();
      expect(ids).toEqual([]);
    });

    it("throws on API error", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ message: "forbidden" }, false, 403));

      await expect(provider.getLinkedWorkItemIds()).rejects.toThrow("Azure DevOps API error 403");
    });
  });

  describe("getDiff", () => {
    function mockPRAndIterations() {
      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          pullRequestId: 42,
          title: "feat: stuff",
          description: "",
          createdBy: { displayName: "User", uniqueName: "u@e.com" },
          sourceRefName: "refs/heads/feature",
          targetRefName: "refs/heads/main",
          repository: { webUrl: "" },
        }),
      );
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({ value: [{ id: 1 }] }));
    }

    it("skips change entries where item.path is null", async () => {
      mockPRAndIterations();

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          changeEntries: [
            { changeType: "edit", item: { path: "/src/real.ts", gitObjectType: "blob" } },
            { changeType: "edit", item: { path: null, gitObjectType: "blob" } },
          ],
        }),
      );

      // file content fetches for the one valid entry
      fetchSpy.mockResolvedValueOnce(mockFetchResponse("const a = 1;", true));
      fetchSpy.mockResolvedValueOnce(mockFetchResponse("const a = 2;", true));

      const patches = await provider.getDiff();

      const paths = patches.map((p) => p.path);
      expect(paths).not.toContain(null);
      expect(paths).toContain("src/real.ts");
    });

    it("handles response where all entries have null paths", async () => {
      mockPRAndIterations();

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          changeEntries: [
            { changeType: "edit", item: { path: null } },
            { changeType: "add", item: { path: null } },
          ],
        }),
      );

      const patches = await provider.getDiff();
      expect(patches).toEqual([]);
    });

    it("skips entries where item itself is null", async () => {
      mockPRAndIterations();

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          changeEntries: [
            { changeType: "sourceRename", item: null },
            { changeType: "edit", item: { path: "/src/valid.ts", gitObjectType: "blob" } },
          ],
        }),
      );

      fetchSpy.mockResolvedValueOnce(mockFetchResponse("new", true));
      fetchSpy.mockResolvedValueOnce(mockFetchResponse("old", true));

      const patches = await provider.getDiff();
      expect(patches).toHaveLength(1);
      expect(patches[0].path).toBe("src/valid.ts");
    });

    it("skips sourceRename entries", async () => {
      mockPRAndIterations();

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          changeEntries: [
            { changeType: "sourceRename", item: { path: "/old/name.ts", gitObjectType: "blob" } },
            {
              changeType: "rename",
              item: { path: "/new/name.ts", gitObjectType: "blob" },
              originalPath: "/old/name.ts",
            },
          ],
        }),
      );

      // rename entry fetches: new content at new path, old content at original path
      fetchSpy.mockResolvedValueOnce(mockFetchResponse("renamed content", true));
      fetchSpy.mockResolvedValueOnce(mockFetchResponse("original content", true));

      const patches = await provider.getDiff();
      expect(patches).toHaveLength(1);
      expect(patches[0].path).toBe("new/name.ts");
    });

    it("fetches old content from originalPath for renames", async () => {
      mockPRAndIterations();

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          changeEntries: [
            {
              changeType: "rename, edit",
              item: { path: "/src/renamed.ts", gitObjectType: "blob" },
              originalPath: "/src/original.ts",
            },
          ],
        }),
      );

      fetchSpy.mockResolvedValueOnce(mockFetchResponse("new code", true));
      fetchSpy.mockResolvedValueOnce(mockFetchResponse("old code", true));

      await provider.getDiff();

      // 3rd fetch = changes, 4th = new content at new path, 5th = old content at original path
      const oldContentUrl = decodeURIComponent(fetchSpy.mock.calls[4][0] as string);
      expect(oldContentUrl).toContain("src/original.ts");
      expect(oldContentUrl).not.toContain("src/renamed.ts");
    });
  });

  describe("updatePRDescription", () => {
    it("posts the description verbatim when within the 4000-char limit", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));

      const description = "## Summary\n\nA short description.";
      await provider.updatePRDescription(description);

      expect(fetchSpy).toHaveBeenCalledWith(
        `${BASE_URL}/pullRequests/${PULL_REQUEST_ID}?${API_VERSION}`,
        expect.objectContaining({ method: "PATCH" }),
      );

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.description).toBe(description);
    });

    it("posts a description of exactly 4000 chars verbatim", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));

      const description = "x".repeat(4000);
      await provider.updatePRDescription(description);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.description).toBe(description);
      expect(body.description.length).toBe(4000);
    });

    it("truncates a description longer than 4000 chars and appends a marker", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));

      const description = "y".repeat(5000);
      await provider.updatePRDescription(description);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.description.length).toBe(4000);
      expect(body.description.endsWith("\n\n…(truncated)")).toBe(true);
    });

    it("truncates a 4001-char description to 4000 chars", async () => {
      fetchSpy.mockResolvedValueOnce(mockFetchResponse({}));

      const description = "z".repeat(4001);
      await provider.updatePRDescription(description);

      const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
      expect(body.description.length).toBe(4000);
      expect(body.description.endsWith("\n\n…(truncated)")).toBe(true);
    });
  });

  describe("truncatePRDescription", () => {
    it("returns the input unchanged when shorter than the limit", () => {
      expect(truncatePRDescription("hello")).toBe("hello");
    });

    it("returns the input unchanged at exactly the limit", () => {
      const s = "a".repeat(4000);
      expect(truncatePRDescription(s)).toBe(s);
      expect(truncatePRDescription(s).length).toBe(4000);
    });

    it("truncates and appends the marker for inputs over the limit", () => {
      const result = truncatePRDescription("b".repeat(10_000));
      expect(result.length).toBe(4000);
      expect(result.endsWith("\n\n…(truncated)")).toBe(true);
      expect(result.startsWith("b".repeat(100))).toBe(true);
    });

    it("respects a custom maxLength", () => {
      const result = truncatePRDescription("c".repeat(500), 100);
      expect(result.length).toBe(100);
      expect(result.endsWith("\n\n…(truncated)")).toBe(true);
    });
  });

  describe("constructor", () => {
    it("strips trailing slash from orgUrl", async () => {
      const p = new AzureDevOpsProvider({
        orgUrl: "https://dev.azure.com/org/",
        project: PROJECT,
        repoName: REPO_NAME,
        pullRequestId: PULL_REQUEST_ID,
        accessToken: ACCESS_TOKEN,
      });

      fetchSpy.mockResolvedValueOnce(
        mockFetchResponse({
          value: [],
        }),
      );

      await p.deleteExistingBotComments();

      expect(
        (fetchSpy.mock.calls[0][0] as string).startsWith("https://dev.azure.com/org/test-project"),
      ).toBe(true);
    });
  });
});

describe("CLI config parsing", () => {
  const REQUIRED_ENV = {
    SYSTEM_PULLREQUEST_PULLREQUESTID: "42",
    SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/org",
    SYSTEM_TEAMPROJECT: "proj",
    BUILD_REPOSITORY_NAME: "repo",
    SYSTEM_ACCESSTOKEN: "token",
  };

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function importParseConfig() {
    // re-import to get the function fresh
    const mod = await import("../cli.js");
    return mod.parseConfig;
  }

  it("throws when required env vars are missing", async () => {
    process.env = { ...originalEnv };
    delete process.env.SYSTEM_PULLREQUEST_PULLREQUESTID;
    delete process.env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI;
    delete process.env.SYSTEM_TEAMPROJECT;
    delete process.env.BUILD_REPOSITORY_NAME;
    delete process.env.SYSTEM_ACCESSTOKEN;

    const parseConfig = await importParseConfig();
    expect(() => parseConfig()).toThrow("missing required env vars");
  });

  it("throws when a single required env var is missing", async () => {
    process.env = { ...originalEnv, ...REQUIRED_ENV };
    delete process.env.SYSTEM_ACCESSTOKEN;

    const parseConfig = await importParseConfig();
    expect(() => parseConfig()).toThrow("SYSTEM_ACCESSTOKEN");
  });

  it("parses valid config from env vars", async () => {
    process.env = {
      ...originalEnv,
      ...REQUIRED_ENV,
      RUSTY_REVIEW_STYLE: "strict",
      RUSTY_FOCUS_AREAS: "security,performance",
      RUSTY_IGNORE_PATTERNS: "*.lock,dist/**",
    };

    const parseConfig = await importParseConfig();
    const { config, failOnCritical } = parseConfig();

    expect(config.style).toBe("strict");
    expect(config.focusAreas).toEqual(["security", "performance"]);
    expect(config.ignorePatterns).toEqual(["*.lock", "dist/**"]);
    expect(failOnCritical).toBe(true);
  });

  it("uses defaults when optional env vars are absent", async () => {
    process.env = { ...originalEnv, ...REQUIRED_ENV };

    const parseConfig = await importParseConfig();
    const { config, failOnCritical } = parseConfig();

    expect(config.style).toBe("balanced");
    expect(config.focusAreas).toEqual([]);
    expect(config.ignorePatterns).toEqual([]);
    expect(failOnCritical).toBe(true);
  });

  it("respects RUSTY_FAIL_ON_CRITICAL=false", async () => {
    process.env = { ...originalEnv, ...REQUIRED_ENV, RUSTY_FAIL_ON_CRITICAL: "false" };

    const parseConfig = await importParseConfig();
    const { failOnCritical } = parseConfig();

    expect(failOnCritical).toBe(false);
  });

  it("treats any non-false value of RUSTY_FAIL_ON_CRITICAL as true", async () => {
    process.env = { ...originalEnv, ...REQUIRED_ENV, RUSTY_FAIL_ON_CRITICAL: "no" };

    const parseConfig = await importParseConfig();
    const { failOnCritical } = parseConfig();

    expect(failOnCritical).toBe(true);
  });

  it("throws on invalid review style", async () => {
    process.env = { ...originalEnv, ...REQUIRED_ENV, RUSTY_REVIEW_STYLE: "invalid" };

    const parseConfig = await importParseConfig();
    expect(() => parseConfig()).toThrow("invalid review style: invalid");
  });

  it("filters empty strings from comma-separated lists", async () => {
    process.env = {
      ...originalEnv,
      ...REQUIRED_ENV,
      RUSTY_FOCUS_AREAS: "security,,performance,",
      RUSTY_IGNORE_PATTERNS: ",*.lock,,",
    };

    const parseConfig = await importParseConfig();
    const { config } = parseConfig();

    expect(config.focusAreas).toEqual(["security", "performance"]);
    expect(config.ignorePatterns).toEqual(["*.lock"]);
  });
});
