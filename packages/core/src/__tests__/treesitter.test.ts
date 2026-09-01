import { describe, expect, it } from "vitest";
import { expandToScopeBoundaries, getGrammarForFile } from "../diff/treesitter.js";
import { expandContext } from "../diff/context.js";
import type { FilePatch, Hunk } from "../types.js";

describe("getGrammarForFile", () => {
  it("maps .ts to typescript", () => {
    expect(getGrammarForFile("src/index.ts")).toBe("typescript");
  });

  it("maps .tsx to tsx", () => {
    expect(getGrammarForFile("App.tsx")).toBe("tsx");
  });

  it("maps .d.ts to typescript", () => {
    expect(getGrammarForFile("types/global.d.ts")).toBe("typescript");
  });

  it("maps .py to python", () => {
    expect(getGrammarForFile("app/main.py")).toBe("python");
  });

  it("maps .go to go", () => {
    expect(getGrammarForFile("cmd/main.go")).toBe("go");
  });

  it("maps .rs to rust", () => {
    expect(getGrammarForFile("src/lib.rs")).toBe("rust");
  });

  it("maps .java to java", () => {
    expect(getGrammarForFile("Main.java")).toBe("java");
  });

  it("returns null for unsupported extensions", () => {
    expect(getGrammarForFile("style.css")).toBeNull();
    expect(getGrammarForFile("data.json")).toBeNull();
  });

  it("returns null for files without extension", () => {
    expect(getGrammarForFile("Makefile")).toBeNull();
    expect(getGrammarForFile("Dockerfile")).toBeNull();
  });

  it("is case-insensitive on extension", () => {
    expect(getGrammarForFile("file.PY")).toBe("python");
    expect(getGrammarForFile("file.TS")).toBe("typescript");
  });
});

// line numbers verified against tree-sitter AST output:
// function_declaration processData: L4-L8
// function_declaration validateInput: L10-L14
// class_declaration DataProcessor: L16-L26
//   method_definition add: L19-L21
//   method_definition process: L23-L25
const tsFileContent = `import { foo } from "./foo";
import { bar } from "./bar";

export function processData(input: string): string {
  const trimmed = input.trim();
  const upper = trimmed.toUpperCase();
  return upper;
}

export function validateInput(input: string): boolean {
  if (!input) return false;
  if (input.length > 100) return false;
  return true;
}

export class DataProcessor {
  private data: string[] = [];

  add(item: string): void {
    this.data.push(item);
  }

  process(): string[] {
    return this.data.map((d) => d.trim());
  }
}`;

const pyFileContent = `import os
from typing import Optional

def fetch_data(url: str) -> dict:
    response = requests.get(url)
    return response.json()

def transform_data(data: dict) -> list:
    result = []
    for key, value in data.items():
        result.append({"key": key, "value": value})
    return result

class DataPipeline:
    def __init__(self, source: str):
        self.source = source
        self.steps = []

    def add_step(self, step):
        self.steps.append(step)

    def run(self):
        data = None
        for step in self.steps:
            data = step(data)
        return data`;

const jsFileContent = `const { readFile } = require("fs");

function parseConfig(raw) {
  const lines = raw.split("\\n");
  const config = {};
  for (const line of lines) {
    const [key, value] = line.split("=");
    config[key.trim()] = value.trim();
  }
  return config;
}

function validateConfig(config) {
  if (!config.host) throw new Error("host required");
  if (!config.port) throw new Error("port required");
  return true;
}

class ConfigManager {
  constructor(path) {
    this.path = path;
    this.config = null;
  }

  async load() {
    const raw = await readFile(this.path, "utf8");
    this.config = parseConfig(raw);
  }
}`;

describe("expandToScopeBoundaries", () => {
  it("expands to enclosing function for TypeScript", async () => {
    // line 6 is inside processData (L4-L8)
    const result = await expandToScopeBoundaries(
      tsFileContent,
      [{ startLine: 6, endLine: 6 }],
      "src/processor.ts",
    );

    expect(result).not.toBeNull();
    expect(result!.scopes).toHaveLength(1);
    expect(result!.scopes[0].startLine).toBe(4);
    expect(result!.scopes[0].endLine).toBe(8);
  });

  it("includes sibling function signatures", async () => {
    const result = await expandToScopeBoundaries(
      tsFileContent,
      [{ startLine: 6, endLine: 6 }],
      "src/processor.ts",
    );

    expect(result).not.toBeNull();
    // siblings: validateInput (L10) and DataProcessor (L16) at program level
    expect(result!.siblingSignatures.length).toBeGreaterThan(0);
    const sigTexts = result!.siblingSignatures.map((s) => s.text);
    expect(sigTexts.some((t) => t.includes("validateInput"))).toBe(true);
  });

  it("expands to enclosing function for Python", async () => {
    // line 10 is inside transform_data
    const result = await expandToScopeBoundaries(
      pyFileContent,
      [{ startLine: 10, endLine: 10 }],
      "utils/transform.py",
    );

    expect(result).not.toBeNull();
    expect(result!.scopes).toHaveLength(1);
    expect(result!.scopes[0].startLine).toBeLessThanOrEqual(8);
  });

  it("expands to enclosing function for JavaScript", async () => {
    // line 5 is inside parseConfig
    const result = await expandToScopeBoundaries(
      jsFileContent,
      [{ startLine: 5, endLine: 5 }],
      "config.js",
    );

    expect(result).not.toBeNull();
    expect(result!.scopes).toHaveLength(1);
    expect(result!.scopes[0].startLine).toBeLessThanOrEqual(3);
  });

  it("deduplicates scopes when multiple ranges land in the same function", async () => {
    const result = await expandToScopeBoundaries(
      tsFileContent,
      [
        { startLine: 5, endLine: 5 },
        { startLine: 6, endLine: 6 },
      ],
      "src/processor.ts",
    );

    expect(result).not.toBeNull();
    expect(result!.scopes).toHaveLength(1);
  });

  it("returns multiple scopes for changes in different functions", async () => {
    // line 6 in processData (L4-L8), line 12 in validateInput (L10-L14)
    const result = await expandToScopeBoundaries(
      tsFileContent,
      [
        { startLine: 6, endLine: 6 },
        { startLine: 12, endLine: 12 },
      ],
      "src/processor.ts",
    );

    expect(result).not.toBeNull();
    expect(result!.scopes).toHaveLength(2);
  });

  it("returns null for unsupported language", async () => {
    const result = await expandToScopeBoundaries(
      "body { color: red; }",
      [{ startLine: 1, endLine: 1 }],
      "style.css",
    );

    expect(result).toBeNull();
  });

  it("uses a medium tier for scopes just over maxScopeLines", async () => {
    const lines = [
      "function huge() {",
      ...Array.from({ length: 300 }, (_, i) => `  const x${i} = ${i};`),
      "}",
    ];
    const bigFile = lines.join("\n");

    const result = await expandToScopeBoundaries(
      bigFile,
      [{ startLine: 150, endLine: 150 }],
      "big.js",
      200,
    );

    expect(result).not.toBeNull();
    expect(result!.scopes).toEqual([{ startLine: 140, endLine: 160 }]);
    expect(result!.siblingSignatures).toContainEqual({ line: 1, text: "function huge() {" });
  });

  it("uses a tighter large tier for very large scopes", async () => {
    const lines = [
      "function huge() {",
      ...Array.from({ length: 500 }, (_, i) => `  const x${i} = ${i};`),
      "}",
    ];
    const bigFile = lines.join("\n");

    const result = await expandToScopeBoundaries(
      bigFile,
      [{ startLine: 250, endLine: 250 }],
      "big.js",
      200,
    );

    expect(result).not.toBeNull();
    expect(result!.scopes).toEqual([{ startLine: 247, endLine: 253 }]);
    expect(result!.siblingSignatures).toContainEqual({ line: 1, text: "function huge() {" });
  });

  it("handles empty file content gracefully", async () => {
    const result = await expandToScopeBoundaries("", [{ startLine: 1, endLine: 1 }], "empty.ts");

    expect(result).toBeNull();
  });

  it("expands class method to the method scope, not the whole class", async () => {
    // line 20 is inside the add method (L19-L21), not L22 which is between methods
    const result = await expandToScopeBoundaries(
      tsFileContent,
      [{ startLine: 20, endLine: 20 }],
      "src/processor.ts",
    );

    expect(result).not.toBeNull();
    const scope = result!.scopes[0];
    expect(scope.startLine).toBe(19);
    expect(scope.endLine).toBe(21);
  });

  it("falls back to class scope when change is between methods", async () => {
    // line 22 is empty space between methods — enclosing scope is class_declaration
    const result = await expandToScopeBoundaries(
      tsFileContent,
      [{ startLine: 22, endLine: 22 }],
      "src/processor.ts",
    );

    expect(result).not.toBeNull();
    expect(result!.scopes[0].startLine).toBe(16);
    expect(result!.scopes[0].endLine).toBe(26);
  });

  it("returns null when change is at top level with no enclosing scope", async () => {
    // line 1 is an import — no enclosing function/class
    const result = await expandToScopeBoundaries(
      tsFileContent,
      [{ startLine: 1, endLine: 1 }],
      "src/processor.ts",
    );

    expect(result).toBeNull();
  });

  it("collects sibling method signatures within a class", async () => {
    // line 20 is in add method — process should be a sibling
    const result = await expandToScopeBoundaries(
      tsFileContent,
      [{ startLine: 20, endLine: 20 }],
      "src/processor.ts",
    );

    expect(result).not.toBeNull();
    const sigTexts = result!.siblingSignatures.map((s) => s.text);
    expect(sigTexts.some((t) => t.includes("process"))).toBe(true);
  });
});

describe("expandContext with tree-sitter", () => {
  const fetcher = (_path: string) => Promise.resolve(tsFileContent);
  const nullFetcher = (_path: string) => Promise.resolve<string | null>(null);

  function makeTsPatch(overrides?: Partial<FilePatch>): FilePatch {
    return {
      path: "src/processor.ts",
      additions: 1,
      deletions: 0,
      isBinary: false,
      hunks: [
        {
          oldStart: 6,
          oldLines: 1,
          newStart: 6,
          newLines: 2,
          content: " const upper = trimmed.toUpperCase();\n+  console.log(upper);",
        },
      ],
      ...overrides,
    };
  }

  it("expands to function boundaries for supported languages", async () => {
    const result = await expandContext([makeTsPatch()], fetcher, 5);
    expect(result).toHaveLength(1);
    const hunk = result[0].hunks[0];
    expect(hunk.content).toContain("export function processData");
  });

  it("falls back to fixed expansion for unsupported languages", async () => {
    const cssPatch: FilePatch = {
      path: "styles/main.css",
      additions: 1,
      deletions: 0,
      isBinary: false,
      hunks: [
        {
          oldStart: 5,
          oldLines: 1,
          newStart: 5,
          newLines: 2,
          content: " color: blue;\n+  font-size: 14px;",
        },
      ],
    };
    const cssContent = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const cssFetcher = (_path: string) => Promise.resolve(cssContent);

    const result = await expandContext([cssPatch], cssFetcher, 3);
    expect(result).toHaveLength(1);
    const hunk = result[0].hunks[0];
    expect(hunk.content).toContain(" line 2");
    expect(hunk.newStart).toBe(2);
  });

  it("falls back when file content unavailable", async () => {
    const patch = makeTsPatch();
    const result = await expandContext([patch], nullFetcher, 5);
    expect(result[0].hunks[0].content).toBe(patch.hunks[0].content);
  });

  it("skips binary files", async () => {
    const patch = makeTsPatch({ isBinary: true, hunks: [] });
    const result = await expandContext([patch], fetcher, 5);
    expect(result[0]).toEqual(patch);
  });

  it("preserves original hunk content within expanded context", async () => {
    const result = await expandContext([makeTsPatch()], fetcher, 5);
    const hunk = result[0].hunks[0];
    expect(hunk.content).toContain("+  console.log(upper);");
    expect(hunk.content).toContain(" const upper = trimmed.toUpperCase();");
  });

  it("handles multi-file patches with mixed languages", async () => {
    const patches: FilePatch[] = [
      makeTsPatch({ path: "src/processor.ts" }),
      {
        path: "data.json",
        additions: 1,
        deletions: 0,
        isBinary: false,
        hunks: [
          {
            oldStart: 2,
            oldLines: 1,
            newStart: 2,
            newLines: 2,
            content: ' "key": "value",\n+ "new": "field",',
          },
        ],
      },
    ];

    const mixedFetcher = (path: string) => {
      if (path === "src/processor.ts") return Promise.resolve(tsFileContent);
      return Promise.resolve('{\n  "key": "value",\n  "other": 1\n}');
    };

    const result = await expandContext(patches, mixedFetcher, 3);
    expect(result).toHaveLength(2);
    expect(result[0].hunks[0].content).toContain("export function processData");
    expect(result[1].hunks[0].content).toContain('"key": "value"');
  });

  it("includes sibling signatures in expanded context", async () => {
    const result = await expandContext([makeTsPatch()], fetcher, 5);
    const hunk = result[0].hunks[0];
    // sibling function signatures should appear as collapsed markers
    expect(hunk.content).toContain("// ...");
  });

  it("falls back to fixed lines when change is at top level", async () => {
    // change at import level — tree-sitter can't find enclosing scope
    const importPatch: FilePatch = {
      path: "src/processor.ts",
      additions: 1,
      deletions: 0,
      isBinary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 2,
          content: ' import { foo } from "./foo";\n+import { baz } from "./baz";',
        },
      ],
    };

    const result = await expandContext([importPatch], fetcher, 3);
    expect(result).toHaveLength(1);
    // falls back to ±3 fixed lines
    expect(result[0].hunks[0].newStart).toBe(1);
    expect(result[0].hunks[0].content).toContain("export function processData");
  });

  it("keeps large function context bounded without shifting new-file line numbers", async () => {
    const lines = [
      "function huge() {",
      ...Array.from({ length: 500 }, (_, i) => `  const x${i} = ${i};`),
      "}",
    ];
    const bigFile = lines.join("\n");
    const patch: FilePatch = {
      path: "src/big.js",
      additions: 1,
      deletions: 0,
      isBinary: false,
      hunks: [
        {
          oldStart: 250,
          oldLines: 1,
          newStart: 250,
          newLines: 2,
          content: " const x248 = 248;\n+  const touched = true;",
        },
      ],
    };

    const result = await expandContext([patch], () => Promise.resolve(bigFile), 10);
    const hunk = result[0].hunks[0];

    expect(hunk.newStart).toBe(248);
    expect(hunk.content).toContain("~ // ... function huge() {");
    expect(hunk.content).toContain(" const x246 = 246;");
    expect(hunk.content).not.toContain(" const x0 = 0;");

    const bodyRowCount = hunk.content.split("\n").filter((l) => !l.startsWith("~")).length;
    expect(hunk.newLines).toBe(bodyRowCount);

    const { compressDiff } = await import("../diff/compress.js");
    const { compressed } = compressDiff(result, 10000);
    const labelled = compressed.split("\n").find((l) => l.startsWith("250 "));
    expect(labelled).toBeDefined();
    expect(labelled).toContain("const x248 = 248");
  });
});

describe("extractChangedLineRanges (deletion anchoring, via expandContext)", () => {
  const fileAfterDeletion = [
    'import { a } from "./a";',
    "",
    "export function foo() {",
    "  const x = 1;",
    "  return x;",
    "}",
    "",
    "export function bar() {",
    "  return 2;",
    "}",
    "",
  ].join("\n");

  it("anchors pure-deletion hunks to the surviving adjacent line, not to newStart of the next scope", async () => {
    const patch: FilePatch = {
      path: "src/mod.ts",
      additions: 0,
      deletions: 1,
      isBinary: false,
      hunks: [
        {
          oldStart: 5,
          oldLines: 2,
          newStart: 5,
          newLines: 1,
          content: "-  const y = 2;\n  return x;",
        },
      ],
    };
    const fetcher = (_: string) => Promise.resolve(fileAfterDeletion);

    const result = await expandContext([patch], fetcher, 3);
    const hunk = result[0].hunks[0];
    expect(hunk.content).toContain("export function foo()");
    // bar appears only as a ~-prefixed annotation, not as real context
    expect(
      hunk.content
        .split("\n")
        .filter((l) => l.startsWith(" "))
        .join("\n"),
    ).not.toContain("export function bar()");
  });
});

describe("sibling signature line numbering", () => {
  const fetcher = (_: string) => Promise.resolve(tsFileContent);

  it("does not shift line numbers of real source lines when signatures are prepended", async () => {
    const patch: FilePatch = {
      path: "src/processor.ts",
      additions: 1,
      deletions: 0,
      isBinary: false,
      hunks: [
        {
          oldStart: 6,
          oldLines: 1,
          newStart: 6,
          newLines: 2,
          content: " const upper = trimmed.toUpperCase();\n+  console.log(upper);",
        },
      ],
    };

    const [expanded] = await expandContext([patch], fetcher, 5);
    const hunk = expanded.hunks[0];

    const signatureRows = hunk.content.split("\n").filter((l) => l.startsWith("~"));
    expect(signatureRows.length).toBeGreaterThan(0);

    expect(hunk.newStart).toBe(4);

    const bodyRowCount = hunk.content.split("\n").filter((l) => !l.startsWith("~")).length;
    expect(hunk.newLines).toBe(bodyRowCount);

    const { compressDiff } = await import("../diff/compress.js");
    const { compressed } = compressDiff([expanded], 10000);

    const labelled = compressed.split("\n").find((l) => l.startsWith("6 "));
    expect(labelled).toBeDefined();
    expect(labelled).toContain("trimmed.toUpperCase()");
  });
});

describe("expansion window contains the original hunk", () => {
  const fetcher = (_path: string) => Promise.resolve(tsFileContent);

  it("clamps the expansion start to the hunk start when the scope begins after it (leading context precedes the function)", async () => {
    // hunk starts at the blank line before processData (L4-L8); the change
    // itself (L6) is inside the function, so the scope (starts at L4) begins
    // after the hunk's own start (L3)
    const originalHunk: Hunk = {
      oldStart: 3,
      oldLines: 4,
      newStart: 3,
      newLines: 5,
      content: [
        " ",
        " export function processData(input: string): string {",
        "   const trimmed = input.trim();",
        "+  const upper = trimmed.toUpperCase();",
        "   return upper;",
      ].join("\n"),
    };

    const [expanded] = await expandContext(
      [
        {
          path: "src/processor.ts",
          additions: 1,
          deletions: 0,
          isBinary: false,
          hunks: [originalHunk],
        },
      ],
      fetcher,
      5,
    );
    const hunk = expanded.hunks[0];

    expect(hunk.newStart).toBeLessThanOrEqual(originalHunk.newStart);

    const bodyRowCount = hunk.content.split("\n").filter((l) => !l.startsWith("~")).length;
    const removedLineCount = hunk.content.split("\n").filter((l) => l.startsWith("-")).length;
    expect(bodyRowCount).toBe(hunk.newLines + removedLineCount);
  });

  it("clamps the expansion end to the hunk end when the scope ends before it (trailing context extends past the function)", async () => {
    // hunk covers L12-L16, but the change itself (L12) is inside
    // validateInput (L10-L14), so the scope ends (L14) before the hunk's own
    // end (L16, into the blank line and the next class declaration)
    const originalHunk: Hunk = {
      oldStart: 12,
      oldLines: 4,
      newStart: 12,
      newLines: 5,
      content: [
        "+  if (input.length > 100) return false;",
        "   return true;",
        " }",
        " ",
        " export class DataProcessor {",
      ].join("\n"),
    };

    const [expanded] = await expandContext(
      [
        {
          path: "src/processor.ts",
          additions: 1,
          deletions: 0,
          isBinary: false,
          hunks: [originalHunk],
        },
      ],
      fetcher,
      5,
    );
    const hunk = expanded.hunks[0];

    const originalEnd = originalHunk.newStart + originalHunk.newLines - 1;
    const expandedEnd = hunk.newStart + hunk.newLines - 1;
    expect(expandedEnd).toBeGreaterThanOrEqual(originalEnd);
  });

  it("keeps the window containing the original hunk on the happy path (scope starts before and ends after)", async () => {
    const patch: FilePatch = {
      path: "src/processor.ts",
      additions: 1,
      deletions: 0,
      isBinary: false,
      hunks: [
        {
          oldStart: 6,
          oldLines: 1,
          newStart: 6,
          newLines: 2,
          content: " const upper = trimmed.toUpperCase();\n+  console.log(upper);",
        },
      ],
    };
    const originalHunk = patch.hunks[0];

    const [expanded] = await expandContext([patch], fetcher, 5);
    const hunk = expanded.hunks[0];

    expect(hunk.newStart).toBeLessThanOrEqual(originalHunk.newStart);
    const originalEnd = originalHunk.newStart + originalHunk.newLines - 1;
    const expandedEnd = hunk.newStart + hunk.newLines - 1;
    expect(expandedEnd).toBeGreaterThanOrEqual(originalEnd);
  });
});
