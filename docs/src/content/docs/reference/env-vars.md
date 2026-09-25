---
title: Environment variables
description: RUSTY_* variables read at runtime by the action and webhook server.
---

Non-secret configuration lives in `RUSTY_*` env vars rather than action inputs, so the same values can be reused between the GitHub Action, the webhook server, and the Azure DevOps task without duplication.

## Core

| Variable | Default | Description |
| --- | --- | --- |
| `RUSTY_LLM_MODEL` | `anthropic/claude-sonnet-4-20250514` | LLM model in `provider/model` format. `openrouter/*` models accept an optional `:<effort>` suffix (`max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`), also in `RUSTY_REVIEW_MODELS`, `RUSTY_JUDGE_MODEL` and `RUSTY_LLM_TRIAGE_MODEL`. See [LLM providers](/guides/llm-providers/#reasoning-effort-openrouter) |
| `RUSTY_REVIEW_STYLE` | `balanced` | One of `strict`, `balanced`, `lenient`, `roast`, `thorough` |
| `RUSTY_FOCUS_AREAS` | all enabled | Comma-separated: `security,performance,bugs,style,tests,docs` |
| `RUSTY_IGNORE_PATTERNS` | — | Comma-separated globs to skip (e.g. `*.lock,dist/**`) |
| `RUSTY_DB_URL` | `file:./rusty.db` | libSQL database URL |
| `RUSTY_MODE` | — | Set to `pipeline` in Azure Pipelines container |
| `RUSTY_FAIL_ON_CRITICAL` | `true` | Exit with code 1 when critical findings are produced |
| `RUSTY_REVIEW_DRAFTS` | `false` | Review draft PRs (skipped by default) |
| `RUSTY_INCREMENTAL_REVIEW` | `true` | Review only the diff since the previously-reviewed commit (GitHub Action) or PR iteration (Azure DevOps). Set to `false` to always review the full PR diff |

## LLM provider — Anthropic / OpenAI / Google

| Variable | Description |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI API key |

## LLM provider — Azure OpenAI

| Variable | Description |
| --- | --- |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key (also accepted as `AZURE_API_KEY`) |
| `AZURE_OPENAI_RESOURCE_NAME` | Azure OpenAI resource name (API key path) |
| `RUSTY_AZURE_RESOURCE_NAME` | Azure OpenAI resource name (managed identity path) |
| `RUSTY_AZURE_DEPLOYMENT` | Azure OpenAI deployment name (managed identity path) |

The managed identity vars (`RUSTY_AZURE_*`) take priority over the API-key vars when both are set. See [LLM providers](/guides/llm-providers/) for details.

## LLM provider — OpenAI-compatible

| Variable | Description |
| --- | --- |
| `RUSTY_LLM_BASE_URL` | Base URL of an OpenAI-compatible endpoint (LiteLLM, vLLM, Ollama, …) |
| `RUSTY_LLM_API_KEY` | API key for the custom endpoint (optional for unauthenticated local instances) |

## Retries

| Variable | Default | Description |
| --- | --- | --- |
| `RUSTY_LLM_MAX_RETRIES` | `2` | Max additional retries after a transient LLM error. Capped at the length of the built-in backoff schedule (2 entries today — values higher than that are silently lowered). Set to `0` to disable retries entirely. |

## Temperature and top-p

| Variable | Default | Description |
| --- | --- | --- |
| `RUSTY_LLM_TEMPERATURE` | provider default | Global temperature for all agents |
| `RUSTY_LLM_TOP_P` | provider default | Global top-p for all agents |
| `RUSTY_REVIEW_TEMPERATURE` | `RUSTY_LLM_TEMPERATURE` | Temperature override for the review agent |
| `RUSTY_REVIEW_MODELS` | `RUSTY_LLM_MODEL` | Comma-separated per-pass review models for consensus, e.g. `anthropic/claude-sonnet,openai/gpt-5-mini` |
| `RUSTY_REVIEW_TEMPERATURES` | `RUSTY_REVIEW_TEMPERATURE` | Comma-separated per-pass review temperatures |
| `RUSTY_REVIEW_TOP_PS` | `RUSTY_REVIEW_TOP_P` | Comma-separated per-pass review top-p values |
| `RUSTY_REVIEW_ADAPTIVE_PASSES` | `true` | Ordinary deep-review chunks use fewer consensus passes (2) while large or security-sensitive chunks keep up to 3. Set to `false` to force every chunk through the full pass count. |
| `RUSTY_TRIAGE_TEMPERATURE` | `RUSTY_LLM_TEMPERATURE` | Temperature override for the triage agent |
| `RUSTY_JUDGE_TEMPERATURE` | `RUSTY_LLM_TEMPERATURE` | Temperature override for the judge agent |
| `RUSTY_DESCRIPTION_TEMPERATURE` | `RUSTY_LLM_TEMPERATURE` | Temperature override for the description agent |
| `RUSTY_TITLE_TEMPERATURE` | `RUSTY_LLM_TEMPERATURE` | Temperature override for the title-rename agent |

Per-agent values override the global setting; omitting any value falls back to the provider default.

## Judge pass

| Variable | Default | Description |
| --- | --- | --- |
| `RUSTY_JUDGE_ENABLED` | `false` | Enable the post-generation judge / filter pass |
| `RUSTY_JUDGE_THRESHOLD` | `6` | Minimum confidence score (0–10) to keep a finding |
| `RUSTY_JUDGE_MODEL` | same as `RUSTY_LLM_MODEL` | Model for the judge (can be a cheaper model) |

See [Judge / filter pass](/guides/judge-pass/).

## Cascading triage

| Variable | Default | Description |
| --- | --- | --- |
| `RUSTY_LLM_TRIAGE_MODEL` | — | LLM model for triage classification; setting this enables cascading |
| `RUSTY_CASCADE_ENABLED` | auto | Explicitly enable (`true`) or disable (`false`) cascading; default is auto (enabled when triage model is set) |

See [Cascading review](/guides/cascading-review/).

## Graph-ranked context

| Variable | Default | Description |
| --- | --- | --- |
| `RUSTY_GRAPH_CONTEXT` | `false` | Enable GraphSift-style ranked context selection for deep-review prompts |
| `RUSTY_GRAPH_CONTEXT_TOKEN_BUDGET` | `2000` | Hard token budget for selected dependency context |
| `RUSTY_GRAPH_CONTEXT_MAX_CANDIDATES` | `8` | Maximum directly related files to consider after ranking |

See [Graph-ranked context](/guides/graph-ranked-context/).

## OpenGrep

| Variable | Default | Description |
| --- | --- | --- |
| `RUSTY_OPENGREP_RULES` | `auto` | OpenGrep config string — ruleset ID (e.g. `p/security-audit`) or path to a rule file (e.g. `.semgrep.yml`) |

See [OpenGrep pre-scan](/guides/opengrep/).

## PR description generation

| Variable | Default | Description |
| --- | --- | --- |
| `RUSTY_GENERATE_DESCRIPTION` | `false` | Generate a PR description when it's empty or a placeholder |

See [PR description generation](/guides/pr-description/).

## PR title rewriting

| Variable | Default | Description |
| --- | --- | --- |
| `RUSTY_RENAME_TITLE_TO_CONVENTIONAL` | `false` | Rewrite non-conventional PR titles into Conventional Commits format |

See [PR title rewriting](/guides/pr-title/).

## MCP tools

| Variable | Default | Description |
| --- | --- | --- |
| `RUSTY_MCP_CONFIG` | `./mcp-servers.json` | Path to a JSON file declaring MCP servers (stdio or HTTP). Missing file disables MCP silently. |

See [MCP tools](/guides/mcp-tools/).

## Dashboard (self-hosted only)

| Variable | Default | Description |
| --- | --- | --- |
| `RUSTY_DASHBOARD` | `false` | Serve the embedded dashboard from the GitHub App webhook server when set to `true`. |
| `RUSTY_DASHBOARD_DIR` | bundled | Override the directory served when the dashboard is enabled. Used for development. |

## Ticket integrations

| Variable | Description |
| --- | --- |
| `RUSTY_JIRA_BASE_URL` | Jira instance URL |
| `RUSTY_JIRA_EMAIL` | Jira auth email |
| `RUSTY_JIRA_API_TOKEN` | Jira API token (also exposed as the `jira-api-token` action input) |
| `RUSTY_LINEAR_API_KEY` | Linear API key (also exposed as the `linear-api-key` action input) |
| `RUSTY_ADO_PAT` | Azure DevOps PAT for non-container / server mode usage |

See [Ticket integration](/guides/ticket-integration/).

## GitHub App (self-hosted only)

| Variable | Description |
| --- | --- |
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_PRIVATE_KEY_PATH` | Path to the GitHub App private key PEM file |
| `GITHUB_PRIVATE_KEY` | Inline PEM string (alternative to `GITHUB_PRIVATE_KEY_PATH`) |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook secret |

See [GitHub App (self-hosted)](/providers/github-app/).

---

For the canonical list, see
[`action.yml`](https://github.com/jegork/rusty-bot/blob/main/action.yml) and
[`.env.example`](https://github.com/jegork/rusty-bot/blob/main/.env.example) in
the repo.
