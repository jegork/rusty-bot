# Rusty Bot

AI-powered PR review bot with configurable review styles, focus areas, and ticket compliance checking. Works with GitHub, GitLab, and Azure DevOps.

Built on [Mastra](https://mastra.ai/) (TypeScript).

## Features

- **5 review styles** — Strict, Balanced, Lenient, Roast, Thorough
- **6 focus areas** — Security, Performance, Bugs, Code Style, Test Coverage, Documentation
- **Triage-driven cascading review** — cheap model classifies files as skip/skim/deep-review, each tier gets an appropriate level of scrutiny
- **Tree-sitter context expansion** — hunks expand to enclosing function/class boundaries instead of fixed line counts (TS, JS, Python, Go, Java, Rust)
- **Structured summary comments** — severity table, collapsible issue details, missing tests list, files reviewed
- **Inline code comments** — findings posted directly on PR diff lines
- **Ticket compliance** — discovers linked tickets from PR description, branch name, and platform APIs (GitHub linked issues, ADO work items), then checks if requirements are addressed
- **OpenGrep pre-scan** — runs [OpenGrep](https://opengrep.dev/) SAST on changed files before LLM review, feeds findings for triage (gracefully skipped when not installed)
- **Multi-provider LLM** — OpenAI, Anthropic, Google, or any provider supported by Mastra
- **PR description generation** — optionally generate a structured PR description from the diff when the description is empty or a placeholder (off by default)
- **Incremental review** — on subsequent pushes the bot reviews only the diff since the previously-reviewed state (commit on GitHub/GitLab, PR iteration on Azure DevOps) instead of the entire PR, cutting tokens on multi-commit PRs. The previous summary, recommendation, and surfaced findings are carried forward so the agent keeps PR-wide context without re-reading the full diff (on by default; opt out with `RUSTY_INCREMENTAL_REVIEW=false`)
- **GitHub + GitLab + Azure DevOps + local CLI** — webhook server for GitHub, pipeline task for Azure DevOps, GitLab CI job, a drop-in GitHub Action, or a `rusty-bot` CLI that runs reviews against any local git repo
- **Web dashboard** — configure repos, review styles, focus areas, and view history

## Quick Start

```bash
# install dependencies
pnpm install

# build all packages
pnpm -r build

# copy env template and configure
cp .env.example .env
# edit .env — set at least one LLM API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)

# start the server
pnpm --filter @rusty-bot/github start
```

Server runs on `http://localhost:3000`. Dashboard is at `/`, health check at `/health`.

## Quick Start (Podman)

```bash
cp .env.example .env
# edit .env with your API keys

podman compose up --build
```

The image defaults to `root` so CI container handlers (GitHub Actions, Azure Pipelines, GitLab CI) can perform their in-container agent setup. The included `compose.yaml` drops privileges via `user: rusty` for the long-running webhook server. If you run the image standalone outside of CI and want non-root, pass `--user rusty` to `docker run` / `podman run`.

## Project Structure

```
packages/
├── core/           # shared review engine
│   ├── src/
│   │   ├── agent/      # Mastra review agent, judge/filter pass, prompt templates, Zod output schema
│   │   ├── diff/       # unified diff parser, tree-sitter context expansion, file filter, token-aware compression
│   │   ├── formatter/  # summary comment + inline comment markdown renderers
│   │   ├── triage/     # file classification for cascading review (skip/skim/deep-review)
│   │   ├── tickets/    # ticket ref extraction, providers (GitHub/Jira/Linear/ADO)
│   │   ├── opengrep/   # OpenGrep SAST runner and JSON output parser
│   │   └── types.ts    # shared type definitions
│   └── src/prompts/    # externalized prompt templates (styles + focus areas)
├── github/         # GitHub App webhook server + config API
├── github-action/  # One-shot CLI driven by GitHub Actions env + event payload
├── azure-devops/   # Azure DevOps pipeline task (Docker entrypoint)
├── gitlab/         # GitLab CI task — provider + CLI driven by CI_MERGE_REQUEST_* env
├── cli/            # `rusty-bot` CLI for local terminal-based reviews against any git repo
└── dashboard/      # React SPA for configuration and review history
```

## GitHub App Setup

1. Create a GitHub App at `https://github.com/settings/apps/new` or use the provided `github-app-manifest.json`
2. Required permissions:
   - **Pull requests**: Read & Write
   - **Issues**: Read
   - **Contents**: Read
3. Subscribe to the **Pull request** event
4. Generate a private key and download it
5. Set environment variables:

```bash
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_PATH=./private-key.pem
GITHUB_WEBHOOK_SECRET=your-secret
```

6. Point the webhook URL to `https://your-domain/api/webhooks/github`
7. Install the app on your repositories

## GitHub Action Setup

The repo publishes a Docker-based GitHub Action alongside the webhook server. Drop it into any repo to get AI review on pull requests without hosting anything — reviews run on the GitHub-hosted runner, authenticated with the built-in `GITHUB_TOKEN`.

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      pull-requests: write
      contents: read
      issues: read
    steps:
      - uses: jegork/rusty-bot@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
        env:
          RUSTY_LLM_MODEL: anthropic/claude-sonnet-4-20250514
          RUSTY_REVIEW_STYLE: balanced
          RUSTY_FOCUS_AREAS: security,bugs,performance
          RUSTY_FAIL_ON_CRITICAL: "true"
```

**Required permissions** (set on the job, not the whole workflow):

- `pull-requests: write` — post summary and inline review comments
- `issues: read` — read linked issues for ticket compliance
- `contents: read` — read the diff and convention file from the target branch

**Action inputs** (secret-bearing only — everything else flows through `env:`):

| Input | Notes |
|---|---|
| `github-token` | Defaults to `${{ github.token }}`; the built-in token works when the `permissions:` block above is set |
| `anthropic-api-key` | Required when `RUSTY_LLM_MODEL` targets an `anthropic/*` model |
| `openai-api-key` | Required when `RUSTY_LLM_MODEL` targets an `openai/*` model |
| `google-api-key` | Required when `RUSTY_LLM_MODEL` targets a `google/*` model |
| `azure-openai-api-key` | Required when `RUSTY_LLM_MODEL` targets an `azure-openai/*` model |
| `llm-api-key` | API key for an OpenAI-compatible endpoint (set together with `RUSTY_LLM_BASE_URL`, e.g. LiteLLM, Requesty, vLLM) |
| `jira-api-token` | Enable Jira ticket compliance (combine with `RUSTY_JIRA_BASE_URL` + `RUSTY_JIRA_EMAIL` env) |
| `linear-api-key` | Enable Linear ticket compliance |

Everything else — `RUSTY_REVIEW_STYLE`, `RUSTY_FOCUS_AREAS`, `RUSTY_LLM_MODEL`, `RUSTY_JUDGE_*`, `RUSTY_LLM_TRIAGE_MODEL`, temperatures, `RUSTY_OPENGREP_RULES`, `RUSTY_REVIEW_DRAFTS`, etc. — is set per-step via `env:`. See the env-var table below for the full list.

The Action runs inside the published Docker image (`ghcr.io/jegork/rusty-bot:latest`), which includes OpenGrep. First run in a repo adds ~20–40s for the image pull; subsequent runs are cached by the runner.

**Skipped events:** the Action exits early with no error for `closed`/`labeled`/`unlabeled`/`assigned`/`unassigned` and for draft PRs (unless `review-drafts: "true"`).

## Azure DevOps Pipeline Setup

Rusty Bot runs inside a container in Azure Pipelines. The pipeline env vars (`SYSTEM_PULLREQUEST_*`, etc.) are automatically available inside the container.

```yaml
trigger: none

pr:
  branches:
    include:
      - main

pool:
  vmImage: ubuntu-latest

container:
  image: ghcr.io/jegork/rusty-bot:latest
  env:
    RUSTY_MODE: pipeline

steps:
  - script: node /app/packages/azure-devops/dist/cli.js
    displayName: Rusty Bot PR Review
    env:
      SYSTEM_ACCESSTOKEN: $(System.AccessToken)
      RUSTY_LLM_MODEL: $(RUSTY_LLM_MODEL)
      ANTHROPIC_API_KEY: $(ANTHROPIC_API_KEY)
      RUSTY_REVIEW_STYLE: $(RUSTY_REVIEW_STYLE)
      RUSTY_FOCUS_AREAS: $(RUSTY_FOCUS_AREAS)
      RUSTY_FAIL_ON_CRITICAL: "true"
```

Set `RUSTY_LLM_MODEL`, `ANTHROPIC_API_KEY`, and other variables as pipeline variables in Azure DevOps. For Azure OpenAI with managed identity, replace the API key vars with `RUSTY_AZURE_RESOURCE_NAME` and `RUSTY_AZURE_DEPLOYMENT`.

The task exits with code 1 when critical issues are found (configurable via `RUSTY_FAIL_ON_CRITICAL`), which can gate PR merges.

## GitLab CI Setup

Rusty Bot ships with a GitLab CI integration that runs as a job inside the published Docker image. The job reads GitLab's predefined `CI_*` variables (`CI_MERGE_REQUEST_IID`, `CI_PROJECT_PATH`, `CI_API_V4_URL`) so there's nothing to configure beyond a token and an LLM key. See [`gitlab-ci-example.yml`](./gitlab-ci-example.yml) for the full snippet.

```yaml
rusty-bot-review:
  stage: test
  image: ghcr.io/jegork/rusty-bot:latest
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    RUSTY_MODE: gitlab
    RUSTY_LLM_MODEL: anthropic/claude-sonnet-4-20250514
    RUSTY_REVIEW_STYLE: balanced
    RUSTY_FOCUS_AREAS: security,bugs,performance
    RUSTY_FAIL_ON_CRITICAL: "true"
  script:
    - node /app/packages/gitlab/dist/cli.js
```

**Authentication:** Set `RUSTY_GITLAB_TOKEN` to a [project access token](https://docs.gitlab.com/ee/user/project/settings/project_access_tokens.html) with the `api` scope as a CI/CD variable (Settings → CI/CD → Variables). `CI_JOB_TOKEN` is read-only on most installs and cannot post MR notes or discussions.

**LLM key:** Set the matching key for your chosen provider as a CI/CD variable too (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, etc.).

**Self-hosted GitLab:** No extra config needed — `CI_API_V4_URL` is populated by the runner. Set `RUSTY_GITLAB_API_URL` only when invoking the CLI outside of GitLab CI.

**What the bot does on GitLab:**

- Posts a structured summary as an MR note (severity table, missing tests, ticket compliance)
- Posts inline review comments on the MR diff via the discussions API
- Updates the MR title/description when `RUSTY_RENAME_TITLE_TO_CONVENTIONAL=true` or `RUSTY_GENERATE_DESCRIPTION=true`
- Resolves linked closing issues (`Closes #123`) via the GitLab `closes_issues` endpoint
- Supports incremental review via head SHA — subsequent pushes only review the delta

The job exits with code 1 when critical issues are found (configurable via `RUSTY_FAIL_ON_CRITICAL`), which can gate MR merges when the job is on the merge train or required.

## Local CLI

The `@rusty-bot/cli` package adds a `rusty-bot` binary that runs the review pipeline against a local git repo with no GitHub/Azure DevOps harness. Useful for previewing what the bot would say on a branch before opening a PR, scripting reviews in pre-commit/pre-push hooks, or running the bot in CI environments that aren't GitHub or Azure DevOps.

```bash
# from the repo root, after pnpm install + pnpm -r build
pnpm --filter @rusty-bot/cli start -- --base main --head HEAD

# or, after npm/pnpm linking the bin
rusty-bot --repo /path/to/repo --base main --head feature-branch --format markdown
```

The CLI reuses the same review engine, prompts, triage, MCP wiring, convention-file loading, and judge pass as the GitHub/Azure DevOps harnesses. Comment-posting is a no-op — findings are printed to stdout (markdown summary + collapsible inline findings, or JSON).

**Flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--repo <path>` | path to the git repo | cwd |
| `--base <ref>` | base ref to diff against | `main` |
| `--head <ref>` | head ref to review | `HEAD` |
| `--style <style>` | `strict` \| `balanced` \| `lenient` \| `roast` \| `thorough` | `balanced` |
| `--focus <list>` | comma-separated focus areas (`security,performance,bugs,style,tests,docs`) | all |
| `--ignore <list>` | comma-separated glob patterns to skip | — |
| `--format <fmt>` | `markdown` or `json` | `markdown` |
| `--fail-on-critical` | exit non-zero when any critical finding is present | off |
| `-h`, `--help` | show help text | — |

**Environment:**

The CLI reads the same env vars as the other harnesses — `RUSTY_LLM_MODEL`, the matching provider API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.), `RUSTY_LLM_TRIAGE_MODEL`, `RUSTY_CASCADE_ENABLED`, `RUSTY_JUDGE_*`, `RUSTY_OPENGREP_RULES`, MCP server configs, etc. See the [Configuration](#configuration) section for the full list.

**`searchCode` tool:** the CLI's `LocalGitProvider` shells out to `ripgrep` when available (preferred for speed and gitignore awareness) and falls back to `git grep` otherwise. PR-mutation methods (post comment, update title/description, etc.) are no-ops in the CLI since there is no PR to mutate.

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RUSTY_LLM_MODEL` | LLM model in `provider/model` format. `openrouter/*` models accept an optional `:<effort>` suffix, see [Reasoning effort](#reasoning-effort-openrouter) | `anthropic/claude-sonnet-4-20250514` |
| `OPENAI_API_KEY` | OpenAI API key | — |
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google AI API key | — |
| `RUSTY_DB_URL` | libSQL database URL | `file:./rusty.db` |
| `GITHUB_APP_ID` | GitHub App ID | — |
| `GITHUB_PRIVATE_KEY_PATH` | path to GitHub App private key PEM | — |
| `GITHUB_PRIVATE_KEY` | inline PEM (alternative to path) | — |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook secret | — |
| `RUSTY_REVIEW_STYLE` | default review style | `balanced` |
| `RUSTY_FOCUS_AREAS` | comma-separated focus areas | all enabled |
| `RUSTY_IGNORE_PATTERNS` | comma-separated glob patterns to skip | — |
| `RUSTY_FAIL_ON_CRITICAL` | exit 1 on critical findings (pipeline/action mode) | `true` |
| `RUSTY_REVIEW_DRAFTS` | review draft PRs in GitHub Action mode | `false` |
| `RUSTY_INCREMENTAL_REVIEW` | review only the diff since the last reviewed commit (GitHub, GitLab) or PR iteration (Azure DevOps); previous summary + findings are carried forward as context | `true` |
| `RUSTY_LLM_HEADERS_TIMEOUT_MS` | undici headers timeout for outbound `fetch` (LLM router + provider APIs) — raised above the 300s default to accommodate slow upstream models on large prompts | `600000` |
| `RUSTY_LLM_BODY_TIMEOUT_MS` | undici body timeout for outbound `fetch`; resets per chunk so generations longer than this still complete as long as chunks keep arriving | `600000` |
| `RUSTY_OLLAMA_BASE_URL` | base URL for the `ollama/*` provider — set to `https://ollama.com` for [Ollama Cloud](https://ollama.com), or a remote host for self-hosted Ollama | `http://127.0.0.1:11434` |
| `RUSTY_OLLAMA_API_KEY` | bearer token for the `ollama/*` provider (required for Ollama Cloud, ignored for unauthenticated local instances); falls back to `OLLAMA_API_KEY` | — |
| `RUSTY_LOG_AGENT_STEPS` | when `true`, log a line per agent step (`stepNumber`, `finishReason`, `toolCallCount`, token usage); diagnostic for slow / tool-looping passes | `false` |
| `RUSTY_LOG_RAW_FINDINGS` | when `true`, log each consensus pass's findings before clustering (file/line/severity/category/message); diagnostic for tuning Jaccard / line-proximity thresholds | `false` |
| `RUSTY_JIRA_BASE_URL` | Jira instance URL | — |
| `RUSTY_JIRA_EMAIL` | Jira auth email | — |
| `RUSTY_JIRA_API_TOKEN` | Jira API token | — |
| `RUSTY_LINEAR_API_KEY` | Linear API key | — |
| `RUSTY_ADO_PAT` | Azure DevOps PAT (server mode) | — |
| `RUSTY_GITLAB_TOKEN` | GitLab project/personal access token (`api` scope) used by the GitLab CI job | falls back to `CI_JOB_TOKEN` |
| `RUSTY_GITLAB_API_URL` | GitLab API v4 base URL (override for self-hosted; defaults to `CI_API_V4_URL`) | — |
| `RUSTY_GITLAB_PROJECT_PATH` | Override `CI_PROJECT_PATH` when invoking the GitLab CLI outside of GitLab CI | — |
| `RUSTY_GITLAB_MR_IID` | Override `CI_MERGE_REQUEST_IID` when invoking the GitLab CLI outside of GitLab CI | — |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key (or `AZURE_API_KEY`) | — |
| `AZURE_OPENAI_RESOURCE_NAME` | Azure OpenAI resource name | — |
| `RUSTY_AZURE_RESOURCE_NAME` | Azure OpenAI resource (managed identity mode) | — |
| `RUSTY_AZURE_DEPLOYMENT` | Azure OpenAI deployment (managed identity mode) | — |
| `RUSTY_AZURE_FOUNDRY_RESOURCE_NAME` | Azure AI Foundry resource for non-OpenAI models (managed identity mode) | — |
| `RUSTY_AZURE_FOUNDRY_DEPLOYMENT` | Azure AI Foundry deployment for non-OpenAI models (managed identity mode) | — |
| `RUSTY_AZURE_ANTHROPIC_BASE_URL` | Azure AI Foundry Anthropic endpoint (e.g. `https://<resource>.services.ai.azure.com/anthropic/v1`) | — |
| `RUSTY_AZURE_ANTHROPIC_API_KEY` | Foundry API key for the Anthropic deployment (or `AZURE_ANTHROPIC_API_KEY`) | — |
| `RUSTY_AZURE_ANTHROPIC_DEPLOYMENT` | Foundry deployment name (managed identity / Entra ID mode) | — |
| `RUSTY_LLM_BASE_URL` | OpenAI-compatible endpoint URL (e.g. LiteLLM) | — |
| `RUSTY_LLM_API_KEY` | API key for custom endpoint | — |
| `RUSTY_JUDGE_ENABLED` | enable post-generation judge/filter pass | `false` |
| `RUSTY_JUDGE_THRESHOLD` | minimum confidence score (0–10) to keep a finding | `6` |
| `RUSTY_JUDGE_MODEL` | model for the judge (can be cheaper than reviewer) | same as `RUSTY_LLM_MODEL` |
| `RUSTY_LLM_TRIAGE_MODEL` | LLM model for triage classification (enables cascading) | — |
| `RUSTY_CASCADE_ENABLED` | explicitly enable/disable cascading (`true`/`false`) | auto (enabled when triage model is set) |
| `RUSTY_OPENGREP_RULES` | OpenGrep config string (ruleset or path to rule file) | `auto` |
| `RUSTY_GENERATE_DESCRIPTION` | generate PR description when empty/placeholder | `false` |
| `RUSTY_RENAME_TITLE_TO_CONVENTIONAL` | rewrite non-conventional PR titles into Conventional Commits format | `false` |
| `RUSTY_LLM_MAX_RETRIES` | application-level retries on transient LLM errors (max 2) | `2` |
| `RUSTY_LLM_MAX_STEPS` | cap on multi-step tool-using trajectories per review pass. The final allowed step is forced to `toolChoice: "none"` so the model has to emit text (and therefore structured output), which avoids tool-happy models — Anthropic in particular — terminating with `finishReason: "tool-calls"` and zero text. Unset = mastra's default (no cap, no forced final step). | — |
| `RUSTY_LLM_STRUCTURING_MODEL` | model id for a separate structuring pass (e.g. `azure-openai/gpt-5.4-mini`). When set, the review model writes freeform prose with tools available and no schema pressure, and a cheap structuring model translates the prose into the required JSON. Eliminates the entire class of "model terminates with tool-calls and zero text" failures since the review model is no longer on the schema-output path. Adds one cheap LLM call per review pass. | — |
| `RUSTY_LLM_JSON_PROMPT_INJECTION` | comma-separated model IDs (or `prefix*` wildcards) to force-on prompt-injected JSON output, overriding the auto-detected default | — |
| `RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT` | comma-separated model IDs (or `prefix*` wildcards) to force-on native `json_schema` structured output, overriding the auto-detected default | — |
| `RUSTY_LLM_DISABLE_THINKING` | comma-separated `azure-foundry/<deployment>` IDs (or `prefix*` wildcards) to send `thinking: { type: "disabled" }` on chat-completions requests. Useful for Moonshot Kimi K2 deployments whose thinking trace eats the output budget and causes JSON truncation. Only takes effect on `azure-foundry/*` configs. | — |
| `RUSTY_LLM_TEMPERATURE` | global LLM temperature | provider default |
| `RUSTY_LLM_TOP_P` | global LLM top-p | provider default |
| `RUSTY_REVIEW_TEMPERATURE` | temperature override for the review agent | `RUSTY_LLM_TEMPERATURE` |
| `RUSTY_TRIAGE_TEMPERATURE` | temperature override for the triage agent | `RUSTY_LLM_TEMPERATURE` |
| `RUSTY_JUDGE_TEMPERATURE` | temperature override for the judge agent | `RUSTY_LLM_TEMPERATURE` |
| `RUSTY_DESCRIPTION_TEMPERATURE` | temperature override for the description agent | `RUSTY_LLM_TEMPERATURE` |
| `RUSTY_TITLE_TEMPERATURE` | temperature override for the title-rename agent | `RUSTY_LLM_TEMPERATURE` |

### LLM Provider Configuration

Rusty Bot supports eight ways to connect to an LLM, resolved in this order:

**1. Azure OpenAI with API key** — for Azure AI Foundry GPT deployments:
```bash
RUSTY_LLM_MODEL=azure-openai/gpt-5.3-codex
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_RESOURCE_NAME=ai-code-review-foundry
```

The resource name is the subdomain from your endpoint URL (e.g. `https://ai-code-review-foundry.cognitiveservices.azure.com` → `ai-code-review-foundry`). Uses `@ai-sdk/azure` directly with the Responses API (`/v1/responses`).

**2. Azure OpenAI with Managed Identity** — no API keys needed when running on Azure:
```bash
RUSTY_AZURE_RESOURCE_NAME=my-openai-resource
RUSTY_AZURE_DEPLOYMENT=gpt-4o
```

Uses `DefaultAzureCredential` from `@azure/identity`, which automatically picks up managed identity in Azure VMs, AKS, App Service, Azure Functions, and Azure Pipelines. Also works with `az login` locally.

**3. Non-OpenAI models on Azure AI Foundry with API key** — Kimi, Llama, Mistral, etc. served from the Foundry endpoint but only reachable via Chat Completions:
```bash
RUSTY_LLM_MODEL=azure-foundry/Kimi-K2.6
AZURE_OPENAI_API_KEY=your-key
AZURE_OPENAI_RESOURCE_NAME=ai-code-review-foundry
```

Identical config to `azure-openai/`, but routes through `/v1/chat/completions` instead of `/v1/responses` because non-OpenAI Foundry models don't support the Responses API. Use this prefix whenever the deployment isn't a first-party OpenAI model.

**4. Non-OpenAI models on Azure AI Foundry with Managed Identity**:
```bash
RUSTY_AZURE_FOUNDRY_RESOURCE_NAME=ai-code-review-foundry
RUSTY_AZURE_FOUNDRY_DEPLOYMENT=Kimi-K2.6
```

Same `DefaultAzureCredential` path as the OpenAI MI mode, but kept on separate env vars so the two can coexist on the same machine.

**5. Anthropic on Azure AI Foundry with API key** — for Claude deployments served from Foundry's Models-as-a-Service:
```bash
RUSTY_LLM_MODEL=azure-anthropic/claude-sonnet-4-5
RUSTY_AZURE_ANTHROPIC_BASE_URL=https://my-foundry.services.ai.azure.com/anthropic/v1
RUSTY_AZURE_ANTHROPIC_API_KEY=your-foundry-key
```

The deployment after `azure-anthropic/` must match the deployment name in Foundry. The base URL is the resource's Anthropic endpoint up to and including `/v1` — `@ai-sdk/anthropic` appends `/messages` itself. Uses `@ai-sdk/anthropic` with a custom `baseURL`, so Anthropic features like prompt caching and tool use work unchanged.

**6. Anthropic on Azure AI Foundry with Entra ID** — managed identity / `az login`, no API key:
```bash
RUSTY_AZURE_ANTHROPIC_BASE_URL=https://my-foundry.services.ai.azure.com/anthropic/v1
RUSTY_AZURE_ANTHROPIC_DEPLOYMENT=claude-sonnet-4-5
```

Uses `DefaultAzureCredential` to fetch a fresh token (scope `https://cognitiveservices.azure.com/.default`) for every request, just like the Azure OpenAI managed identity path.

**7. OpenAI-compatible endpoint** — for LiteLLM, vLLM, or any proxy:
```bash
RUSTY_LLM_BASE_URL=http://localhost:4000/v1
RUSTY_LLM_MODEL=gpt-4o
RUSTY_LLM_API_KEY=optional-key
```

**8. Ollama (local or [Ollama Cloud](https://ollama.com))** — uses the native [`ai-sdk-ollama`](https://www.npmjs.com/package/ai-sdk-ollama) provider, so it supports tool calling and can be mixed per-pass with other providers in `RUSTY_REVIEW_MODELS`:
```bash
# local Ollama (default)
RUSTY_LLM_MODEL=ollama/llama3.2

# Ollama Cloud
RUSTY_LLM_MODEL=ollama/gpt-oss:120b
RUSTY_OLLAMA_BASE_URL=https://ollama.com
RUSTY_OLLAMA_API_KEY=...   # get one at https://ollama.com/account
```

To mix Ollama with other providers in a consensus ensemble:

```bash
RUSTY_OLLAMA_BASE_URL=https://ollama.com
RUSTY_OLLAMA_API_KEY=...
RUSTY_REVIEW_MODELS=anthropic/claude-sonnet-4-5,ollama/gpt-oss:120b,requesty/google/gemini-3.1-pro
```

Structured output: by default Ollama uses prompt-injected JSON via the structuring model (set `RUSTY_LLM_STRUCTURING_MODEL` to a known-good model like `requesty/google/gemini-3.1-flash-lite-preview`). Opt into native JSON schema for specific models with `RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT=ollama/gpt-oss*`.

**9. Mastra model router (default)** — direct provider API keys:
```bash
RUSTY_LLM_MODEL=anthropic/claude-sonnet-4-20250514
ANTHROPIC_API_KEY=sk-ant-...
```

Supports 99+ providers: `openai/gpt-4o`, `google/gemini-2.5-flash`, `openrouter/...`, etc.

### Model + Provider Routing Notes

The same model id can route through different inference providers (e.g. `requesty/deepseek/deepseek-v4-pro` vs. `requesty/fireworks/deepseek-v4-pro`). They are **not interchangeable** — different provider backends serve the same model with different latency profiles, tool-calling reliability, and rate limits. When picking a route for `RUSTY_REVIEW_MODELS` or `RUSTY_JUDGE_MODEL`, the choice between proxy backends matters as much as the choice between models.

Empirically observed gotchas:

- **`requesty/fireworks/deepseek-v4-pro` tool-loops on review-tier calls.** With `RUSTY_LLM_MAX_STEPS=10` and active `searchCode` / `getFileContext` tools, observed reviewer passes hanging for 10-15 minutes before the step cap fires. Use `requesty/deepseek/deepseek-v4-pro` (the official DeepSeek provider on Requesty) for the review path instead. Fireworks-routed deepseek is fine for the **judge** because the judge has no tools and can't tool-loop.
- **`ollama/deepseek-v4-pro:cloud` (Ollama Cloud) was observed sustaining 503 "Server overloaded" through full retry budget** during peak load. The 503 is genuinely retried by `isTransientRetryableError`, but if all attempts fail you've lost the pass. Capacity has fluctuated; flip to a Requesty-backed deepseek if Ollama Cloud's hosted instance is congested.
- **`moonshot/kimi-k2.5` requires `temperature=1`.** Lower values are rejected by the upstream and the call fails. The `HARD_TEMPERATURE_LOCKS` table in `model.ts` rewrites the temperature on this exact pattern; it does NOT catch `kimi-k2.6` or proxy variants like `requesty/fireworks/kimi-k2.6`. Empirically the k2.x series benefits from `temperature=1` regardless of the route — set it explicitly via `RUSTY_REVIEW_TEMPERATURES` for any kimi-shaped pass.
- **Single-provider ensembles defeat consensus diversity.** If you set `RUSTY_REVIEW_MODELS` to three Anthropic models, the cluster algorithm has very little signal to filter — different sizes of the same model agree more than different vendors. Mix providers (Anthropic / xAI / Moonshot / DeepSeek / OpenAI / Google) for the consensus path to be useful.
- **Skim tier inherits `RUSTY_REVIEW_MODELS[0]`.** When the cascade triages a file as "skim" rather than "deep-review", the skim pass uses a single-pass review with the **first** entry in `RUSTY_REVIEW_MODELS` (`consensus.ts:113-120`). If slot 1 is a slow model (`deepseek-v4-pro` reasoning takes minutes per call), skim becomes slow too — even though the skim tier is supposed to be the fast triage path. Put a quick model (grok, kimi, gemini) in slot 1 and let the slower / more analytical models live in slots 2-3 where they only fire on consensus deep-review chunks.

If you observe a new failure pattern tied to a specific provider+model combination, add an entry here so the next person doesn't burn an afternoon on the same shape.

### OpenRouter as an alternative gateway

Same shape as Requesty — Mastra's router fallback handles `openrouter/*` model ids automatically when `OPENROUTER_API_KEY` is set. No code change needed.

```bash
OPENROUTER_API_KEY=sk-or-v1-...
RUSTY_LLM_MODEL=openrouter/anthropic/claude-sonnet-4-5
RUSTY_REVIEW_MODELS=openrouter/x-ai/grok-4.3,openrouter/moonshotai/kimi-k2.6,openrouter/deepseek/deepseek-v4-pro
```

You can mix gateways in one ensemble — `requesty/...`, `openrouter/...`, `ollama/...`, and direct provider ids all resolve per-pass through their own routes.

Caveats:
- **Native structured output is off by default for OpenRouter.** `supportsNativeStructuredOutput` doesn't include `openrouter/` in its allow-list because OpenRouter's proxying of `response_format: json_schema` varies by underlying model. Route through the structuring model (`RUSTY_LLM_STRUCTURING_MODEL`) instead, or opt in per-pattern with `RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT=openrouter/anthropic/*` if you've verified the upstream honors it.
- **OpenRouter's load balancer picks an inference backend per request**, so the same `openrouter/deepseek/deepseek-v4-pro` request can land on Fireworks, DeepSeek's own API, Together, etc. — bringing the same provider-routing-matters lesson with it. Pin a specific backend with the `:nitro` suffix (fastest available) or the OpenRouter-native `provider` parameter if you need determinism.
- **No bot-level prompt-cache integration**, the way `requesty/*` gets `auto_cache: true`. OpenRouter has its own caching for some models — handled upstream, no env var to flip on the bot side.

#### Reasoning effort (OpenRouter)

Without an explicit effort, every model runs at its provider default (GPT-6 Luna, for example, defaults to `medium`). Append `:<effort>` to any `openrouter/*` model string to send `reasoning: { effort }` with each request. This works in `RUSTY_LLM_MODEL`, in each `RUSTY_REVIEW_MODELS` entry, and in `RUSTY_JUDGE_MODEL` and `RUSTY_LLM_TRIAGE_MODEL`:

```bash
RUSTY_REVIEW_MODELS=openrouter/openai/gpt-6-luna:xhigh,openrouter/moonshotai/kimi-k2.6,openrouter/deepseek/deepseek-v4-pro:batch:high
RUSTY_LLM_TRIAGE_MODEL=openrouter/google/gemini-3-flash:low
```

- Accepted values match OpenRouter's [`reasoning.effort`](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens): `max`, `xhigh`, `high`, `medium`, `low`, `minimal`, `none`. Each model supports only some of these, so check the model's `supported_efforts` on OpenRouter.
- Only the **last** `:segment` is read, and only when it is one of those values. OpenRouter variants (`:batch`, `:free`, `:nitro`, `:online`, ...) and Ollama tags (`ollama/qwen3:32b`) stay part of the model id. To combine a variant with an effort, put the effort last: `openrouter/x/y:batch:high`.
- **OpenRouter only.** An effort suffix on any other provider (`anthropic/...:high`, `azure-openai/...:high`, `ollama/...:high`, or an `openrouter/*` model sent to `RUSTY_LLM_BASE_URL`) fails with a config error. It is not silently ignored.
- The effort appears in the model name shown in review comments and logs (e.g. `openrouter/openai/gpt-6-luna:xhigh`). Pattern matching for `RUSTY_LLM_JSON_PROMPT_INJECTION` / `RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT` uses the id without the suffix.

### Model Inference Settings

Set a global temperature/top-p for all agents, or override per agent. Per-agent values take priority over the global fallback.

```bash
# global defaults
RUSTY_LLM_TEMPERATURE=0.3
RUSTY_LLM_TOP_P=0.9

# per-agent overrides (each falls back to the global value when unset)
RUSTY_REVIEW_TEMPERATURE=0.3
RUSTY_TRIAGE_TEMPERATURE=0
RUSTY_JUDGE_TEMPERATURE=0
RUSTY_DESCRIPTION_TEMPERATURE=0.5
```

Some models enforce a fixed temperature (e.g. `moonshot/kimi-k2.5` only accepts `temperature=1`). Use the per-agent override when you run different models per agent.

### Structured Output Compatibility

Mastra asks the model to return findings as a typed JSON object via `response_format: json_schema`. Some providers (notably MiniMax M2.x and DeepSeek V4 in thinking mode) do not implement that protocol, and routers like Requesty only proxy `json_schema` for OpenAI / Anthropic / Google / Moonshot today. When the model can't honour the schema, the response comes back empty and the review pass fails with `STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED`.

Rusty Bot detects this automatically and falls back to **prompt-injected JSON** for non-supported model strings (Mastra's `jsonPromptInjection: true`) — the schema is added to the system prompt and Mastra parses the JSON out of the text response. The default rule is:

- Native `json_schema`: any model whose ID starts with `openai/`, `anthropic/`, `google/`, `azure-openai/`, `requesty/openai/`, `requesty/anthropic/`, `requesty/google/`, `requesty/moonshot/`, or `requesty/fireworks/`. Azure OpenAI, Azure-hosted Anthropic (both API key and Entra ID), and OpenAI-compatible endpoints also default to native.
- Prompt injection: everything else (e.g. `requesty/minimaxi/...`, `requesty/deepseek/...`, `requesty/qwen/...`).

Override the default per model with two env vars (CSV; trailing-`*` matches a prefix):

```bash
# force prompt injection (escape hatch when a "supported" model regresses)
RUSTY_LLM_JSON_PROMPT_INJECTION=requesty/openai/gpt-5-pro,requesty/google/*

# force native json_schema (when a custom proxy translates it correctly)
RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT=requesty/deepseek/deepseek-v4-pro
```

Force-on takes precedence over force-off when the same model appears in both lists.

#### Two-pass structured output (alternative to forcing one schema mode)

Some models — Kimi K2.x with thinking enabled, Anthropic models with tools — sometimes terminate with `finishReason: "tool-calls"` and zero text instead of emitting JSON, regardless of which schema mode is in use. The single-model path can't recover from that: there's no text for either the native parser or the prompt-injection parser to work with.

`RUSTY_LLM_STRUCTURING_MODEL` opts into Mastra's two-agent flow:

```bash
RUSTY_LLM_STRUCTURING_MODEL=azure-openai/gpt-5.4-mini
```

When set, the review model runs with tools and writes freeform prose (no schema pressure), then a cheap structuring model translates the prose into the schema-conformant JSON. Tool-loop failures evaporate because the review model is no longer on the schema-output path. `RUSTY_LLM_JSON_PROMPT_INJECTION` / `RUSTY_LLM_NATIVE_STRUCTURED_OUTPUT` are evaluated against the *structuring* model's capabilities when this is set.

Costs: one extra LLM call per review pass (small on a cheap model) and ~3–8s of extra latency. Trade-off: small risk of information loss in the prose-to-JSON translation if the structuring model misses a field.

### Per-Repository Configuration

Configure via the web dashboard at `http://localhost:3000` or the API:

```bash
# set repo config
curl -X PUT http://localhost:3000/api/config/repos/owner/repo \
  -H "Content-Type: application/json" \
  -d '{
    "style": "roast",
    "focusAreas": ["security", "bugs", "performance"],
    "ignorePatterns": ["*.generated.ts", "vendor/**"]
  }'
```

### Convention Files

Check in a markdown file to your repo root to provide review instructions:

| File | Priority |
|------|----------|
| `.rusty-bot.md` | Highest |
| `REVIEW-BOT.md` | Medium |
| `AGENTS.md` | Lowest |

The bot picks up the first file found (winner-takes-all) and injects its content into the system prompt. The file is fetched from the **target branch** so PR authors cannot tamper with review rules.

Example `.rusty-bot.md`:

```markdown
- We use Effect-TS, don't flag `.pipe()` chains as complexity issues
- All API endpoints must have Zod validation — flag missing schemas as warnings
- Ignore `generated/` and `__snapshots__/` directories
- Security findings in `scripts/` are low priority, it's internal tooling
- Be lenient on style, strict on security
```

### Review Styles

| Style | Behavior |
|-------|----------|
| **Strict** | Flags all potential issues, prioritizes quality and security |
| **Balanced** | Focuses on confidence, balances thoroughness with practicality |
| **Lenient** | Only critical bugs and security issues, encouraging tone |
| **Roast** | Technically accurate feedback wrapped in sharp, witty commentary |
| **Thorough** | Structured reasoning (intent → components → execution paths → invariants → edge cases → blast radius) before producing findings |

### Judge / Filter Pass

By default every finding the LLM produces gets posted directly. The judge pass adds a self-reflection stage: after generating findings, a second agent scores each one for confidence (0–10) and drops anything below a configurable threshold. This catches hallucinated findings, speculative claims, and low-value noise before they reach developers.

Enable it with:

```bash
RUSTY_JUDGE_ENABLED=true
RUSTY_JUDGE_THRESHOLD=6          # 0–10, findings below this are dropped
RUSTY_JUDGE_MODEL=anthropic/claude-3-5-haiku-20241022  # optional, cheaper model
```

**How it works:**

1. The reviewer generates findings as normal
2. The judge agent receives the diff + all findings and scores each one 0–10
3. Findings below the threshold are filtered out and logged at `debug` level
4. The merge recommendation is recalculated based on surviving findings
5. The summary footer shows token usage for review and judge separately, plus how many findings were filtered

**Tuning the threshold:**

| Threshold | Behavior |
|-----------|----------|
| 3–4 | Permissive — only drops clearly hallucinated findings |
| 5–6 | Balanced — removes speculative and low-confidence noise |
| 7–8 | Strict — only high-confidence, evidence-backed findings survive |
| 9–10 | Very strict — likely over-filters, use for low-noise environments |

**Cost:** The judge uses a single LLM call with structured output (no tools). Using a cheap model like Haiku adds ~1–3% to total cost. Using the same model as the reviewer adds ~30–50%.

When the judge is disabled (default), the pipeline behaves exactly as before with zero overhead.

### Incremental Review

When a PR gets new commits after a previous review, the bot only fetches the diff since the last reviewed commit (or PR iteration on Azure DevOps) instead of the full PR. To keep PR-wide context without paying for the full diff, the previous review's **summary**, **recommendation**, and **surfaced findings** are carried forward and shown to the agent as established background.

**How it works:**

1. After every review, the bot embeds two hidden markers in its summary comment:
   - `<!-- rusty-bot:last-sha:... -->` (or `last-iteration` on ADO) — pinpoints what was reviewed
   - `<!-- rusty-bot:context:... -->` — base64-encoded JSON of the prior summary + findings (capped: 4 000-char summary, 50 findings, 250-char message each)
2. On the next push, the bot reads both markers from its previous comment, fetches only the new diff, and injects a `## Prior review context` section into the agent's prompt. The agent is explicitly told its summary must describe the **whole** PR, not just the new diff.
3. The prior-findings list is annotated as "do NOT re-raise unless this commit changes the underlying code", which suppresses duplicate findings across re-reviews.

**Caps and trade-offs:**

- Only the **most recent** prior review is carried forward — chained re-reviews compound the prior summary at every step (the previous summary already absorbed the one before it).
- Carry-forward state is provider-side: it survives bot-comment cleanup because the markers are read **before** old comments are deleted on each run.
- If a force-push or rebase makes the prior SHA unreachable, the bot transparently falls back to a full review — there is no fragile state.
- Disable with `RUSTY_INCREMENTAL_REVIEW=false`; the bot then re-reviews the full PR every time and posts no carry-forward markers.

### LLM Request Timeouts

Node's underlying HTTP client (undici) defaults to a **300-second headers timeout**. On large PRs reviewed with slower upstream routes — particularly Requesty proxying to Fireworks/Kimi or other long-tail providers — the response headers may not arrive within that window even though the model is making forward progress. The default would surface as a `HeadersTimeoutError` (`UND_ERR_HEADERS_TIMEOUT`) on the affected pass.

Each CLI entry point calls `configureGlobalHttp()` at startup, which installs an undici dispatcher with a longer headers + body timeout. Defaults:

- `RUSTY_LLM_HEADERS_TIMEOUT_MS=600000` (10 min)
- `RUSTY_LLM_BODY_TIMEOUT_MS=600000` (resets per response chunk)

These apply to **all** outbound `fetch` calls (LLM routes + GitHub/GitLab/ADO APIs). Raising the timeout never harms a fast request — it only delays the failure mode for slow ones.

If you keep seeing headers-timeout failures on a specific consensus pass, bump `RUSTY_LLM_HEADERS_TIMEOUT_MS` to `900000` or `1200000`. If the failure persists past 15 minutes, the upstream model is genuinely stuck (not slow) — the right fix is to drop that model from `RUSTY_REVIEW_MODELS` rather than extend the timeout further.

### Diagnostic Logging

Two opt-in flags surface internal state for debugging slow consensus runs and tuning ensemble behavior. Both default off so production cost is zero.

**`RUSTY_LOG_AGENT_STEPS=true`** — one log line per agent step inside every `runReview` call:

```jsonc
{ "stepNumber": 0, "finishReason": "tool-calls", "toolCallCount": 3, "totalTokens": 12450, ... }
{ "stepNumber": 1, "finishReason": "tool-calls", "toolCallCount": 1, "totalTokens": 8200, ... }
{ "stepNumber": 2, "finishReason": "stop", "toolCallCount": 0, "totalTokens": 6100, ... }
```

Useful when a pass takes minutes and you can't tell whether the model is making forward progress (decreasing tool calls, reasonable token counts per step) or spinning in a tool-call loop (constant or growing tool calls, no `"stop"` ever). Particularly diagnostic for the `finishReason: "tool-calls"` failure mode where a tool-happy model burns its step budget without emitting a final answer — the per-step trace tells you whether `RUSTY_LLM_MAX_STEPS` saved the day or got hit.

**`RUSTY_LOG_RAW_FINDINGS=true`** — emits each consensus pass's findings list **before clustering**, at debug level:

```jsonc
{ "passIndex": 0, "model": "ollama/deepseek-v4-pro:cloud", "findingCount": 4, "findings": [ ... ], ... }
{ "passIndex": 1, "model": "requesty/xai/grok-4.3", "findingCount": 6, "findings": [ ... ], ... }
{ "passIndex": 2, "model": "ollama/kimi-k2.6:cloud", "findingCount": 3, "findings": [ ... ], ... }
```

Lets you tell whether the models are actually disagreeing (different findings → clustering's job is hard, threshold may be too strict) vs. saying the same thing in different words (overlap exists but Jaccard threshold may be missing it). Prerequisite for tuning `cluster.ts` — see `CONSENSUS-QUALITY-WRITEUP.md` for proposed experiments.

The pino logger has to be at `debug` level for this one — set `LOG_LEVEL=debug` alongside the flag if you're not seeing the output.

### OpenGrep Pre-scan

Rusty Bot can run [OpenGrep](https://opengrep.dev/) (LGPL-2.1 fork of Semgrep) on changed files before the LLM review. OpenGrep findings are fed to the LLM as structured context so the model can **confirm** true positives (emitting them as findings) or **dismiss** false positives (explaining why in the summary). This combines deterministic SAST coverage with LLM-powered triage — catching patterns LLMs inconsistently detect (hardcoded secrets, SQL injection, XSS) while filtering out false positive noise.

**Requirements:** `opengrep` must be available in `PATH`. The Docker image includes it by default. If it's not installed, the review continues LLM-only with a logged notice — no action required.

**Installation (outside Docker):**

```bash
curl -fsSL https://raw.githubusercontent.com/opengrep/opengrep/main/install.sh | bash
```

**Configuration:**

```bash
# use curated ruleset (default)
RUSTY_OPENGREP_RULES=auto

# use a custom config file from the repo
RUSTY_OPENGREP_RULES=.semgrep.yml

# use a specific registry ruleset
RUSTY_OPENGREP_RULES=p/security-audit
```

**How it works:**

1. Changed file paths (excluding binaries) are written to a temp file
2. `opengrep scan --config <rules> --json --quiet --target-list <file>` runs with a 2-minute timeout
3. JSON output is parsed into structured findings (rule ID, file, line range, message, severity, snippet)
4. Findings are injected into the LLM user prompt before the diff, with instructions to confirm or dismiss each one
5. When the diff is split into token-aware chunks, OpenGrep findings are filtered to only files in each chunk
6. The summary comment shows OpenGrep stats (finding count, availability, errors)

**Summary comment:** When OpenGrep runs, the PR comment includes a line like:

> **OpenGrep pre-scan:** 5 finding(s) fed to LLM for triage

**Cost:** OpenGrep runs locally in seconds with zero LLM cost. The only added token cost is the findings injected into the prompt (~50–200 tokens per finding).

### Consensus Voting

By default, each review runs 3 independent passes with shuffled diff ordering (file and hunk order randomized per pass). Findings are clustered across passes using file match, line proximity (±5 lines), and message similarity (Jaccard ≥ 0.3). Only findings that appear in a majority of passes survive — the rest are dropped as likely false positives.

Configure via per-repo config:

```json
{
  "consensusPasses": 5,
  "consensusThreshold": 3
}
```

| Setting | Description | Default |
|---------|-------------|---------|
| `consensusPasses` | Number of independent review passes (1 = disabled) | `3` |
| `consensusThreshold` | Minimum votes to keep a finding (`null` = simple majority) | `ceil(passes/2)` |

**How it works:**

1. The diff is shuffled N times (seeded PRNG for reproducibility) to produce N different orderings
2. Each ordering is reviewed independently in parallel
3. Findings from all passes are clustered by file + line proximity + message similarity
4. Clusters with votes below the threshold are dropped
5. Surviving findings include a `voteCount` showing how many passes flagged them

**Pass-level fault tolerance:**

Consensus uses `Promise.allSettled` rather than `Promise.all`, so a single flaky pass no longer fails the whole review:

- Each pass retries once on `STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED` (common with models that have inconsistent structured-output support, e.g. Kimi K2 via aggregators). Other errors are not retried.
- If at least `consensusThreshold` passes succeed, consensus is formed from the surviving passes and `consensusMetadata.failedPasses` records how many threw.
- If fewer than `consensusThreshold` passes succeed, the review throws an `AggregateError` containing every pass failure.

**Cost:** With the default 3 passes, LLM cost per review triples. Combine with the judge pass (using a cheaper model) to offset costs.

Set `consensusPasses` to `1` to disable consensus voting and get the original single-pass behavior with zero overhead.



### Cascading Review (Triage)

By default every file gets the same deep review treatment. When cascading is enabled, a cheap triage model first classifies each file as `skip`, `skim`, or `deep-review`. Each tier then gets an appropriate level of scrutiny:

| Tier | What happens |
|------|-------------|
| **skip** | File is excluded entirely (lock files, auto-generated code, vendored deps) |
| **skim** | Lightweight single-pass review — diff-only context, no tools, reduced output schema (no ticket compliance, no missing-tests list). The system prompt is tier-aware, so a skim pass is never told about tools it doesn't have or fields its schema can't hold. |
| **deep-review** | Full review pipeline — tree-sitter context expansion, code search tools, consensus voting, ticket compliance |

**Tier failures degrade instead of aborting.** A tier runs on a single model (skim always; deep when consensus is off), so a dead upstream there used to take the whole action down. Now:

- If the **skim** tier fails, its files are promoted into the deep-review tier rather than dropped. Deep review runs consensus, so it survives a bad seat — at deep-review cost for those files.
- If the **deep-review** tier fails, the surviving skim results are still posted and the summary names how many files went unreviewed.
- If every tier with files fails, the run throws. It never reports "No files required review after triage", which would read as an all-clear.

A response with no text, no tool calls and *no token usage at all* is treated as a dead upstream rather than a parse failure, so the pass fails immediately instead of paying for a full retry trajectory. The raw provider body is logged once on that path.

Enable by setting a triage model:

```bash
RUSTY_LLM_TRIAGE_MODEL=anthropic/claude-3-5-haiku-20241022
```

Or toggle explicitly:

```bash
RUSTY_CASCADE_ENABLED=true   # force on (requires RUSTY_LLM_TRIAGE_MODEL)
RUSTY_CASCADE_ENABLED=false  # force off even if triage model is set
```

**How it works:**

1. The triage agent receives a truncated version of each file's diff (≤200 tokens per file, 30k token budget total) and classifies it
2. Files that overflow the triage budget default to `deep-review`
3. Files the triage model misses also default to `deep-review`
4. Safety net: if triage classifies *all* files as `skip`, the top 20% by additions are force-promoted to `deep-review`
5. Skim-tier and deep-tier files are reviewed in parallel via `runCascadeReview`
6. Results from both tiers are merged, then passed through the judge (if enabled)
7. If triage fails entirely, the bot falls back to the standard full-review pipeline

**Summary comment:** When cascading is active, the PR comment includes a collapsible **Triage Summary** showing how many files were skipped, skimmed, and deep-reviewed, plus the triage model and token usage.

**Dashboard:** The reviews table shows a triage column with the breakdown (e.g. `3s / 5k / 8d` for 3 skipped, 5 skimmed, 8 deep-reviewed).

**Cost:** The triage call itself is cheap (truncated diffs, small output schema). The savings come from skipping context expansion and tool calls for skim-tier files. For a typical PR where ~40% of files are config/docs/tests, expect roughly 30–50% token reduction on the review calls.

### PR Description Generation

When a PR has an empty or placeholder description, Rusty Bot can generate a structured one from the diff before starting the review. This helps reviewers understand the PR at a glance and also gives the review agent better context (the generated description is visible to the reviewer in the same run).

Off by default. Enable via:

```bash
RUSTY_GENERATE_DESCRIPTION=true
```

Or per-repo in the dashboard (PR Description checkbox).

**How it works:**

1. Before the review starts, the bot checks the current PR description
2. If the description is empty, whitespace-only, a short placeholder (e.g. "TODO", "WIP"), or a previously bot-generated description, it proceeds
3. A dedicated agent produces a structured description: summary, per-file change table, breaking changes, and migration notes (sections are omitted when not applicable)
4. The description is updated on the PR via the platform API
5. The review then runs with the generated description visible in the PR metadata

**Safety:** The bot never overwrites a human-written description. The detection is conservative — any description with meaningful prose, issue references, or structured content is left untouched. Bot-generated descriptions (identified by an HTML marker) can be regenerated on subsequent runs.

### Conventional Commit Title Rewriting

When a PR title does not already follow the [Conventional Commits](https://www.conventionalcommits.org/) spec (e.g. `feat: add login`, `fix(auth): handle expired tokens`), Rusty Bot can rewrite it into one before the review starts. Useful when squash-merging into a repo that derives changelog/release notes from PR titles.

Off by default. Enable via:

```bash
RUSTY_RENAME_TITLE_TO_CONVENTIONAL=true
```

**How it works:**

1. Before the review starts, the bot inspects the current PR title
2. If the title already matches the Conventional Commits regex (`type(scope)?!?: subject`), it is left untouched
3. Otherwise, a dedicated agent picks a `type` (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`), an optional `scope`, a cleaned subject line, and a breaking-change flag based on the diff and metadata
4. The new title is written back to the PR via the platform API and used for the rest of the run

**Safety:** Already-conventional titles are never modified. The agent reuses wording from the original title and only adjusts the prefix, scope, and casing. The rewrite is wrapped in a try/catch — failures are logged and the review continues with the original title.

### Tree-sitter Context Expansion

By default, when the LLM reviews a diff hunk, the surrounding context is expanded to the enclosing function, method, or class boundary using [tree-sitter](https://tree-sitter.github.io/tree-sitter/) AST parsing. This means the model sees complete semantic units — full functions instead of fragments cut mid-logic — which improves review accuracy and eliminates wasted tokens on unrelated adjacent code.

**Supported languages:** TypeScript, TSX, JavaScript, Python, Go, Java, Rust

**How it works:**

1. Each changed file is parsed with a WASM-based tree-sitter grammar (no native compilation needed)
2. For each changed line range, the smallest enclosing scope (function, method, class) is found in the AST
3. The hunk expands to include the full enclosing scope
4. Collapsed signatures of sibling functions/methods are prepended for orientation (e.g. `// ... export function otherFn()`)
5. If the enclosing scope exceeds 200 lines, or if the language is unsupported, it falls back to the previous ±10 fixed-line expansion

The feature is automatic and requires no configuration. Unsupported languages (CSS, JSON, YAML, etc.) gracefully fall back to fixed-line expansion with zero overhead.

### Ticket Integration

Rusty Bot discovers linked tickets through three mechanisms:

**1. Regex extraction** — scans PR descriptions and branch names for ticket patterns:

- **GitHub Issues**: `#123`, `owner/repo#123`, full URL
- **GitLab Issues**: `https://gitlab.example.com/group/project/-/issues/123` (in GitLab CI mode, bare `#123` is treated as a GitLab issue)
- **Jira**: `PROJ-123`, Jira browse URL
- **Linear**: Linear issue URL
- **Azure DevOps**: `AB#123`, ADO work item URL
- **Branch names**: `feature/123-desc`, `fix/PROJ-123-title`

**2. GitHub linked issues** — queries the `closingIssuesReferences` GraphQL field to find issues linked via closing keywords (`Closes #123`, `Fixes #456`) or the PR Development sidebar.

**3. Azure DevOps linked work items** — calls the PR work items API endpoint to find work items formally linked through the ADO UI, even when they aren't mentioned in the description or branch name.

**4. GitLab linked closing issues** — calls the MR `closes_issues` API endpoint to find issues closed by the MR via closing keywords (`Closes #123`, `Fixes group/project#456`).

All sources are merged and deduplicated before resolution. When tickets are found and the corresponding provider is configured, the review summary includes a compliance assessment.

## Development

```bash
# install
pnpm install

# build all packages
pnpm -r build

# run tests

pnpm test

# start dev server
pnpm --filter @rusty-bot/github start

# start dashboard dev server (with hot reload)
pnpm --filter @rusty-bot/dashboard dev
```

## Claude Code skills

This repo publishes agent skills under `skills/`. They're indexed by [skills.sh](https://skills.sh) and installable with the `skills` CLI:

```bash
# install every skill in this repo
npx skills add jegork/rusty-bot

# or just one
npx skills add jegork/rusty-bot/pr-comment-monitor
```

Available skills:

- **pr-comment-monitor** — detects the remote git provider (GitHub / Azure DevOps / GitLab / Bitbucket), finds the current branch's open PR, handles each new review comment (code edit + push, or reply) and resolves the thread. Runs as a one-shot sweep, as an iterative live-watch loop, or on a schedule via the built-in `loop` skill.

## License

MIT
