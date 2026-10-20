import { describe, it, expect, vi, afterEach } from "vitest";
import { ToolCache } from "../agent/tool-cache.js";
import { SearchUnavailableError } from "../agent/search-errors.js";

function makeProvider() {
  return {
    searchCode: vi.fn(async (query: string) => [
      { file: `${query}.ts`, line: 1, content: `const ${query} = 1` },
    ]),
    getFileContent: vi.fn(async (path: string) => `content of ${path}`),
  };
}

describe("ToolCache", () => {
  it("deduplicates concurrent searchCode calls with the same query", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(provider as any, "main");

    const [a, b] = await Promise.all([cache.searchCode("foo"), cache.searchCode("foo")]);

    expect(a).toEqual(b);
    expect(provider.searchCode).toHaveBeenCalledTimes(1);
    expect(provider.searchCode).toHaveBeenCalledWith("foo");
  });

  it("deduplicates sequential searchCode calls with the same query", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(provider as any, "main");

    const a = await cache.searchCode("foo");
    const b = await cache.searchCode("foo");

    expect(a).toEqual(b);
    expect(provider.searchCode).toHaveBeenCalledTimes(1);
  });

  it("does not deduplicate different searchCode queries", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(provider as any, "main");

    await Promise.all([cache.searchCode("foo"), cache.searchCode("bar")]);

    expect(provider.searchCode).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent getFileContent calls with the same path", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(provider as any, "main");

    const [a, b] = await Promise.all([
      cache.getFileContent("src/index.ts"),
      cache.getFileContent("src/index.ts"),
    ]);

    expect(a).toEqual(b);
    expect(provider.getFileContent).toHaveBeenCalledTimes(1);
    expect(provider.getFileContent).toHaveBeenCalledWith("src/index.ts", "main");
  });

  it("does not deduplicate different getFileContent paths", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(provider as any, "main");

    await Promise.all([cache.getFileContent("src/a.ts"), cache.getFileContent("src/b.ts")]);

    expect(provider.getFileContent).toHaveBeenCalledTimes(2);
  });

  it("caches search and file calls independently", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(provider as any, "main");

    await cache.searchCode("query");
    await cache.getFileContent("path");

    expect(provider.searchCode).toHaveBeenCalledTimes(1);
    expect(provider.getFileContent).toHaveBeenCalledTimes(1);
  });
});

describe("ToolCache search unavailability", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeRateLimitedProvider(retryAfterMs?: number) {
    return {
      searchCode: vi.fn(async () => {
        throw new SearchUnavailableError("rate_limited", retryAfterMs);
      }),
      getFileContent: vi.fn(),
    };
  }

  it("short-circuits every query during the cooldown without calling the provider", async () => {
    const provider = makeRateLimitedProvider();
    const cache = new ToolCache(provider as any, "main");

    await expect(cache.searchCode("foo")).rejects.toBeInstanceOf(SearchUnavailableError);
    await expect(cache.searchCode("bar")).rejects.toMatchObject({ reason: "rate_limited" });
    await expect(cache.searchCode("foo")).rejects.toBeInstanceOf(SearchUnavailableError);

    expect(provider.searchCode).toHaveBeenCalledTimes(1);
  });

  it("calls the provider again once the cooldown has passed", async () => {
    vi.useFakeTimers();
    const provider = makeRateLimitedProvider();
    const cache = new ToolCache(provider as any, "main");

    await expect(cache.searchCode("foo")).rejects.toBeInstanceOf(SearchUnavailableError);
    vi.advanceTimersByTime(59_000);
    await expect(cache.searchCode("foo")).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(provider.searchCode).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2_000);
    await expect(cache.searchCode("foo")).rejects.toBeInstanceOf(SearchUnavailableError);
    expect(provider.searchCode).toHaveBeenCalledTimes(2);
  });

  it("honours retryAfterMs from the error for the cooldown", async () => {
    vi.useFakeTimers();
    const provider = makeRateLimitedProvider(5_000);
    const cache = new ToolCache(provider as any, "main");

    await expect(cache.searchCode("foo")).rejects.toBeInstanceOf(SearchUnavailableError);
    vi.advanceTimersByTime(6_000);
    await expect(cache.searchCode("foo")).rejects.toBeInstanceOf(SearchUnavailableError);

    expect(provider.searchCode).toHaveBeenCalledTimes(2);
  });

  it("does not memoize a failed search forever", async () => {
    const provider = {
      searchCode: vi
        .fn()
        .mockRejectedValueOnce(new SearchUnavailableError("failed"))
        .mockResolvedValueOnce([{ file: "a.ts", line: 1, content: "x" }]),
      getFileContent: vi.fn(),
    };
    const cache = new ToolCache(provider as any, "main");

    await expect(cache.searchCode("foo")).rejects.toMatchObject({ reason: "failed" });
    const retry = await cache.searchCode("foo");

    expect(retry.count).toBe(1);
    expect(provider.searchCode).toHaveBeenCalledTimes(2);
  });

  it("still memoizes normal results per query", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(provider as any, "main");

    await cache.searchCode("foo");
    await cache.searchCode("foo");
    await cache.searchCode("bar");

    expect(provider.searchCode).toHaveBeenCalledTimes(2);
  });
});
