import type { FilePatch, Hunk } from "../types.js";
import { expandToScopeBoundaries, type TreeSitterExpansion } from "./treesitter.js";

const DEFAULT_CONTEXT_LINES = 10;

export type FileContentFetcher = (path: string) => Promise<string | null>;

function extractChangedLineRanges(hunk: Hunk): { startLine: number; endLine: number }[] {
  const ranges: { startLine: number; endLine: number }[] = [];
  let _oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let rangeStart: number | null = null;
  let rangeEnd: number | null = null;

  const flush = () => {
    if (rangeStart !== null && rangeEnd !== null) {
      ranges.push({ startLine: rangeStart, endLine: rangeEnd });
    }
    rangeStart = null;
    rangeEnd = null;
  };

  const extend = (start: number, end: number) => {
    if (rangeStart === null || rangeEnd === null) {
      rangeStart = start;
      rangeEnd = end;
    } else {
      rangeStart = Math.min(rangeStart, start);
      rangeEnd = Math.max(rangeEnd, end);
    }
  };

  for (const line of hunk.content.split("\n")) {
    if (line.startsWith("+")) {
      extend(newLine, newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      // a deletion has no direct new-file line; anchor to surviving lines
      // adjacent to the edit site so AST scope lookup is unambiguous
      const anchorStart = Math.max(1, newLine - 1);
      const anchorEnd = newLine;
      extend(anchorStart, anchorEnd);
      _oldLine++;
    } else if (line.startsWith("\\")) {
      continue;
    } else {
      flush();
      _oldLine++;
      newLine++;
    }
  }

  flush();

  if (ranges.length === 0) {
    ranges.push({
      startLine: hunk.newStart,
      endLine: hunk.newStart + Math.max(0, hunk.newLines - 1),
    });
  }

  return ranges;
}

function expandHunkToScope(hunk: Hunk, fileLines: string[], expansion: TreeSitterExpansion): Hunk {
  let expandedStart = Infinity;
  let expandedEnd = -Infinity;

  for (const scope of expansion.scopes) {
    expandedStart = Math.min(expandedStart, scope.startLine);
    expandedEnd = Math.max(expandedEnd, scope.endLine);
  }

  expandedStart = Math.max(1, expandedStart);
  expandedEnd = Math.min(fileLines.length, expandedEnd);

  // the expansion window must always contain the original hunk — a scope that
  // begins inside the hunk's leading context (common when the first changed
  // line is a function's first line) must not shift newStart forward, or every
  // rendered line label drifts and findings get dropped as outside-hunk
  expandedStart = Math.min(expandedStart, hunk.newStart);
  expandedEnd = Math.max(expandedEnd, hunk.newStart + hunk.newLines - 1);

  const hunkContentLines = hunk.content.split("\n");

  const beforeLines: string[] = [];
  for (let i = expandedStart; i < hunk.newStart; i++) {
    beforeLines.push(` ${fileLines[i - 1]}`);
  }

  const newEnd = hunk.newStart + hunk.newLines - 1;
  const afterLines: string[] = [];
  for (let i = newEnd + 1; i <= expandedEnd; i++) {
    afterLines.push(` ${fileLines[i - 1]}`);
  }

  // sibling signatures are rendered with a "~" marker so the diff formatter
  // can emit them without advancing line counters; they are annotations, not
  // real file rows, and must not shift subsequent line numbers
  const signatureLines: string[] = [];
  for (const sig of expansion.siblingSignatures) {
    if (sig.line < expandedStart || sig.line > expandedEnd) {
      signatureLines.push(`~ // ... ${sig.text}`);
    }
  }

  const parts: string[] = [];
  if (signatureLines.length > 0) {
    parts.push(...signatureLines);
  }
  parts.push(...beforeLines, ...hunkContentLines, ...afterLines);

  const expandedContent = parts.join("\n");
  const addedContextBefore = hunk.newStart - expandedStart;
  const addedContextAfter = expandedEnd - newEnd;

  return {
    oldStart: Math.max(1, hunk.oldStart - addedContextBefore),
    oldLines: hunk.oldLines + addedContextBefore + addedContextAfter,
    newStart: expandedStart,
    newLines: hunk.newLines + addedContextBefore + addedContextAfter,
    content: expandedContent,
  };
}

function expandHunkFixed(hunk: Hunk, fileLines: string[], extraLines: number): Hunk {
  const hunkContentLines = hunk.content.split("\n");
  const newEnd = hunk.newStart + hunk.newLines - 1;

  const expandedStart = Math.max(1, hunk.newStart - extraLines);
  const expandedEnd = Math.min(fileLines.length, newEnd + extraLines);

  const beforeLines: string[] = [];
  for (let i = expandedStart; i < hunk.newStart; i++) {
    beforeLines.push(` ${fileLines[i - 1]}`);
  }

  const afterLines: string[] = [];
  for (let i = newEnd + 1; i <= expandedEnd; i++) {
    afterLines.push(` ${fileLines[i - 1]}`);
  }

  const expandedContent = [...beforeLines, ...hunkContentLines, ...afterLines].join("\n");

  const addedContextBefore = hunk.newStart - expandedStart;
  const addedContextAfter = expandedEnd - newEnd;

  return {
    oldStart: Math.max(1, hunk.oldStart - addedContextBefore),
    oldLines: hunk.oldLines + addedContextBefore + addedContextAfter,
    newStart: expandedStart,
    newLines: hunk.newLines + addedContextBefore + addedContextAfter,
    content: expandedContent,
  };
}

export async function expandContext(
  patches: FilePatch[],
  fetchContent: FileContentFetcher,
  extraLines: number = DEFAULT_CONTEXT_LINES,
): Promise<FilePatch[]> {
  const results: FilePatch[] = [];

  for (const patch of patches) {
    if (patch.isBinary || patch.hunks.length === 0) {
      results.push(patch);
      continue;
    }

    const content = await fetchContent(patch.path);
    if (!content) {
      results.push(patch);
      continue;
    }

    const fileLines = content.split("\n");

    const allChangedRanges = patch.hunks.flatMap(extractChangedLineRanges);

    const expansion = await expandToScopeBoundaries(content, allChangedRanges, patch.path);

    if (expansion) {
      const expandedHunks = patch.hunks.map((hunk) => {
        const hunkRanges = extractChangedLineRanges(hunk);
        const hunkScopes = expansion.scopes.filter((scope) =>
          hunkRanges.some((r) => r.startLine <= scope.endLine && r.endLine >= scope.startLine),
        );

        if (hunkScopes.length === 0) {
          return expandHunkFixed(hunk, fileLines, extraLines);
        }

        const hunkSiblings = expansion.siblingSignatures.filter((sig) =>
          hunkScopes.every((scope) => sig.line < scope.startLine || sig.line > scope.endLine),
        );

        return expandHunkToScope(hunk, fileLines, {
          scopes: hunkScopes,
          siblingSignatures: hunkSiblings,
        });
      });

      results.push({ ...patch, hunks: expandedHunks });
    } else {
      const expandedHunks = patch.hunks.map((hunk) => expandHunkFixed(hunk, fileLines, extraLines));
      results.push({ ...patch, hunks: expandedHunks });
    }
  }

  return results;
}
