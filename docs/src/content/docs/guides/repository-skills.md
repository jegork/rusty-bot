---
title: Repository skills
description: Keep area-specific review rules as skills the agent loads only when the diff touches that area.
---

A [convention file](/guides/convention-files/) is injected whole into every review. Skills let a repository keep detailed, area-specific rules ("how we write migrations", "our auth invariants") at no cost until they matter: the prompt lists only each skill's name and description, and the deep-review agent loads the full text with the `loadSkill` tool when the diff touches that area.

## Format

A skill is a folder containing `SKILL.md`, in the Agent Skills format Claude Code uses:

```markdown
---
name: database-migrations
description: Rules for SQL migrations — reversibility, locking, backfills. Use when the diff touches migrations/ or schema files.
---

# Migrations

...
```

- `name` — lowercase letters, digits and single hyphens, at most 64 characters.
- `description` — at most 1024 characters. The model sees it up front, so say when to use the skill.
- Other files in the folder are resources the body can reference by relative path; `loadSkill` reads them on request. Nothing in a skill is executed.

## Where skills live

By default the bot looks in `.rusty-bot/skills/<skill>/SKILL.md` and `.skills/<skill>/SKILL.md`, one level deep. Change the folders in `.rusty-bot.json`; setting `paths` replaces the defaults:

```json
{
  "skills": {
    "enabled": true,
    "paths": [".rusty-bot/skills", ".claude/skills"]
  }
}
```

Adding `.claude/skills` shares the skills a team already keeps for Claude Code. Paths must be repo-relative, without `..` or backslashes, and unknown keys fail the run like the rest of the file.

Skills are listed and read from the **target branch** through the platform API, never from the PR's checkout, so a pull request cannot rewrite the rules that review it.

## Limits

- At most 40 skills. When two folders define the same name, the first one wins and the other is skipped with a warning.
- Invalid skills (no frontmatter, invalid YAML, a bad name, a missing or over-long description, an empty body) are skipped with a warning; they never fail the run.
- The listing in the prompt is held to 3,000 tokens. If the full descriptions do not fit, every description is shortened to its first sentence and at most 200 characters; if that still does not fit, later skills are left out of the listing.
- Only the deep-review tier gets the listing and the `loadSkill` tool. Triage, the skim tier, the judge, and the title and description generators do not.
- Turn discovery off with `"skills": { "enabled": false }` or `RUSTY_SKILLS=false`.

## Platforms

- **GitHub** — works with the Action's `contents: read` permission.
- **Azure DevOps** — works with `System.AccessToken`.
- **GitLab** — needs `RUSTY_GITLAB_TOKEN`. GitLab does not let `CI_JOB_TOKEN` list repository folders, so with only a job token discovery is skipped and the log says why.
- **Local CLI** — reads `.rusty-bot.json` and skills from the `--base` ref. A malformed `.rusty-bot.json` fails the local run too.

## Checking it worked

Every review logs one `skills` event with `outcome`, `discovered`, `skipped` (path and reason), `truncated`, `listing` (`full`, `shortened` or `truncated`), `listingTokens` and `omittedFromListing`. With `RUSTY_LOG_AGENT_STEPS=true`, `loadSkill` in a step's `toolNames` shows the model loaded a skill.
