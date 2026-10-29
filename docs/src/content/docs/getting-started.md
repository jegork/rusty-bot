---
title: Getting started
description: Add Rusty Bot to your repo as a one-step GitHub Action.
---

The fastest way to try Rusty Bot is to drop the GitHub Action into your repo.

## 1. Add the workflow

Create `.github/workflows/rusty-bot-review.yml`:

```yaml
name: Rusty Bot review

on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  contents: read
  issues: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jegork/rusty-bot@v1
        env:
          RUSTY_LLM_MODEL: anthropic/claude-sonnet-4-20250514
          RUSTY_REVIEW_STYLE: balanced
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## 2. Add the API key

Under **Settings → Secrets and variables → Actions**, add `ANTHROPIC_API_KEY`
(or `OPENAI_API_KEY` / `GOOGLE_API_KEY`) — match the provider in
`RUSTY_LLM_MODEL`.

## 3. Open a PR

That's it. Rusty Bot will run on the next PR and post a structured review with
a summary comment plus inline findings on the diff.

## Pinning

| Pin | Behaviour |
| --- | --- |
| `@v1` | Floats to the latest `1.x.x` release. **Recommended.** |
| `@v1.2.3` | Pinned to an exact release. |
| `@main` | Tracks `main`. Use only for development. |

Pinning to a specific SHA is supported only for the action repo itself; the
underlying Docker image is published per release tag.

## Next steps

- [Full GitHub Action reference](/providers/github-action/) — every input and env var, skipped event types, and how to pin the Docker image
- [GitHub App (self-hosted)](/providers/github-app/) — run as a webhook server when you want one deployment to cover many repos
- [Azure DevOps](/providers/azure-devops/) — drop the same review into Azure Pipelines with PR threads instead of GitHub comments
- [LLM providers](/guides/llm-providers/) — swap to Azure OpenAI, an OpenAI-compatible endpoint, or any of 99+ providers via LiteLLM
- [Convention files](/guides/convention-files/) — teach the bot your house rules with a `REVIEW-BOT.md` checked into the repo
- [Gating merges](/guides/gating-merges/) — fail the check on critical findings so PRs can't merge until they're resolved
- [Tuning cost & noise](/guides/cascading-review/) — control how many files get the deep-review treatment vs. skipped outright
