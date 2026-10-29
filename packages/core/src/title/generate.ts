import { compressDiff } from "../diff/compress.js";
import {
  resolveModelConfig,
  getModelDisplayName,
  resolveModelSettings,
  applyModelConstraints,
} from "../agent/model.js";
import { generateStructured } from "../agent/generate.js";
import { ConventionalTitleOutputSchema, type ConventionalTitleOutput } from "./schema.js";
import { buildTitleSystemPrompt, buildTitleUserMessage } from "./prompt.js";
import { formatConventionalTitle, isConventionalTitle } from "./parse.js";
import type { FilePatch, PRMetadata } from "../types.js";

const MAX_TITLE_TOKENS = 12_000;

export interface GenerateTitleResult {
  title: string;
  output: ConventionalTitleOutput;
  modelUsed: string;
  tokenCount: number;
}

export async function generateConventionalTitle(
  patches: FilePatch[],
  prMetadata: PRMetadata,
): Promise<GenerateTitleResult> {
  const { compressed } = compressDiff(patches, MAX_TITLE_TOKENS);

  const modelConfig = resolveModelConfig();
  const modelName = getModelDisplayName(modelConfig);

  const userMessage = buildTitleUserMessage(compressed, prMetadata);

  const modelSettings = applyModelConstraints(modelConfig, resolveModelSettings("title"));
  const response = await generateStructured({
    modelConfig,
    system: buildTitleSystemPrompt(),
    prompt: userMessage,
    schema: ConventionalTitleOutputSchema,
    settings: modelSettings,
  });

  const parsed = response.object;
  if (!parsed) throw new Error("title generation returned no parseable object");
  const tokenCount = response.usage.totalTokens ?? 0;

  const title = formatConventionalTitle(parsed);
  if (!isConventionalTitle(title)) {
    throw new Error(`generated title failed conventional commit validation: ${title}`);
  }

  return {
    title,
    output: parsed,
    modelUsed: modelName,
    tokenCount,
  };
}

export { isConventionalTitle, formatConventionalTitle };
