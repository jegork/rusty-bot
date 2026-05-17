import { Agent } from "@mastra/core/agent";
import { compressDiff } from "../diff/compress.js";
import {
  resolveModelConfig,
  resolveModel,
  getModelDisplayName,
  resolveModelSettings,
  resolveJsonPromptInjection,
  applyModelConstraints,
} from "../agent/model.js";
import { PRDescriptionOutputSchema, type PRDescriptionOutput } from "./schema.js";
import { buildDescriptionSystemPrompt, buildDescriptionUserMessage } from "./prompt.js";
import type { FilePatch, PRMetadata } from "../types.js";

const DESCRIPTION_MARKER = "<!-- rusty-bot-description -->";
const MAX_DESCRIPTION_TOKENS = 30_000;

export interface GenerateDescriptionResult {
  markdown: string;
  modelUsed: string;
  tokenCount: number;
}

const PLACEHOLDER_PATTERNS = [
  /^\s*$/,
  /^(todo|wip|fixme|tbd|placeholder|fill\s*(this\s*)?in)\s*\.?$/i,
  /^(no\s+description|update|fix|changes?)\s*\.?$/i,
];

export function shouldGenerateDescription(currentDescription: string): boolean {
  const trimmed = currentDescription.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.includes(DESCRIPTION_MARKER)) return true;
  if (trimmed.length < 20 && PLACEHOLDER_PATTERNS.some((p) => p.test(trimmed))) return true;
  return false;
}

function stripBotMarker(description: string): string {
  return description.replace(DESCRIPTION_MARKER, "").trim();
}

export interface FormatDescriptionOptions {
  /** when true, the model has already folded the previous description into its
   * output → skip the <details>"Original description" wrap so we don't end up
   * with the same content rendered twice (and the wrap itself accumulating
   * one extra nesting level on every incremental re-review). */
  incremental?: boolean;
}

export function formatDescription(
  output: PRDescriptionOutput,
  originalDescription?: string,
  options?: FormatDescriptionOptions,
): string {
  const lines: string[] = [DESCRIPTION_MARKER, ""];

  lines.push("## Summary");
  lines.push("");
  lines.push(output.summary);
  lines.push("");

  if (output.fileChanges.length > 0) {
    lines.push("## Changes");
    lines.push("");
    lines.push("| File | Description |");
    lines.push("|------|-------------|");
    for (const change of output.fileChanges) {
      const path = change.path.replace(/\|/g, "\\|");
      const desc = change.description.replace(/\|/g, "\\|").replace(/\n+/g, " ");
      lines.push(`| \`${path}\` | ${desc} |`);
    }
    lines.push("");
  }

  if (output.breakingChanges.length > 0) {
    lines.push("## Breaking Changes");
    lines.push("");
    for (const change of output.breakingChanges) {
      lines.push(`- ${change}`);
    }
    lines.push("");
  }

  if (output.migrationNotes) {
    lines.push("## Migration Notes");
    lines.push("");
    lines.push(output.migrationNotes);
    lines.push("");
  }

  // augment mode skips the wrap entirely: the model's output already merged the
  // prior description's content, so re-attaching it would duplicate everything
  // AND keep growing one nested <details> deeper on every incremental push.
  const skipOriginalWrap = options?.incremental === true;
  const stripped =
    !skipOriginalWrap && originalDescription ? stripBotMarker(originalDescription) : "";
  if (stripped.length > 0) {
    lines.push("<details>");
    lines.push("<summary>Original description</summary>");
    lines.push("");
    lines.push(stripped);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }

  return lines.join("\n");
}

export interface GeneratePRDescriptionOptions {
  /** when true, the patches above represent ONLY the diff since the existing
   * description was generated. The generator runs in augment-in-place mode and
   * skips the <details>"Original description" wrap on output. Only meaningful
   * when an existingDescription is provided. */
  incremental?: boolean;
}

export async function generatePRDescription(
  patches: FilePatch[],
  prMetadata: PRMetadata,
  existingDescription?: string,
  options?: GeneratePRDescriptionOptions,
): Promise<GenerateDescriptionResult> {
  const { compressed } = compressDiff(patches, MAX_DESCRIPTION_TOKENS);

  const modelConfig = resolveModelConfig();
  const modelName = getModelDisplayName(modelConfig);

  const agent = new Agent({
    id: "description-agent",
    name: "Rusty Bot Description Generator",
    instructions: () => buildDescriptionSystemPrompt(),
    model: () => resolveModel(modelConfig),
  });

  const incremental = options?.incremental === true;
  const userMessage = buildDescriptionUserMessage(compressed, prMetadata, existingDescription, {
    incremental,
  });

  const modelSettings = applyModelConstraints(modelConfig, resolveModelSettings("description"));
  const jsonPromptInjection = resolveJsonPromptInjection(modelConfig);
  const response = await agent.generate(userMessage, {
    structuredOutput: { schema: PRDescriptionOutputSchema, jsonPromptInjection },
    ...(Object.keys(modelSettings).length > 0 && { modelSettings }),
  });

  const parsed = response.object;
  const tokenCount = response.usage.totalTokens ?? 0;

  return {
    markdown: formatDescription(parsed, existingDescription, { incremental }),
    modelUsed: modelName,
    tokenCount,
  };
}
