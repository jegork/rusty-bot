import { describe, expect, it } from "vitest";
import { compressDiff, countTokens } from "../diff/compress.js";
import type { FilePatch } from "../types.js";

/**
 * Token-decrease benchmark for `compressDiff`. Asserts that the post-refactor
 * implementation (which emits context lines exactly once) is at least 30% cheaper
 * than the pre-refactor dual-emit shape on a context-heavy fixture.
 *
 * Why a percentage instead of an absolute cap: countTokens uses a rough
 * Math.ceil(length/4) heuristic, which is volatile under small format tweaks
 * (block markers, blank lines). What we actually care about is the relative
 * win — context lines must not appear twice anymore.
 */

function makeContextHeavyHunk(contextLines: number, addLines: number, removeLines: number) {
  const lines: string[] = [];
  for (let i = 0; i < contextLines; i++) {
    lines.push(` const x${i} = ${i};`);
  }
  for (let i = 0; i < addLines; i++) {
    lines.push(`+const newConst${i} = ${i};`);
  }
  for (let i = 0; i < removeLines; i++) {
    lines.push(`-const goneConst${i} = ${i};`);
  }
  return lines.join("\n");
}

function makeFixture(): FilePatch[] {
  // representative shape: 4 files, mostly context (the worst case for the old shape)
  return [
    {
      path: "src/a.ts",
      additions: 5,
      deletions: 0,
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 100,
          newStart: 1,
          newLines: 105,
          content: makeContextHeavyHunk(100, 5, 0),
        },
      ],
    },
    {
      path: "src/b.ts",
      additions: 3,
      deletions: 2,
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 80,
          newStart: 1,
          newLines: 81,
          content: makeContextHeavyHunk(80, 3, 2),
        },
      ],
    },
    {
      path: "src/c.ts",
      additions: 0,
      deletions: 4,
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 60,
          newStart: 1,
          newLines: 56,
          content: makeContextHeavyHunk(60, 0, 4),
        },
      ],
    },
    {
      path: "src/d.ts",
      additions: 10,
      deletions: 10,
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 40,
          newStart: 1,
          newLines: 40,
          content: makeContextHeavyHunk(40, 10, 10),
        },
      ],
    },
  ];
}

/** simulate the pre-refactor dual-emit shape so the benchmark is self-contained. */
function legacyCompressedSize(patches: FilePatch[]): number {
  const parts: string[] = [];
  for (const patch of patches) {
    parts.push(`## ${patch.path}`);
    for (const hunk of patch.hunks) {
      const lines = hunk.content.split("\n");
      const oldLines: string[] = [];
      const newLines: string[] = [];
      let oldLine = hunk.oldStart;
      let newLine = hunk.newStart;
      for (const line of lines) {
        if (line.startsWith("-")) {
          oldLines.push(`${oldLine} ${line}`);
          oldLine++;
        } else if (line.startsWith("+")) {
          newLines.push(`${newLine} ${line}`);
          newLine++;
        } else if (line.startsWith("\\")) {
          continue;
        } else if (line.startsWith("~")) {
          oldLines.push(line);
          newLines.push(line);
        } else {
          oldLines.push(`${oldLine} ${line}`);
          newLines.push(`${newLine} ${line}`);
          oldLine++;
          newLine++;
        }
      }
      if (oldLines.length > 0) {
        parts.push("__old hunk__");
        parts.push(...oldLines);
      }
      if (newLines.length > 0) {
        parts.push("__new hunk__");
        parts.push(...newLines);
      }
    }
  }
  return countTokens(parts.join("\n"));
}

describe("compressDiff token-decrease benchmark", () => {
  it("emits at least 30% fewer tokens than the pre-refactor dual-emit shape on a context-heavy fixture", () => {
    const patches = makeFixture();
    const newTokens = countTokens(compressDiff(patches, Infinity).compressed);
    const oldTokens = legacyCompressedSize(patches);

    expect(newTokens).toBeLessThan(oldTokens);

    const ratio = newTokens / oldTokens;
    expect(ratio).toBeLessThan(0.7);
  });

  it("does not duplicate context lines in the output", () => {
    const patches = makeFixture();
    const { compressed } = compressDiff(patches, Infinity);
    // pick a context line we know exists exactly once per file in the fixture
    const occurrences = compressed.split("\n").filter((l) => l.endsWith(" const x42 = 42;"));
    // x42 appears in three files (a, b, c — d only has 40 context lines so no x42)
    expect(occurrences).toHaveLength(3);
  });
});

function simplePatch(path: string, addLines: number): FilePatch {
  const content = Array.from({ length: addLines }, (_, i) => `+line ${path} ${i}`).join("\n");
  return {
    path,
    additions: addLines,
    deletions: 0,
    isBinary: false,
    hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: addLines, content }],
  };
}

describe("compressDiff emission order", () => {
  const small = simplePatch("small.ts", 2);
  const medium = simplePatch("medium.ts", 10);
  const large = simplePatch("large.ts", 30);

  it("emits files in caller order when under budget", () => {
    const a = compressDiff([small, medium, large], Infinity).compressed;
    const b = compressDiff([large, small, medium], Infinity).compressed;
    expect(a).not.toBe(b);
    expect(a.indexOf("## small.ts")).toBeLessThan(a.indexOf("## medium.ts"));
    expect(a.indexOf("## medium.ts")).toBeLessThan(a.indexOf("## large.ts"));
    expect(b.indexOf("## large.ts")).toBeLessThan(b.indexOf("## small.ts"));
  });

  it("selects largest files first when over budget but emits in caller order", () => {
    const largeTokens = countTokens(compressDiff([large], Infinity).compressed);
    const { compressed, skippedFiles } = compressDiff([small, medium, large], largeTokens);
    expect(compressed).toContain("## large.ts");
    expect(compressed).not.toContain("## small.ts");
    expect(compressed).not.toContain("## medium.ts");
    expect(skippedFiles.sort()).toEqual(["medium.ts", "small.ts"]);

    const smallTokens = countTokens(compressDiff([small], Infinity).compressed);
    const both = compressDiff([small, large], largeTokens + smallTokens + 2);
    expect(both.skippedFiles).toEqual([]);
    expect(both.compressed.indexOf("## small.ts")).toBeLessThan(
      both.compressed.indexOf("## large.ts"),
    );
  });

  it("emits a clipped partial file at its caller position", () => {
    const largeTokens = countTokens(compressDiff([large], Infinity).compressed);
    const { compressed, skippedFiles } = compressDiff([small, large], largeTokens + 9);
    expect(skippedFiles).toEqual([]);
    expect(compressed).not.toContain("small.ts 1");
    expect(compressed.indexOf("## small.ts")).toBeLessThan(compressed.indexOf("## large.ts"));
  });
});
