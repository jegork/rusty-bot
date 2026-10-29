import { afterEach, describe, expect, it } from "vitest";
import {
  aggregate,
  parseRawFindings,
  summarizeRuns,
  sweepJaccard,
} from "../analysis/raw-findings.js";

const finding = (message: string) => ({
  file: "a.ts",
  line: 10,
  severity: "warning",
  category: "bugs",
  message,
});

const pass = (
  passIndex: number,
  model: string,
  messages: string[],
  over: Record<string, unknown> = {},
) =>
  JSON.stringify({
    kind: "pass",
    runId: "r1",
    prId: "7",
    passIndex,
    model,
    findingCount: messages.length,
    findings: messages.map(finding),
    ...over,
  });

const clusters = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    kind: "clusters",
    runId: "r1",
    prId: "7",
    passes: 2,
    effectiveThreshold: 2,
    agreementRate: 0.5,
    passModels: ["m-a", "m-b"],
    clusters: [
      { file: "a.ts", line: 10, voteCount: 2, surviving: true, passIndices: [0, 1], variants: [] },
      { file: "a.ts", line: 50, voteCount: 1, surviving: false, passIndices: [0], variants: [] },
      { file: "b.ts", line: 5, voteCount: 1, surviving: false, passIndices: [1], variants: [] },
    ],
    ...over,
  });

describe("parseRawFindings", () => {
  it("splits pass and cluster records and skips blank lines", () => {
    const parsed = parseRawFindings([pass(0, "m-a", ["x"]), "", "   ", clusters(), ""].join("\n"));
    expect(parsed.passRecords).toHaveLength(1);
    expect(parsed.clusterRecords).toHaveLength(1);
    expect(parsed.errors).toEqual([]);
  });

  it("reports malformed lines with their line number and keeps parsing", () => {
    const parsed = parseRawFindings(
      [pass(0, "m-a", ["x"]), "{not json", '{"kind":"other"}', "", clusters()].join("\n"),
    );
    expect(parsed.passRecords).toHaveLength(1);
    expect(parsed.clusterRecords).toHaveLength(1);
    expect(parsed.errors.map((e) => e.line)).toEqual([2, 3]);
  });
});

describe("summarizeRuns", () => {
  it("counts the vote histogram and attributes singletons to the contributing model", () => {
    const parsed = parseRawFindings(
      [pass(0, "m-a", ["x", "y"]), pass(1, "m-b", ["x", "z"]), clusters()].join("\n"),
    );
    const [run] = summarizeRuns(parsed);
    expect(run.runId).toBe("r1");
    expect(run.passes).toBe(2);
    expect(run.models).toEqual(["m-a", "m-b"]);
    expect(run.findingsPerModel).toEqual({ "m-a": 2, "m-b": 2 });
    expect(run.clusters).toBe(3);
    expect(run.surviving).toBe(1);
    expect(run.voteHistogram).toEqual({ 1: 2, 2: 1 });
    expect(run.agreementRate).toBe(0.5);
    expect(run.singletonsPerModel).toEqual({ "m-a": 1, "m-b": 1 });
  });

  it("attributes singletons by original slot when pass 0 failed", () => {
    const parsed = parseRawFindings(
      [
        pass(1, "m-b", ["x"]),
        pass(2, "m-c", ["y"]),
        clusters({
          passes: 3,
          passModels: ["m-a", "m-b", "m-c"],
          clusters: [
            {
              file: "a.ts",
              line: 1,
              voteCount: 1,
              surviving: false,
              passIndices: [2],
              variants: [],
            },
          ],
        }),
      ].join("\n"),
    );
    const [run] = summarizeRuns(parsed);
    expect(run.singletonsPerModel).toEqual({ "m-b": 0, "m-c": 1 });
  });

  it("groups records without runId by prId", () => {
    const legacy = (prId: string) => ({ runId: undefined, prId });
    const parsed = parseRawFindings(
      [
        pass(0, "m-a", ["x"], legacy("7")),
        pass(0, "m-a", ["y"], legacy("8")),
        clusters(legacy("7")),
      ].join("\n"),
    );
    const runs = summarizeRuns(parsed);
    expect(runs.map((r) => r.prId).sort()).toEqual(["7", "8"]);
    expect(runs.every((r) => r.runId === null)).toBe(true);
    expect(runs.find((r) => r.prId === "8")!.clusters).toBe(0);
  });

  it("returns singletonsPerModel null when passIndices are absent", () => {
    const legacy = clusters({
      agreementRate: undefined,
      passModels: undefined,
      clusters: [{ file: "a.ts", line: 1, voteCount: 1, surviving: false, variants: [] }],
    });
    const [run] = summarizeRuns(parseRawFindings([pass(0, "m-a", ["x"]), legacy].join("\n")));
    expect(run.singletonsPerModel).toBeNull();
    expect(run.agreementRate).toBeNull();
    expect(run.voteHistogram).toEqual({ 1: 1 });
  });
});

describe("aggregate", () => {
  it("averages agreement over non-null runs and reports how many were null", () => {
    const text = [
      pass(0, "m-a", ["x"]),
      clusters({ agreementRate: 0.5 }),
      pass(0, "m-a", ["x"], { runId: "r2" }),
      clusters({ runId: "r2", agreementRate: 1 }),
      pass(0, "m-a", ["x"], { runId: "r3" }),
      clusters({ runId: "r3", agreementRate: null }),
    ].join("\n");
    const agg = aggregate(summarizeRuns(parseRawFindings(text)));
    expect(agg.runs).toBe(3);
    expect(agg.meanAgreementRate).toBe(0.75);
    expect(agg.nullAgreementRuns).toBe(1);
    expect(agg.findingsPerModel).toEqual({ "m-a": 3 });
    expect(agg.voteHistogram).toEqual({ 1: 6, 2: 3 });
  });

  it("gives a null mean when every run has null agreement", () => {
    const agg = aggregate(summarizeRuns(parseRawFindings(clusters({ agreementRate: null }))));
    expect(agg.meanAgreementRate).toBeNull();
    expect(agg.nullAgreementRuns).toBe(1);
  });
});

describe("sweepJaccard", () => {
  const saved = {
    RUSTY_CLUSTER_JACCARD: process.env.RUSTY_CLUSTER_JACCARD,
    RUSTY_CLUSTER_CATEGORY_JACCARD: process.env.RUSTY_CLUSTER_CATEGORY_JACCARD,
  };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  // jaccard of the two messages is 2/9, so they cluster at 0.2 but not at 0.5
  const text = [
    pass(0, "m-a", ["null pointer dereference in handler"]),
    pass(1, "m-b", ["null pointer when parsing request body"]),
    clusters({ clusters: [] }),
  ].join("\n");

  it("re-clusters per threshold so cluster counts differ", () => {
    const rows = sweepJaccard(parseRawFindings(text), [0.2, 0.5]);
    expect(rows.map((r) => r.threshold)).toEqual([0.2, 0.5]);
    expect(rows[0].clusters).toBe(1);
    expect(rows[0].surviving).toBe(1);
    expect(rows[0].meanAgreement).toBe(1);
    expect(rows[1].clusters).toBe(2);
    expect(rows[1].surviving).toBe(0);
    expect(rows[1].meanAgreement).toBe(0);
  });

  it("restores env vars afterwards, including when unset", () => {
    delete process.env.RUSTY_CLUSTER_JACCARD;
    process.env.RUSTY_CLUSTER_CATEGORY_JACCARD = "0.4";
    sweepJaccard(parseRawFindings(text), [0.2]);
    expect(process.env.RUSTY_CLUSTER_JACCARD).toBeUndefined();
    expect(process.env.RUSTY_CLUSTER_CATEGORY_JACCARD).toBe("0.4");
  });

  it("restores env vars when clustering throws", () => {
    process.env.RUSTY_CLUSTER_JACCARD = "0.7";
    delete process.env.RUSTY_CLUSTER_CATEGORY_JACCARD;
    const bad = [
      JSON.stringify({
        kind: "pass",
        runId: "r1",
        prId: "7",
        passIndex: 0,
        model: "m",
        findingCount: 1,
        findings: [{ file: "a.ts", line: 1, severity: "warning", category: "bugs" }],
      }),
      clusters({ clusters: [] }),
    ].join("\n");
    expect(() => sweepJaccard(parseRawFindings(bad), [0.2])).toThrow();
    expect(process.env.RUSTY_CLUSTER_JACCARD).toBe("0.7");
    expect(process.env.RUSTY_CLUSTER_CATEGORY_JACCARD).toBeUndefined();
  });
});
