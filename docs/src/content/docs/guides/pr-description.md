---
title: PR description generation
description: Automatically generate a structured PR description from the diff when it's empty or a placeholder.
---

Off by default. When enabled, Rusty Bot generates a structured PR description before the review runs — so both human reviewers and the review agent see a clear summary of what changed.

## Enabling it

```bash
RUSTY_GENERATE_DESCRIPTION=true
```

## How it works

1. Before the review starts, the bot checks the current PR description
2. If the description is empty, whitespace-only, a short placeholder (e.g. "TODO", "WIP"), or a previously bot-generated description, it proceeds
3. A dedicated agent produces a structured description: summary, per-file change table, breaking changes, and migration notes (sections are omitted when not applicable)
4. The description is updated on the PR via the platform API
5. The review then runs with the generated description visible in the PR metadata

## Safety

The bot never overwrites a human-written description. The detection is conservative — any description with meaningful prose, issue references, or structured content is left untouched. Bot-generated descriptions are identified by an HTML marker, so they can be safely regenerated on subsequent runs.
