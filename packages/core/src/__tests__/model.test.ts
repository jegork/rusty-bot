import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveModelConfig,
  resolveTriageModelConfig,
  resolveModelConfigWithOverride,
  resolveReviewPassModelConfigs,
  getModelDisplayName,
  resolveDefaultAgentOptions,
  resolveDisableThinking,
  resolveJsonPromptInjection,
  supportsAnthropicCacheControl,
  supportsNativeStructuredOutput,
  applyModelConstraints,
  mutateBodyForFoundry,
  parseModelEffort,
  resolveModel,
} from "../agent/model.js";

function clearEnv() {
  delete process.env.RUSTY_LLM_MODEL;
  delete process.env.RUSTY_LLM_TRIAGE_MODEL;
  delete process.env.RUSTY_REVIEW_MODELS;
  delete process.env.RUSTY_REVIEW_TEMPERATURES;
  delete process.env.RUSTY_REVIEW_TOP_PS;
  delete process.env.RUSTY_REVIEW_TEMPERATURE;
  delete process.env.RUSTY_REVIEW_TOP_P;
  delete process.env.RUSTY_LLM_TEMPERATURE;
  delete process.env.RUSTY_LLM_TOP_P;
  delete process.env.AZURE_API_KEY;
  delete process.env.AZURE_OPENAI_API_KEY;
  delete process.env.AZURE_OPENAI_RESOURCE_NAME;
  delete process.env.RUSTY_AZURE_RESOURCE_NAME;
  delete process.env.RUSTY_AZURE_DEPLOYMENT;
  delete process.env.RUSTY_AZURE_ANTHROPIC_BASE_URL;
  delete process.env.RUSTY_AZURE_ANTHROPIC_API_KEY;
  delete process.env.AZURE_ANTHROPIC_API_KEY;
  delete process.env.RUSTY_AZURE_ANTHROPIC_DEPLOYMENT;
  delete process.env.RUSTY_AZURE_FOUNDRY_RESOURCE_NAME;
  delete process.env.RUSTY_AZURE_FOUNDRY_DEPLOYMENT;
  delete process.env.RUSTY_LLM_BASE_URL;
  delete process.env.RUSTY_LLM_API_KEY;
  delete process.env.REQUESTY_API_KEY;
  delete process.env.RUSTY_PROMPT_CACHE;
  delete process.env.RUSTY_LLM_JSON_PROMPT_INJECTION;
  delete process.env.RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT;
  delete process.env.RUSTY_LLM_DISABLE_THINKING;
  delete process.env.RUSTY_OLLAMA_BASE_URL;
  delete process.env.RUSTY_OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
}

describe("resolveModelConfig", () => {
  beforeEach(clearEnv);

  it("falls back to router with the default model when nothing is set", () => {
    const config = resolveModelConfig();
    expect(config.type).toBe("router");
    if (config.type === "router") {
      expect(config.model).toMatch(/anthropic\//);
    }
  });

  it("returns router config for arbitrary provider strings", () => {
    process.env.RUSTY_LLM_MODEL = "anthropic/claude-haiku";
    const config = resolveModelConfig();
    expect(config).toEqual({ type: "router", model: "anthropic/claude-haiku" });
  });

  it("builds azure-api-key config when azure-openai prefix + api key + resource name are present", () => {
    process.env.RUSTY_LLM_MODEL = "azure-openai/gpt-5.4-mini";
    process.env.AZURE_API_KEY = "secret";
    process.env.AZURE_OPENAI_RESOURCE_NAME = "my-resource";

    const config = resolveModelConfig();
    expect(config.type).toBe("azure-api-key");
    if (config.type === "azure-api-key") {
      expect(config.deploymentName).toBe("gpt-5.4-mini");
      expect(config.resourceName).toBe("my-resource");
      expect(config.apiKey).toBe("secret");
    }
  });

  it("accepts AZURE_OPENAI_API_KEY as an alternative to AZURE_API_KEY", () => {
    process.env.RUSTY_LLM_MODEL = "azure-openai/gpt-5.4-mini";
    process.env.AZURE_OPENAI_API_KEY = "other-secret";
    process.env.AZURE_OPENAI_RESOURCE_NAME = "my-resource";

    const config = resolveModelConfig();
    expect(config.type).toBe("azure-api-key");
    if (config.type === "azure-api-key") {
      expect(config.apiKey).toBe("other-secret");
    }
  });

  it("falls through to router when azure-openai prefix is set but resource name is missing", () => {
    process.env.RUSTY_LLM_MODEL = "azure-openai/gpt-5.4-mini";
    process.env.AZURE_API_KEY = "secret";
    // no AZURE_OPENAI_RESOURCE_NAME

    const config = resolveModelConfig();
    expect(config.type).toBe("router");
  });

  it("leaves requesty/ models on the native mastra router", () => {
    process.env.RUSTY_LLM_MODEL = "requesty/anthropic/claude-sonnet-4";

    const config = resolveModelConfig();
    expect(config).toEqual({ type: "router", model: "requesty/anthropic/claude-sonnet-4" });
  });

  it("builds azure-anthropic-api-key when prefix + base url + api key are present", () => {
    process.env.RUSTY_LLM_MODEL = "azure-anthropic/claude-sonnet-4-5";
    process.env.RUSTY_AZURE_ANTHROPIC_BASE_URL =
      "https://my-foundry.services.ai.azure.com/anthropic/v1";
    process.env.RUSTY_AZURE_ANTHROPIC_API_KEY = "secret";

    const config = resolveModelConfig();
    expect(config).toEqual({
      type: "azure-anthropic-api-key",
      baseUrl: "https://my-foundry.services.ai.azure.com/anthropic/v1",
      deploymentName: "claude-sonnet-4-5",
      apiKey: "secret",
    });
  });

  it("accepts AZURE_ANTHROPIC_API_KEY as an alternative to RUSTY_AZURE_ANTHROPIC_API_KEY", () => {
    process.env.RUSTY_LLM_MODEL = "azure-anthropic/claude-sonnet-4-5";
    process.env.RUSTY_AZURE_ANTHROPIC_BASE_URL =
      "https://my-foundry.services.ai.azure.com/anthropic/v1";
    process.env.AZURE_ANTHROPIC_API_KEY = "alt-secret";

    const config = resolveModelConfig();
    expect(config.type).toBe("azure-anthropic-api-key");
    if (config.type === "azure-anthropic-api-key") {
      expect(config.apiKey).toBe("alt-secret");
    }
  });

  it("falls through to router when azure-anthropic prefix is set but base url is missing", () => {
    process.env.RUSTY_LLM_MODEL = "azure-anthropic/claude-sonnet-4-5";
    process.env.RUSTY_AZURE_ANTHROPIC_API_KEY = "secret";
    // no RUSTY_AZURE_ANTHROPIC_BASE_URL

    const config = resolveModelConfig();
    expect(config.type).toBe("router");
  });

  it("builds azure-anthropic-managed-identity from base url + deployment env vars", () => {
    process.env.RUSTY_AZURE_ANTHROPIC_BASE_URL =
      "https://my-foundry.services.ai.azure.com/anthropic/v1";
    process.env.RUSTY_AZURE_ANTHROPIC_DEPLOYMENT = "claude-sonnet-4-5";

    const config = resolveModelConfig();
    expect(config).toEqual({
      type: "azure-anthropic-managed-identity",
      baseUrl: "https://my-foundry.services.ai.azure.com/anthropic/v1",
      deploymentName: "claude-sonnet-4-5",
    });
  });

  it("prefers azure-anthropic-api-key over managed-identity when both are configured", () => {
    process.env.RUSTY_LLM_MODEL = "azure-anthropic/claude-sonnet-4-5";
    process.env.RUSTY_AZURE_ANTHROPIC_BASE_URL =
      "https://my-foundry.services.ai.azure.com/anthropic/v1";
    process.env.RUSTY_AZURE_ANTHROPIC_API_KEY = "secret";
    process.env.RUSTY_AZURE_ANTHROPIC_DEPLOYMENT = "fallback";

    const config = resolveModelConfig();
    expect(config.type).toBe("azure-anthropic-api-key");
  });

  it("builds azure-foundry-api-key when prefix + api key + resource name are present", () => {
    process.env.RUSTY_LLM_MODEL = "azure-foundry/Kimi-K2.6";
    process.env.AZURE_API_KEY = "secret";
    process.env.AZURE_OPENAI_RESOURCE_NAME = "ai-code-review-foundry";

    const config = resolveModelConfig();
    expect(config).toEqual({
      type: "azure-foundry-api-key",
      resourceName: "ai-code-review-foundry",
      deploymentName: "Kimi-K2.6",
      apiKey: "secret",
    });
  });

  it("falls through to router when azure-foundry prefix is set but resource name is missing", () => {
    process.env.RUSTY_LLM_MODEL = "azure-foundry/Kimi-K2.6";
    process.env.AZURE_API_KEY = "secret";

    const config = resolveModelConfig();
    expect(config.type).toBe("router");
  });

  it("builds azure-foundry-managed-identity from foundry-specific resource + deployment env vars", () => {
    process.env.RUSTY_AZURE_FOUNDRY_RESOURCE_NAME = "ai-code-review-foundry";
    process.env.RUSTY_AZURE_FOUNDRY_DEPLOYMENT = "Kimi-K2.6";

    const config = resolveModelConfig();
    expect(config).toEqual({
      type: "azure-foundry-managed-identity",
      resourceName: "ai-code-review-foundry",
      deploymentName: "Kimi-K2.6",
    });
  });

  it("does not collide with azure-managed-identity when only OpenAI MI vars are set", () => {
    process.env.RUSTY_AZURE_RESOURCE_NAME = "openai-resource";
    process.env.RUSTY_AZURE_DEPLOYMENT = "gpt-5.4";

    const config = resolveModelConfig();
    expect(config.type).toBe("azure-managed-identity");
  });

  it("prefers azure-foundry-api-key over foundry MI when both are configured with the prefix", () => {
    process.env.RUSTY_LLM_MODEL = "azure-foundry/Kimi-K2.6";
    process.env.AZURE_API_KEY = "secret";
    process.env.AZURE_OPENAI_RESOURCE_NAME = "ai-code-review-foundry";
    process.env.RUSTY_AZURE_FOUNDRY_RESOURCE_NAME = "fallback-resource";
    process.env.RUSTY_AZURE_FOUNDRY_DEPLOYMENT = "fallback-deployment";

    const config = resolveModelConfig();
    expect(config.type).toBe("azure-foundry-api-key");
    if (config.type === "azure-foundry-api-key") {
      expect(config.deploymentName).toBe("Kimi-K2.6");
    }
  });

  // Entra-ID-by-absence-of-key paths — these let a single Azure resource
  // host multiple deployments and use the bot's per-slot model strings
  // without needing one RUSTY_AZURE_*_DEPLOYMENT env var per deployment.

  it("falls through to azure-managed-identity when azure-openai prefix + resource name are set but no API key", () => {
    process.env.RUSTY_LLM_MODEL = "azure-openai/gpt-5.4-mini";
    process.env.AZURE_OPENAI_RESOURCE_NAME = "ai-code-review-foundry";
    // no AZURE_API_KEY / AZURE_OPENAI_API_KEY

    const config = resolveModelConfig();
    expect(config).toEqual({
      type: "azure-managed-identity",
      resourceName: "ai-code-review-foundry",
      deploymentName: "gpt-5.4-mini",
    });
  });

  it("derives the azure-openai managed-identity deployment from the model prefix per call (multi-deployment Entra)", () => {
    // critical for consensus: each pass calls resolveModelConfigWithOverride
    // with its own model string; under Entra ID, each must resolve to its own
    // deployment, not a single RUSTY_AZURE_DEPLOYMENT
    process.env.AZURE_OPENAI_RESOURCE_NAME = "ai-code-review-foundry";

    const a = resolveModelConfigWithOverride("azure-openai/gpt-5.4-mini");
    const b = resolveModelConfigWithOverride("azure-openai/gpt-5.3-codex");

    expect(a).toEqual({
      type: "azure-managed-identity",
      resourceName: "ai-code-review-foundry",
      deploymentName: "gpt-5.4-mini",
    });
    expect(b).toEqual({
      type: "azure-managed-identity",
      resourceName: "ai-code-review-foundry",
      deploymentName: "gpt-5.3-codex",
    });
  });

  it("falls through to azure-foundry-managed-identity when azure-foundry prefix + resource name are set but no API key", () => {
    process.env.RUSTY_LLM_MODEL = "azure-foundry/DeepSeek-V4-Flash";
    process.env.AZURE_OPENAI_RESOURCE_NAME = "ai-code-review-foundry";
    // no AZURE_API_KEY

    const config = resolveModelConfig();
    expect(config).toEqual({
      type: "azure-foundry-managed-identity",
      resourceName: "ai-code-review-foundry",
      deploymentName: "DeepSeek-V4-Flash",
    });
  });

  it("falls through to azure-anthropic-managed-identity when azure-anthropic prefix + base URL are set but no API key", () => {
    process.env.RUSTY_LLM_MODEL = "azure-anthropic/claude-sonnet-4-6";
    process.env.RUSTY_AZURE_ANTHROPIC_BASE_URL =
      "https://ai-code-review-foundry.services.ai.azure.com/anthropic/v1";
    // no RUSTY_AZURE_ANTHROPIC_API_KEY / AZURE_ANTHROPIC_API_KEY

    const config = resolveModelConfig();
    expect(config).toEqual({
      type: "azure-anthropic-managed-identity",
      baseUrl: "https://ai-code-review-foundry.services.ai.azure.com/anthropic/v1",
      deploymentName: "claude-sonnet-4-6",
    });
  });

  it("prefers azure-api-key over managed-identity when an API key is set (api-key wins by default)", () => {
    process.env.RUSTY_LLM_MODEL = "azure-openai/gpt-5.4-mini";
    process.env.AZURE_OPENAI_RESOURCE_NAME = "ai-code-review-foundry";
    process.env.AZURE_OPENAI_API_KEY = "secret";

    const config = resolveModelConfig();
    expect(config.type).toBe("azure-api-key");
  });

  it("legacy RUSTY_AZURE_RESOURCE_NAME + RUSTY_AZURE_DEPLOYMENT still wins when no prefix match (backward compat)", () => {
    // a setup that predates per-prefix Entra and never set the azure-openai/ prefix
    // continues to resolve as before
    process.env.RUSTY_LLM_MODEL = "anthropic/some-model";
    process.env.RUSTY_AZURE_RESOURCE_NAME = "legacy-resource";
    process.env.RUSTY_AZURE_DEPLOYMENT = "legacy-deployment";

    const config = resolveModelConfig();
    expect(config).toEqual({
      type: "azure-managed-identity",
      resourceName: "legacy-resource",
      deploymentName: "legacy-deployment",
    });
  });

  it("user's actual config: 4 azure-* models all resolve to managed-identity from one resource name", () => {
    // mirrors the production ADO pipeline config: one resource, multiple
    // deployments across openai/foundry/anthropic, all secret-less
    process.env.AZURE_OPENAI_RESOURCE_NAME = "ai-code-review-foundry";
    process.env.RUSTY_AZURE_ANTHROPIC_BASE_URL =
      "https://ai-code-review-foundry.services.ai.azure.com/anthropic/v1";

    expect(resolveModelConfigWithOverride("azure-openai/gpt-5.4-mini").type).toBe(
      "azure-managed-identity",
    );
    expect(resolveModelConfigWithOverride("azure-openai/gpt-5.3-codex").type).toBe(
      "azure-managed-identity",
    );
    expect(resolveModelConfigWithOverride("azure-foundry/DeepSeek-V4-Flash").type).toBe(
      "azure-foundry-managed-identity",
    );
    expect(resolveModelConfigWithOverride("azure-anthropic/claude-sonnet-4-6").type).toBe(
      "azure-anthropic-managed-identity",
    );
  });

  it("builds ollama config from `ollama/` prefix with no env vars (local default)", () => {
    process.env.RUSTY_LLM_MODEL = "ollama/llama3.2";
    const config = resolveModelConfig();
    expect(config).toEqual({
      type: "ollama",
      model: "llama3.2",
      baseUrl: undefined,
      apiKey: undefined,
    });
  });

  it("preserves colons in ollama model identifiers (e.g. gpt-oss:120b)", () => {
    process.env.RUSTY_LLM_MODEL = "ollama/gpt-oss:120b";
    const config = resolveModelConfig();
    expect(config.type).toBe("ollama");
    if (config.type === "ollama") {
      expect(config.model).toBe("gpt-oss:120b");
    }
  });

  it("threads RUSTY_OLLAMA_BASE_URL into the ollama config (cloud routing)", () => {
    process.env.RUSTY_LLM_MODEL = "ollama/gpt-oss:120b";
    process.env.RUSTY_OLLAMA_BASE_URL = "https://ollama.com";
    process.env.RUSTY_OLLAMA_API_KEY = "ol-secret";
    const config = resolveModelConfig();
    expect(config).toEqual({
      type: "ollama",
      model: "gpt-oss:120b",
      baseUrl: "https://ollama.com",
      apiKey: "ol-secret",
    });
  });

  it("falls back to OLLAMA_API_KEY when RUSTY_OLLAMA_API_KEY is unset", () => {
    process.env.RUSTY_LLM_MODEL = "ollama/llama3.2";
    process.env.OLLAMA_API_KEY = "fallback-key";
    const config = resolveModelConfig();
    expect(config.type).toBe("ollama");
    if (config.type === "ollama") {
      expect(config.apiKey).toBe("fallback-key");
    }
  });

  it("prefers RUSTY_OLLAMA_API_KEY over OLLAMA_API_KEY when both set", () => {
    process.env.RUSTY_LLM_MODEL = "ollama/llama3.2";
    process.env.RUSTY_OLLAMA_API_KEY = "rusty-key";
    process.env.OLLAMA_API_KEY = "fallback-key";
    const config = resolveModelConfig();
    if (config.type === "ollama") {
      expect(config.apiKey).toBe("rusty-key");
    }
  });

  it("ollama prefix wins over RUSTY_LLM_BASE_URL (the openai-compatible path)", () => {
    process.env.RUSTY_LLM_MODEL = "ollama/llama3.2";
    process.env.RUSTY_LLM_BASE_URL = "http://litellm.local/v1";
    process.env.RUSTY_LLM_API_KEY = "litellm-key";
    const config = resolveModelConfig();
    expect(config.type).toBe("ollama");
  });
});

describe("resolveReviewPassModelConfigs", () => {
  beforeEach(clearEnv);

  it("uses the default review model for every pass when no per-pass models are set", () => {
    process.env.RUSTY_LLM_MODEL = "anthropic/claude-sonnet";

    const configs = resolveReviewPassModelConfigs(3);

    expect(configs.map((c) => c.displayName)).toEqual([
      "anthropic/claude-sonnet",
      "anthropic/claude-sonnet",
      "anthropic/claude-sonnet",
    ]);
  });

  it("resolves per-pass models and falls back to RUSTY_LLM_MODEL for missing entries", () => {
    process.env.RUSTY_LLM_MODEL = "anthropic/default";
    process.env.RUSTY_REVIEW_MODELS = "anthropic/pass-1, openai/pass-2";

    const configs = resolveReviewPassModelConfigs(3);

    expect(configs.map((c) => c.displayName)).toEqual([
      "anthropic/pass-1",
      "openai/pass-2",
      "anthropic/default",
    ]);
  });

  it("mixes ollama with router providers across consensus passes", () => {
    process.env.RUSTY_OLLAMA_BASE_URL = "https://ollama.com";
    process.env.RUSTY_OLLAMA_API_KEY = "ol-key";
    process.env.RUSTY_REVIEW_MODELS =
      "anthropic/claude-sonnet-4-5,ollama/gpt-oss:120b,requesty/google/gemini-3.1-pro";

    const configs = resolveReviewPassModelConfigs(3);

    expect(configs[0].config.type).toBe("router");
    expect(configs[1].config.type).toBe("ollama");
    expect(configs[2].config.type).toBe("router");
    expect(configs.map((c) => c.displayName)).toEqual([
      "anthropic/claude-sonnet-4-5",
      "ollama/gpt-oss:120b",
      "requesty/google/gemini-3.1-pro",
    ]);
    if (configs[1].config.type === "ollama") {
      expect(configs[1].config.baseUrl).toBe("https://ollama.com");
      expect(configs[1].config.apiKey).toBe("ol-key");
    }
  });

  it("applies per-pass temperature and top-p overrides", () => {
    process.env.RUSTY_REVIEW_TEMPERATURE = "0.5";
    process.env.RUSTY_REVIEW_TOP_P = "0.8";
    process.env.RUSTY_REVIEW_TEMPERATURES = "0.1,0.2";
    process.env.RUSTY_REVIEW_TOP_PS = "0.9";

    const configs = resolveReviewPassModelConfigs(3);

    expect(configs.map((c) => c.settings)).toEqual([
      { temperature: 0.1, topP: 0.9 },
      { temperature: 0.2, topP: 0.8 },
      { temperature: 0.5, topP: 0.8 },
    ]);
  });

  it("forces temperature=1 for kimi-k2.5 even when the per-pass list says otherwise", () => {
    process.env.RUSTY_REVIEW_MODELS = "anthropic/claude-sonnet,requesty/moonshot/kimi-k2.5";
    process.env.RUSTY_REVIEW_TEMPERATURES = "0.2,0.2";

    const configs = resolveReviewPassModelConfigs(2);

    expect(configs[0].settings.temperature).toBe(0.2);
    expect(configs[1].settings.temperature).toBe(1);
  });
});

describe("applyModelConstraints", () => {
  beforeEach(clearEnv);

  it("forces temperature=1 for moonshot/kimi-k2.5 router models", () => {
    const settings = applyModelConstraints(
      { type: "router", model: "requesty/moonshot/kimi-k2.5" },
      { temperature: 0.2, topP: 0.9 },
    );
    expect(settings).toEqual({ temperature: 1, topP: 0.9 });
  });

  it("matches kimi-k2.5 even without a routing prefix", () => {
    const settings = applyModelConstraints(
      { type: "router", model: "moonshot/kimi-k2.5" },
      { temperature: 0.4 },
    );
    expect(settings.temperature).toBe(1);
  });

  it("leaves settings unchanged when temperature is already at the locked value", () => {
    const original = { temperature: 1, topP: 0.5 };
    const settings = applyModelConstraints(
      { type: "router", model: "requesty/moonshot/kimi-k2.5" },
      original,
    );
    expect(settings).toBe(original);
  });

  it("returns settings unchanged for unaffected models", () => {
    const original = { temperature: 0.2 };
    const settings = applyModelConstraints(
      { type: "router", model: "anthropic/claude-sonnet-4-6" },
      original,
    );
    expect(settings).toBe(original);
  });
});

describe("resolveDefaultAgentOptions", () => {
  beforeEach(clearEnv);

  it("returns auto_cache providerOptions for requesty/ router models", () => {
    const opts = resolveDefaultAgentOptions({
      type: "router",
      model: "requesty/anthropic/claude-sonnet-4",
    });
    expect(opts).toEqual({
      providerOptions: { requesty: { auto_cache: true } },
    });
  });

  it("returns undefined for non-requesty router models", () => {
    expect(
      resolveDefaultAgentOptions({ type: "router", model: "anthropic/claude-sonnet" }),
    ).toBeUndefined();
  });

  it("returns undefined for non-router configs", () => {
    expect(
      resolveDefaultAgentOptions({
        type: "azure-api-key",
        resourceName: "r",
        deploymentName: "d",
        apiKey: "k",
      }),
    ).toBeUndefined();
    expect(
      resolveDefaultAgentOptions({
        type: "openai-compatible",
        baseUrl: "https://litellm.example.com/v1",
        model: "anything",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when RUSTY_PROMPT_CACHE=false even for requesty/ models", () => {
    process.env.RUSTY_PROMPT_CACHE = "false";
    expect(
      resolveDefaultAgentOptions({
        type: "router",
        model: "requesty/anthropic/claude-sonnet-4",
      }),
    ).toBeUndefined();
  });
});

describe("supportsAnthropicCacheControl", () => {
  it("returns true for direct anthropic router models", () => {
    expect(
      supportsAnthropicCacheControl({
        type: "router",
        model: "anthropic/claude-sonnet-4",
      }),
    ).toBe(true);
  });

  it("returns true for requesty-routed anthropic models", () => {
    expect(
      supportsAnthropicCacheControl({
        type: "router",
        model: "requesty/anthropic/claude-sonnet-4",
      }),
    ).toBe(true);
  });

  it("returns true when anthropic appears later in a router model string", () => {
    expect(
      supportsAnthropicCacheControl({
        type: "router",
        model: "gateway/vendor/anthropic/claude-sonnet-4",
      }),
    ).toBe(true);
  });

  it("returns false for other requesty-routed providers", () => {
    expect(
      supportsAnthropicCacheControl({
        type: "router",
        model: "requesty/openai/gpt-5",
      }),
    ).toBe(false);
  });

  it("returns false for non-router configs", () => {
    expect(
      supportsAnthropicCacheControl({
        type: "openai-compatible",
        baseUrl: "https://example.com/v1",
        model: "anthropic/claude-sonnet-4",
      }),
    ).toBe(false);
  });

  it("returns true for azure-anthropic configs (api key and managed identity)", () => {
    expect(
      supportsAnthropicCacheControl({
        type: "azure-anthropic-api-key",
        baseUrl: "https://r.services.ai.azure.com/anthropic/v1",
        deploymentName: "claude-sonnet-4-5",
        apiKey: "k",
      }),
    ).toBe(true);
    expect(
      supportsAnthropicCacheControl({
        type: "azure-anthropic-managed-identity",
        baseUrl: "https://r.services.ai.azure.com/anthropic/v1",
        deploymentName: "claude-sonnet-4-5",
      }),
    ).toBe(true);
  });
});

describe("supportsNativeStructuredOutput", () => {
  it("returns true for direct openai/anthropic/google/azure-openai router prefixes", () => {
    expect(supportsNativeStructuredOutput({ type: "router", model: "openai/gpt-5-mini" })).toBe(
      true,
    );
    expect(
      supportsNativeStructuredOutput({ type: "router", model: "anthropic/claude-sonnet-4-6" }),
    ).toBe(true);
    expect(supportsNativeStructuredOutput({ type: "router", model: "google/gemini-3.1-pro" })).toBe(
      true,
    );
    expect(
      supportsNativeStructuredOutput({ type: "router", model: "azure-openai/my-deployment" }),
    ).toBe(true);
  });

  it("returns true for requesty-routed openai/anthropic/google/moonshot/fireworks", () => {
    expect(
      supportsNativeStructuredOutput({ type: "router", model: "requesty/openai/gpt-5-mini" }),
    ).toBe(true);
    expect(
      supportsNativeStructuredOutput({
        type: "router",
        model: "requesty/anthropic/claude-sonnet-4-6",
      }),
    ).toBe(true);
    expect(
      supportsNativeStructuredOutput({ type: "router", model: "requesty/google/gemini-3.1-pro" }),
    ).toBe(true);
    expect(
      supportsNativeStructuredOutput({ type: "router", model: "requesty/moonshot/kimi-k2.6" }),
    ).toBe(true);
    expect(
      supportsNativeStructuredOutput({
        type: "router",
        model: "requesty/fireworks/deepseek-v4-pro",
      }),
    ).toBe(true);
  });

  it("returns false for requesty-routed providers without verified json_schema support", () => {
    expect(
      supportsNativeStructuredOutput({
        type: "router",
        model: "requesty/minimaxi/MiniMax-M2.7",
      }),
    ).toBe(false);
    expect(
      supportsNativeStructuredOutput({
        type: "router",
        model: "requesty/deepseek/deepseek-v4-pro",
      }),
    ).toBe(false);
    expect(
      supportsNativeStructuredOutput({ type: "router", model: "requesty/qwen/qwen3-coder" }),
    ).toBe(false);
  });

  it("returns false for non-listed direct router providers", () => {
    expect(
      supportsNativeStructuredOutput({ type: "router", model: "deepseek/deepseek-v4-pro" }),
    ).toBe(false);
    expect(supportsNativeStructuredOutput({ type: "router", model: "minimaxi/MiniMax-M2.7" })).toBe(
      false,
    );
  });

  it("returns true for azure configs", () => {
    expect(
      supportsNativeStructuredOutput({
        type: "azure-api-key",
        resourceName: "r",
        deploymentName: "d",
        apiKey: "k",
      }),
    ).toBe(true);
    expect(
      supportsNativeStructuredOutput({
        type: "azure-managed-identity",
        resourceName: "r",
        deploymentName: "d",
      }),
    ).toBe(true);
    expect(
      supportsNativeStructuredOutput({
        type: "azure-anthropic-api-key",
        baseUrl: "https://r.services.ai.azure.com/anthropic/v1",
        deploymentName: "claude-sonnet-4-5",
        apiKey: "k",
      }),
    ).toBe(true);
    expect(
      supportsNativeStructuredOutput({
        type: "azure-anthropic-managed-identity",
        baseUrl: "https://r.services.ai.azure.com/anthropic/v1",
        deploymentName: "claude-sonnet-4-5",
      }),
    ).toBe(true);
  });

  it("returns true for openai-compatible configs (assumes proxy translates json_schema)", () => {
    expect(
      supportsNativeStructuredOutput({
        type: "openai-compatible",
        baseUrl: "https://litellm.example/v1",
        model: "gpt-4o",
      }),
    ).toBe(true);
  });

  it("returns false for azure-foundry configs (deployments vary; default to prompt-injected JSON)", () => {
    expect(
      supportsNativeStructuredOutput({
        type: "azure-foundry-api-key",
        resourceName: "ai-code-review-foundry",
        deploymentName: "Kimi-K2.6",
        apiKey: "k",
      }),
    ).toBe(false);
    expect(
      supportsNativeStructuredOutput({
        type: "azure-foundry-managed-identity",
        resourceName: "ai-code-review-foundry",
        deploymentName: "Kimi-K2.6",
      }),
    ).toBe(false);
  });

  it("returns false for ollama configs (defaults to prompt-injected JSON)", () => {
    expect(
      supportsNativeStructuredOutput({
        type: "ollama",
        model: "gpt-oss:120b",
        baseUrl: "https://ollama.com",
        apiKey: "k",
      }),
    ).toBe(false);
  });

  it("opts ollama into native structured output via RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT", () => {
    process.env.RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT = "ollama/gpt-oss*";
    const config = {
      type: "ollama" as const,
      model: "gpt-oss:120b",
      baseUrl: "https://ollama.com",
    };
    // resolveJsonPromptInjection inverts supportsNativeStructuredOutput when the
    // override matches — so the native path becomes active for matched models.
    expect(resolveJsonPromptInjection(config)).toBe(false);
  });
});

describe("resolveJsonPromptInjection", () => {
  beforeEach(clearEnv);

  it("returns false (use native) for providers in the supported list", () => {
    expect(
      resolveJsonPromptInjection({ type: "router", model: "requesty/openai/gpt-5-mini" }),
    ).toBe(false);
    expect(
      resolveJsonPromptInjection({ type: "router", model: "requesty/moonshot/kimi-k2.6" }),
    ).toBe(false);
  });

  it("returns true (inject prompt) for providers outside the supported list", () => {
    expect(
      resolveJsonPromptInjection({
        type: "router",
        model: "requesty/minimaxi/MiniMax-M2.7",
      }),
    ).toBe(true);
    expect(
      resolveJsonPromptInjection({
        type: "router",
        model: "requesty/deepseek/deepseek-v4-pro",
      }),
    ).toBe(true);
  });

  it("force-on env var overrides default for an exact model match", () => {
    process.env.RUSTY_LLM_JSON_PROMPT_INJECTION = "requesty/openai/gpt-5-mini";

    expect(
      resolveJsonPromptInjection({ type: "router", model: "requesty/openai/gpt-5-mini" }),
    ).toBe(true);
    expect(resolveJsonPromptInjection({ type: "router", model: "requesty/openai/gpt-5-pro" })).toBe(
      false,
    );
  });

  it("force-on env var supports trailing-* prefix wildcards", () => {
    process.env.RUSTY_LLM_JSON_PROMPT_INJECTION = "requesty/minimaxi/*,requesty/deepseek/*";

    expect(
      resolveJsonPromptInjection({
        type: "router",
        model: "requesty/minimaxi/MiniMax-M2.7",
      }),
    ).toBe(true);
    expect(
      resolveJsonPromptInjection({
        type: "router",
        model: "requesty/deepseek/deepseek-v4-pro",
      }),
    ).toBe(true);
    expect(
      resolveJsonPromptInjection({ type: "router", model: "requesty/openai/gpt-5-mini" }),
    ).toBe(false);
  });

  it("force-off env var overrides the default-injection path", () => {
    process.env.RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT = "requesty/minimaxi/MiniMax-M2.7";

    expect(
      resolveJsonPromptInjection({
        type: "router",
        model: "requesty/minimaxi/MiniMax-M2.7",
      }),
    ).toBe(false);
  });

  it("force-on takes precedence over force-off for the same model", () => {
    process.env.RUSTY_LLM_JSON_PROMPT_INJECTION = "requesty/openai/gpt-5-mini";
    process.env.RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT = "requesty/openai/gpt-5-mini";

    expect(
      resolveJsonPromptInjection({ type: "router", model: "requesty/openai/gpt-5-mini" }),
    ).toBe(true);
  });

  it("matches azure configs against azure-openai/<deployment>", () => {
    process.env.RUSTY_LLM_JSON_PROMPT_INJECTION = "azure-openai/my-deployment";

    expect(
      resolveJsonPromptInjection({
        type: "azure-api-key",
        resourceName: "r",
        deploymentName: "my-deployment",
        apiKey: "k",
      }),
    ).toBe(true);
  });

  it("matches azure-anthropic configs against azure-anthropic/<deployment>", () => {
    process.env.RUSTY_LLM_JSON_PROMPT_INJECTION = "azure-anthropic/claude-sonnet-4-5";

    expect(
      resolveJsonPromptInjection({
        type: "azure-anthropic-api-key",
        baseUrl: "https://r.services.ai.azure.com/anthropic/v1",
        deploymentName: "claude-sonnet-4-5",
        apiKey: "k",
      }),
    ).toBe(true);
    expect(
      resolveJsonPromptInjection({
        type: "azure-anthropic-managed-identity",
        baseUrl: "https://r.services.ai.azure.com/anthropic/v1",
        deploymentName: "claude-sonnet-4-5",
      }),
    ).toBe(true);
  });

  it("ignores empty env vars and falls back to default", () => {
    process.env.RUSTY_LLM_JSON_PROMPT_INJECTION = "";
    process.env.RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT = "";

    expect(
      resolveJsonPromptInjection({
        type: "router",
        model: "requesty/minimaxi/MiniMax-M2.7",
      }),
    ).toBe(true);
    expect(
      resolveJsonPromptInjection({ type: "router", model: "requesty/openai/gpt-5-mini" }),
    ).toBe(false);
  });
});

describe("resolveDisableThinking", () => {
  beforeEach(clearEnv);

  it("returns false when env var is unset", () => {
    expect(
      resolveDisableThinking({
        type: "azure-foundry-api-key",
        resourceName: "r",
        deploymentName: "Kimi-K2.6",
        apiKey: "k",
      }),
    ).toBe(false);
  });

  it("returns true for an azure-foundry config that matches the env list", () => {
    process.env.RUSTY_LLM_DISABLE_THINKING = "azure-foundry/Kimi-K2.6";
    expect(
      resolveDisableThinking({
        type: "azure-foundry-api-key",
        resourceName: "r",
        deploymentName: "Kimi-K2.6",
        apiKey: "k",
      }),
    ).toBe(true);
    expect(
      resolveDisableThinking({
        type: "azure-foundry-managed-identity",
        resourceName: "r",
        deploymentName: "Kimi-K2.6",
      }),
    ).toBe(true);
  });

  it("supports trailing-* wildcard for foundry deployments", () => {
    process.env.RUSTY_LLM_DISABLE_THINKING = "azure-foundry/Kimi-*";
    expect(
      resolveDisableThinking({
        type: "azure-foundry-api-key",
        resourceName: "r",
        deploymentName: "Kimi-K2.6",
        apiKey: "k",
      }),
    ).toBe(true);
    expect(
      resolveDisableThinking({
        type: "azure-foundry-api-key",
        resourceName: "r",
        deploymentName: "Llama-3.3",
        apiKey: "k",
      }),
    ).toBe(false);
  });

  it("only takes effect on azure-foundry configs (other types ignored even if matched)", () => {
    process.env.RUSTY_LLM_DISABLE_THINKING =
      "azure-openai/gpt-5.4-mini,anthropic/claude-sonnet-4-6";
    expect(
      resolveDisableThinking({
        type: "azure-api-key",
        resourceName: "r",
        deploymentName: "gpt-5.4-mini",
        apiKey: "k",
      }),
    ).toBe(false);
    expect(resolveDisableThinking({ type: "router", model: "anthropic/claude-sonnet-4-6" })).toBe(
      false,
    );
  });

  it("matches one foundry deployment without affecting another", () => {
    process.env.RUSTY_LLM_DISABLE_THINKING = "azure-foundry/Kimi-K2.6";
    expect(
      resolveDisableThinking({
        type: "azure-foundry-api-key",
        resourceName: "r",
        deploymentName: "Kimi-K2.6",
        apiKey: "k",
      }),
    ).toBe(true);
    expect(
      resolveDisableThinking({
        type: "azure-foundry-api-key",
        resourceName: "r",
        deploymentName: "Llama-3.3",
        apiKey: "k",
      }),
    ).toBe(false);
  });

  it("ignores empty env var", () => {
    process.env.RUSTY_LLM_DISABLE_THINKING = "";
    expect(
      resolveDisableThinking({
        type: "azure-foundry-api-key",
        resourceName: "r",
        deploymentName: "Kimi-K2.6",
        apiKey: "k",
      }),
    ).toBe(false);
  });
});

describe("mutateBodyForFoundry", () => {
  it("injects thinking:{type:disabled} into a JSON body when disableThinking is set", () => {
    const init: Record<string, unknown> = {
      body: JSON.stringify({ model: "Kimi-K2.6", messages: [{ role: "user", content: "hi" }] }),
    };
    mutateBodyForFoundry(init, { disableThinking: true });
    expect(JSON.parse(init.body as string)).toEqual({
      model: "Kimi-K2.6",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    });
  });

  it("overrides any caller-provided thinking field", () => {
    const init: Record<string, unknown> = {
      body: JSON.stringify({ model: "x", thinking: { type: "enabled" } }),
    };
    mutateBodyForFoundry(init, { disableThinking: true });
    expect((JSON.parse(init.body as string) as Record<string, unknown>).thinking).toEqual({
      type: "disabled",
    });
  });

  it("is a no-op when no flags are set", () => {
    const init: Record<string, unknown> = { body: JSON.stringify({ model: "x" }) };
    mutateBodyForFoundry(init, {});
    expect(init.body).toBe(JSON.stringify({ model: "x" }));
  });

  it("silently leaves non-JSON bodies alone", () => {
    const formData = "form-data-not-json";
    const init: Record<string, unknown> = { body: formData };
    mutateBodyForFoundry(init, { disableThinking: true });
    expect(init.body).toBe(formData);
  });

  it("silently leaves missing body alone", () => {
    const init: Record<string, unknown> = {};
    mutateBodyForFoundry(init, { disableThinking: true });
    expect(init.body).toBeUndefined();
  });

  it("silently leaves a JSON body that parses to an array alone", () => {
    const init: Record<string, unknown> = { body: JSON.stringify([1, 2, 3]) };
    mutateBodyForFoundry(init, { disableThinking: true });
    expect(init.body).toBe(JSON.stringify([1, 2, 3]));
  });

  it("ignores undefined init", () => {
    expect(() => mutateBodyForFoundry(undefined, { disableThinking: true })).not.toThrow();
  });
});

describe("getModelDisplayName", () => {
  it("returns azure/<deployment> for azure-api-key configs", () => {
    const name = getModelDisplayName({
      type: "azure-api-key",
      resourceName: "my-resource",
      deploymentName: "gpt-5.4-mini",
      apiKey: "secret",
    });
    expect(name).toBe("azure/gpt-5.4-mini");
  });

  it("returns the raw model string for router configs", () => {
    const name = getModelDisplayName({ type: "router", model: "azure-openai/gpt-5.4-mini" });
    expect(name).toBe("azure-openai/gpt-5.4-mini");
  });

  it("returns azure-anthropic/<deployment> for both azure-anthropic config types", () => {
    expect(
      getModelDisplayName({
        type: "azure-anthropic-api-key",
        baseUrl: "https://r.services.ai.azure.com/anthropic/v1",
        deploymentName: "claude-sonnet-4-5",
        apiKey: "k",
      }),
    ).toBe("azure-anthropic/claude-sonnet-4-5");
    expect(
      getModelDisplayName({
        type: "azure-anthropic-managed-identity",
        baseUrl: "https://r.services.ai.azure.com/anthropic/v1",
        deploymentName: "claude-sonnet-4-5",
      }),
    ).toBe("azure-anthropic/claude-sonnet-4-5");
  });

  it("returns azure-foundry/<deployment> for both azure-foundry config types", () => {
    expect(
      getModelDisplayName({
        type: "azure-foundry-api-key",
        resourceName: "ai-code-review-foundry",
        deploymentName: "Kimi-K2.6",
        apiKey: "k",
      }),
    ).toBe("azure-foundry/Kimi-K2.6");
    expect(
      getModelDisplayName({
        type: "azure-foundry-managed-identity",
        resourceName: "ai-code-review-foundry",
        deploymentName: "Kimi-K2.6",
      }),
    ).toBe("azure-foundry/Kimi-K2.6");
  });

  it("returns ollama/<model> preserving colons for ollama configs", () => {
    expect(
      getModelDisplayName({
        type: "ollama",
        model: "gpt-oss:120b",
        baseUrl: "https://ollama.com",
        apiKey: "k",
      }),
    ).toBe("ollama/gpt-oss:120b");
  });
});

describe("resolveTriageModelConfig", () => {
  beforeEach(clearEnv);

  it("returns null when no triage model is configured", () => {
    expect(resolveTriageModelConfig()).toBeNull();
  });

  it("resolves the triage override through the azure-api-key branch when env is set", () => {
    process.env.RUSTY_LLM_TRIAGE_MODEL = "azure-openai/gpt-5.4-mini";
    process.env.AZURE_API_KEY = "secret";
    process.env.AZURE_OPENAI_RESOURCE_NAME = "my-resource";
    process.env.RUSTY_LLM_MODEL = "anthropic/claude-sonnet";

    const config = resolveTriageModelConfig();
    expect(config?.type).toBe("azure-api-key");
    if (config?.type === "azure-api-key") {
      expect(config.deploymentName).toBe("gpt-5.4-mini");
    }
  });

  it("restores the original RUSTY_LLM_MODEL after resolving", () => {
    process.env.RUSTY_LLM_TRIAGE_MODEL = "azure-openai/gpt-5.4-mini";
    process.env.AZURE_API_KEY = "secret";
    process.env.AZURE_OPENAI_RESOURCE_NAME = "my-resource";
    process.env.RUSTY_LLM_MODEL = "anthropic/claude-sonnet";

    resolveTriageModelConfig();

    expect(process.env.RUSTY_LLM_MODEL).toBe("anthropic/claude-sonnet");
  });

  it("leaves RUSTY_LLM_MODEL unset when it was unset before", () => {
    process.env.RUSTY_LLM_TRIAGE_MODEL = "anthropic/claude-haiku";
    expect(process.env.RUSTY_LLM_MODEL).toBeUndefined();

    resolveTriageModelConfig();

    expect(process.env.RUSTY_LLM_MODEL).toBeUndefined();
  });
});

describe("resolveModelConfigWithOverride", () => {
  beforeEach(clearEnv);

  it("resolves an azure-openai override through the azure-api-key branch", () => {
    process.env.AZURE_API_KEY = "secret";
    process.env.AZURE_OPENAI_RESOURCE_NAME = "my-resource";
    process.env.RUSTY_LLM_MODEL = "anthropic/claude-sonnet";

    const config = resolveModelConfigWithOverride("azure-openai/gpt-5.4-mini");
    expect(config.type).toBe("azure-api-key");
    if (config.type === "azure-api-key") {
      expect(config.deploymentName).toBe("gpt-5.4-mini");
      expect(config.resourceName).toBe("my-resource");
    }
  });

  it("returns a router config for a plain router-style override", () => {
    const config = resolveModelConfigWithOverride("anthropic/claude-haiku");
    expect(config).toEqual({ type: "router", model: "anthropic/claude-haiku" });
  });

  it("routes through openai-compatible when RUSTY_LLM_BASE_URL is set", () => {
    process.env.RUSTY_LLM_BASE_URL = "https://litellm.example/v1";
    process.env.RUSTY_LLM_API_KEY = "k";

    const config = resolveModelConfigWithOverride("custom/model");
    expect(config).toEqual({
      type: "openai-compatible",
      baseUrl: "https://litellm.example/v1",
      model: "custom/model",
      apiKey: "k",
    });
  });

  it("restores the original RUSTY_LLM_MODEL after resolving", () => {
    process.env.RUSTY_LLM_MODEL = "anthropic/claude-sonnet";

    resolveModelConfigWithOverride("anthropic/claude-haiku");

    expect(process.env.RUSTY_LLM_MODEL).toBe("anthropic/claude-sonnet");
  });

  it("leaves RUSTY_LLM_MODEL unset when it was unset before", () => {
    expect(process.env.RUSTY_LLM_MODEL).toBeUndefined();

    resolveModelConfigWithOverride("anthropic/claude-haiku");

    expect(process.env.RUSTY_LLM_MODEL).toBeUndefined();
  });

  it("restores RUSTY_LLM_MODEL when resolveModelConfig throws", () => {
    process.env.RUSTY_LLM_MODEL = "anthropic/claude-sonnet";

    // process.env rejects accessor descriptors, so wrap it in a Proxy that
    // throws on AZURE_API_KEY reads — resolveModelConfig hits that read
    // once the model string starts with "azure-openai/"
    const realEnv = process.env;
    const throwingEnv = new Proxy(realEnv, {
      get(target, prop) {
        if (prop === "AZURE_API_KEY") throw new Error("simulated env failure");
        return Reflect.get(target, prop);
      },
      // delegate set/delete directly to target so process.env's string-coercion
      // path runs on the real env, not on the Proxy wrapper
      set(target, prop, value) {
        (target as Record<string, string>)[prop as string] = value;
        return true;
      },
      deleteProperty(target, prop) {
        return Reflect.deleteProperty(target, prop);
      },
    });
    Object.defineProperty(process, "env", { value: throwingEnv, configurable: true });

    try {
      expect(() => resolveModelConfigWithOverride("azure-openai/gpt-5.4-mini")).toThrow(
        "simulated env failure",
      );
    } finally {
      Object.defineProperty(process, "env", { value: realEnv, configurable: true });
    }

    expect(process.env.RUSTY_LLM_MODEL).toBe("anthropic/claude-sonnet");
  });
});

describe("parseModelEffort", () => {
  it("strips a trailing effort suffix", () => {
    expect(parseModelEffort("openrouter/openai/gpt-6-luna:xhigh")).toEqual({
      model: "openrouter/openai/gpt-6-luna",
      reasoningEffort: "xhigh",
    });
  });

  it.each(["max", "xhigh", "high", "medium", "low", "minimal", "none"])(
    "accepts %s as an effort",
    (effort) => {
      expect(parseModelEffort(`openrouter/x/y:${effort}`)).toEqual({
        model: "openrouter/x/y",
        reasoningEffort: effort,
      });
    },
  );

  it.each([
    "openrouter/x/y:batch",
    "openrouter/x/y:free",
    "openrouter/x/y:nitro",
    "openrouter/x/y:floor",
    "openrouter/x/y:online",
    "openrouter/x/y:exacto",
    "ollama/qwen3:32b",
    "ollama/foo:latest",
    "openrouter/x/y:ultra",
    "openrouter/x/y:HIGH",
    "anthropic/claude-sonnet-4-6",
  ])("leaves %s untouched", (model) => {
    expect(parseModelEffort(model)).toEqual({ model });
  });

  it("keeps an openrouter variant and strips only the trailing effort", () => {
    expect(parseModelEffort("openrouter/x/y:batch:high")).toEqual({
      model: "openrouter/x/y:batch",
      reasoningEffort: "high",
    });
  });

  it("only strips the last segment when an effort-looking segment is not last", () => {
    expect(parseModelEffort("openrouter/x/y:high:batch")).toEqual({
      model: "openrouter/x/y:high:batch",
    });
  });

  it("does not treat a bare effort word without a model as a suffix", () => {
    expect(parseModelEffort("high")).toEqual({ model: "high" });
    expect(parseModelEffort(":high")).toEqual({ model: ":high" });
  });
});

describe("model:effort suffix", () => {
  beforeEach(clearEnv);

  it("resolves an openrouter model to the base id plus the effort", () => {
    process.env.RUSTY_LLM_MODEL = "openrouter/openai/gpt-6-luna:xhigh";
    expect(resolveModelConfig()).toEqual({
      type: "router",
      model: "openrouter/openai/gpt-6-luna",
      reasoningEffort: "xhigh",
    });
  });

  it("never hands the suffixed id to the model router", () => {
    process.env.RUSTY_LLM_MODEL = "openrouter/openai/gpt-6-luna:xhigh";
    expect(resolveModel(resolveModelConfig())).toBe("openrouter/openai/gpt-6-luna");
  });

  it("passes openrouter variants through with no effort", () => {
    process.env.RUSTY_LLM_MODEL = "openrouter/x/y:batch";
    const config = resolveModelConfig();
    expect(config).toEqual({ type: "router", model: "openrouter/x/y:batch" });
    expect(resolveDefaultAgentOptions(config)).toBeUndefined();
  });

  it("keeps the variant and applies the effort for variant:effort", () => {
    process.env.RUSTY_LLM_MODEL = "openrouter/x/y:batch:high";
    expect(resolveModelConfig()).toEqual({
      type: "router",
      model: "openrouter/x/y:batch",
      reasoningEffort: "high",
    });
  });

  it("treats an unknown suffix as part of the model id", () => {
    process.env.RUSTY_LLM_MODEL = "openrouter/x/y:ultra";
    expect(resolveModelConfig()).toEqual({ type: "router", model: "openrouter/x/y:ultra" });
  });

  it.each(["ollama/qwen3:32b", "ollama/foo:latest"])("leaves ollama tag %s untouched", (m) => {
    process.env.RUSTY_LLM_MODEL = m;
    const config = resolveModelConfig();
    expect(config.type).toBe("ollama");
    expect(getModelDisplayName(config)).toBe(m);
  });

  it.each([
    "anthropic/claude-sonnet-4-6:high",
    "requesty/openai/gpt-5:high",
    "ollama/qwen3:32b:high",
  ])("throws a config error for a non-openrouter model with an effort (%s)", (m) => {
    process.env.RUSTY_LLM_MODEL = m;
    expect(() => resolveModelConfig()).toThrow(/only supported for openrouter\//);
    expect(() => resolveModelConfig()).toThrow(m);
  });

  it("throws for azure prefixes with an effort", () => {
    process.env.AZURE_OPENAI_RESOURCE_NAME = "r";
    process.env.AZURE_API_KEY = "k";
    expect(() => resolveModelConfigWithOverride("azure-openai/gpt-5.4-mini:high")).toThrow(
      /only supported for openrouter\//,
    );
    expect(() => resolveModelConfigWithOverride("azure-foundry/Kimi-K2.6:low")).toThrow(
      /only supported for openrouter\//,
    );
  });

  it("throws when an openrouter model is routed to an openai-compatible endpoint", () => {
    process.env.RUSTY_LLM_BASE_URL = "https://litellm.example.com/v1";
    process.env.RUSTY_LLM_MODEL = "openrouter/x/y:high";
    expect(() => resolveModelConfig()).toThrow(/only supported for openrouter\//);
  });

  it("applies to RUSTY_LLM_TRIAGE_MODEL", () => {
    process.env.RUSTY_LLM_TRIAGE_MODEL = "openrouter/google/gemini-3-flash:low";
    expect(resolveTriageModelConfig()).toEqual({
      type: "router",
      model: "openrouter/google/gemini-3-flash",
      reasoningEffort: "low",
    });
  });

  it("applies to RUSTY_REVIEW_MODELS entries independently", () => {
    process.env.RUSTY_LLM_MODEL = "openrouter/default/model:medium";
    process.env.RUSTY_REVIEW_MODELS =
      "openrouter/openai/gpt-6-luna:xhigh,openrouter/x/y:batch,anthropic/claude-sonnet-4-6";

    const configs = resolveReviewPassModelConfigs(4);

    expect(configs.map((c) => c.config)).toEqual([
      { type: "router", model: "openrouter/openai/gpt-6-luna", reasoningEffort: "xhigh" },
      { type: "router", model: "openrouter/x/y:batch" },
      { type: "router", model: "anthropic/claude-sonnet-4-6" },
      { type: "router", model: "openrouter/default/model", reasoningEffort: "medium" },
    ]);
    expect(configs.map((c) => c.displayName)).toEqual([
      "openrouter/openai/gpt-6-luna:xhigh",
      "openrouter/x/y:batch",
      "anthropic/claude-sonnet-4-6",
      "openrouter/default/model:medium",
    ]);
  });

  it("throws when any RUSTY_REVIEW_MODELS entry carries an effort on an unsupported provider", () => {
    process.env.RUSTY_REVIEW_MODELS = "openrouter/x/y:high,anthropic/claude-sonnet-4-6:high";
    expect(() => resolveReviewPassModelConfigs(2)).toThrow("anthropic/claude-sonnet-4-6:high");
  });

  it("sends the effort as providerOptions.openrouter.reasoning.effort", () => {
    expect(
      resolveDefaultAgentOptions({
        type: "router",
        model: "openrouter/openai/gpt-6-luna",
        reasoningEffort: "xhigh",
      }),
    ).toEqual({ providerOptions: { openrouter: { reasoning: { effort: "xhigh" } } } });
  });

  it("still sends the effort when prompt caching is disabled", () => {
    process.env.RUSTY_PROMPT_CACHE = "false";
    expect(
      resolveDefaultAgentOptions({
        type: "router",
        model: "openrouter/x/y",
        reasoningEffort: "low",
      }),
    ).toEqual({ providerOptions: { openrouter: { reasoning: { effort: "low" } } } });
  });

  it("merges the effort with requesty auto_cache options", () => {
    expect(
      resolveDefaultAgentOptions({
        type: "router",
        model: "requesty/openrouter/x",
        reasoningEffort: "high",
      }),
    ).toEqual({
      providerOptions: {
        requesty: { auto_cache: true },
        openrouter: { reasoning: { effort: "high" } },
      },
    });
  });

  it("includes the effort in the display name", () => {
    expect(
      getModelDisplayName({
        type: "router",
        model: "openrouter/openai/gpt-6-luna",
        reasoningEffort: "xhigh",
      }),
    ).toBe("openrouter/openai/gpt-6-luna:xhigh");
  });

  it("applies the temperature lock to a suffixed model", () => {
    process.env.RUSTY_LLM_MODEL = "openrouter/moonshot/kimi-k2.5:high";
    const settings = applyModelConstraints(resolveModelConfig(), { temperature: 0.2 });
    expect(settings.temperature).toBe(1);
  });

  it("matches exact model patterns against the base id, not the suffixed one", () => {
    process.env.RUSTY_LLM_MODEL = "openrouter/openai/gpt-6-luna:xhigh";
    process.env.RUSTY_LLM_JSON_PROMPT_INJECTION = "openrouter/openai/gpt-6-luna";
    expect(resolveJsonPromptInjection(resolveModelConfig())).toBe(true);

    delete process.env.RUSTY_LLM_JSON_PROMPT_INJECTION;
    process.env.RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT = "openrouter/openai/gpt-6-luna";
    expect(resolveJsonPromptInjection(resolveModelConfig())).toBe(false);
  });

  it("disable-thinking still matches a foundry deployment whose name contains a colon", () => {
    process.env.AZURE_OPENAI_RESOURCE_NAME = "r";
    process.env.AZURE_API_KEY = "k";
    process.env.RUSTY_LLM_DISABLE_THINKING = "azure-foundry/Kimi-K2.6:v2";
    expect(
      resolveDisableThinking(resolveModelConfigWithOverride("azure-foundry/Kimi-K2.6:v2")),
    ).toBe(true);
  });
});
