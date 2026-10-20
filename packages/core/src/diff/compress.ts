import type { FilePatch } from "../types.js";

export function countTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatHunks(patch: FilePatch): string {
  const parts: string[] = [`## ${patch.path}`];

  for (const hunk of patch.hunks) {
    const lines = hunk.content.split("\n");
    // context, additions, and sibling signatures collect into the new-side block;
    // removals collect into the old-side block. context lines are NOT duplicated
    // across blocks — the model can read context once from the new-hunk block and
    // still understand removals from the old-hunk block via line numbers.
    const oldRemovedLines: string[] = [];
    const newSideLines: string[] = [];
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    for (const line of lines) {
      if (line.startsWith("-")) {
        oldRemovedLines.push(`${oldLine} ${line}`);
        oldLine++;
      } else if (line.startsWith("+")) {
        newSideLines.push(`${newLine} ${line}`);
        newLine++;
      } else if (line.startsWith("\\")) {
        // no-newline marker, keep in whichever section was last
        continue;
      } else if (line.startsWith("~")) {
        // sibling signature annotation from tree-sitter scope expansion. emit without
        // line number, do not advance counters. only needed in the new-side block —
        // it's a hint about the surrounding scope, not historical state.
        newSideLines.push(line);
      } else {
        // unchanged context: advance both counters but emit only on the new side.
        newSideLines.push(`${newLine} ${line}`);
        oldLine++;
        newLine++;
      }
    }

    if (newSideLines.length > 0) {
      parts.push("__new hunk__");
      parts.push(...newSideLines);
    }
    if (oldRemovedLines.length > 0) {
      parts.push("__old hunk__");
      parts.push(...oldRemovedLines);
    }
  }

  return parts.join("\n");
}

export function compressDiff(
  patches: FilePatch[],
  maxTokens: number,
): { compressed: string; skippedFiles: string[] } {
  if (patches.length === 0) return { compressed: "", skippedFiles: [] };

  const formatted = patches.map((p) => ({
    path: p.path,
    text: formatHunks(p),
    tokens: 0,
    emitted: undefined as string | undefined,
  }));

  for (const f of formatted) {
    f.tokens = countTokens(f.text);
  }

  // selection favors the largest files, but emission keeps the caller's order so
  // per-pass shuffles survive into the rendered diff
  const bySize = [...formatted].sort((a, b) => b.tokens - a.tokens);

  const skippedFiles: string[] = [];
  let remaining = maxTokens;

  for (const f of bySize) {
    if (f.tokens <= remaining) {
      f.emitted = f.text;
      remaining -= f.tokens;
    } else if (remaining > 0) {
      // try to include partial hunks
      const lines = f.text.split("\n");
      const clipped: string[] = [];
      let usedTokens = 0;

      for (const line of lines) {
        const lineTokens = countTokens(line + "\n");
        if (usedTokens + lineTokens > remaining) break;
        clipped.push(line);
        usedTokens += lineTokens;
      }

      if (clipped.length > 1) {
        f.emitted = clipped.join("\n");
        remaining -= usedTokens;
      } else {
        skippedFiles.push(f.path);
      }
    } else {
      skippedFiles.push(f.path);
    }
  }

  const included = formatted.flatMap((f) => (f.emitted === undefined ? [] : [f.emitted]));

  return { compressed: included.join("\n\n"), skippedFiles };
}
