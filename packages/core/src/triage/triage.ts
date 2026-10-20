import { Agent } from "@mastra/core/agent";
import type { FilePatch, TriageResult, TriageFileResult } from "../types.js";
import type { OpenGrepFinding } from "../opengrep/types.js";
import { TriageOutputSchema } from "./schema.js";
import { buildTriageSystemPrompt, buildTriageUserMessage } from "./prompt.js";
import {
  resolveTriageModelConfig,
  resolveModel,
  getModelDisplayName,
  resolveModelSettings,
  resolveDefaultAgentOptions,
  resolveJsonPromptInjection,
  applyModelConstraints,
} from "../agent/model.js";
import { normalizePath } from "../diff/normalize-path.js";
import { countTokens } from "../diff/compress.js";
import { logger } from "../logger.js";

const log = logger.child({ module: "triage" });
const MAX_TRIAGE_TOKENS = 30_000;

function applyOverflowDefaults(
  patches: FilePatch[],
  triageablePatches: FilePatch[],
): TriageFileResult[] {
  const triageablePaths = new Set(triageablePatches.map((p) => p.path));
  return patches
    .filter((p) => !triageablePaths.has(p.path))
    .map((p) => ({
      path: p.path,
      classification: "deep-review" as const,
      reason: "exceeded triage token budget",
    }));
}

export function promoteOpenGrepFindings(
  files: TriageFileResult[],
  openGrepFindings: OpenGrepFinding[] | undefined,
): TriageFileResult[] {
  if (!openGrepFindings || openGrepFindings.length === 0) return files;

  const flaggedPaths = new Set(openGrepFindings.map((f) => normalizePath(f.file)));

  return files.map((f) => {
    if (f.classification === "deep-review") return f;
    if (!flaggedPaths.has(normalizePath(f.path))) return f;
    return {
      ...f,
      classification: "deep-review",
      reason: "opengrep finding",
    };
  });
}

function applySafetyNet(files: TriageFileResult[], patches: FilePatch[]): TriageFileResult[] {
  const hasReviewable = files.some((f) => f.classification !== "skip");
  if (hasReviewable) return files;

  // all files were skipped — force the largest ones to deep-review
  log.warn("triage classified all files as skip, applying safety net");
  const sorted = [...patches].sort((a, b) => b.additions - a.additions);
  const forceReview = new Set(
    sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.2))).map((p) => p.path),
  );

  return files.map((f) =>
    forceReview.has(f.path)
      ? {
          ...f,
          classification: "deep-review",
          reason: "safety net: forced review",
        }
      : f,
  );
}

export async function runTriage(
  patches: FilePatch[],
  openGrepFindings?: OpenGrepFinding[],
): Promise<TriageResult> {
  const modelConfig = resolveTriageModelConfig();
  if (!modelConfig) {
    throw new Error("triage model not configured");
  }

  const modelName = getModelDisplayName(modelConfig);
  const systemPrompt = buildTriageSystemPrompt();

  // check if all patches fit within the triage budget
  const userMessage = buildTriageUserMessage(patches);
  const inputTokens = countTokens(systemPrompt + userMessage);

  let triageablePatches = patches;
  let overflowFiles: TriageFileResult[] = [];

  if (inputTokens > MAX_TRIAGE_TOKENS) {
    log.warn(
      { inputTokens, maxTokens: MAX_TRIAGE_TOKENS, totalFiles: patches.length },
      "triage input exceeds token budget, splitting",
    );

    // include files until we hit the budget
    triageablePatches = [];
    let currentTokens = countTokens(systemPrompt);
    for (const patch of patches) {
      const patchMessage = buildTriageUserMessage([patch]);
      const patchTokens = countTokens(patchMessage);
      if (currentTokens + patchTokens > MAX_TRIAGE_TOKENS) break;
      triageablePatches.push(patch);
      currentTokens += patchTokens;
    }

    overflowFiles = applyOverflowDefaults(patches, triageablePatches);
  }

  const defaultOptions = resolveDefaultAgentOptions(modelConfig);
  const agent = new Agent({
    id: "triage-agent",
    name: "Rusty Bot Triage",
    instructions: () => systemPrompt,
    model: () => resolveModel(modelConfig),
    ...(defaultOptions && { defaultOptions }),
  });

  const triageMessage = buildTriageUserMessage(triageablePatches);
  const modelSettings = applyModelConstraints(modelConfig, resolveModelSettings("triage"));
  const jsonPromptInjection = resolveJsonPromptInjection(modelConfig);
  const response = await agent.generate(triageMessage, {
    structuredOutput: { schema: TriageOutputSchema, jsonPromptInjection },
    ...(Object.keys(modelSettings).length > 0 && { modelSettings }),
  });

  const parsed = response.object;
  const tokenCount = response.usage.totalTokens ?? 0;

  // merge triage results with overflow defaults
  const allFiles = [...parsed.files, ...overflowFiles];

  // handle files that the model missed (classify as deep-review to be safe)
  const classifiedPaths = new Set(allFiles.map((f) => f.path));
  for (const patch of patches) {
    if (!classifiedPaths.has(patch.path)) {
      allFiles.push({
        path: patch.path,
        classification: "deep-review",
        reason: "not classified by triage model",
      });
    }
  }

  const promotedFiles = promoteOpenGrepFindings(allFiles, openGrepFindings);
  const safeFiles = applySafetyNet(promotedFiles, patches);

  const promotedCount = promotedFiles.filter(
    (f, i) => f.classification === "deep-review" && allFiles[i].classification !== "deep-review",
  ).length;

  log.info(
    {
      skipped: safeFiles.filter((f) => f.classification === "skip").length,
      skimmed: safeFiles.filter((f) => f.classification === "skim").length,
      deepReview: safeFiles.filter((f) => f.classification === "deep-review").length,
      openGrepPromoted: promotedCount,
      model: modelName,
      tokens: tokenCount,
    },
    "triage complete",
  );

  return { files: safeFiles, modelUsed: modelName, tokenCount };
}

export function isCascadeEnabled(): boolean {
  const explicitToggle = process.env.RUSTY_CASCADE_ENABLED;
  if (explicitToggle === "false") return false;
  if (explicitToggle === "true") return true;
  return !!process.env.RUSTY_LLM_TRIAGE_MODEL;
}

export function splitByClassification(
  patches: FilePatch[],
  triageFiles: TriageFileResult[],
): { skip: FilePatch[]; skim: FilePatch[]; deepReview: FilePatch[] } {
  const classMap = new Map(triageFiles.map((f) => [f.path, f.classification]));

  const skip: FilePatch[] = [];
  const skim: FilePatch[] = [];
  const deepReview: FilePatch[] = [];

  for (const patch of patches) {
    const classification = classMap.get(patch.path) ?? "deep-review";
    switch (classification) {
      case "skip":
        skip.push(patch);
        break;
      case "skim":
        skim.push(patch);
        break;
      case "deep-review":
        deepReview.push(patch);
        break;
    }
  }

  return { skip, skim, deepReview };
}
