import { describe, it, expect } from "vitest";
import { SearchUnavailableError } from "../agent/search-errors.js";
import {
  createSearchCodeTool,
  capSearchResults,
  capFileContent,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_FRAGMENT_CHARS,
  MAX_FILE_CONTEXT_CHARS,
} from "../agent/tools.js";

function makeResult(file: string, content: string) {
  return { file, line: 1, content };
}

describe("capSearchResults", () => {
  it("slices results down to MAX_SEARCH_RESULTS", () => {
    const results = Array.from({ length: 20 }, (_, i) => makeResult(`f${i}.ts`, "x"));
    const out = capSearchResults({ results, count: results.length });

    expect(out.results).toHaveLength(MAX_SEARCH_RESULTS);
    expect(out.shown).toBe(MAX_SEARCH_RESULTS);
    expect(out.totalMatches).toBe(20);
  });

  it("preserves all results when there are fewer than the cap", () => {
    const results = [makeResult("a.ts", "x"), makeResult("b.ts", "y")];
    const out = capSearchResults({ results, count: results.length });

    expect(out.results).toHaveLength(2);
    expect(out.shown).toBe(2);
    expect(out.totalMatches).toBe(2);
  });

  it("truncates fragments longer than MAX_SEARCH_FRAGMENT_CHARS and appends an ellipsis", () => {
    const longContent = "a".repeat(MAX_SEARCH_FRAGMENT_CHARS + 50);
    const out = capSearchResults({
      results: [makeResult("big.ts", longContent)],
      count: 1,
    });

    const content = out.results[0].content;
    expect(content.length).toBe(MAX_SEARCH_FRAGMENT_CHARS + 1);
    expect(content.endsWith("…")).toBe(true);
    expect(content.startsWith("a".repeat(MAX_SEARCH_FRAGMENT_CHARS))).toBe(true);
  });

  it("leaves fragments at exactly the threshold untouched", () => {
    const content = "a".repeat(MAX_SEARCH_FRAGMENT_CHARS);
    const out = capSearchResults({ results: [makeResult("edge.ts", content)], count: 1 });

    expect(out.results[0].content).toBe(content);
    expect(out.results[0].content.endsWith("…")).toBe(false);
  });

  it("reports the original total even after slicing", () => {
    const results = Array.from({ length: 50 }, (_, i) => makeResult(`f${i}.ts`, "x"));
    const out = capSearchResults({ results, count: 137 });

    expect(out.results).toHaveLength(MAX_SEARCH_RESULTS);
    expect(out.shown).toBe(MAX_SEARCH_RESULTS);
    expect(out.totalMatches).toBe(137);
  });

  it("handles an empty result set", () => {
    const out = capSearchResults({ results: [], count: 0 });

    expect(out.results).toHaveLength(0);
    expect(out.shown).toBe(0);
    expect(out.totalMatches).toBe(0);
  });

  it("preserves file and line metadata while truncating content", () => {
    const longContent = "z".repeat(MAX_SEARCH_FRAGMENT_CHARS + 1);
    const out = capSearchResults({
      results: [{ file: "src/a.ts", line: 42, content: longContent }],
      count: 1,
    });

    expect(out.results[0].file).toBe("src/a.ts");
    expect(out.results[0].line).toBe(42);
    expect(out.results[0].content.length).toBe(MAX_SEARCH_FRAGMENT_CHARS + 1);
  });
});

describe("capFileContent", () => {
  it("returns null content untouched and reports zero totalChars", () => {
    const out = capFileContent({ content: null });

    expect(out.content).toBeNull();
    expect(out.truncated).toBe(false);
    expect(out.totalChars).toBe(0);
  });

  it("passes through content shorter than the cap unchanged", () => {
    const content = "small file body";
    const out = capFileContent({ content });

    expect(out.content).toBe(content);
    expect(out.truncated).toBe(false);
    expect(out.totalChars).toBe(content.length);
  });

  it("treats content at exactly the cap as not truncated", () => {
    const content = "x".repeat(MAX_FILE_CONTEXT_CHARS);
    const out = capFileContent({ content });

    expect(out.content).toBe(content);
    expect(out.truncated).toBe(false);
    expect(out.totalChars).toBe(MAX_FILE_CONTEXT_CHARS);
  });

  it("truncates content larger than the cap and appends a remaining-char hint", () => {
    const remaining = 500;
    const content = "y".repeat(MAX_FILE_CONTEXT_CHARS + remaining);
    const out = capFileContent({ content });

    expect(out.truncated).toBe(true);
    expect(out.totalChars).toBe(MAX_FILE_CONTEXT_CHARS + remaining);
    expect(out.content).not.toBeNull();
    expect(out.content!.startsWith("y".repeat(MAX_FILE_CONTEXT_CHARS))).toBe(true);
    expect(out.content!.endsWith(`[file truncated, ${remaining} more characters]`)).toBe(true);
  });

  it("reports the original totalChars even when content is truncated", () => {
    const total = MAX_FILE_CONTEXT_CHARS * 5;
    const out = capFileContent({ content: "z".repeat(total) });

    expect(out.totalChars).toBe(total);
    expect(out.truncated).toBe(true);
  });
});

describe("createSearchCodeTool", () => {
  function run(cache: unknown) {
    const tool = createSearchCodeTool(cache as any);
    return tool.execute!({ query: "foo" }, {} as any) as Promise<any>;
  }

  it("reports unavailable with a not-evidence note when the search is rate limited", async () => {
    const out = await run({
      searchCode: async () => {
        throw new SearchUnavailableError("rate_limited");
      },
    });

    expect(out.unavailable).toBe(true);
    expect(out.note).toContain("NOT evidence");
    expect(out.note).toContain("rate_limited");
    expect(out.results).toEqual([]);
    expect(out.totalMatches).toBe(0);
    expect(out.shown).toBe(0);
  });

  it("reports unavailable for a generic failed search", async () => {
    const out = await run({
      searchCode: async () => {
        throw new SearchUnavailableError("failed");
      },
    });

    expect(out.unavailable).toBe(true);
    expect(out.note).toContain("failed");
  });

  it("rethrows errors that are not SearchUnavailableError", async () => {
    await expect(
      run({
        searchCode: async () => {
          throw new Error("boom");
        },
      }),
    ).rejects.toThrow("boom");
  });

  it("does not set unavailable for a genuine empty result", async () => {
    const out = await run({ searchCode: async () => ({ results: [], count: 0 }) });

    expect(out).toEqual({ results: [], totalMatches: 0, shown: 0 });
    expect("unavailable" in out).toBe(false);
  });

  it("mentions the default-branch limitation in the description", () => {
    const tool = createSearchCodeTool({} as any);
    expect(tool.description).toContain("default branch");
  });
});
