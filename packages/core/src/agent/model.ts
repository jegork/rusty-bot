import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { DefaultAzureCredential } from "@azure/identity";
import { createOllama } from "ai-sdk-ollama";

export type ModelConfig =
  | { type: "router"; model: string }
  | { type: "azure-api-key"; resourceName: string; deploymentName: string; apiKey: string }
  | { type: "azure-managed-identity"; resourceName: string; deploymentName: string }
  | { type: "azure-foundry-api-key"; resourceName: string; deploymentName: string; apiKey: string }
  | { type: "azure-foundry-managed-identity"; resourceName: string; deploymentName: string }
  | { type: "azure-anthropic-api-key"; baseUrl: string; deploymentName: string; apiKey: string }
  | { type: "azure-anthropic-managed-identity"; baseUrl: string; deploymentName: string }
  | { type: "openai-compatible"; baseUrl: string; model: string; apiKey?: string }
  | { type: "ollama"; baseUrl?: string; model: string; apiKey?: string };

export function resolveModelConfig(): ModelConfig {
  const model = process.env.RUSTY_LLM_MODEL ?? "anthropic/claude-sonnet-4-20250514";

  // azure-openai/<deployment> — derive deployment from the model prefix so a
  // single Azure resource can host multiple deployments (gpt-5.4-mini,
  // gpt-5.3-codex, etc.) and consensus passes can mix them.
  // accepts AZURE_API_KEY (mastra convention) or AZURE_OPENAI_API_KEY.
  // when no API key is present but AZURE_OPENAI_RESOURCE_NAME is set, fall
  // through to managed identity / Entra ID auth — DefaultAzureCredential
  // picks up workload-identity / service-principal / managed-identity creds
  // from the runtime environment.
  const azureApiKey = process.env.AZURE_API_KEY ?? process.env.AZURE_OPENAI_API_KEY;
  if (model.startsWith("azure-openai/") && process.env.AZURE_OPENAI_RESOURCE_NAME) {
    if (azureApiKey) {
      return {
        type: "azure-api-key",
        resourceName: process.env.AZURE_OPENAI_RESOURCE_NAME,
        deploymentName: model.replace("azure-openai/", ""),
        apiKey: azureApiKey,
      };
    }
    return {
      type: "azure-managed-identity",
      resourceName: process.env.AZURE_OPENAI_RESOURCE_NAME,
      deploymentName: model.replace("azure-openai/", ""),
    };
  }

  // legacy single-deployment override: when RUSTY_AZURE_RESOURCE_NAME +
  // RUSTY_AZURE_DEPLOYMENT are both set, use them regardless of the model
  // prefix. predates the prefix-based managed-identity branch above; kept for
  // backward compat with setups that pin a single Azure deployment.
  if (process.env.RUSTY_AZURE_RESOURCE_NAME && process.env.RUSTY_AZURE_DEPLOYMENT) {
    return {
      type: "azure-managed-identity",
      resourceName: process.env.RUSTY_AZURE_RESOURCE_NAME,
      deploymentName: process.env.RUSTY_AZURE_DEPLOYMENT,
    };
  }

  // non-OpenAI models on Azure AI Foundry (Kimi, Llama, Mistral, DeepSeek,
  // etc.) — they share the AOAI endpoint shape but only support
  // /chat/completions, not the newer /responses API that azure(deployment)
  // defaults to. same prefix-driven api-key-or-entra dispatch as azure-openai
  // above; falls through to managed identity when no api key is set.
  if (model.startsWith("azure-foundry/") && process.env.AZURE_OPENAI_RESOURCE_NAME) {
    if (azureApiKey) {
      return {
        type: "azure-foundry-api-key",
        resourceName: process.env.AZURE_OPENAI_RESOURCE_NAME,
        deploymentName: model.replace("azure-foundry/", ""),
        apiKey: azureApiKey,
      };
    }
    return {
      type: "azure-foundry-managed-identity",
      resourceName: process.env.AZURE_OPENAI_RESOURCE_NAME,
      deploymentName: model.replace("azure-foundry/", ""),
    };
  }

  // legacy single-deployment override for foundry (same rationale as above)
  if (process.env.RUSTY_AZURE_FOUNDRY_RESOURCE_NAME && process.env.RUSTY_AZURE_FOUNDRY_DEPLOYMENT) {
    return {
      type: "azure-foundry-managed-identity",
      resourceName: process.env.RUSTY_AZURE_FOUNDRY_RESOURCE_NAME,
      deploymentName: process.env.RUSTY_AZURE_FOUNDRY_DEPLOYMENT,
    };
  }

  // anthropic on azure ai foundry. accepts AZURE_ANTHROPIC_API_KEY or
  // RUSTY_AZURE_ANTHROPIC_API_KEY for api-key mode; falls through to
  // managed identity / Entra ID when no key is set (DefaultAzureCredential
  // resolves the runtime creds, scope cognitiveservices.azure.com/.default).
  const azureAnthropicBaseUrl = process.env.RUSTY_AZURE_ANTHROPIC_BASE_URL;
  const azureAnthropicApiKey =
    process.env.RUSTY_AZURE_ANTHROPIC_API_KEY ?? process.env.AZURE_ANTHROPIC_API_KEY;
  if (model.startsWith("azure-anthropic/") && azureAnthropicBaseUrl) {
    if (azureAnthropicApiKey) {
      return {
        type: "azure-anthropic-api-key",
        baseUrl: azureAnthropicBaseUrl,
        deploymentName: model.replace("azure-anthropic/", ""),
        apiKey: azureAnthropicApiKey,
      };
    }
    return {
      type: "azure-anthropic-managed-identity",
      baseUrl: azureAnthropicBaseUrl,
      deploymentName: model.replace("azure-anthropic/", ""),
    };
  }

  // legacy single-deployment override for anthropic (same rationale as the
  // openai/foundry overrides above)
  if (azureAnthropicBaseUrl && process.env.RUSTY_AZURE_ANTHROPIC_DEPLOYMENT) {
    return {
      type: "azure-anthropic-managed-identity",
      baseUrl: azureAnthropicBaseUrl,
      deploymentName: process.env.RUSTY_AZURE_ANTHROPIC_DEPLOYMENT,
    };
  }

  // ollama (local default; cloud when RUSTY_OLLAMA_BASE_URL=https://ollama.com).
  // routed via the native ai-sdk-ollama provider instead of the openai-compat
  // path so tool-calling + provider-specific options (mirostat, num_ctx, etc.)
  // are available, and so consensus passes can mix ollama models with other
  // providers per-route.
  if (model.startsWith("ollama/")) {
    return {
      type: "ollama",
      model: model.replace("ollama/", ""),
      baseUrl: process.env.RUSTY_OLLAMA_BASE_URL,
      apiKey: process.env.RUSTY_OLLAMA_API_KEY ?? process.env.OLLAMA_API_KEY,
    };
  }

  // custom openai-compatible endpoint (e.g. litellm)
  if (process.env.RUSTY_LLM_BASE_URL) {
    return {
      type: "openai-compatible",
      baseUrl: process.env.RUSTY_LLM_BASE_URL,
      model,
      apiKey: process.env.RUSTY_LLM_API_KEY,
    };
  }

  return { type: "router", model };
}

/**
 * resolve a ModelConfig for a specific model string, as if RUSTY_LLM_MODEL
 * were set to it — so azure-openai/ prefix handling, openai-compatible
 * endpoints, etc. all apply consistently across per-agent overrides.
 */
export function resolveModelConfigWithOverride(overrideModel: string): ModelConfig {
  const saved = process.env.RUSTY_LLM_MODEL;
  process.env.RUSTY_LLM_MODEL = overrideModel;
  try {
    return resolveModelConfig();
  } finally {
    if (saved !== undefined) {
      process.env.RUSTY_LLM_MODEL = saved;
    } else {
      delete process.env.RUSTY_LLM_MODEL;
    }
  }
}

export function resolveTriageModelConfig(): ModelConfig | null {
  const triageModel = process.env.RUSTY_LLM_TRIAGE_MODEL;
  if (!triageModel) return null;
  return resolveModelConfigWithOverride(triageModel);
}

interface FoundryBodyOptions {
  disableThinking?: boolean;
}

// foundry chat completions accepts vendor-specific body fields like
// `thinking: { type: "disabled" }` (Moonshot/Kimi) that have no equivalent
// passthrough in @ai-sdk/openai's typed options. mutate the JSON body in-place
// before it goes on the wire. silently no-ops on non-JSON bodies (streaming
// uploads, FormData, etc.) — those don't apply to chat completions today.
export function mutateBodyForFoundry(
  init: Record<string, unknown> | undefined,
  opts: FoundryBodyOptions,
): void {
  if (!init || typeof init.body !== "string") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
  const body = parsed as Record<string, unknown>;
  if (opts.disableThinking) {
    body.thinking = { type: "disabled" };
  }
  init.body = JSON.stringify(body);
}

function makeFoundryFetch(opts: FoundryBodyOptions): typeof globalThis.fetch {
  return (async (input: unknown, init?: Record<string, unknown>) => {
    const next = { ...init };
    mutateBodyForFoundry(next, opts);
    return globalThis.fetch(input as Parameters<typeof fetch>[0], next);
  }) as typeof globalThis.fetch;
}

export function resolveModel(
  config: ModelConfig,
): string | ReturnType<ReturnType<typeof createAzure>> {
  // both createAzure(...)(...) and createOllama(...)(...) return the ai-sdk-v6
  // LanguageModelV3 shape, so a single ReturnType<...> annotation is enough.
  switch (config.type) {
    case "router":
      return config.model;

    case "azure-api-key": {
      const azure = createAzure({
        resourceName: config.resourceName,
        apiKey: config.apiKey,
      });
      return azure(config.deploymentName);
    }

    case "azure-managed-identity": {
      const credential = new DefaultAzureCredential();
      const scope = "https://cognitiveservices.azure.com/.default";

      const azureFetch = (async (input: unknown, init?: Record<string, unknown>) => {
        const token = await credential.getToken(scope);
        const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
        headers.set("Authorization", `Bearer ${token.token}`);
        return globalThis.fetch(input as Parameters<typeof fetch>[0], { ...init, headers });
      }) as typeof globalThis.fetch;

      const azure = createAzure({
        resourceName: config.resourceName,
        fetch: azureFetch,
      });
      return azure(config.deploymentName);
    }

    case "azure-foundry-api-key": {
      const disableThinking = resolveDisableThinking(config);
      const azure = createAzure({
        resourceName: config.resourceName,
        apiKey: config.apiKey,
        ...(disableThinking && { fetch: makeFoundryFetch({ disableThinking: true }) }),
      });
      // .chat() routes to /v1/chat/completions; the default azure() picks
      // /v1/responses, which non-OpenAI Foundry models reject
      return azure.chat(config.deploymentName);
    }

    case "azure-foundry-managed-identity": {
      const credential = new DefaultAzureCredential();
      const scope = "https://cognitiveservices.azure.com/.default";
      const disableThinking = resolveDisableThinking(config);

      const azureFetch = (async (input: unknown, init?: Record<string, unknown>) => {
        const token = await credential.getToken(scope);
        const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
        headers.set("Authorization", `Bearer ${token.token}`);
        const next = { ...init, headers };
        if (disableThinking) mutateBodyForFoundry(next, { disableThinking: true });
        return globalThis.fetch(input as Parameters<typeof fetch>[0], next);
      }) as typeof globalThis.fetch;

      const azure = createAzure({
        resourceName: config.resourceName,
        fetch: azureFetch,
      });
      return azure.chat(config.deploymentName);
    }

    case "azure-anthropic-api-key": {
      const anthropic = createAnthropic({
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
      });
      return anthropic(config.deploymentName);
    }

    case "azure-anthropic-managed-identity": {
      const credential = new DefaultAzureCredential();
      const scope = "https://cognitiveservices.azure.com/.default";

      const anthropicFetch = (async (input: unknown, init?: Record<string, unknown>) => {
        const token = await credential.getToken(scope);
        const headers = new Headers(init?.headers as ConstructorParameters<typeof Headers>[0]);
        headers.delete("x-api-key");
        headers.set("Authorization", `Bearer ${token.token}`);
        return globalThis.fetch(input as Parameters<typeof fetch>[0], { ...init, headers });
      }) as typeof globalThis.fetch;

      const anthropic = createAnthropic({
        baseURL: config.baseUrl,
        // createAnthropic requires apiKey or authToken; the fetch wrapper
        // overrides Authorization with a fresh entra token per request.
        authToken: "managed-identity",
        fetch: anthropicFetch,
      });
      return anthropic(config.deploymentName);
    }

    case "openai-compatible":
      return config.model;

    case "ollama": {
      const ollama = createOllama({
        ...(config.baseUrl && { baseURL: config.baseUrl }),
        ...(config.apiKey && { apiKey: config.apiKey }),
      });
      return ollama(config.model);
    }
  }
}

export function resolveDefaultAgentOptions(
  config: ModelConfig,
): { providerOptions: { requesty: { auto_cache: true } } } | undefined {
  if (process.env.RUSTY_PROMPT_CACHE === "false") return undefined;
  if (config.type !== "router") return undefined;
  if (!config.model.startsWith("requesty/")) return undefined;
  return { providerOptions: { requesty: { auto_cache: true } } };
}

export function supportsAnthropicCacheControl(config: ModelConfig): boolean {
  if (
    config.type === "azure-anthropic-api-key" ||
    config.type === "azure-anthropic-managed-identity"
  ) {
    return true;
  }
  if (config.type !== "router") return false;
  return config.model.includes("anthropic/");
}

const NATIVE_STRUCTURED_OUTPUT_ROUTER_PREFIXES = [
  "openai/",
  "anthropic/",
  "google/",
  "azure-openai/",
  "requesty/openai/",
  "requesty/anthropic/",
  "requesty/google/",
  "requesty/moonshot/",
  "requesty/fireworks/",
];

export function supportsNativeStructuredOutput(config: ModelConfig): boolean {
  switch (config.type) {
    case "azure-api-key":
    case "azure-managed-identity":
    case "azure-anthropic-api-key":
    case "azure-anthropic-managed-identity":
      return true;
    case "azure-foundry-api-key":
    case "azure-foundry-managed-identity":
      // Foundry chat completions for non-OpenAI models (Kimi, Llama, etc.)
      // varies by deployment; default to prompt-injected JSON to be safe
      return false;
    case "openai-compatible":
      return true;
    case "ollama":
      // ollama models vary widely in JSON-schema reliability. default to
      // prompt-injected JSON via the structuring model; opt in per-model with
      // RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT=ollama/gpt-oss* etc.
      return false;
    case "router":
      return NATIVE_STRUCTURED_OUTPUT_ROUTER_PREFIXES.some((prefix) =>
        config.model.startsWith(prefix),
      );
  }
}

function modelMatchKey(config: ModelConfig): string {
  switch (config.type) {
    case "router":
      return config.model;
    case "openai-compatible":
      return config.model;
    case "azure-api-key":
    case "azure-managed-identity":
      return `azure-openai/${config.deploymentName}`;
    case "azure-foundry-api-key":
    case "azure-foundry-managed-identity":
      return `azure-foundry/${config.deploymentName}`;
    case "azure-anthropic-api-key":
    case "azure-anthropic-managed-identity":
      return `azure-anthropic/${config.deploymentName}`;
    case "ollama":
      return `ollama/${config.model}`;
  }
}

function matchesAny(modelKey: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (modelKey.startsWith(prefix)) return true;
    } else if (modelKey === pattern) {
      return true;
    }
  }
  return false;
}

export function resolveJsonPromptInjection(config: ModelConfig): boolean {
  const key = modelMatchKey(config);

  const forceOn = readCsvEnv("RUSTY_LLM_JSON_PROMPT_INJECTION");
  if (forceOn.length > 0 && matchesAny(key, forceOn)) return true;

  const forceOff = readCsvEnv("RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT");
  if (forceOff.length > 0 && matchesAny(key, forceOff)) return false;

  return !supportsNativeStructuredOutput(config);
}

/**
 * Whether the deployment should have its thinking/reasoning trace disabled at
 * request time. Currently only takes effect on azure-foundry/* deployments —
 * other paths have no Foundry-style `thinking` knob to flip. Matches the
 * model display name against `RUSTY_LLM_DISABLE_THINKING` (CSV with trailing-*
 * wildcards), same pattern as `RUSTY_LLM_JSON_PROMPT_INJECTION`.
 */
export function resolveDisableThinking(config: ModelConfig): boolean {
  if (config.type !== "azure-foundry-api-key" && config.type !== "azure-foundry-managed-identity") {
    return false;
  }
  const patterns = readCsvEnv("RUSTY_LLM_DISABLE_THINKING");
  if (patterns.length === 0) return false;
  return matchesAny(modelMatchKey(config), patterns);
}

export interface ModelSettings {
  temperature?: number;
  topP?: number;
}

type AgentKind = "review" | "triage" | "judge" | "description" | "title";

const AGENT_ENV_PREFIX: Record<AgentKind, string> = {
  review: "RUSTY_REVIEW",
  triage: "RUSTY_TRIAGE",
  judge: "RUSTY_JUDGE",
  description: "RUSTY_DESCRIPTION",
  title: "RUSTY_TITLE",
};

function readNumericEnv(
  agentKind: AgentKind,
  suffix: string,
  globalKey: string,
): number | undefined {
  const raw = process.env[`${AGENT_ENV_PREFIX[agentKind]}_${suffix}`] ?? process.env[globalKey];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

/** per-agent settings with global fallback: e.g. RUSTY_JUDGE_TEMPERATURE → RUSTY_LLM_TEMPERATURE */
export function resolveModelSettings(agentKind: AgentKind = "review"): ModelSettings {
  const settings: ModelSettings = {};

  const temp = readNumericEnv(agentKind, "TEMPERATURE", "RUSTY_LLM_TEMPERATURE");
  if (temp !== undefined) settings.temperature = temp;

  const topP = readNumericEnv(agentKind, "TOP_P", "RUSTY_LLM_TOP_P");
  if (topP !== undefined) settings.topP = topP;

  return settings;
}

function readCsvEnv(key: string): string[] {
  return (
    process.env[key]
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []
  );
}

function readNumericCsvEnv(key: string): number[] {
  return readCsvEnv(key)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

export interface ReviewPassModelConfig {
  config: ModelConfig;
  settings: ModelSettings;
  displayName: string;
}

export function resolveReviewPassModelConfigs(passCount: number): ReviewPassModelConfig[] {
  const reviewModels = readCsvEnv("RUSTY_REVIEW_MODELS");
  const reviewTemperatures = readNumericCsvEnv("RUSTY_REVIEW_TEMPERATURES");
  const reviewTopPs = readNumericCsvEnv("RUSTY_REVIEW_TOP_PS");
  const defaultSettings = resolveModelSettings("review");

  return Array.from({ length: passCount }, (_, index) => {
    const model = reviewModels[index];
    const config = model ? resolveModelConfigWithOverride(model) : resolveModelConfig();
    const settings: ModelSettings = { ...defaultSettings };

    if (index < reviewTemperatures.length) {
      settings.temperature = reviewTemperatures[index];
    }
    if (index < reviewTopPs.length) {
      settings.topP = reviewTopPs[index];
    }

    return {
      config,
      settings: applyModelConstraints(config, settings),
      displayName: getModelDisplayName(config),
    };
  });
}

interface HardTemperatureLock {
  pattern: RegExp;
  temperature: number;
}

const HARD_TEMPERATURE_LOCKS: HardTemperatureLock[] = [
  { pattern: /moonshot\/kimi-k2\.5/i, temperature: 1 },
];

function findHardTemperatureLock(displayName: string): HardTemperatureLock | undefined {
  return HARD_TEMPERATURE_LOCKS.find((entry) => entry.pattern.test(displayName));
}

export function applyModelConstraints(config: ModelConfig, settings: ModelSettings): ModelSettings {
  const lock = findHardTemperatureLock(getModelDisplayName(config));
  if (!lock) return settings;
  if (settings.temperature === lock.temperature) return settings;
  return { ...settings, temperature: lock.temperature };
}

export function getModelDisplayName(config: ModelConfig): string {
  switch (config.type) {
    case "router":
      return config.model;
    case "azure-api-key":
      return `azure/${config.deploymentName}`;
    case "azure-managed-identity":
      return `azure/${config.deploymentName}`;
    case "azure-foundry-api-key":
      return `azure-foundry/${config.deploymentName}`;
    case "azure-foundry-managed-identity":
      return `azure-foundry/${config.deploymentName}`;
    case "azure-anthropic-api-key":
      return `azure-anthropic/${config.deploymentName}`;
    case "azure-anthropic-managed-identity":
      return `azure-anthropic/${config.deploymentName}`;
    case "openai-compatible":
      return `${config.baseUrl}/${config.model}`;
    case "ollama":
      return `ollama/${config.model}`;
  }
}
