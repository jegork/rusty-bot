---
title: GitHub Action
description: Run Rusty Bot as a drop-in GitHub Action — no hosting required.
---

The GitHub Action is the easiest way to get started. Reviews run on GitHub-hosted runners — no server to provision or maintain.

## Minimal workflow

Create `.github/workflows/rusty-bot-review.yml`:

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
      - uses: actions/checkout@v4
      - uses: jegork/rusty-bot@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
        env:
          RUSTY_LLM_MODEL: anthropic/claude-sonnet-4-20250514
          RUSTY_REVIEW_STYLE: balanced
          RUSTY_FOCUS_AREAS: security,bugs,performance
          RUSTY_FAIL_ON_CRITICAL: "true"
```

The `actions/checkout` step gives the reviewer read-only search over the PR's code; without it the agent falls back to the GitHub code-search API, which only sees the default branch. The default `fetch-depth: 1` is enough — the Action fetches the PR head commit itself with the same `GITHUB_TOKEN`.

The [Getting started](/rusty-bot/getting-started/) page has the bare minimum to get running. This page is the complete reference.

## Required permissions

Set these on the job (not the whole workflow):

| Permission | Reason |
| --- | --- |
| `pull-requests: write` | Post the summary comment and inline review findings |
| `issues: read` | Read linked issues for ticket compliance checks |
| `contents: read` | Read the diff and fetch the convention file from the target branch |

## Inputs reference

Secret-bearing inputs only — everything else flows through `env:`. See [Environment variables](/reference/env-vars/) for non-secret config.

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `github-token` | No | `${{ github.token }}` | GitHub token; the built-in token works when the `permissions:` block above is set |
| `anthropic-api-key` | Conditional | — | Required when `RUSTY_LLM_MODEL` targets an `anthropic/*` model |
| `openai-api-key` | Conditional | — | Required when `RUSTY_LLM_MODEL` targets an `openai/*` model |
| `google-api-key` | Conditional | — | Required when `RUSTY_LLM_MODEL` targets a `google/*` model |
| `azure-openai-api-key` | Conditional | — | Required when `RUSTY_LLM_MODEL` targets an `azure-openai/*` model |
| `llm-api-key` | Conditional | — | API key for an OpenAI-compatible endpoint (set together with `RUSTY_LLM_BASE_URL`) |
| `jira-api-token` | No | — | Enable Jira ticket compliance; combine with `RUSTY_JIRA_BASE_URL` + `RUSTY_JIRA_EMAIL` |
| `linear-api-key` | No | — | Enable Linear ticket compliance |

## Pinning

| Pin | Behaviour |
| --- | --- |
| `@v1` | Floats to the latest `1.x.x` release. **Recommended.** |
| `@v1.2.3` | Pinned to an exact release. |
| `@main` | Tracks `main`. Use only for development. |

## Skipped events

The Action exits early (no error, no review) for these PR event types:

- `closed`, `labeled`, `unlabeled`, `assigned`, `unassigned`
- Draft PRs — unless `RUSTY_REVIEW_DRAFTS=true` is set in `env:`

## Incremental review

On `synchronize` events (every push after the first review), the Action only reviews the diff between the previously-reviewed commit and the new HEAD instead of re-reviewing the full PR diff. This typically cuts token usage by 60–80% on multi-commit PRs.

How it works:

- After each successful review, the Action embeds the reviewed commit sha in a hidden HTML marker inside the summary comment (`<!-- rusty-bot:last-sha:abc... -->`).
- On the next push the Action reads that marker, fetches `git compare {last-sha}...{new-head}` from GitHub, and runs the review against only that delta.
- If the marker is missing (first run) or the previous sha is no longer reachable (force-push or rebase), the Action falls back to a full review.
- If the new HEAD is identical to the previously-reviewed sha, the run exits without re-posting anything.
- If the delta has no reviewable files (e.g. only ignored paths changed), the Action skips the LLM call and posts a one-line summary instead.

Enabled by default. To always review the full PR diff, set `RUSTY_INCREMENTAL_REVIEW=false`.

## Docker image

The Action runs inside `ghcr.io/jegork/rusty-bot:latest`, which includes OpenGrep. The first run in a fresh runner environment adds roughly 20–40s for the image pull; subsequent runs on cached runners skip this entirely.
