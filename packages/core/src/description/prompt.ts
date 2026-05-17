import type { PRMetadata } from "../types.js";

const SYSTEM_PROMPT = `You are a PR description writer. Your job is to produce a clear, structured description of a pull request based on the diff and PR metadata.

Write from the perspective of someone explaining the PR to a reviewer. Be concise and factual — describe what changed and why, not whether the changes are good.

Rules:
- Focus on the intent and effect of the changes, not low-level line-by-line details
- Group related file changes by logical concern when the same feature touches multiple files
- Only list breaking changes when the diff clearly introduces API/contract/schema incompatibilities
- Only include migration notes when there are schema migrations, API changes, config changes, or dependency changes that consumers need to act on
- If the PR title or branch name hints at the purpose, use that context
- Do not invent context that isn't evident from the diff
- When an existing description is provided, preserve any useful human-added context (rationale, rollout notes, linked issues) and incorporate it into the new description`;

export function buildDescriptionSystemPrompt(): string {
  return SYSTEM_PROMPT;
}

export interface BuildDescriptionUserMessageOptions {
  /** when true, the diff represents ONLY the changes since the existing description
   * was generated. the model is told to augment the existing description in-place
   * (preserving sections that still apply, folding in the new commit's changes)
   * rather than rewrite from scratch. only meaningful when an existingDescription
   * is also provided. */
  incremental?: boolean;
}

export function buildDescriptionUserMessage(
  diff: string,
  prMetadata: PRMetadata,
  existingDescription?: string,
  options?: BuildDescriptionUserMessageOptions,
): string {
  const parts: string[] = [];

  parts.push("## Pull Request");
  parts.push(`**Title:** ${prMetadata.title}`);
  parts.push(`**Author:** ${prMetadata.author}`);
  parts.push(`**Branch:** ${prMetadata.sourceBranch} → ${prMetadata.targetBranch}`);

  const trimmedExisting = existingDescription?.trim() ?? "";
  // augment mode only fires when there's an existing description to augment;
  // an `incremental: true` flag with no prior text degrades to a normal full-diff
  // generation since there's nothing to merge into.
  const augmentMode = options?.incremental === true && trimmedExisting.length > 0;

  if (trimmedExisting.length > 0) {
    if (augmentMode) {
      parts.push("\n## Description so far");
      parts.push(
        "This description was generated for an earlier commit on the same PR and currently " +
          "describes the FULL PR scope up to that point. The diff in the next section is ONLY " +
          "the changes pushed since then — NOT the whole PR. Your job is to AUGMENT this " +
          "description in place: preserve every section, paragraph, and bullet that still " +
          "applies, modify what changed, and add only what's strictly new. Do NOT rewrite from " +
          "scratch and do NOT drop coverage of earlier work just because it isn't visible in " +
          "the diff below.\n",
      );
    } else {
      parts.push("\n## Existing Description");
      parts.push(
        "The PR currently has the following description. Preserve any useful human-added " +
          "context (rationale, rollout notes, linked issues) when generating the new description.\n",
      );
    }
    parts.push(trimmedExisting);
  }

  parts.push(augmentMode ? "\n## New changes since the existing description\n" : "\n## Diff\n");
  parts.push(diff);

  return parts.join("\n");
}
