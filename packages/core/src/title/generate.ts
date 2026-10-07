import { Agent } from "@mastra/core/agent";
import { compressDiff } from "../diff/compress.js";
import {
  resolveModelConfig,
  resolveModel,
  getModelDisplayName,
  resolveModelSettings,
  resolveJsonPromptInjection,
  applyModelConstraints,
  resolveDefaultAgentOptions,
} from "../agent/model.js";
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

  const defaultOptions = resolveDefaultAgentOptions(modelConfig);
  const agent = new Agent({
    id: "title-agent",
    name: "Rusty Bot Title Generator",
    instructions: () => buildTitleSystemPrompt(),
    model: () => resolveModel(modelConfig),
    ...(defaultOptions && { defaultOptions }),
  });

  const userMessage = buildTitleUserMessage(compressed, prMetadata);

  const modelSettings = applyModelConstraints(modelConfig, resolveModelSettings("title"));
  const jsonPromptInjection = resolveJsonPromptInjection(modelConfig);
  const response = await agent.generate(userMessage, {
    structuredOutput: { schema: ConventionalTitleOutputSchema, jsonPromptInjection },
    ...(Object.keys(modelSettings).length > 0 && { modelSettings }),
  });

  const parsed = response.object;
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
