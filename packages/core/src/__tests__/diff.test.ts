import { describe, expect, it } from "vitest";
import { parseDiff } from "../diff/parser.js";
import { filterFiles } from "../diff/filter.js";
import { compressDiff, countTokens } from "../diff/compress.js";
import { expandContext } from "../diff/context.js";
import { detectLanguage, summarizeLanguages } from "../diff/language.js";
import type { FilePatch } from "../types.js";

const singleFileDiff = `diff --git a/src/index.ts b/src/index.ts
--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,4 @@
 import { foo } from "./foo";
+import { bar } from "./bar";

 export function main() {
`;

const multiFileDiff = `diff --git a/file1.ts b/file1.ts
--- a/file1.ts
+++ b/file1.ts
@@ -1,2 +1,3 @@
 line1
+added
 line2
diff --git a/file2.ts b/file2.ts
--- a/file2.ts
+++ b/file2.ts
@@ -1,3 +1,2 @@
 line1
-removed
 line3
`;

const binaryDiff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`;

const gitBinaryPatchDiff = `diff --git a/font.woff b/font.woff
index abc123..def456 100644
GIT binary patch
literal 1234
some binary data
`;

const renameDiff = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,3 @@
-export const name = "old";
+export const name = "new";

 export function run() {}
`;

const noNewlineDiff = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 hello
-world
\\ No newline at end of file
+world!
\\ No newline at end of file
`;

const modeChangeDiff = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
--- a/script.sh
+++ b/script.sh
@@ -1,2 +1,3 @@
 #!/bin/bash
+set -e
 echo "hello"
`;

const multiHunkDiff = `diff --git a/big.ts b/big.ts
--- a/big.ts
+++ b/big.ts
@@ -1,3 +1,4 @@
 import { a } from "a";
+import { b } from "b";

 function first() {
@@ -20,3 +21,4 @@

 function second() {
+  console.log("added");
   return true;
`;

const newFileDiff = `diff --git a/brand-new.ts b/brand-new.ts
--- /dev/null
+++ b/brand-new.ts
@@ -0,0 +1,3 @@
+export const x = 1;
+export const y = 2;
+export const z = 3;
`;

const deletedFileDiff = `diff --git a/gone.ts b/gone.ts
--- a/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const x = 1;
-export const y = 2;
-export const z = 3;
`;

describe("parseDiff", () => {
  it("parses a single-file diff", () => {
    const patches = parseDiff(singleFileDiff);
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe("src/index.ts");
    expect(patches[0].additions).toBe(1);
    expect(patches[0].deletions).toBe(0);
    expect(patches[0].isBinary).toBe(false);
    expect(patches[0].hunks).toHaveLength(1);
  });

  it("parses a multi-file diff", () => {
    const patches = parseDiff(multiFileDiff);
    expect(patches).toHaveLength(2);
    expect(patches[0].path).toBe("file1.ts");
    expect(patches[0].additions).toBe(1);
    expect(patches[0].deletions).toBe(0);
    expect(patches[1].path).toBe("file2.ts");
    expect(patches[1].additions).toBe(0);
    expect(patches[1].deletions).toBe(1);
  });

  it("detects binary files via Binary files marker", () => {
    const patches = parseDiff(binaryDiff);
    expect(patches).toHaveLength(1);
    expect(patches[0].isBinary).toBe(true);
    expect(patches[0].path).toBe("image.png");
    expect(patches[0].hunks).toHaveLength(0);
  });

  it("detects binary files via GIT binary patch", () => {
    const patches = parseDiff(gitBinaryPatchDiff);
    expect(patches).toHaveLength(1);
    expect(patches[0].isBinary).toBe(true);
    expect(patches[0].path).toBe("font.woff");
  });

  it("parses hunk headers with correct line numbers", () => {
    const patches = parseDiff(multiHunkDiff);
    expect(patches).toHaveLength(1);
    const hunks = patches[0].hunks;
    expect(hunks).toHaveLength(2);
    expect(hunks[0].oldStart).toBe(1);
    expect(hunks[0].oldLines).toBe(3);
    expect(hunks[0].newStart).toBe(1);
    expect(hunks[0].newLines).toBe(4);
    expect(hunks[1].oldStart).toBe(20);
    expect(hunks[1].newStart).toBe(21);
  });

  it("handles file renames", () => {
    const patches = parseDiff(renameDiff);
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe("new-name.ts");
    expect(patches[0].additions).toBe(1);
    expect(patches[0].deletions).toBe(1);
  });

  it("handles no-newline-at-end-of-file", () => {
    const patches = parseDiff(noNewlineDiff);
    expect(patches).toHaveLength(1);
    expect(patches[0].additions).toBe(1);
    expect(patches[0].deletions).toBe(1);
    expect(patches[0].hunks[0].content).toContain("No newline at end of file");
  });

  it("handles mode changes", () => {
    const patches = parseDiff(modeChangeDiff);
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe("script.sh");
    expect(patches[0].additions).toBe(1);
  });

  it("returns empty array for empty diff", () => {
    expect(parseDiff("")).toEqual([]);
    expect(parseDiff("  \n  \n  ")).toEqual([]);
  });

  it("handles new file creation (--- /dev/null)", () => {
    const patches = parseDiff(newFileDiff);
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe("brand-new.ts");
    expect(patches[0].additions).toBe(3);
    expect(patches[0].deletions).toBe(0);
  });

  it("handles file deletion (+++ /dev/null)", () => {
    const patches = parseDiff(deletedFileDiff);
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toBe("gone.ts");
    expect(patches[0].additions).toBe(0);
    expect(patches[0].deletions).toBe(3);
  });

  it("parses hunk with omitted count (defaults to 1)", () => {
    const diff = `diff --git a/one.ts b/one.ts
--- a/one.ts
+++ b/one.ts
@@ -5 +5 @@
-old
+new
`;
    const patches = parseDiff(diff);
    expect(patches[0].hunks[0].oldLines).toBe(1);
    expect(patches[0].hunks[0].newLines).toBe(1);
  });
});

describe("filterFiles", () => {
  it("filters out binary files", () => {
    const patches = parseDiff(binaryDiff + singleFileDiff);
    const result = filterFiles(patches);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/index.ts");
  });

  it("filters default lock files", () => {
    const lockDiff = `diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml
--- a/pnpm-lock.yaml
+++ b/pnpm-lock.yaml
@@ -1,2 +1,3 @@
 lockfileVersion: 9
+something: true
 specifiers: {}
`;
    const patches = parseDiff(lockDiff + singleFileDiff);
    const result = filterFiles(patches);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/index.ts");
  });

  it("filters files matching custom glob patterns", () => {
    const patches = parseDiff(multiFileDiff);
    const result = filterFiles(patches, ["file1.*"]);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("file2.ts");
  });

  it("supports nested glob patterns", () => {
    const result = filterFiles(
      [
        { path: "src/utils/helper.ts", hunks: [], additions: 1, deletions: 0, isBinary: false },
        { path: "src/index.ts", hunks: [], additions: 1, deletions: 0, isBinary: false },
      ],
      ["src/utils/**"],
    );
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/index.ts");
  });

  it("returns empty array when all files are filtered", () => {
    const patches = parseDiff(binaryDiff);
    expect(filterFiles(patches)).toEqual([]);
  });

  it("filters package-lock.json and yarn.lock by default", () => {
    const result = filterFiles([
      { path: "package-lock.json", hunks: [], additions: 100, deletions: 50, isBinary: false },
      { path: "yarn.lock", hunks: [], additions: 200, deletions: 100, isBinary: false },
      { path: "src/app.ts", hunks: [], additions: 5, deletions: 2, isBinary: false },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/app.ts");
  });

  const mk = (path: string): FilePatch => ({
    path,
    hunks: [],
    additions: 1,
    deletions: 0,
    isBinary: false,
  });

  it("filters nested default lockfiles at any depth", () => {
    const result = filterFiles([
      mk("apps/web/package-lock.json"),
      mk("packages/x/pnpm-lock.yaml"),
      mk("a/b/c/yarn.lock"),
      mk("src/app.ts"),
    ]);
    expect(result.map((p) => p.path)).toEqual(["src/app.ts"]);
  });

  it("matches slash-free user patterns against the basename at any depth", () => {
    const result = filterFiles(
      [mk("src/deep/a.generated.ts"), mk("src/keep.ts")],
      ["*.generated.ts"],
    );
    expect(result.map((p) => p.path)).toEqual(["src/keep.ts"]);
  });

  it("keeps slash patterns anchored to the repo root", () => {
    const result = filterFiles([mk("vendor/a.ts"), mk("src/vendor/a.ts")], ["vendor/**"]);
    expect(result.map((p) => p.path)).toEqual(["src/vendor/a.ts"]);
  });

  it("does not ignore files that merely contain a lockfile name as a substring", () => {
    const result = filterFiles([mk("src/my-package-lock.json.ts"), mk("docs/yarn.lock.md")]);
    expect(result).toHaveLength(2);
  });

  it("filters other ecosystem lockfiles in nested directories", () => {
    const result = filterFiles([
      mk("svc/Cargo.lock"),
      mk("svc/poetry.lock"),
      mk("svc/Gemfile.lock"),
      mk("svc/go.sum"),
      mk("svc/bun.lockb"),
      mk("svc/main.go"),
    ]);
    expect(result.map((p) => p.path)).toEqual(["svc/main.go"]);
  });
});

describe("countTokens", () => {
  it("estimates 4 chars per token", () => {
    expect(countTokens("abcd")).toBe(1);
    expect(countTokens("abcde")).toBe(2);
    expect(countTokens("12345678")).toBe(2);
  });

  it("returns 0 for empty string", () => {
    expect(countTokens("")).toBe(0);
  });
});

describe("compressDiff", () => {
  it("emits the file header and a __new hunk__ block for an additions-only diff", () => {
    const patches = parseDiff(singleFileDiff);
    const result = compressDiff(patches, 10000);
    expect(result.compressed).toContain("## src/index.ts");
    expect(result.compressed).toContain("__new hunk__");
    // singleFileDiff has zero removed lines — old block must be omitted entirely
    expect(result.compressed).not.toContain("__old hunk__");
    expect(result.skippedFiles).toEqual([]);
  });

  it("emits __old hunk__ only when a hunk has removals", () => {
    const patches = parseDiff(multiFileDiff);
    const result = compressDiff(patches, 10000);
    // multiFileDiff has file2.ts with a removal
    expect(result.compressed).toContain("__old hunk__");
    expect(result.compressed).toContain("__new hunk__");
  });

  it("omits __new hunk__ when a hunk has only removals (no context, no additions)", () => {
    // hand-built patch avoids the parser's trailing-newline phantom-context quirk
    const patches: FilePatch[] = [
      {
        path: "src/all-gone.ts",
        additions: 0,
        deletions: 2,
        isBinary: false,
        hunks: [
          {
            oldStart: 1,
            oldLines: 2,
            newStart: 0,
            newLines: 0,
            content: "-line one\n-line two",
          },
        ],
      },
    ];
    const result = compressDiff(patches, 10000);
    expect(result.compressed).toContain("## src/all-gone.ts");
    expect(result.compressed).toContain("__old hunk__");
    expect(result.compressed).not.toContain("__new hunk__");
  });

  it("emits each context line exactly once (no duplication across blocks)", () => {
    // mixed hunk: context + addition + removal — context must appear once total
    const patches: FilePatch[] = [
      {
        path: "src/mixed.ts",
        additions: 1,
        deletions: 1,
        isBinary: false,
        hunks: [
          {
            oldStart: 10,
            oldLines: 4,
            newStart: 10,
            newLines: 4,
            content: [" unchanged-before", "-removed-line", "+added-line", " unchanged-after"].join(
              "\n",
            ),
          },
        ],
      },
    ];
    const { compressed } = compressDiff(patches, 10000);
    const lines = compressed.split("\n");
    expect(lines.filter((l) => l.includes("unchanged-before"))).toHaveLength(1);
    expect(lines.filter((l) => l.includes("unchanged-after"))).toHaveLength(1);
    // both blocks present
    expect(compressed).toContain("__new hunk__");
    expect(compressed).toContain("__old hunk__");
  });

  it("places sibling signature annotations only in the new-side block", () => {
    const patches: FilePatch[] = [
      {
        path: "src/sig.ts",
        additions: 1,
        deletions: 0,
        isBinary: false,
        hunks: [
          {
            oldStart: 5,
            oldLines: 1,
            newStart: 5,
            newLines: 2,
            content: ["~ // ... function outer() {", " context-line", "+added"].join("\n"),
          },
        ],
      },
    ];
    const { compressed } = compressDiff(patches, 10000);
    expect(compressed.match(/~ \/\/ \.\.\. function outer/g)).toHaveLength(1);
    // new block only — pure-add hunk has no old block
    expect(compressed).not.toContain("__old hunk__");
  });

  it("advances new-side line numbers across context lines", () => {
    // context advances both counters even though only the new-side prefix is emitted
    const patches: FilePatch[] = [
      {
        path: "src/counter.ts",
        additions: 1,
        deletions: 0,
        isBinary: false,
        hunks: [
          {
            oldStart: 100,
            oldLines: 3,
            newStart: 100,
            newLines: 4,
            content: [" first context", " second context", "+added line"].join("\n"),
          },
        ],
      },
    ];
    const { compressed } = compressDiff(patches, 10000);
    expect(compressed).toContain("100  first context");
    expect(compressed).toContain("101  second context");
    expect(compressed).toContain("102 +added line");
  });

  it("removed lines are prefixed with old-side line numbers", () => {
    const patches: FilePatch[] = [
      {
        path: "src/removal.ts",
        additions: 0,
        deletions: 2,
        isBinary: false,
        hunks: [
          {
            oldStart: 50,
            oldLines: 4,
            newStart: 50,
            newLines: 2,
            content: [" before", "-gone-1", "-gone-2", " after"].join("\n"),
          },
        ],
      },
    ];
    const { compressed } = compressDiff(patches, 10000);
    expect(compressed).toContain("51 -gone-1");
    expect(compressed).toContain("52 -gone-2");
  });

  it("skips files when budget is exhausted", () => {
    const patches = parseDiff(multiFileDiff);
    const result = compressDiff(patches, 10);
    expect(result.skippedFiles.length).toBeGreaterThan(0);
  });

  it("returns empty string for empty patches", () => {
    const result = compressDiff([], 1000);
    expect(result.compressed).toBe("");
    expect(result.skippedFiles).toEqual([]);
  });

  it("clips large files to partial hunks when budget is tight", () => {
    const patches = parseDiff(multiHunkDiff);
    // give enough budget to include some lines but not all
    const fullResult = compressDiff(patches, 10000);
    const tightResult = compressDiff(patches, 20);
    expect(tightResult.compressed.length).toBeLessThan(fullResult.compressed.length);
  });

  it("emits files in caller order rather than by token cost", () => {
    const patches = [
      {
        path: "small.ts",
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, content: "+x" }],
        additions: 1,
        deletions: 0,
        isBinary: false,
      },
      {
        path: "big.ts",
        hunks: [
          {
            oldStart: 1,
            oldLines: 10,
            newStart: 1,
            newLines: 20,
            content: "+a\n+b\n+c\n+d\n+e\n+f\n+g\n+h\n+i\n+j",
          },
        ],
        additions: 10,
        deletions: 0,
        isBinary: false,
      },
    ];
    const result = compressDiff(patches, 10000);
    // small.ts was passed first so it is emitted first
    const bigIdx = result.compressed.indexOf("## big.ts");
    const smallIdx = result.compressed.indexOf("## small.ts");
    expect(smallIdx).toBeLessThan(bigIdx);
  });

  it("handles zero budget gracefully", () => {
    const patches = parseDiff(singleFileDiff);
    const result = compressDiff(patches, 0);
    expect(result.compressed).toBe("");
    expect(result.skippedFiles).toEqual(["src/index.ts"]);
  });
});

describe("expandContext", () => {
  const fileContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const fetcher = (_path: string) => Promise.resolve(fileContent);
  const nullFetcher = (_path: string) => Promise.resolve<string | null>(null);

  function makePatch(overrides?: Partial<FilePatch>): FilePatch {
    return {
      path: "src/index.ts",
      additions: 1,
      deletions: 0,
      isBinary: false,
      hunks: [
        {
          oldStart: 15,
          oldLines: 2,
          newStart: 15,
          newLines: 3,
          content: " line 15\n+new line\n line 16",
        },
      ],
      ...overrides,
    };
  }

  it("adds context lines before and after hunk", async () => {
    const result = await expandContext([makePatch()], fetcher, 5);
    expect(result).toHaveLength(1);
    const hunk = result[0].hunks[0];
    // should include lines 10-14 as context before
    expect(hunk.content).toContain(" line 10");
    expect(hunk.content).toContain(" line 14");
    // original hunk content preserved
    expect(hunk.content).toContain("+new line");
    // should include lines 17-20 as context after (newEnd = 15+3-1=17, +5 = 22)
    expect(hunk.content).toContain(" line 18");
    expect(hunk.newStart).toBe(10);
  });

  it("clamps to file start when hunk is near the beginning", async () => {
    const patch = makePatch({
      hunks: [
        { oldStart: 2, oldLines: 2, newStart: 2, newLines: 3, content: " line 2\n+added\n line 3" },
      ],
    });
    const result = await expandContext([patch], fetcher, 5);
    const hunk = result[0].hunks[0];
    expect(hunk.newStart).toBe(1);
    expect(hunk.content).toContain(" line 1");
  });

  it("clamps to file end when hunk is near the end", async () => {
    const patch = makePatch({
      hunks: [
        {
          oldStart: 28,
          oldLines: 2,
          newStart: 28,
          newLines: 3,
          content: " line 28\n+added\n line 29",
        },
      ],
    });
    const result = await expandContext([patch], fetcher, 5);
    const hunk = result[0].hunks[0];
    // before-context added
    expect(hunk.content).toContain(" line 23");
    expect(hunk.content).toContain(" line 27");
    // original hunk preserved
    expect(hunk.content).toContain("+added");
    expect(hunk.content).toContain(" line 28");
    expect(hunk.newStart).toBe(23);
  });

  it("preserves original patch when file content is unavailable", async () => {
    const patch = makePatch();
    const result = await expandContext([patch], nullFetcher, 5);
    expect(result[0].hunks[0].content).toBe(patch.hunks[0].content);
  });

  it("skips binary files", async () => {
    const patch = makePatch({ isBinary: true, hunks: [] });
    const result = await expandContext([patch], fetcher, 5);
    expect(result[0]).toEqual(patch);
  });

  it("handles zero extra lines", async () => {
    const patch = makePatch();
    const result = await expandContext([patch], fetcher, 0);
    expect(result[0].hunks[0].content).toBe(patch.hunks[0].content);
    expect(result[0].hunks[0].newStart).toBe(15);
  });

  it("handles multiple hunks in one file", async () => {
    const patch = makePatch({
      hunks: [
        { oldStart: 5, oldLines: 1, newStart: 5, newLines: 2, content: " line 5\n+first" },
        { oldStart: 20, oldLines: 1, newStart: 21, newLines: 2, content: " line 21\n+second" },
      ],
    });
    const result = await expandContext([patch], fetcher, 3);
    expect(result[0].hunks).toHaveLength(2);
    expect(result[0].hunks[0].content).toContain(" line 2");
    expect(result[0].hunks[1].content).toContain(" line 18");
  });

  it("handles multiple files", async () => {
    const patches = [makePatch({ path: "a.ts" }), makePatch({ path: "b.ts" })];
    const result = await expandContext(patches, fetcher, 3);
    expect(result).toHaveLength(2);
    expect(result[0].hunks[0].content).toContain(" line 12");
    expect(result[1].hunks[0].content).toContain(" line 12");
  });
});

describe("detectLanguage", () => {
  it("detects TypeScript", () => {
    expect(detectLanguage("src/index.ts")).toBe("TypeScript");
  });

  it("detects TSX", () => {
    expect(detectLanguage("components/App.tsx")).toBe("TypeScript (React)");
  });

  it("detects .d.ts as declarations", () => {
    expect(detectLanguage("types/global.d.ts")).toBe("TypeScript (declarations)");
  });

  it("detects Python", () => {
    expect(detectLanguage("app/main.py")).toBe("Python");
  });

  it("detects Go", () => {
    expect(detectLanguage("cmd/server.go")).toBe("Go");
  });

  it("detects Dockerfile by name", () => {
    expect(detectLanguage("Dockerfile")).toBe("Dockerfile");
    expect(detectLanguage("docker/Dockerfile.prod")).toBe("Dockerfile");
  });

  it("detects Makefile by name", () => {
    expect(detectLanguage("Makefile")).toBe("Makefile");
  });

  it("returns null for unknown extensions", () => {
    expect(detectLanguage("data.bin")).toBeNull();
  });

  it("returns null for files without extension", () => {
    expect(detectLanguage("LICENSE")).toBeNull();
  });

  it("is case-insensitive on extension", () => {
    expect(detectLanguage("App.TSX")).toBe("TypeScript (React)");
  });
});

describe("summarizeLanguages", () => {
  function patch(path: string, additions: number): FilePatch {
    return { path, additions, deletions: 0, isBinary: false, hunks: [] };
  }

  it("summarizes single language", () => {
    const result = summarizeLanguages([patch("a.ts", 100)]);
    expect(result).toContain("TypeScript (100%)");
  });

  it("summarizes multiple languages sorted by size", () => {
    const result = summarizeLanguages([patch("a.ts", 80), patch("b.py", 20)]);
    expect(result).toMatch(/TypeScript.*Python/);
  });

  it("returns empty string for no recognized languages", () => {
    expect(summarizeLanguages([patch("data.bin", 50)])).toBe("");
  });

  it("returns empty string for empty patches", () => {
    expect(summarizeLanguages([])).toBe("");
  });

  it("groups same language from multiple files", () => {
    const result = summarizeLanguages([patch("a.ts", 50), patch("b.ts", 50)]);
    expect(result).toContain("TypeScript (100%)");
  });
});
