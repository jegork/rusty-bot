import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAnalyzeFindings } from "../analyze-findings.js";

const finding = (message: string) => ({
  file: "a.ts",
  line: 10,
  severity: "warning",
  category: "bugs",
  message,
});

const fixture = [
  {
    kind: "pass",
    runId: "r1",
    prId: "7",
    passIndex: 0,
    model: "m-a",
    findingCount: 1,
    findings: [finding("null pointer dereference in handler")],
  },
  {
    kind: "pass",
    runId: "r1",
    prId: "7",
    passIndex: 1,
    model: "m-b",
    findingCount: 1,
    findings: [finding("null pointer when parsing request body")],
  },
  {
    kind: "clusters",
    runId: "r1",
    prId: "7",
    passes: 2,
    effectiveThreshold: 2,
    agreementRate: 0.5,
    passModels: ["m-a", "m-b"],
    clusters: [
      { file: "a.ts", line: 10, voteCount: 1, surviving: false, passIndices: [0], variants: [] },
      { file: "a.ts", line: 10, voteCount: 1, surviving: false, passIndices: [1], variants: [] },
    ],
  },
]
  .map((r) => JSON.stringify(r))
  .join("\n");

describe("runAnalyzeFindings", () => {
  let dir: string;
  let out: string;
  let err: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "analyze-"));
    out = "";
    err = "";
    vi.spyOn(process.stdout, "write").mockImplementation((s) => ((out += String(s)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((s) => ((err += String(s)), true));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints the run count and mean agreement", async () => {
    const file = join(dir, "raw.ndjson");
    writeFileSync(file, fixture);
    const code = await runAnalyzeFindings([file]);
    expect(code).toBe(0);
    expect(out).toMatch(/runs\s*:?\s*1/i);
    expect(out).toContain("0.500");
    expect(out).toContain("m-a");
  });

  it("concatenates several files and warns about malformed lines without failing", async () => {
    const a = join(dir, "a.ndjson");
    const b = join(dir, "b.ndjson");
    writeFileSync(a, fixture);
    writeFileSync(b, "{broken\n" + fixture.replaceAll("r1", "r2"));
    const code = await runAnalyzeFindings([a, b]);
    expect(code).toBe(0);
    expect(out).toMatch(/runs\s*:?\s*2/i);
    expect(err).toMatch(/1 malformed line/);
  });

  it("prints parseable json with --json", async () => {
    const file = join(dir, "raw.ndjson");
    writeFileSync(file, fixture);
    const code = await runAnalyzeFindings([file, "--json", "--sweep", "0.2,0.5"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as {
      aggregate: { runs: number; meanAgreementRate: number };
      summaries: unknown[];
      sweep: { threshold: number; clusters: number }[];
    };
    expect(parsed.aggregate.runs).toBe(1);
    expect(parsed.aggregate.meanAgreementRate).toBe(0.5);
    expect(parsed.sweep.map((r) => r.threshold)).toEqual([0.2, 0.5]);
    expect(parsed.sweep.map((r) => r.clusters)).toEqual([1, 2]);
  });

  it("prints a sweep table with --sweep", async () => {
    const file = join(dir, "raw.ndjson");
    writeFileSync(file, fixture);
    await runAnalyzeFindings([file, "--sweep", "0.2,0.5"]);
    expect(out).toMatch(/sweep/i);
    expect(out).toContain("0.2");
    expect(out).toContain("0.5");
  });

  it("exits non-zero only when no file could be read", async () => {
    const good = join(dir, "raw.ndjson");
    writeFileSync(good, fixture);
    expect(await runAnalyzeFindings([join(dir, "missing.ndjson")])).toBe(1);
    expect(await runAnalyzeFindings([join(dir, "missing.ndjson"), good])).toBe(0);
    expect(err).toMatch(/missing\.ndjson/);
  });

  it("rejects missing files argument and bad sweep values with exit 2", async () => {
    expect(await runAnalyzeFindings([])).toBe(2);
    const file = join(dir, "raw.ndjson");
    writeFileSync(file, fixture);
    expect(await runAnalyzeFindings([file, "--sweep", "abc"])).toBe(2);
    expect(await runAnalyzeFindings([file, "--sweep", "1.5"])).toBe(2);
  });
});
