import { tool } from "ai";
import { z } from "zod";
import type { ToolCache } from "./tool-cache.js";
import { SearchUnavailableError } from "./search-errors.js";

export const MAX_SEARCH_RESULTS = 5;
export const MAX_SEARCH_FRAGMENT_CHARS = 300;

export function capSearchResults(input: {
  results: { file: string; line: number; content: string }[];
  count: number;
}) {
  const results = input.results.slice(0, MAX_SEARCH_RESULTS).map((r) => ({
    ...r,
    content:
      r.content.length > MAX_SEARCH_FRAGMENT_CHARS
        ? r.content.slice(0, MAX_SEARCH_FRAGMENT_CHARS) + "…"
        : r.content,
  }));
  return { results, totalMatches: input.count, shown: results.length };
}

export function createSearchCodeTool(cache: ToolCache) {
  return tool({
    description:
      "Search the codebase for references to a symbol, function name, import, or string. " +
      "Use this to verify whether removed or renamed exports are still used elsewhere " +
      `before reporting them as issues. Returns up to ${MAX_SEARCH_RESULTS} matches with ` +
      `snippets truncated to ${MAX_SEARCH_FRAGMENT_CHARS} characters; if totalMatches ` +
      "exceeds shown, narrow the query to see more. Results come from the repository's " +
      "default branch, so symbols added or renamed in this PR will not be found. " +
      "If the output has unavailable: true the search did not run; that is not evidence of absence.",
    inputSchema: z.object({
      query: z.string().describe("symbol name, function name, or search term to find usages of"),
    }),
    outputSchema: z.object({
      results: z.array(
        z.object({
          file: z.string(),
          line: z.number(),
          content: z.string(),
        }),
      ),
      totalMatches: z.number(),
      shown: z.number(),
      unavailable: z.boolean().optional(),
      note: z.string().optional(),
    }),
    execute: async ({ query }) => {
      try {
        return capSearchResults(await cache.searchCode(query));
      } catch (err) {
        if (!(err instanceof SearchUnavailableError)) throw err;
        return {
          results: [],
          totalMatches: 0,
          shown: 0,
          unavailable: true,
          note:
            `code search is unavailable right now (${err.reason}). This is NOT evidence that ` +
            "the symbol is unused — do not retry, and do not report unused/missing-reference " +
            "findings that depend on it.",
        };
      }
    },
  });
}

export const MAX_FILE_CONTEXT_CHARS = 12_000;

export function capFileContent(input: { content: string | null }) {
  if (input.content === null) {
    return { content: null, truncated: false, totalChars: 0 };
  }
  const totalChars = input.content.length;
  if (totalChars <= MAX_FILE_CONTEXT_CHARS) {
    return { content: input.content, truncated: false, totalChars };
  }
  const remaining = totalChars - MAX_FILE_CONTEXT_CHARS;
  return {
    content:
      input.content.slice(0, MAX_FILE_CONTEXT_CHARS) +
      `\n... [file truncated, ${remaining} more characters]`,
    truncated: true,
    totalChars,
  };
}

export function createGetFileContextTool(cache: ToolCache) {
  return tool({
    description:
      "Fetch the content of a file from the repository. " +
      "Use this when you need to see more context around a change than what the diff " +
      `provides. Returns up to ${MAX_FILE_CONTEXT_CHARS} characters; if truncated is ` +
      "true, narrow your investigation to a more specific path or accept the partial view.",
    inputSchema: z.object({
      path: z.string().describe("file path relative to repo root"),
    }),
    outputSchema: z.object({
      content: z.string().nullable(),
      truncated: z.boolean(),
      totalChars: z.number(),
    }),
    execute: async ({ path }) => capFileContent(await cache.getFileContent(path)),
  });
}
