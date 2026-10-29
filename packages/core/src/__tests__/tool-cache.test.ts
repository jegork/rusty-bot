import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ToolCache, checkoutCodeSource, providerCodeSource } from "../agent/tool-cache.js";
import { RepoCheckout } from "../repo/checkout.js";
import { gitEnv } from "../repo/git-env.js";
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
    const cache = new ToolCache(providerCodeSource(provider as any, "main"));

    const [a, b] = await Promise.all([cache.searchCode("foo"), cache.searchCode("foo")]);

    expect(a).toEqual(b);
    expect(provider.searchCode).toHaveBeenCalledTimes(1);
    expect(provider.searchCode).toHaveBeenCalledWith("foo");
  });

  it("deduplicates sequential searchCode calls with the same query", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(providerCodeSource(provider as any, "main"));

    const a = await cache.searchCode("foo");
    const b = await cache.searchCode("foo");

    expect(a).toEqual(b);
    expect(provider.searchCode).toHaveBeenCalledTimes(1);
  });

  it("does not deduplicate different searchCode queries", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(providerCodeSource(provider as any, "main"));

    await Promise.all([cache.searchCode("foo"), cache.searchCode("bar")]);

    expect(provider.searchCode).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent getFileContent calls with the same path", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(providerCodeSource(provider as any, "main"));

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
    const cache = new ToolCache(providerCodeSource(provider as any, "main"));

    await Promise.all([cache.getFileContent("src/a.ts"), cache.getFileContent("src/b.ts")]);

    expect(provider.getFileContent).toHaveBeenCalledTimes(2);
  });

  it("caches search and file calls independently", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(providerCodeSource(provider as any, "main"));

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
    const cache = new ToolCache(providerCodeSource(provider as any, "main"));

    await expect(cache.searchCode("foo")).rejects.toBeInstanceOf(SearchUnavailableError);
    await expect(cache.searchCode("bar")).rejects.toMatchObject({ reason: "rate_limited" });
    await expect(cache.searchCode("foo")).rejects.toBeInstanceOf(SearchUnavailableError);

    expect(provider.searchCode).toHaveBeenCalledTimes(1);
  });

  it("calls the provider again once the cooldown has passed", async () => {
    vi.useFakeTimers();
    const provider = makeRateLimitedProvider();
    const cache = new ToolCache(providerCodeSource(provider as any, "main"));

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
    const cache = new ToolCache(providerCodeSource(provider as any, "main"));

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
    const cache = new ToolCache(providerCodeSource(provider as any, "main"));

    await expect(cache.searchCode("foo")).rejects.toMatchObject({ reason: "failed" });
    const retry = await cache.searchCode("foo");

    expect(retry.count).toBe(1);
    expect(provider.searchCode).toHaveBeenCalledTimes(2);
  });

  it("still memoizes normal results per query", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(providerCodeSource(provider as any, "main"));

    await cache.searchCode("foo");
    await cache.searchCode("foo");
    await cache.searchCode("bar");

    expect(provider.searchCode).toHaveBeenCalledTimes(2);
  });
});

describe("ToolCache over a checkout source", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function setupCheckout(): Promise<RepoCheckout> {
    const path = await mkdtemp(join(tmpdir(), "rusty-tool-cache-"));
    dirs.push(path);
    const env = gitEnv({
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
    });
    const git = (args: string[]) => execFileSync("git", args, { cwd: path, env }).toString().trim();
    git(["init", "--initial-branch=main", "--quiet"]);
    git(["config", "commit.gpgsign", "false"]);
    await writeFile(join(path, "a.ts"), "export const headOnly = 1;\n");
    git(["add", "."]);
    git(["commit", "-m", "head", "--quiet"]);
    return new RepoCheckout({
      repoPath: path,
      tree: git(["rev-parse", "HEAD"]),
      approximate: false,
    });
  }

  it("exposes the pr-head scope and the checkout's approximate flag", async () => {
    const checkout = await setupCheckout();
    const exact = new ToolCache(checkoutCodeSource(checkout));
    const approx = new ToolCache(
      checkoutCodeSource(
        new RepoCheckout({ repoPath: checkout.repoPath, tree: "HEAD", approximate: true }),
      ),
    );

    expect(exact.scope).toBe("pr-head");
    expect(exact.approximate).toBe(false);
    expect(approx.approximate).toBe(true);
  });

  it("memoises grep and readFile against the real checkout", async () => {
    const checkout = await setupCheckout();
    const grep = vi.spyOn(checkout, "grep");
    const readFile = vi.spyOn(checkout, "readFile");
    const cache = new ToolCache(checkoutCodeSource(checkout));

    const [a, b] = await Promise.all([cache.searchCode("headOnly"), cache.searchCode("headOnly")]);
    await cache.getFileContent("a.ts");
    const file = await cache.getFileContent("a.ts");

    expect(a).toEqual({
      results: [{ file: "a.ts", line: 1, content: "export const headOnly = 1;" }],
      count: 1,
    });
    expect(b).toEqual(a);
    expect(grep).toHaveBeenCalledTimes(1);
    expect(file.content).toBe("export const headOnly = 1;\n");
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("never enters the rate-limit cooldown, however many queries run", async () => {
    const checkout = await setupCheckout();
    const cache = new ToolCache(checkoutCodeSource(checkout));

    for (let i = 0; i < 15; i++) {
      await expect(cache.searchCode(`missing${i}`)).resolves.toEqual({ results: [], count: 0 });
    }
    await expect(cache.searchCode("headOnly")).resolves.toMatchObject({ count: 1 });
  });

  it("returns null for a path outside the tree instead of throwing", async () => {
    const cache = new ToolCache(checkoutCodeSource(await setupCheckout()));

    await expect(cache.getFileContent("nope.ts")).resolves.toEqual({ content: null });
    await expect(cache.getFileContent("--output=/tmp/x")).resolves.toEqual({ content: null });
  });
});

describe("providerCodeSource", () => {
  it("reports the remote scope and passes the ref to the provider", async () => {
    const provider = makeProvider();
    const cache = new ToolCache(providerCodeSource(provider as any, "feature"));

    await cache.getFileContent("x.ts");

    expect(cache.scope).toBe("remote");
    expect(cache.approximate).toBe(false);
    expect(provider.getFileContent).toHaveBeenCalledWith("x.ts", "feature");
  });
});
