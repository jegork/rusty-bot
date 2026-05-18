import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReviewRecord, RepoConfig } from "../storage.js";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(async () => undefined),
}));

const fs = await import("node:fs/promises");
const { saveReview, setRepoConfig, setSetting } = await import("../storage.js");

const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);

function makeReview(id: string): ReviewRecord {
  return {
    id,
    owner: "test",
    repo: "test",
    prNumber: 1,
    timestamp: new Date().toISOString(),
    findingsCount: 0,
    criticalCount: 0,
    warningCount: 0,
    suggestionCount: 0,
    modelUsed: "test-model",
    tokenCount: 100,
    recommendation: "looks_good",
    prUrl: "https://example.com/pr/1",
  };
}

function makeConfig(owner: string, repo: string): RepoConfig {
  return {
    owner,
    repo,
    style: "balanced",
    focusAreas: [],
    ignorePatterns: [],
  };
}

describe("storage write-lock serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readFile.mockResolvedValue(JSON.stringify({ configs: {}, reviews: [], settings: {} }));
    writeFile.mockResolvedValue(undefined);
  });

  it("serializes two concurrent saveReview calls (no interleaved read/write)", async () => {
    // record every fs op in call-order so we can verify it never goes
    // read→read→write→write (which would be the buggy interleave)
    const events: string[] = [];
    readFile.mockImplementation(async () => {
      events.push("read");
      // give the other concurrent caller a chance to interleave if not serialized
      await new Promise((r) => setTimeout(r, 5));
      return JSON.stringify({ configs: {}, reviews: [], settings: {} });
    });
    writeFile.mockImplementation(async () => {
      events.push("write");
    });

    await Promise.all([saveReview(makeReview("r1")), saveReview(makeReview("r2"))]);

    // serialized: read, write, read, write — never read, read, write, write
    expect(events).toEqual(["read", "write", "read", "write"]);
  });

  it("serializes mixed write types (setRepoConfig + saveReview + setSetting)", async () => {
    const events: string[] = [];
    readFile.mockImplementation(async () => {
      events.push("read");
      await new Promise((r) => setTimeout(r, 2));
      return JSON.stringify({ configs: {}, reviews: [], settings: {} });
    });
    writeFile.mockImplementation(async () => {
      events.push("write");
    });

    await Promise.all([
      setRepoConfig("a", "b", makeConfig("a", "b")),
      saveReview(makeReview("r1")),
      setSetting("k", "v"),
    ]);

    // 3 writes, all serialized — no interleaving regardless of mutation type
    expect(events.filter((e) => e === "read")).toHaveLength(3);
    expect(events.filter((e) => e === "write")).toHaveLength(3);
    // every read should be followed immediately by its own write
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i]).toBe("read");
      expect(events[i + 1]).toBe("write");
    }
  });

  it("does not break the serialization chain when a write throws", async () => {
    // first write rejects on save; the second write must still execute
    // afterwards (the lock chain has to recover from rejected upstream)
    let writeCallCount = 0;
    readFile.mockResolvedValue(JSON.stringify({ configs: {}, reviews: [], settings: {} }));
    writeFile.mockImplementation(async () => {
      writeCallCount++;
      if (writeCallCount === 1) throw new Error("disk full (simulated)");
    });

    const failing = saveReview(makeReview("r1"));
    const succeeding = saveReview(makeReview("r2"));

    await expect(failing).rejects.toThrow("disk full");
    await expect(succeeding).resolves.toBe("r2"); // didn't get stuck behind the rejection
    expect(writeCallCount).toBe(2);
  });
});
