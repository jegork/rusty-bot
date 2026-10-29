import { readFile } from "node:fs/promises";
import {
  aggregate,
  parseRawFindings,
  summarizeRuns,
  sweepJaccard,
  type Aggregate,
  type SweepRow,
} from "@rusty-bot/core";

export const ANALYZE_HELP_TEXT = `Usage: rusty-bot analyze-findings <file...> [options]

Summarize consensus raw-findings ndjson files (RUSTY_LOG_RAW_FINDINGS_FILE).

Options:
  --sweep <list>   comma-separated jaccard thresholds in [0,1] to re-cluster at
  --json           print raw result objects instead of tables
  -h, --help       show this help
`;

interface AnalyzeArgs {
  files: string[];
  sweep: number[] | null;
  json: boolean;
  help: boolean;
}

function parseAnalyzeArgs(argv: string[]): AnalyzeArgs {
  const args: AnalyzeArgs = { files: [], sweep: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--sweep" || arg.startsWith("--sweep=")) {
      if (!arg.includes("=") && i + 1 >= argv.length) {
        throw new Error("option --sweep requires a value");
      }
      const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      const values = raw.split(",").map((s) => s.trim());
      const nums = values.map((s) => (s === "" ? NaN : Number(s)));
      if (nums.length === 0 || nums.some((n) => !Number.isFinite(n) || n < 0 || n > 1)) {
        throw new Error(`invalid --sweep value: ${raw} (expected numbers between 0 and 1)`);
      }
      args.sweep = nums;
    } else if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
    else args.files.push(arg);
  }
  if (!args.help && args.files.length === 0) throw new Error("analyze-findings requires a file");
  return args;
}

const fmt = (n: number | null): string => (n === null ? "n/a" : n.toFixed(3));

function table(header: string[], rows: string[][]): string {
  const all = [header, ...rows];
  const widths = header.map((_, c) => Math.max(...all.map((r) => r[c].length)));
  return all
    .map((r) =>
      r
        .map((cell, c) => cell.padEnd(widths[c]))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

function renderAggregate(agg: Aggregate): string {
  const lines = [
    `runs: ${agg.runs}`,
    `mean agreement: ${fmt(agg.meanAgreementRate)} (${agg.nullAgreementRuns} run(s) without a rate)`,
    "",
  ];
  const models = Object.keys(agg.findingsPerModel);
  lines.push(
    table(
      ["model", "findings", "singletons"],
      models.map((m) => [
        m,
        String(agg.findingsPerModel[m]),
        String(agg.singletonsPerModel[m] ?? 0),
      ]),
    ),
  );
  if (agg.runsWithoutSingletonData > 0) {
    lines.push(
      `(${agg.runsWithoutSingletonData} run(s) lack cluster pass membership; excluded from singletons)`,
    );
  }
  lines.push("", "votes  clusters");
  const votes = Object.keys(agg.voteHistogram)
    .map(Number)
    .sort((a, b) => a - b);
  for (const v of votes) lines.push(`${String(v).padEnd(5)}  ${agg.voteHistogram[v]}`);
  return lines.join("\n");
}

function renderSweep(rows: SweepRow[]): string {
  return [
    "jaccard sweep",
    table(
      ["threshold", "runs", "clusters", "surviving", "mean agreement"],
      rows.map((r) => [
        String(r.threshold),
        String(r.runs),
        String(r.clusters),
        String(r.surviving),
        fmt(r.meanAgreement),
      ]),
    ),
  ].join("\n");
}

export async function runAnalyzeFindings(argv: string[]): Promise<number> {
  let args: AnalyzeArgs;
  try {
    args = parseAnalyzeArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${ANALYZE_HELP_TEXT}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(ANALYZE_HELP_TEXT);
    return 0;
  }

  const contents: string[] = [];
  for (const file of args.files) {
    try {
      contents.push(await readFile(file, "utf8"));
    } catch (err) {
      process.stderr.write(`could not read ${file}: ${(err as Error).message}\n`);
    }
  }
  if (contents.length === 0) return 1;

  const parsed = parseRawFindings(contents.map((c) => (c.endsWith("\n") ? c : c + "\n")).join(""));
  if (parsed.errors.length > 0) {
    process.stderr.write(`warning: skipped ${parsed.errors.length} malformed line(s)\n`);
  }

  const summaries = summarizeRuns(parsed);
  const agg = aggregate(summaries);
  const sweep = args.sweep ? sweepJaccard(parsed, args.sweep) : null;

  if (args.json) {
    process.stdout.write(
      JSON.stringify({ aggregate: agg, summaries, sweep, errors: parsed.errors }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(renderAggregate(agg) + "\n");
    if (sweep) process.stdout.write("\n" + renderSweep(sweep) + "\n");
  }
  return 0;
}
