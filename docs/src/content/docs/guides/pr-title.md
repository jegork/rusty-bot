---
title: PR title rewriting
description: Automatically rewrite non-conventional PR titles into Conventional Commits format before the review runs.
---

Off by default. When enabled, Rusty Bot rewrites the PR title into [Conventional Commits](https://www.conventionalcommits.org/) format (`type(scope)?!?: subject`) before the review runs — useful when squash-merging into a repo that derives changelog or release notes from PR titles.

## Enabling it

```bash
RUSTY_RENAME_TITLE_TO_CONVENTIONAL=true
```

## How it works

1. Before the review starts, the bot inspects the current PR title
2. If the title already matches the Conventional Commits regex (`type(scope)?!?: subject`), it is left untouched
3. Otherwise, a dedicated agent picks a `type` (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`), an optional `scope`, a cleaned subject line, and a breaking-change flag based on the diff and metadata
4. The new title is written back to the PR via the platform API and used for the rest of the run

## Length handling

PR titles are capped at 256 characters (the tighter of GitHub's 256 and Azure DevOps' 400 limits). When the generated title would exceed that, the bot:

1. Drops the scope (`feat(longscope): subject` → `feat: subject`)
2. If still too long, truncates the subject and appends an ellipsis, preserving the type prefix and any breaking-change marker

## Tuning

| Variable | Description |
| --- | --- |
| `RUSTY_TITLE_TEMPERATURE` | Temperature override for the title-rename agent (falls back to `RUSTY_LLM_TEMPERATURE`) |

## Safety

Already-conventional titles are never modified. The agent reuses wording from the original title and only adjusts the prefix, scope, and casing. The rewrite is wrapped in a try/catch — if the LLM call fails, the schema validation fails, or the formatted title fails the post-format sanity check, the failure is logged and the review continues with the original title.
