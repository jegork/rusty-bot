import type { Finding } from "../types.js";
import { clusterFindings } from "../agent/cluster.js";

export interface RawFindingEntry {
  file: string;
  line: number;
  severity: string;
  category: string;
  message: string;
}

export interface RawPassRecord {
  kind: "pass";
  runId?: string;
  prId: string | number;
  passIndex: number;
  model: string;
  findingCount: number;
  findings: RawFindingEntry[];
}

export interface RawClusterEntry {
  file: string;
  line: number;
  voteCount: number;
  surviving: boolean;
  passIndices?: number[];
  variants: unknown[];
}

export interface RawClustersRecord {
  kind: "clusters";
  runId?: string;
  prId: string | number;
  passes: number;
  effectiveThreshold: number;
  agreementRate?: number | null;
  passModels?: string[];
  clusters: RawClusterEntry[];
}

export interface ParsedRawFindings {
  passRecords: RawPassRecord[];
  clusterRecords: RawClustersRecord[];
  errors: { line: number; message: string }[];
}

export interface RunSummary {
  runId: string | null;
  prId: string;
  passes: number;
  models: string[];
  findingsPerModel: Record<string, number>;
  clusters: number;
  surviving: number;
  voteHistogram: Record<number, number>;
  agreementRate: number | null;
  singletonsPerModel: Record<string, number> | null;
}

export interface Aggregate {
  runs: number;
  meanAgreementRate: number | null;
  nullAgreementRuns: number;
  findingsPerModel: Record<string, number>;
  singletonsPerModel: Record<string, number>;
  runsWithoutSingletonData: number;
  voteHistogram: Record<number, number>;
}

export interface SweepRow {
  threshold: number;
  runs: number;
  clusters: number;
  surviving: number;
  meanAgreement: number | null;
}

export function parseRawFindings(ndjson: string): ParsedRawFindings {
  const parsed: ParsedRawFindings = { passRecords: [], clusterRecords: [], errors: [] };
  ndjson.split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    const line = i + 1;
    let record: unknown;
    try {
      record = JSON.parse(raw);
    } catch (err) {
      parsed.errors.push({ line, message: (err as Error).message });
      return;
    }
    const kind = (record as { kind?: unknown } | null)?.kind;
    if (kind === "pass") parsed.passRecords.push(record as RawPassRecord);
    else if (kind === "clusters") parsed.clusterRecords.push(record as RawClustersRecord);
    else parsed.errors.push({ line, message: "not a pass or clusters record" });
  });
  return parsed;
}

function add(target: Record<string | number, number>, key: string | number, n: number): void {
  target[key] = (target[key] ?? 0) + n;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

export function summarizeRuns(parsed: ParsedRawFindings): RunSummary[] {
  interface Group {
    runId: string | null;
    prId: string;
    passes: RawPassRecord[];
    clusters: RawClustersRecord[];
  }
  const groups = new Map<string, Group>();
  const groupFor = (r: { runId?: string; prId: string | number }): Group => {
    const key = r.runId ? `run:${r.runId}` : `pr:${r.prId}`;
    let g = groups.get(key);
    if (!g) {
      g = { runId: r.runId ?? null, prId: String(r.prId), passes: [], clusters: [] };
      groups.set(key, g);
    }
    return g;
  };
  for (const r of parsed.passRecords) groupFor(r).passes.push(r);
  for (const r of parsed.clusterRecords) groupFor(r).clusters.push(r);

  return [...groups.values()].map((g) => {
    const modelBySlot = new Map<number, string>();
    for (const c of g.clusters) c.passModels?.forEach((m, slot) => modelBySlot.set(slot, m));
    for (const p of g.passes) modelBySlot.set(p.passIndex, p.model);

    const models = [...new Set(g.passes.map((p) => p.model))];
    const findingsPerModel: Record<string, number> = {};
    for (const p of g.passes) add(findingsPerModel, p.model, p.findingCount);

    const entries = g.clusters.flatMap((c) => c.clusters);
    const voteHistogram: Record<number, number> = {};
    for (const c of entries) add(voteHistogram, c.voteCount, 1);

    const hasMembership =
      g.clusters.length > 0 && entries.every((c) => Array.isArray(c.passIndices));
    let singletonsPerModel: Record<string, number> | null = null;
    if (hasMembership) {
      singletonsPerModel = Object.fromEntries(models.map((m) => [m, 0]));
      for (const c of entries) {
        const ids = c.passIndices;
        if (ids?.length !== 1) continue;
        const model = modelBySlot.get(ids[0]);
        if (model !== undefined) add(singletonsPerModel, model, 1);
      }
    }

    const rates = g.clusters
      .map((c) => c.agreementRate)
      .filter((r): r is number => typeof r === "number");

    return {
      runId: g.runId,
      prId: g.prId,
      passes: Math.max(g.passes.length, ...g.clusters.map((c) => c.passes)),
      models,
      findingsPerModel,
      clusters: entries.length,
      surviving: entries.filter((c) => c.surviving).length,
      voteHistogram,
      agreementRate: mean(rates),
      singletonsPerModel,
    };
  });
}

export function aggregate(summaries: RunSummary[]): Aggregate {
  const agg: Aggregate = {
    runs: summaries.length,
    meanAgreementRate: null,
    nullAgreementRuns: 0,
    findingsPerModel: {},
    singletonsPerModel: {},
    runsWithoutSingletonData: 0,
    voteHistogram: {},
  };
  const rates: number[] = [];
  for (const s of summaries) {
    if (s.agreementRate === null) agg.nullAgreementRuns++;
    else rates.push(s.agreementRate);
    for (const [m, n] of Object.entries(s.findingsPerModel)) add(agg.findingsPerModel, m, n);
    if (s.singletonsPerModel === null) agg.runsWithoutSingletonData++;
    else
      for (const [m, n] of Object.entries(s.singletonsPerModel)) add(agg.singletonsPerModel, m, n);
    for (const [votes, n] of Object.entries(s.voteHistogram)) add(agg.voteHistogram, votes, n);
  }
  agg.meanAgreementRate = mean(rates);
  return agg;
}

// same math as meanPairwiseAgreement in agent/consensus.ts (not exported there)
function pairwiseAgreement(clusterPasses: number[][], passCount: number): number | null {
  if (passCount < 2 || clusterPasses.length === 0) return null;
  const sets = Array.from({ length: passCount }, () => new Set<number>());
  clusterPasses.forEach((passes, ci) => passes.forEach((p) => sets[p].add(ci)));
  let sum = 0;
  let pairs = 0;
  for (let a = 0; a < passCount; a++) {
    for (let b = a + 1; b < passCount; b++) {
      let inter = 0;
      for (const c of sets[a]) if (sets[b].has(c)) inter++;
      const union = sets[a].size + sets[b].size - inter;
      sum += union === 0 ? 1 : inter / union;
      pairs++;
    }
  }
  return sum / pairs;
}

const SWEEP_ENV = ["RUSTY_CLUSTER_JACCARD", "RUSTY_CLUSTER_CATEGORY_JACCARD"] as const;

// re-clusters each run's recorded pass findings at every threshold. runs without a
// clusters record are skipped because their effective threshold is unknown.
export function sweepJaccard(parsed: ParsedRawFindings, thresholds: number[]): SweepRow[] {
  const thresholdByRun = new Map<string, number>();
  for (const c of parsed.clusterRecords) {
    const key = c.runId ? `run:${c.runId}` : `pr:${c.prId}`;
    if (!thresholdByRun.has(key)) thresholdByRun.set(key, c.effectiveThreshold);
  }
  const runs = new Map<string, { effective: number; passes: RawPassRecord[] }>();
  for (const p of parsed.passRecords) {
    const key = p.runId ? `run:${p.runId}` : `pr:${p.prId}`;
    const effective = thresholdByRun.get(key);
    if (effective === undefined) continue;
    const run = runs.get(key) ?? { effective, passes: [] };
    run.passes.push(p);
    runs.set(key, run);
  }

  const saved = SWEEP_ENV.map((k) => [k, process.env[k]] as const);
  try {
    return thresholds.map((threshold) => {
      for (const k of SWEEP_ENV) process.env[k] = String(threshold);
      let clusters = 0;
      let surviving = 0;
      const rates: number[] = [];
      for (const { effective, passes } of runs.values()) {
        const ordered = [...passes].sort((a, b) => a.passIndex - b.passIndex);
        const found = clusterFindings(ordered.map((p) => p.findings as unknown as Finding[]));
        clusters += found.length;
        surviving += found.filter((c) => c.voteCount >= effective).length;
        const rate = pairwiseAgreement(
          found.map((c) => c.passIndices),
          ordered.length,
        );
        if (rate !== null) rates.push(rate);
      }
      return {
        threshold,
        runs: runs.size,
        clusters,
        surviving,
        meanAgreement: mean(rates),
      };
    });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  }
}
