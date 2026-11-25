import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compressDiff } from "../diff/compress.js";
import { normalizePath } from "../diff/normalize-path.js";
import { logger } from "../logger.js";
import type { FilePatch, Finding, PRMetadata, ReviewResult } from "../types.js";
import { generateStructured } from "./generate.js";
import { judgeFindings, resolveJudgeConfig } from "./judge.js";
import { resolveReviewPassModelConfigs } from "./model.js";
import { deriveMergedRecommendation } from "./recommendation.js";
import { FocusAreaSchema, SeveritySchema } from "./schema.js";
import { wrapUntrusted } from "./untrusted.js";

const log = logger.child({ module: "design-pass" });

const MAX_DESIGN_FINDINGS = 5;
export const DESIGN_FINDING_PREFIX = "Design consistency: ";

const DesignFindingSchema = z.object({
  file: z.string(),
  line: z.number(),
  endLine: z.number().nullable(),
  severity: SeveritySchema,
  category: FocusAreaSchema,
  message: z.string(),
  failureMode: z
    .string()
    .describe("the concrete sequence of events and the wrong result it produces"),
  relatedLocations: z
    .array(z.object({ file: z.string(), line: z.number() }))
    .describe("the other places that make up the problem"),
});

const DesignPassOutputSchema = z.object({
  findings: z.array(DesignFindingSchema).describe("at most five; empty is the expected answer"),
});

type DesignFinding = z.infer<typeof DesignPassOutputSchema>["findings"][number];

const promptPath = resolve(dirname(fileURLToPath(import.meta.url)), "../prompts/design-pass.txt");

export function isDesignPassEnabled(): boolean {
  return process.env.RUSTY_DESIGN_PASS === "true";
}

const designRubric = (threshold: number) => `

Every finding below comes from a single reviewer that read the whole pull request at once to find cross-file design problems: the same concern implemented several ways, duplicated logic, helpers that take a scope argument but do not scope, meaningless flag combinations, and unnecessary locks or locks held across I/O. Nobody else has corroborated them. Score ${threshold} or higher only when the diff context shows every location the finding names and its failure mode actually follows from that code. Give 0 to generic maintainability advice, to anything without a concrete failure mode, and to any finding that repeats an entry under "Already reported".`;

function buildUserMessage(
  compressed: string,
  prMetadata: PRMetadata,
  patches: readonly FilePatch[],
  skippedFiles: readonly string[],
): string {
  const parts = ["## Pull Request", `**Title:**\n${wrapUntrusted("title", prMetadata.title)}`];
  if (prMetadata.description) {
    parts.push(`**Description:**\n${wrapUntrusted("description", prMetadata.description)}`);
  }
  parts.push("\n## Files changed");
  parts.push(patches.map((p) => `- \`${p.path}\``).join("\n"));
  if (skippedFiles.length > 0) {
    parts.push(
      `\n${skippedFiles.length} of these files did not fit in the diff below; do not report on them.`,
    );
  }
  parts.push("\n## Diff\n");
  parts.push(wrapUntrusted("diff", compressed));
  return parts.join("\n");
}

// a finding must sit on a file of this PR, and its related locations must too:
// a location outside the PR could neither be judged nor anchored
function toFinding(d: DesignFinding, prFiles: Set<string>): Finding | null {
  if (!d.failureMode.trim() || !prFiles.has(normalizePath(d.file))) return null;
  const related = d.relatedLocations.filter(
    (l) => prFiles.has(normalizePath(l.file)) && !(l.file === d.file && l.line === d.line),
  );
  return {
    file: d.file,
    line: d.line,
    endLine: d.endLine,
    severity: d.severity,
    category: d.category,
    message: `${DESIGN_FINDING_PREFIX}${d.message.trim()}\n\nFailure mode: ${d.failureMode.trim()}`,
    suggestedFix: null,
    ...(related.length > 0 && { relatedLocations: related }),
  };
}

export interface DesignPassResult {
  findings: Finding[];
  tokenCount: number;
  modelUsed: string;
}

/** one tool-less call over the whole PR diff, looking only for cross-file design problems. */
export async function runDesignPass(
  patches: readonly FilePatch[],
  prMetadata: PRMetadata,
  maxTokens: number,
): Promise<DesignPassResult> {
  const { compressed, skippedFiles } = compressDiff([...patches], maxTokens);
  // the model and settings a single-pass review would use
  const [model] = resolveReviewPassModelConfigs(1);
  const modelUsed = model.displayName;
  const response = await generateStructured({
    modelConfig: model.config,
    system: readFileSync(promptPath, "utf-8"),
    prompt: buildUserMessage(compressed, prMetadata, patches, skippedFiles),
    schema: DesignPassOutputSchema,
    settings: model.settings,
  });
  if (!response.object) throw new Error("design pass returned no parseable object");

  const prFiles = new Set(patches.map((p) => normalizePath(p.path)));
  const findings = response.object.findings
    .map((d) => toFinding(d, prFiles))
    .filter((f): f is Finding => f !== null)
    .slice(0, MAX_DESIGN_FINDINGS);
  log.info(
    {
      model: modelUsed,
      raised: response.object.findings.length,
      kept: findings.length,
      skippedFiles: skippedFiles.length,
    },
    "design pass complete",
  );
  return { findings, tokenCount: response.usage.totalTokens ?? 0, modelUsed };
}

/**
 * runs the design pass and publishes only what the judge confirms. without the
 * judge nothing would stand between one model's opinion and an inline comment,
 * so the pass does not run at all then. never throws: a failure keeps the review.
 */
export async function applyDesignPass(
  review: ReviewResult,
  patches: readonly FilePatch[],
  prMetadata: PRMetadata,
  maxTokens: number,
): Promise<ReviewResult> {
  const judge = resolveJudgeConfig();
  if (!judge.enabled) {
    log.warn("RUSTY_DESIGN_PASS is on but the judge is disabled; skipping the design pass");
    return review;
  }

  let pass: DesignPassResult;
  try {
    pass = await runDesignPass(patches, prMetadata, maxTokens);
  } catch (err) {
    log.warn({ err }, "design pass failed; publishing the review without it");
    return review;
  }

  if (pass.findings.length === 0) {
    return { ...review, designPass: { raised: 0, published: 0, tokenCount: pass.tokenCount } };
  }

  const judged = await judgeFindings(pass.findings, patches, judge, {
    alreadyReported: review.findings,
    rubric: designRubric(judge.threshold),
  });
  // a failed judge keeps everything it was given, which here would publish unjudged findings
  const published = judged.failed ? [] : judged.accepted;
  const findings = [...review.findings, ...published];
  return {
    ...review,
    findings,
    recommendation: deriveMergedRecommendation(findings, [review.recommendation]),
    designPass: {
      raised: pass.findings.length,
      published: published.length,
      tokenCount: pass.tokenCount + judged.tokenCount,
    },
  };
}
