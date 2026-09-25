---
title: LLM providers
description: Connect Rusty Bot to any LLM — Anthropic, OpenAI, Azure OpenAI, or an OpenAI-compatible endpoint.
---

Rusty Bot resolves the LLM provider through four paths, tried in order. The first path whose required environment variables are set wins.

## 1. Azure OpenAI with API key

For Azure AI Foundry deployments:

```bash
RUSTY_LLM_MODEL=azure-openai/gpt-5.3-codex
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_RESOURCE_NAME=ai-code-review-foundry
```

The resource name is the subdomain from your endpoint URL — for example, `https://ai-code-review-foundry.cognitiveservices.azure.com` → `ai-code-review-foundry`. Uses `@ai-sdk/azure` directly.

## 2. Azure OpenAI with Managed Identity

No API keys needed when running on Azure:

```bash
RUSTY_AZURE_RESOURCE_NAME=my-openai-resource
RUSTY_AZURE_DEPLOYMENT=gpt-4o
```

Uses `DefaultAzureCredential` from `@azure/identity`, which automatically picks up managed identity on AKS, App Service, Azure Functions, and Azure Pipelines. Also works with `az login` locally.

## 3. OpenAI-compatible endpoint

For LiteLLM, vLLM, Ollama, or any proxy:

```bash
RUSTY_LLM_BASE_URL=http://localhost:4000/v1
RUSTY_LLM_MODEL=gpt-4o
RUSTY_LLM_API_KEY=optional-key
```

`RUSTY_LLM_API_KEY` is optional; omit it for unauthenticated local endpoints.

## 4. Mastra router (default)

Direct provider API keys with 99+ providers supported:

```bash
RUSTY_LLM_MODEL=anthropic/claude-sonnet-4-20250514
ANTHROPIC_API_KEY=sk-ant-...
```

Other supported providers: `openai/gpt-4o`, `google/gemini-2.5-flash`, `openrouter/...`, and many more. Set the matching API key (`OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, etc.) for whichever model you choose.

## Reasoning effort (OpenRouter)

Without an explicit effort, every model runs at its provider default. Append `:<effort>` to an `openrouter/*` model string to send `reasoning: { effort }` with each request. The suffix works in every model setting: `RUSTY_LLM_MODEL`, each entry in `RUSTY_REVIEW_MODELS`, `RUSTY_JUDGE_MODEL` and `RUSTY_LLM_TRIAGE_MODEL`.

```bash
OPENROUTER_API_KEY=sk-or-v1-...
RUSTY_REVIEW_MODELS=openrouter/openai/gpt-6-luna:xhigh,openrouter/moonshotai/kimi-k2.6,openrouter/deepseek/deepseek-v4-pro:batch:high
RUSTY_JUDGE_MODEL=openrouter/openai/gpt-6-luna:medium
```

- **Accepted values** are the ones OpenRouter's [`reasoning.effort`](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) accepts: `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`. Each model supports only some of them, so check the model's `supported_efforts` on OpenRouter.
- **Only the last `:segment` is read**, and only when it is one of those values. OpenRouter variants (`:batch`, `:free`, `:nitro`, `:online`, ...) and Ollama tags (`ollama/qwen3:32b`) stay part of the model id. To combine a variant with an effort, put the effort last: `openrouter/x/y:batch:high`.
- **OpenRouter only.** An effort suffix on any other provider (`anthropic/...:high`, `azure-openai/...:high`, `ollama/...:high`, or an `openrouter/*` model sent to `RUSTY_LLM_BASE_URL`) fails with a config error. It is not silently ignored.
- The effort appears in the model name shown in review comments and logs, e.g. `openrouter/openai/gpt-6-luna:xhigh`.

## Temperature and top-p

Set global defaults for all agents, or override per agent. Per-agent values take priority over the global setting; omitting any value falls back to the provider default.

```bash
# global defaults
RUSTY_LLM_TEMPERATURE=0.3
RUSTY_LLM_TOP_P=0.9

# per-agent overrides
RUSTY_REVIEW_TEMPERATURE=0.3
RUSTY_TRIAGE_TEMPERATURE=0
RUSTY_JUDGE_TEMPERATURE=0
RUSTY_DESCRIPTION_TEMPERATURE=0.5
```

Some models enforce a fixed temperature — for example, `moonshot/kimi-k2.5` only accepts `temperature=1`. Use per-agent overrides when running different models per agent to work around such restrictions.
