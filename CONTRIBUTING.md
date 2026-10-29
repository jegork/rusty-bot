# Contributing

## Development setup

```bash
pnpm install
pnpm -r build
cp .env.example .env
# set at least one LLM API key in .env
pnpm --filter @rusty-bot/github start
```

Tests:

```bash
pnpm test
```

## Project structure

```
packages/
├── core/           # shared review engine (agent, diff, triage, tickets, opengrep)
├── github/         # GitHub provider library
├── github-action/  # one-shot CLI for GitHub Actions
└── azure-devops/   # Azure Pipelines container entrypoint
docs/               # Astro Starlight documentation site
```

## Pull requests

- Open an issue first for anything beyond a small bug fix — alignment before implementation saves time.
- Keep PRs focused; one logical change per PR.
- Add or update tests for changed behaviour.
- The pre-commit hook runs `lint-staged` (ESLint + Prettier) and the full test suite. Fix failures before pushing.
- PR titles should follow conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `perf:`.

## Reporting security issues

See [SECURITY.md](SECURITY.md).
