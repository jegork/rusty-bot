import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubProvider } from "../provider.js";
import type { Octokit } from "octokit";
import type { Finding, PriorReviewContext } from "@rusty-bot/core";
import { encodePriorReviewContext, extractPriorReviewContext } from "@rusty-bot/core";

function createMockOctokit() {
  return {
    request: vi.fn(),
    graphql: vi.fn(),
  } as unknown as Octokit & {
    request: ReturnType<typeof vi.fn>;
    graphql: ReturnType<typeof vi.fn>;
  };
}

const OWNER = "test-owner";
const REPO = "test-repo";
const PULL_NUMBER = 42;

describe("GitHubProvider", () => {
  let octokit: ReturnType<typeof createMockOctokit>;
  let provider: GitHubProvider;

  beforeEach(() => {
    octokit = createMockOctokit();
    provider = new GitHubProvider({
      octokit,
      owner: OWNER,
      repo: REPO,
      pullNumber: PULL_NUMBER,
    });
  });

  describe("getPRMetadata", () => {
    it("maps github response to PRMetadata", async () => {
      octokit.request.mockResolvedValueOnce({
        data: {
          number: 42,
          title: "feat: add feature",
          body: "some description",
          user: { login: "octocat" },
          head: { ref: "feature-branch", sha: "deadbeef0000000000000000000000000000beef" },
          base: { ref: "main" },
          html_url: "https://github.com/test-owner/test-repo/pull/42",
        },
      });

      const metadata = await provider.getPRMetadata();

      expect(metadata).toEqual({
        id: "42",
        title: "feat: add feature",
        description: "some description",
        author: "octocat",
        sourceBranch: "feature-branch",
        targetBranch: "main",
        url: "https://github.com/test-owner/test-repo/pull/42",
        headSha: "deadbeef0000000000000000000000000000beef",
      });

      expect(octokit.request).toHaveBeenCalledWith(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          pull_number: PULL_NUMBER,
        }),
      );
    });

    it("handles null body and missing user", async () => {
      octokit.request.mockResolvedValueOnce({
        data: {
          number: 1,
          title: "pr",
          body: null,
          user: null,
          head: { ref: "src", sha: "0".repeat(40) },
          base: { ref: "dst" },
          html_url: "https://example.com",
        },
      });

      const metadata = await provider.getPRMetadata();

      expect(metadata.description).toBe("");
      expect(metadata.author).toBe("");
    });
  });

  describe("postSummaryComment", () => {
    it("posts comment with bot marker prepended", async () => {
      octokit.request.mockResolvedValueOnce({ data: {} });

      await provider.postSummaryComment("## Review\nLooks good!");

      expect(octokit.request).toHaveBeenCalledWith(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          issue_number: PULL_NUMBER,
          body: "<!-- rusty-bot-review -->\n## Review\nLooks good!",
        }),
      );
    });

    it("embeds the last-reviewed-sha marker when provided", async () => {
      octokit.request.mockResolvedValueOnce({ data: {} });

      await provider.postSummaryComment("## Review\nLooks good!", {
        lastReviewedSha: "abc123def4560000000000000000000000000000",
      });

      const call = octokit.request.mock.calls[0][1] as { body: string };
      expect(call.body).toContain("<!-- rusty-bot-review -->");
      expect(call.body).toContain(
        "<!-- rusty-bot:last-sha:abc123def4560000000000000000000000000000 -->",
      );
      expect(call.body).toContain("## Review\nLooks good!");
    });

    it("embeds the prior-context marker when provided", async () => {
      octokit.request.mockResolvedValueOnce({ data: {} });

      const priorContext: PriorReviewContext = {
        summary: "earlier review summary",
        recommendation: "address_before_merge",
        findings: [{ file: "src/a.ts", line: 1, severity: "warning", message: "issue" }],
      };

      await provider.postSummaryComment("## Review\nLooks good!", {
        lastReviewedSha: "abc123def4560000000000000000000000000000",
        priorContext,
      });

      const call = octokit.request.mock.calls[0][1] as { body: string };
      expect(call.body).toContain("<!-- rusty-bot:last-sha:");
      expect(call.body).toMatch(/<!--\s*rusty-bot:context:/);
      const decoded = extractPriorReviewContext(call.body);
      expect(decoded).toEqual(priorContext);
    });

    it("does not embed the prior-context marker when omitted", async () => {
      octokit.request.mockResolvedValueOnce({ data: {} });
      await provider.postSummaryComment("## Review\nLooks good!", {
        lastReviewedSha: "abc123def4560000000000000000000000000000",
      });
      const call = octokit.request.mock.calls[0][1] as { body: string };
      expect(call.body).not.toContain("rusty-bot:context:");
    });
  });

  describe("getPriorReviewContext", () => {
    const priorContext: PriorReviewContext = {
      summary: "earlier review",
      recommendation: "looks_good",
      findings: [{ file: "x.ts", line: 1, severity: "suggestion", message: "ok" }],
    };

    it("returns null when no comments exist", async () => {
      octokit.request.mockResolvedValueOnce({ data: [] });
      expect(await provider.getPriorReviewContext()).toBeNull();
    });

    it("returns null when bot comments exist but lack the context marker", async () => {
      octokit.request.mockResolvedValueOnce({
        data: [{ id: 1, body: "<!-- rusty-bot-review -->\nold review, no context marker" }],
      });
      expect(await provider.getPriorReviewContext()).toBeNull();
    });

    it("returns null when the context marker is malformed", async () => {
      octokit.request.mockResolvedValueOnce({
        data: [
          {
            id: 1,
            body: "<!-- rusty-bot-review -->\n<!-- rusty-bot:context:!!!notbase64!!! -->",
          },
        ],
      });
      expect(await provider.getPriorReviewContext()).toBeNull();
    });

    it("extracts the most recent prior context when multiple bot comments exist", async () => {
      const olderCtx: PriorReviewContext = {
        summary: "OLDER review",
        recommendation: "critical_issues",
        findings: [],
      };
      octokit.request.mockResolvedValueOnce({
        data: [
          {
            id: 1,
            body: `<!-- rusty-bot-review -->\n${encodePriorReviewContext(olderCtx)}`,
          },
          { id: 2, body: "human comment" },
          {
            id: 3,
            body: `<!-- rusty-bot-review -->\n${encodePriorReviewContext(priorContext)}`,
          },
        ],
      });
      expect(await provider.getPriorReviewContext()).toEqual(priorContext);
    });

    it("ignores a context marker outside a bot comment", async () => {
      octokit.request.mockResolvedValueOnce({
        data: [{ id: 1, body: encodePriorReviewContext(priorContext) }],
      });
      expect(await provider.getPriorReviewContext()).toBeNull();
    });
  });

  describe("getLastReviewedSha", () => {
    it("returns null when no comments exist", async () => {
      octokit.request.mockResolvedValueOnce({ data: [] });
      const sha = await provider.getLastReviewedSha();
      expect(sha).toBeNull();
    });

    it("returns null when no bot comment carries the marker", async () => {
      octokit.request.mockResolvedValueOnce({
        data: [
          { id: 1, body: "<!-- rusty-bot-review -->\nold review without marker" },
          { id: 2, body: "human comment" },
        ],
      });
      const sha = await provider.getLastReviewedSha();
      expect(sha).toBeNull();
    });

    it("extracts the sha when a bot comment carries the marker", async () => {
      octokit.request.mockResolvedValueOnce({
        data: [
          {
            id: 1,
            body:
              "<!-- rusty-bot-review -->\n" +
              "<!-- rusty-bot:last-sha:abc123def4560000000000000000000000000000 -->\n" +
              "## Review",
          },
        ],
      });
      const sha = await provider.getLastReviewedSha();
      expect(sha).toBe("abc123def4560000000000000000000000000000");
    });

    it("prefers the newest matching comment when multiple bot comments exist", async () => {
      octokit.request.mockResolvedValueOnce({
        data: [
          {
            id: 1,
            body:
              "<!-- rusty-bot-review -->\n" +
              "<!-- rusty-bot:last-sha:1111111111111111111111111111111111111111 -->",
          },
          { id: 2, body: "an unrelated human comment" },
          {
            id: 3,
            body:
              "<!-- rusty-bot-review -->\n" +
              "<!-- rusty-bot:last-sha:2222222222222222222222222222222222222222 -->",
          },
        ],
      });
      const sha = await provider.getLastReviewedSha();
      expect(sha).toBe("2222222222222222222222222222222222222222");
    });

    it("ignores the marker when it isn't inside a bot comment", async () => {
      octokit.request.mockResolvedValueOnce({
        data: [
          {
            id: 1,
            body: "<!-- rusty-bot:last-sha:abc123def4560000000000000000000000000000 -->",
          },
        ],
      });
      const sha = await provider.getLastReviewedSha();
      expect(sha).toBeNull();
    });
  });

  describe("comment-fetch memoization", () => {
    const ctx: PriorReviewContext = {
      summary: "earlier review",
      recommendation: "looks_good",
      findings: [],
    };

    it("calls the comments API once even when both getLastReviewedSha and getPriorReviewContext are invoked", async () => {
      // single mock response — if the second method were uncached it would
      // hit a fresh `request` slot and get `undefined`, breaking the test
      octokit.request.mockResolvedValueOnce({
        data: [
          {
            id: 1,
            body:
              "<!-- rusty-bot-review -->\n" +
              "<!-- rusty-bot:last-sha:abc123def4560000000000000000000000000000 -->\n" +
              encodePriorReviewContext(ctx),
          },
        ],
      });

      const sha = await provider.getLastReviewedSha();
      const decoded = await provider.getPriorReviewContext();

      expect(sha).toBe("abc123def4560000000000000000000000000000");
      expect(decoded).toEqual(ctx);

      const commentFetchCalls = octokit.request.mock.calls.filter(
        (call) => call[0] === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      );
      expect(commentFetchCalls).toHaveLength(1);
    });

    it("dedupes concurrent in-flight fetches into one API call", async () => {
      // both calls fire before the request resolves; both must await the same
      // in-flight promise so we still hit the API only once
      let resolveFetch!: (value: { data: unknown[] }) => void;
      octokit.request.mockReturnValueOnce(
        new Promise((r) => {
          resolveFetch = r;
        }),
      );

      const shaPromise = provider.getLastReviewedSha();
      const ctxPromise = provider.getPriorReviewContext();

      resolveFetch({ data: [] });

      await Promise.all([shaPromise, ctxPromise]);

      const commentFetchCalls = octokit.request.mock.calls.filter(
        (call) => call[0] === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      );
      expect(commentFetchCalls).toHaveLength(1);
    });

    it("re-fetches when a fresh provider instance is constructed (cache is per-instance)", async () => {
      octokit.request.mockResolvedValueOnce({ data: [] }).mockResolvedValueOnce({ data: [] });

      await provider.getLastReviewedSha();
      const provider2 = new GitHubProvider({
        octokit,
        owner: OWNER,
        repo: REPO,
        pullNumber: PULL_NUMBER,
      });
      await provider2.getLastReviewedSha();

      const commentFetchCalls = octokit.request.mock.calls.filter(
        (call) => call[0] === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
      );
      expect(commentFetchCalls).toHaveLength(2);
    });
  });

  describe("getDiffSinceSha", () => {
    const HEAD_SHA = "feedface0000000000000000000000000000face";
    const SINCE_SHA = "deadbeef0000000000000000000000000000beef";

    it("returns an empty array when sinceSha equals headSha without calling the API", async () => {
      const patches = await provider.getDiffSinceSha(HEAD_SHA, HEAD_SHA);
      expect(patches).toEqual([]);
      expect(octokit.request).not.toHaveBeenCalled();
    });

    it("calls the compare API with basehead and parses the resulting diff", async () => {
      const rawDiff = [
        "diff --git a/file.ts b/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1,2 +1,2 @@",
        "-old",
        "+new",
        " keep",
      ].join("\n");
      octokit.request.mockResolvedValueOnce({ data: rawDiff });

      const patches = await provider.getDiffSinceSha(SINCE_SHA, HEAD_SHA);

      expect(patches).not.toBeNull();
      expect(patches).toHaveLength(1);
      expect(patches?.[0].path).toBe("file.ts");
      expect(octokit.request).toHaveBeenCalledWith(
        "GET /repos/{owner}/{repo}/compare/{basehead}",
        expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          basehead: `${SINCE_SHA}...${HEAD_SHA}`,
        }),
      );
    });

    it("returns null when the compare API errors (force-push or unreachable sha)", async () => {
      octokit.request.mockRejectedValueOnce(Object.assign(new Error("Not Found"), { status: 404 }));

      const patches = await provider.getDiffSinceSha(SINCE_SHA, HEAD_SHA);
      expect(patches).toBeNull();
    });
  });

  describe("deleteExistingBotComments", () => {
    it("deletes only comments containing the bot marker", async () => {
      octokit.request.mockImplementation((route: string) => {
        if (route.startsWith("GET")) {
          return {
            data: [
              { id: 1, body: "<!-- rusty-bot-review -->\nold review" },
              { id: 2, body: "human comment" },
              { id: 3, body: "another <!-- rusty-bot-review --> comment" },
            ],
          };
        }
        return { data: {} };
      });

      await provider.deleteExistingBotComments();

      const deleteCalls = octokit.request.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === "string" && args[0].startsWith("DELETE"),
      );

      expect(deleteCalls).toHaveLength(2);
      expect(deleteCalls[0][1]).toMatchObject({ comment_id: 1 });
      expect(deleteCalls[1][1]).toMatchObject({ comment_id: 3 });
    });

    it("does nothing when there are no bot comments", async () => {
      octokit.request.mockResolvedValueOnce({
        data: [{ id: 1, body: "normal comment" }],
      });

      await provider.deleteExistingBotComments();

      const deleteCalls = octokit.request.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === "string" && args[0].startsWith("DELETE"),
      );
      expect(deleteCalls).toHaveLength(0);
    });

    it("handles comments with undefined body", async () => {
      octokit.request.mockResolvedValueOnce({
        data: [
          { id: 1, body: undefined },
          { id: 2, body: "<!-- rusty-bot-review -->\nreview" },
        ],
      });

      await provider.deleteExistingBotComments();

      const deleteCalls = octokit.request.mock.calls.filter(
        (args: unknown[]) => typeof args[0] === "string" && args[0].startsWith("DELETE"),
      );
      expect(deleteCalls).toHaveLength(1);
      expect(deleteCalls[0][1]).toMatchObject({ comment_id: 2 });
    });
  });

  describe("postInlineComments", () => {
    it("creates a review with mapped comments", async () => {
      octokit.request.mockResolvedValueOnce({ data: {} });

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

      expect(octokit.request).toHaveBeenCalledWith(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        expect.objectContaining({
          owner: OWNER,
          repo: REPO,
          pull_number: PULL_NUMBER,
          event: "COMMENT",
          body: "",
          comments: expect.arrayContaining([
            expect.objectContaining({
              path: "src/index.ts",
              line: 10,
              side: "RIGHT",
            }),
            expect.objectContaining({
              path: "src/utils.ts",
              line: 25,
              side: "RIGHT",
            }),
          ]),
        }),
      );

      const call = octokit.request.mock.calls[0][1];
      expect(call.comments[0].body).toContain("SQL injection risk");
      expect(call.comments[0].body).toContain("```suggestion");
      expect(call.comments[1].body).not.toContain("```suggestion");
    });

    it("skips API call when findings array is empty", async () => {
      await provider.postInlineComments([]);

      expect(octokit.request).not.toHaveBeenCalled();
    });

    function makeFinding(overrides: Partial<Finding> = {}): Finding {
      return {
        file: "src/index.ts",
        line: 10,
        endLine: null,
        severity: "warning",
        category: "bugs",
        message: "issue",
        suggestedFix: null,
        ...overrides,
      };
    }

    function makePathResolutionError(): Error {
      const err = new Error("Unprocessable Entity") as Error & {
        status?: number;
        response?: unknown;
      };
      err.status = 422;
      err.response = {
        data: {
          message: "Unprocessable Entity",
          errors: ["Path could not be resolved"],
          status: "422",
        },
      };
      return err;
    }

    it("falls back to per-comment posts when batch returns 422 path-resolution", async () => {
      // batch fails, then 3 individual posts: 2 succeed, 1 fails (still 422)
      octokit.request
        .mockRejectedValueOnce(makePathResolutionError()) // batch
        .mockResolvedValueOnce({ data: {} }) // individual 1
        .mockRejectedValueOnce(makePathResolutionError()) // individual 2 (bad anchor)
        .mockResolvedValueOnce({ data: {} }); // individual 3

      await provider.postInlineComments([
        makeFinding({ file: "good-a.ts" }),
        makeFinding({ file: "bad.ts" }),
        makeFinding({ file: "good-b.ts" }),
      ]);

      // batch (1) + 3 individual = 4 calls total
      expect(octokit.request).toHaveBeenCalledTimes(4);
      // each individual call uses the same endpoint with a 1-comment batch
      const individualCalls = octokit.request.mock.calls.slice(1);
      for (const [, args] of individualCalls) {
        expect((args as { comments: unknown[] }).comments).toHaveLength(1);
      }
    });

    it("silently drops a single bad comment when batch fails with 1 finding", async () => {
      // batch with 1 comment fails — no fallback to attempt, just drop and log
      octokit.request.mockRejectedValueOnce(makePathResolutionError());

      await provider.postInlineComments([makeFinding({ file: "bad.ts" })]);

      // only the failed batch attempt happens; no retry
      expect(octokit.request).toHaveBeenCalledTimes(1);
    });

    it("propagates non-422 errors from the batch post", async () => {
      const err = Object.assign(new Error("network"), { status: 503 });
      octokit.request.mockRejectedValueOnce(err);

      await expect(
        provider.postInlineComments([makeFinding(), makeFinding({ file: "b.ts" })]),
      ).rejects.toThrow("network");
      expect(octokit.request).toHaveBeenCalledTimes(1);
    });

    it("propagates non-422 errors during per-comment fallback", async () => {
      // batch fails 422, first individual succeeds, second hits a network error
      const networkErr = Object.assign(new Error("network"), { status: 500 });
      octokit.request
        .mockRejectedValueOnce(makePathResolutionError())
        .mockResolvedValueOnce({ data: {} })
        .mockRejectedValueOnce(networkErr);

      await expect(
        provider.postInlineComments([makeFinding({ file: "a.ts" }), makeFinding({ file: "b.ts" })]),
      ).rejects.toThrow("network");
      // batch + 2 individuals (the second threw)
      expect(octokit.request).toHaveBeenCalledTimes(3);
    });

    it("does not attempt fallback when error is 422 with non-path-resolution body", async () => {
      // a 422 that isn't path-resolution (e.g., body too long) should NOT fallback
      const otherErr = Object.assign(new Error("Unprocessable Entity"), {
        status: 422,
        response: { data: { errors: ["body is too long"] } },
      });
      octokit.request.mockRejectedValueOnce(otherErr);

      await expect(
        provider.postInlineComments([makeFinding(), makeFinding({ file: "b.ts" })]),
      ).rejects.toThrow("Unprocessable Entity");
      // batch attempt only — no retry on a different 422 class
      expect(octokit.request).toHaveBeenCalledTimes(1);
    });

    it("drops every comment when the fallback loop also fails for all of them", async () => {
      // batch 422, then every individual post 422s too. each one path-resolution.
      // expected behavior: log every drop, post nothing, do NOT throw — summary
      // comment is already up and the action shouldn't go red for an inline-only
      // failure class.
      octokit.request
        .mockRejectedValueOnce(makePathResolutionError()) // batch
        .mockRejectedValueOnce(makePathResolutionError()) // individual 1
        .mockRejectedValueOnce(makePathResolutionError()) // individual 2
        .mockRejectedValueOnce(makePathResolutionError()); // individual 3

      await provider.postInlineComments([
        makeFinding({ file: "bad-a.ts" }),
        makeFinding({ file: "bad-b.ts" }),
        makeFinding({ file: "bad-c.ts" }),
      ]);

      // 1 batch + 3 individual = 4 requests
      expect(octokit.request).toHaveBeenCalledTimes(4);
      // none of the individuals succeeded — the function returns normally
      // without throwing. (no assertion on rejection)
    });

    it("emits a single-line payload (no start_line/start_side) when endLine is null", async () => {
      octokit.request.mockResolvedValueOnce({ data: {} });

      await provider.postInlineComments([
        makeFinding({ file: "src/single.ts", line: 42, endLine: null }),
      ]);

      const call = octokit.request.mock.calls[0][1] as {
        comments: {
          path: string;
          line: number;
          side: string;
          start_line?: number;
          start_side?: string;
        }[];
      };
      expect(call.comments).toHaveLength(1);
      expect(call.comments[0]).toEqual(
        expect.objectContaining({
          path: "src/single.ts",
          line: 42,
          side: "RIGHT",
        }),
      );
      expect(call.comments[0].start_line).toBeUndefined();
      expect(call.comments[0].start_side).toBeUndefined();
    });

    it("treats endLine: 0 as single-line (falsy guard, no start_line/start_side)", async () => {
      // 0 is a degenerate value — could come from a model that emitted a bare
      // zero instead of null. The multi-line gate
      // (`finding.endLine && finding.endLine !== finding.line`) treats 0 as
      // falsy and correctly omits start_line/start_side, so we don't emit a
      // bogus multi-line payload that github would reject.
      // (Note: the `line` field uses `endLine ?? line` so endLine=0 *does*
      // land in `line`. That's tangential to the single-line property and
      // would be caught upstream by filterAnchorableFindings; not asserted
      // here to keep the test focused on the multi-line gating behavior.)
      octokit.request.mockResolvedValueOnce({ data: {} });

      await provider.postInlineComments([
        makeFinding({ file: "src/deg.ts", line: 7, endLine: 0 as unknown as null }),
      ]);

      const call = octokit.request.mock.calls[0][1] as {
        comments: { start_line?: number; start_side?: string }[];
      };
      expect(call.comments).toHaveLength(1);
      expect(call.comments[0].start_line).toBeUndefined();
      expect(call.comments[0].start_side).toBeUndefined();
    });
  });

  describe("getLinkedIssueNumbers", () => {
    it("returns issue numbers from closingIssuesReferences", async () => {
      octokit.graphql.mockResolvedValueOnce({
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: [{ number: 16 }, { number: 42 }],
            },
          },
        },
      });

      const numbers = await provider.getLinkedIssueNumbers();

      expect(numbers).toEqual([16, 42]);
      expect(octokit.graphql).toHaveBeenCalledWith(
        expect.stringContaining("closingIssuesReferences"),
        { owner: OWNER, repo: REPO, pr: PULL_NUMBER },
      );
    });

    it("returns empty array when no issues are linked", async () => {
      octokit.graphql.mockResolvedValueOnce({
        repository: {
          pullRequest: {
            closingIssuesReferences: { nodes: [] },
          },
        },
      });

      const numbers = await provider.getLinkedIssueNumbers();
      expect(numbers).toEqual([]);
    });

    it("returns empty array when pullRequest is null", async () => {
      octokit.graphql.mockResolvedValueOnce({
        repository: { pullRequest: null },
      });

      const numbers = await provider.getLinkedIssueNumbers();
      expect(numbers).toEqual([]);
    });

    it("returns empty array when repository is null", async () => {
      octokit.graphql.mockResolvedValueOnce({ repository: null });

      const numbers = await provider.getLinkedIssueNumbers();
      expect(numbers).toEqual([]);
    });

    it("returns empty array when closingIssuesReferences is missing", async () => {
      octokit.graphql.mockResolvedValueOnce({
        repository: { pullRequest: {} },
      });

      const numbers = await provider.getLinkedIssueNumbers();
      expect(numbers).toEqual([]);
    });
  });

  describe("getDiff", () => {
    it("parses a unified diff into FilePatch objects", async () => {
      const rawDiff = [
        "diff --git a/file.ts b/file.ts",
        "index abc..def 100644",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1,3 +1,4 @@",
        " line1",
        "-old line",
        "+new line",
        "+added line",
        " line3",
      ].join("\n");

      octokit.request.mockResolvedValueOnce({ data: rawDiff });

      const patches = await provider.getDiff();

      expect(patches).toHaveLength(1);
      expect(patches[0].path).toBe("file.ts");
      expect(patches[0].additions).toBe(2);
      expect(patches[0].deletions).toBe(1);
      expect(patches[0].isBinary).toBe(false);
      expect(patches[0].hunks).toHaveLength(1);
      expect(patches[0].hunks[0].oldStart).toBe(1);
      expect(patches[0].hunks[0].newStart).toBe(1);
      expect(patches[0].hunks[0].newLines).toBe(4);
    });

    it("handles multiple files in a single diff", async () => {
      const rawDiff = [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/b.ts b/b.ts",
        "--- a/b.ts",
        "+++ b/b.ts",
        "@@ -1 +1,2 @@",
        " keep",
        "+added",
      ].join("\n");

      octokit.request.mockResolvedValueOnce({ data: rawDiff });

      const patches = await provider.getDiff();

      expect(patches).toHaveLength(2);
      expect(patches[0].path).toBe("a.ts");
      expect(patches[1].path).toBe("b.ts");
      expect(patches[1].additions).toBe(1);
      expect(patches[1].deletions).toBe(0);
    });

    it("marks binary files correctly", async () => {
      const rawDiff = [
        "diff --git a/image.png b/image.png",
        "Binary files /dev/null and b/image.png differ",
      ].join("\n");

      octokit.request.mockResolvedValueOnce({ data: rawDiff });

      const patches = await provider.getDiff();

      expect(patches).toHaveLength(1);
      expect(patches[0].isBinary).toBe(true);
      expect(patches[0].hunks).toHaveLength(0);
    });

    it("handles multiple hunks in one file", async () => {
      const rawDiff = [
        "diff --git a/file.ts b/file.ts",
        "--- a/file.ts",
        "+++ b/file.ts",
        "@@ -1,3 +1,3 @@",
        " a",
        "-b",
        "+c",
        " d",
        "@@ -10,3 +10,4 @@",
        " x",
        " y",
        "+z",
        " w",
      ].join("\n");

      octokit.request.mockResolvedValueOnce({ data: rawDiff });

      const patches = await provider.getDiff();

      expect(patches).toHaveLength(1);
      expect(patches[0].hunks).toHaveLength(2);
      expect(patches[0].hunks[0].oldStart).toBe(1);
      expect(patches[0].hunks[1].oldStart).toBe(10);
      expect(patches[0].hunks[1].newLines).toBe(4);
    });

    it("returns empty array for empty diff", async () => {
      octokit.request.mockResolvedValueOnce({ data: "" });

      const patches = await provider.getDiff();

      expect(patches).toHaveLength(0);
    });
  });

  describe("updatePRTitle", () => {
    it("PATCHes the pull request with the new title", async () => {
      octokit.request.mockResolvedValueOnce({ data: {} });

      await provider.updatePRTitle("feat: new feature");

      expect(octokit.request).toHaveBeenCalledWith(
        "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: OWNER,
          repo: REPO,
          pull_number: PULL_NUMBER,
          title: "feat: new feature",
        },
      );
    });
  });
});
