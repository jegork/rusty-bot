import { describe, it, expect, vi } from "vitest";
import { fetchConventionFile } from "../convention-file.js";

function makeFetcher(files: Record<string, string>) {
  return vi.fn(async (path: string, _ref: string) => files[path] ?? null);
}

describe("fetchConventionFile", () => {
  it("returns .rusty-bot.md when it exists", async () => {
    const fetcher = makeFetcher({ ".rusty-bot.md": "be strict on security" });
    const result = await fetchConventionFile(fetcher, "main");

    expect(result).toBe("be strict on security");
    expect(fetcher).toHaveBeenCalledWith(".rusty-bot.md", "main");
  });

  it("falls back to REVIEW-BOT.md when .rusty-bot.md is missing", async () => {
    const fetcher = makeFetcher({ "REVIEW-BOT.md": "ignore generated/" });
    const result = await fetchConventionFile(fetcher, "main");

    expect(result).toBe("ignore generated/");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("falls back to AGENTS.md when the first two are missing", async () => {
    const fetcher = makeFetcher({ "AGENTS.md": "use effect-ts conventions" });
    const result = await fetchConventionFile(fetcher, "main");

    expect(result).toBe("use effect-ts conventions");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("returns null when no convention files exist", async () => {
    const fetcher = makeFetcher({});
    const result = await fetchConventionFile(fetcher, "main");

    expect(result).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("uses the highest-priority file when multiple exist", async () => {
    const fetcher = makeFetcher({
      ".rusty-bot.md": "from rusty-bot",
      "REVIEW-BOT.md": "from review-bot",
      "AGENTS.md": "from agents",
    });
    const result = await fetchConventionFile(fetcher, "main");

    expect(result).toBe("from rusty-bot");
  });

  it("stops fetching after the first match", async () => {
    const fetcher = makeFetcher({
      ".rusty-bot.md": "found",
      "REVIEW-BOT.md": "should not reach",
    });
    await fetchConventionFile(fetcher, "main");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalledWith("REVIEW-BOT.md", "main");
  });

  it("passes the ref to getFileContent", async () => {
    const fetcher = makeFetcher({ ".rusty-bot.md": "content" });
    await fetchConventionFile(fetcher, "develop");

    expect(fetcher).toHaveBeenCalledWith(".rusty-bot.md", "develop");
  });

  it("truncates content that exceeds the token limit", async () => {
    // 15000 tokens * 4 chars/token = 60000 chars
    const longContent = "x".repeat(75_000);
    const fetcher = makeFetcher({ ".rusty-bot.md": longContent });
    const result = await fetchConventionFile(fetcher, "main");

    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(60_000);
  });

  it("does not truncate content exactly at the token limit", async () => {
    const content = "a".repeat(60_000);
    const fetcher = makeFetcher({ ".rusty-bot.md": content });
    const result = await fetchConventionFile(fetcher, "main");

    expect(result).toBe(content);
  });

  it("truncates content one character over the token limit", async () => {
    const content = "a".repeat(60_001);
    const fetcher = makeFetcher({ ".rusty-bot.md": content });
    const result = await fetchConventionFile(fetcher, "main");

    expect(result!.length).toBe(60_000);
  });

  it("keeps a convention file of ~11.5k tokens whole", async () => {
    // the size of a real downstream REVIEW-BOT.md that the old 5k limit cut in half
    const content = "b".repeat(46_000);
    const fetcher = makeFetcher({ ".rusty-bot.md": content });
    const result = await fetchConventionFile(fetcher, "main");

    expect(result).toBe(content);
  });

  it("truncates at newline boundaries", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}: ${"x".repeat(20)}`);
    const longContent = lines.join("\n");
    const fetcher = makeFetcher({ ".rusty-bot.md": longContent });
    const result = await fetchConventionFile(fetcher, "main");

    expect(result).not.toBeNull();
    expect(result!.endsWith("\n")).toBe(false);
    // should end at a complete line, not mid-line
    const lastChar = result!.at(-1);
    expect(lastChar).not.toBe(undefined);
    expect(result!.includes("\n")).toBe(true);
    expect(result!.length).toBeLessThan(longContent.length);
  });

  it("returns null and does not throw when fetcher throws", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("network timeout");
    });
    const result = await fetchConventionFile(fetcher, "main");

    expect(result).toBeNull();
  });

  it("skips erroring file and tries the next one", async () => {
    let callCount = 0;
    const fetcher = vi.fn(async (path: string, _ref: string) => {
      callCount++;
      if (path === ".rusty-bot.md") throw new Error("403 forbidden");
      if (path === "REVIEW-BOT.md") return "fallback content";
      return null;
    });

    const result = await fetchConventionFile(fetcher, "main");

    expect(result).toBe("fallback content");
    expect(callCount).toBe(2);
  });
});
