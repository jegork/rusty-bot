import { ReviewStyleSchema, type FocusArea, type ReviewStyle } from "@rusty-bot/core";

const ALL_FOCUS_AREAS: FocusArea[] = ["security", "performance", "bugs", "style", "tests", "docs"];

export type OutputFormat = "markdown" | "json";

export interface CliArgs {
  repoPath: string;
  baseRef: string;
  headRef: string;
  style: ReviewStyle;
  focusAreas: FocusArea[];
  ignorePatterns: string[];
  format: OutputFormat;
  failOnCritical: boolean;
  flagScopeCreep: boolean;
  help: boolean;
}

export const HELP_TEXT = `Usage: rusty-bot [options]

Run a rusty-bot code review against a local git diff and print the result.

Options:
  --repo <path>          path to the git repo (default: cwd)
  --base <ref>           base ref to diff against (default: main)
  --head <ref>           head ref to review (default: HEAD)
  --style <style>        review style: strict | balanced | lenient | roast | thorough
                         (default: balanced)
  --focus <list>         comma-separated focus areas: ${ALL_FOCUS_AREAS.join(",")}
                         (default: all)
  --ignore <list>        comma-separated glob patterns to exclude
  --format <fmt>         output format: markdown | json (default: markdown)
  --fail-on-critical     exit non-zero when critical findings are present
  -h, --help             show this help

Flags accept --flag value or --flag=value form.

Environment (overridden by flags when both are set):
  RUSTY_REVIEW_STYLE     default for --style
  RUSTY_FOCUS_AREAS      default for --focus
  RUSTY_FLAG_SCOPE_CREEP set to "true" to list out-of-scope changes in the review
  RUSTY_IGNORE_PATTERNS  default for --ignore
  RUSTY_FAIL_ON_CRITICAL set to "true" to enable --fail-on-critical
  RUSTY_LLM_MODEL        e.g. anthropic/claude-sonnet-4-20250514
  ANTHROPIC_API_KEY      (or the matching key for the chosen provider)
`;

function takeValue(name: string, argv: string[], i: number): string {
  if (i + 1 >= argv.length) {
    throw new Error(`option ${name} requires a value`);
  }
  const next = argv[i + 1];
  // a leading dash is almost always the next flag, not a value — reject so the
  // user gets a clear error instead of silently consuming the next flag's name.
  if (next.startsWith("-")) {
    throw new Error(`option ${name} requires a value`);
  }
  return next;
}

function parseFocusList(raw: string, source: string): FocusArea[] {
  const requested = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    throw new Error(`${source} requires at least one focus area`);
  }
  const valid = requested.filter((a): a is FocusArea => (ALL_FOCUS_AREAS as string[]).includes(a));
  const invalid = requested.filter((a) => !valid.includes(a as FocusArea));
  if (invalid.length > 0) {
    throw new Error(
      `unknown focus area(s) in ${source}: ${invalid.join(", ")}. allowed: ${ALL_FOCUS_AREAS.join(", ")}`,
    );
  }
  return valid;
}

function parseIgnoreList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// expand `--flag=value` into `--flag value` so the loop below can treat them uniformly.
// short flags (`-h`) are not split — only the long-form `=` syntax.
function expandEqSyntax(argv: string[]): string[] {
  const out: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        out.push(arg.slice(0, eq), arg.slice(eq + 1));
        continue;
      }
    }
    out.push(arg);
  }
  return out;
}

function applyEnvDefaults(args: CliArgs, env: NodeJS.ProcessEnv): void {
  const style = env.RUSTY_REVIEW_STYLE;
  if (style) {
    const parsed = ReviewStyleSchema.safeParse(style);
    if (!parsed.success) {
      throw new Error(`invalid RUSTY_REVIEW_STYLE: ${style}`);
    }
    args.style = parsed.data;
  }

  const focus = env.RUSTY_FOCUS_AREAS;
  if (focus) {
    args.focusAreas = parseFocusList(focus, "RUSTY_FOCUS_AREAS");
  }

  const ignore = env.RUSTY_IGNORE_PATTERNS;
  if (ignore) {
    args.ignorePatterns = parseIgnoreList(ignore);
  }

  if (env.RUSTY_FAIL_ON_CRITICAL === "true") {
    args.failOnCritical = true;
  }

  if (env.RUSTY_FLAG_SCOPE_CREEP === "true") {
    args.flagScopeCreep = true;
  }
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const args: CliArgs = {
    repoPath: process.cwd(),
    baseRef: "main",
    headRef: "HEAD",
    style: "balanced",
    focusAreas: ALL_FOCUS_AREAS,
    ignorePatterns: [],
    format: "markdown",
    failOnCritical: false,
    flagScopeCreep: false,
    help: false,
  };

  applyEnvDefaults(args, env);

  const expanded = expandEqSyntax(argv);

  for (let i = 0; i < expanded.length; i++) {
    const arg = expanded[i];
    switch (arg) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--repo":
        args.repoPath = takeValue(arg, expanded, i++);
        break;
      case "--base":
        args.baseRef = takeValue(arg, expanded, i++);
        break;
      case "--head":
        args.headRef = takeValue(arg, expanded, i++);
        break;
      case "--style": {
        const raw = takeValue(arg, expanded, i++);
        const parsed = ReviewStyleSchema.safeParse(raw);
        if (!parsed.success) {
          throw new Error(`invalid review style: ${raw}`);
        }
        args.style = parsed.data;
        break;
      }
      case "--focus": {
        const raw = takeValue(arg, expanded, i++);
        args.focusAreas = parseFocusList(raw, "--focus");
        break;
      }
      case "--ignore": {
        const raw = takeValue(arg, expanded, i++);
        args.ignorePatterns = parseIgnoreList(raw);
        break;
      }
      case "--format": {
        const raw = takeValue(arg, expanded, i++);
        if (raw !== "markdown" && raw !== "json") {
          throw new Error(`invalid format: ${raw} (expected markdown or json)`);
        }
        args.format = raw;
        break;
      }
      case "--fail-on-critical":
        args.failOnCritical = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  return args;
}
