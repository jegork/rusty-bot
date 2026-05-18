import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ReviewConfig,
  PRMetadata,
  TicketInfo,
  FocusArea,
  ReviewStyle,
  PriorReviewContext,
} from "../types.js";
import type { OpenGrepFinding } from "../opengrep/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptsDir = resolve(__dirname, "../prompts");

function loadTemplate(relativePath: string): string {
  return readFileSync(resolve(promptsDir, relativePath), "utf-8");
}

const ALL_FOCUS_AREAS: FocusArea[] = ["security", "performance", "bugs", "style", "tests", "docs"];

function buildStyleInstructions(style: ReviewStyle): string {
  return loadTemplate(`styles/${style}.txt`);
}

function buildFocusInstructions(focusAreas: FocusArea[]): string {
  const areas = focusAreas.length > 0 ? focusAreas : ALL_FOCUS_AREAS;
  return areas.map((area) => loadTemplate(`focus/${area}.txt`)).join("\n\n");
}

export function buildSystemPrompt(config: ReviewConfig): string {
  const base = loadTemplate("base.txt");
  const styleInstructions = buildStyleInstructions(config.style);
  const focusInstructions = buildFocusInstructions(config.focusAreas);
  const conventionInstructions = config.conventionFile
    ? `\n\nAdditional instructions from the repository maintainer:\n${config.conventionFile}`
    : "";

  return base
    .replace("{{style_instructions}}", styleInstructions)
    .replace("{{focus_instructions}}", focusInstructions)
    .replace("{{convention_instructions}}", conventionInstructions);
}

export interface CachedSystemMessage {
  role: "system";
  content: string;
  providerOptions?: {
    anthropic?: { cacheControl: { type: "ephemeral" } };
  };
}

/**
 * wrap the system prompt in Mastra's array-of-system-messages form, marking the
 * static block as cacheable for Anthropic when the resolved model supports it.
 */
export function buildCachedSystemMessages(
  systemPrompt: string,
  options: { anthropicCacheControl: boolean } = { anthropicCacheControl: true },
): CachedSystemMessage[] {
  const enabled = process.env.RUSTY_PROMPT_CACHE !== "false" && options.anthropicCacheControl;
  if (!enabled) {
    return [{ role: "system", content: systemPrompt }];
  }
  return [
    {
      role: "system",
      content: systemPrompt,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
  ];
}

function buildOpenGrepSection(findings: OpenGrepFinding[]): string {
  const parts: string[] = [];
  parts.push("## OpenGrep Pre-scan Findings");
  parts.push("");
  parts.push(
    "The following issues were detected by OpenGrep static analysis before your review. " +
      "For each finding, decide whether to **confirm** (include in your findings with the appropriate severity) " +
      "or **dismiss** (explain briefly in your summary why it is a false positive). " +
      "Confirmed OpenGrep findings should be reported as structured findings with exact file/line references. " +
      "You may also find additional issues that OpenGrep cannot detect (logic bugs, auth flaws, design problems).",
  );
  parts.push("");

  for (const f of findings) {
    parts.push(
      `- **${f.ruleId}** [\`${f.severity}\`] in \`${f.file}\` L${f.startLine}–${f.endLine}`,
    );
    parts.push(`  ${f.message}`);
    if (f.snippet) {
      parts.push(`  \`\`\`\`\n  ${f.snippet.trim()}\n  \`\`\`\``);
    }
  }

  return parts.join("\n");
}

export function buildUserMessage(
  diff: string,
  prMetadata: PRMetadata,
  ticketContext?: TicketInfo[],
  languageSummary?: string,
  otherPrFiles?: string[],
  openGrepFindings?: OpenGrepFinding[],
  chunkFiles?: string[],
  rankedContext?: string,
  priorContext?: PriorReviewContext,
): string {
  const parts: string[] = [];

  parts.push("## Pull Request");
  parts.push(`**Title:** ${prMetadata.title}`);
  parts.push(`**Author:** ${prMetadata.author}`);
  parts.push(`**Branch:** ${prMetadata.sourceBranch} → ${prMetadata.targetBranch}`);

  if (languageSummary) {
    parts.push(`\n**Languages:** ${languageSummary}`);
  }

  if (prMetadata.description) {
    parts.push(`\n**Description:**\n${prMetadata.description}`);
  }

  if (chunkFiles && chunkFiles.length > 0) {
    parts.push("\n## Files in this chunk");
    parts.push(
      "These are the only paths your `findings` may reference. Copy each path exactly as written — " +
        "do not change extensions (e.g. `.ts` → `.js`), do not normalize separators, do not invent " +
        "siblings. If you cannot anchor an issue to one of these paths and a line in the diff, " +
        "describe it in the summary or as an `observation` instead of a finding.\n",
    );
    parts.push(chunkFiles.map((f) => `- \`${f}\``).join("\n"));
  }

  if (ticketContext && ticketContext.length > 0) {
    parts.push("\n## Linked Tickets");
    for (const ticket of ticketContext) {
      parts.push(`\n### ${ticket.source}: ${ticket.id} — ${ticket.title}`);
      if (ticket.description) {
        parts.push(ticket.description);
      }
      if (ticket.acceptanceCriteria) {
        parts.push(`\n**Acceptance Criteria:**\n${ticket.acceptanceCriteria}`);
      }
      if (ticket.labels.length > 0) {
        parts.push(`**Labels:** ${ticket.labels.join(", ")}`);
      }
    }
    parts.push(
      "\nThe linked tickets above are CONTEXT for this PR — they describe the work the change " +
        "fits into, NOT a checklist that must be fully delivered by this PR. PRs commonly implement " +
        "one slice of a larger ticket; earlier commits on this branch, sibling PRs, or later work may " +
        "handle the rest. Do NOT flag missing scope as a problem just because it isn't visible in this diff, " +
        "and do NOT write summary prose claiming the PR 'fails to include' work that the ticket describes " +
        "but this diff doesn't show.",
    );
    parts.push(
      "\nExtract each concrete requirement into the structured `ticketCompliance` output and grade it:",
    );
    parts.push(
      "- `addressed` — this PR's diff contains positive evidence the requirement is now met.",
    );
    parts.push(
      "- `partially_addressed` — this PR clearly advances the requirement but doesn't fully close it.",
    );
    parts.push(
      "- `not_addressed` — reserved for cases where this PR actively CONTRADICTS or BREAKS the " +
        "requirement (e.g. the diff removes a check the ticket asked for, or implements the opposite " +
        "of the requested behavior). Do NOT use this just because the diff is silent — use `unclear` instead.",
    );
    parts.push(
      "- `unclear` — the default when this PR's diff is silent on the requirement (no positive or " +
        "negative evidence). Use this freely; it carries no negative judgment.",
    );
    parts.push(
      "\nIf a 'Files already covered by the prior review' section is present, assume requirements that " +
        "map to those files were already evaluated in the prior pass and do NOT re-grade them as " +
        "`not_addressed` from this incremental diff alone.",
    );
    parts.push(
      "\nKeep requirement wording stable across equivalent checks so later passes can merge into the " +
        "same checklist. Prefer adding evidence to an existing requirement over restating it with " +
        "different phrasing. Set `ticketId` when you can, and cite diff evidence when available.",
    );
  }

  if (otherPrFiles && otherPrFiles.length > 0) {
    parts.push("\n## Other Files Changed in This PR");
    parts.push(
      "The following files are also being modified in this PR but are not included in this review chunk. " +
        'Do NOT report observations about these files as issues in "unchanged code" — they are actively changed in this PR ' +
        "and will be reviewed in a separate chunk. However, DO consider their presence when evaluating ticket compliance — " +
        "for example, if a ticket requires tests and test files appear in this list, that requirement is likely addressed " +
        "even though the test diffs are not shown here. If searchCode returns results in these files, " +
        "note that the search results may be stale (pre-merge content).\n",
    );
    parts.push(otherPrFiles.map((f) => `- \`${f}\``).join("\n"));
  }

  if (openGrepFindings && openGrepFindings.length > 0) {
    parts.push("");
    parts.push(buildOpenGrepSection(openGrepFindings));
  }

  if (rankedContext) {
    parts.push("");
    parts.push(rankedContext);
  }

  if (priorContext) {
    parts.push("");
    parts.push(buildPriorContextSection(priorContext));
  }

  parts.push("\n## Diff\n");
  parts.push(diff);

  return parts.join("\n");
}

function buildPriorContextSection(ctx: PriorReviewContext): string {
  const parts: string[] = [];
  parts.push("## Prior review context");
  parts.push(
    "This PR was reviewed previously; the **Diff** section below contains only the changes pushed since that review. " +
      "Use the prior summary as established context for the rest of the PR — your published `summary` " +
      "must describe the WHOLE PR, not just the new diff.",
  );

  parts.push("\n**Previously published summary:**");
  parts.push(ctx.summary.trim());

  parts.push(`\n**Previous recommendation:** ${ctx.recommendation}`);

  if (ctx.filesReviewed && ctx.filesReviewed.length > 0) {
    parts.push(
      "\n**Files already covered by the prior review** (work in these paths has already been evaluated; " +
        "if a linked ticket describes work in one of them, assume it was reviewed in an earlier commit and " +
        "do NOT flag it as missing from this PR):",
    );
    for (const path of ctx.filesReviewed) {
      parts.push(`- \`${path}\``);
    }
  }

  if (ctx.findings.length > 0) {
    parts.push(
      "\n**Issues already surfaced** (do NOT re-raise unless this commit changes the underlying code; " +
        "if a new commit fixes one of these, mention it in your summary):",
    );
    for (const f of ctx.findings) {
      parts.push(`- \`${f.file}\`:${f.line} (${f.severity}) — ${f.message}`);
    }
  }
  return parts.join("\n");
}
