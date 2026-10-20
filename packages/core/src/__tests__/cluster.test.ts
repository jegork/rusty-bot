import { describe, it, expect, afterEach } from "vitest";
import type { Finding, Observation } from "../types.js";
import {
  tokenize,
  jaccardSimilarity,
  clusterFindings,
  clusterObservations,
  getClusterConfig,
} from "../agent/cluster.js";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "src/index.ts",
    line: 10,
    endLine: null,
    severity: "warning",
    category: "bugs",
    message: "potential null reference in handler function",
    suggestedFix: "",
    ...overrides,
  };
}

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    file: "src/index.ts",
    line: 10,
    severity: "warning",
    category: "bugs",
    message: "potential null reference in handler function",
    ...overrides,
  };
}

describe("tokenize", () => {
  it("lowercases and splits on whitespace and punctuation", () => {
    const tokens = tokenize("Hello, World! Foo-Bar");
    expect(tokens).toEqual(new Set(["hello", "world", "foo", "bar"]));
  });

  it("returns empty set for empty string", () => {
    expect(tokenize("")).toEqual(new Set());
  });

  it("returns empty set for only punctuation", () => {
    expect(tokenize("...---!!!")).toEqual(new Set());
  });
});

describe("jaccardSimilarity", () => {
  it("returns 0 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    const s = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["c", "d"]))).toBe(0);
  });

  it("computes correctly for partial overlap", () => {
    const a = new Set(["a", "b", "c"]);
    const b = new Set(["b", "c", "d"]);
    // intersection=2, union=4
    expect(jaccardSimilarity(a, b)).toBeCloseTo(0.5);
  });
});

describe("clusterFindings", () => {
  it("returns empty array for empty input", () => {
    expect(clusterFindings([])).toEqual([]);
  });

  it("returns empty array for empty passes", () => {
    expect(clusterFindings([[], []])).toEqual([]);
  });

  it("clusters exact duplicates across passes", () => {
    const f = makeFinding();
    const result = clusterFindings([[f], [f], [f]]);
    expect(result).toHaveLength(1);
    expect(result[0].voteCount).toBe(3);
    expect(result[0].variants).toHaveLength(3);
  });

  it("clusters findings on same file with nearby lines and similar messages", () => {
    const f1 = makeFinding({ line: 10 });
    const f2 = makeFinding({ line: 13, message: "potential null reference in handler" });
    const result = clusterFindings([[f1], [f2]]);
    expect(result).toHaveLength(1);
    expect(result[0].voteCount).toBe(2);
  });

  it("does not cluster findings with same file, nearby lines, but very different messages", () => {
    const f1 = makeFinding({
      line: 10,
      message: "potential null reference in handler function",
    });
    const f2 = makeFinding({
      line: 12,
      message: "unused import should be removed from module",
    });
    const result = clusterFindings([[f1], [f2]]);
    expect(result).toHaveLength(2);
  });

  it("never clusters findings from different files even with identical messages", () => {
    const f1 = makeFinding({ file: "src/a.ts" });
    const f2 = makeFinding({ file: "src/b.ts" });
    const result = clusterFindings([[f1], [f2]]);
    expect(result).toHaveLength(2);
  });

  it("does not cluster findings with distant lines even on same file", () => {
    const f1 = makeFinding({ line: 10 });
    const f2 = makeFinding({ line: 20 });
    const result = clusterFindings([[f1], [f2]]);
    expect(result).toHaveLength(2);
  });

  it("respects jaccard threshold boundary - just above 0.3", () => {
    // 3 shared tokens out of 7 union = 0.4286 > 0.3 -> cluster
    const f1 = makeFinding({ message: "alpha beta gamma delta" });
    const f2 = makeFinding({ message: "alpha beta gamma zeta epsilon" });
    const sim = jaccardSimilarity(tokenize(f1.message), tokenize(f2.message));
    expect(sim).toBeGreaterThanOrEqual(0.3);
    const result = clusterFindings([[f1], [f2]]);
    expect(result).toHaveLength(1);
  });

  it("respects jaccard threshold boundary - just below 0.3", () => {
    // 1 shared token out of 7 union = 0.143 < 0.3 -> separate
    const f1 = makeFinding({ message: "alpha beta gamma delta" });
    const f2 = makeFinding({ message: "alpha zeta epsilon theta" });
    const sim = jaccardSimilarity(tokenize(f1.message), tokenize(f2.message));
    expect(sim).toBeLessThan(0.3);
    const result = clusterFindings([[f1], [f2]]);
    expect(result).toHaveLength(2);
  });

  it("applies category bonus - same category clusters at lower similarity", () => {
    // 2 shared out of 8 union = 0.25, above 0.2 bonus threshold but below 0.3
    const f1 = makeFinding({
      category: "security",
      message: "alpha beta gamma delta",
    });
    const f2 = makeFinding({
      category: "security",
      message: "alpha beta epsilon zeta theta kappa",
    });
    const sim = jaccardSimilarity(tokenize(f1.message), tokenize(f2.message));
    expect(sim).toBeGreaterThanOrEqual(0.2);
    expect(sim).toBeLessThan(0.3);
    const result = clusterFindings([[f1], [f2]]);
    expect(result).toHaveLength(1);
  });

  it("does not apply category bonus across different categories", () => {
    const f1 = makeFinding({
      category: "security",
      message: "alpha beta gamma delta",
    });
    const f2 = makeFinding({
      category: "performance",
      message: "alpha beta epsilon zeta theta kappa",
    });
    const sim = jaccardSimilarity(tokenize(f1.message), tokenize(f2.message));
    expect(sim).toBeLessThan(0.3);
    const result = clusterFindings([[f1], [f2]]);
    expect(result).toHaveLength(2);
  });

  it("counts vote as distinct passes, not total findings", () => {
    const f1 = makeFinding({ line: 10 });
    const f2 = makeFinding({ line: 11 });
    const f3 = makeFinding({ line: 12 });
    // pass 0 has two duplicates, pass 1 has one, pass 2 has none matching
    const result = clusterFindings([[f1, f2], [f3], []]);
    expect(result).toHaveLength(1);
    expect(result[0].voteCount).toBe(2);
    expect(result[0].variants).toHaveLength(3);
  });

  it("selects representative with highest severity", () => {
    const f1 = makeFinding({ severity: "suggestion" });
    const f2 = makeFinding({ severity: "critical" });
    const f3 = makeFinding({ severity: "warning" });
    const result = clusterFindings([[f1], [f2], [f3]]);
    expect(result).toHaveLength(1);
    expect(result[0].representative.severity).toBe("critical");
  });

  it("breaks severity tie by longest message", () => {
    const f1 = makeFinding({
      severity: "warning",
      message: "potential null reference in handler",
    });
    const f2 = makeFinding({
      severity: "warning",
      message: "potential null reference in handler function that processes user input",
    });
    const result = clusterFindings([[f1], [f2]]);
    expect(result).toHaveLength(1);
    expect(result[0].representative.message).toBe(f2.message);
  });

  it("gives voteCount=1 for single pass input", () => {
    const f1 = makeFinding({ line: 10 });
    const f2 = makeFinding({ line: 50, message: "completely different issue" });
    const result = clusterFindings([[f1, f2]]);
    expect(result).toHaveLength(2);
    expect(result[0].voteCount).toBe(1);
    expect(result[1].voteCount).toBe(1);
  });

  it("does not over-cluster unrelated findings in the same file", () => {
    const f1 = makeFinding({
      line: 10,
      category: "bugs",
      message: "potential null reference in handler function",
    });
    const f2 = makeFinding({
      line: 100,
      category: "performance",
      message: "inefficient loop should use map instead of forEach",
    });
    const f3 = makeFinding({
      line: 200,
      category: "security",
      message: "user input not sanitized before database query",
    });
    const result = clusterFindings([
      [f1, f2, f3],
      [f1, f2, f3],
    ]);
    expect(result).toHaveLength(3);
    result.forEach((c) => expect(c.voteCount).toBe(2));
  });

  it("does not dilute similarity when multiple variants join a cluster", () => {
    const f1 = makeFinding({
      message: "potential null pointer dereference in the request handler",
    });
    const f2 = makeFinding({
      message: "possible null pointer dereference in request handler function",
    });
    const f3 = makeFinding({
      message: "null pointer dereference risk in the request handler",
    });
    const result = clusterFindings([[f1], [f2], [f3]]);
    expect(result).toHaveLength(1);
    expect(result[0].voteCount).toBe(3);
  });

  it("handles findings at line proximity boundary (exactly ±5)", () => {
    const f1 = makeFinding({ line: 10 });
    const f2 = makeFinding({ line: 15 });
    const f3 = makeFinding({ line: 16 });

    const withinWindow = clusterFindings([[f1], [f2]]);
    expect(withinWindow).toHaveLength(1);

    const outsideWindow = clusterFindings([[f1], [f3]]);
    expect(outsideWindow).toHaveLength(2);
  });

  // CONSENSUS-QUALITY-WRITEUP.md experiment 1: cluster.messageTokens used to be
  // frozen at the first finding's tokens, so similarity for any later joiner
  // was always measured against pass 1's specific wording. This block verifies
  // the union-on-join behavior — pass 3 can now reach the cluster via pass 2's
  // wording even when its similarity to pass 1 alone is below threshold.

  it("widens the comparison vocabulary as findings join the cluster", () => {
    // f1: "alpha beta gamma delta"
    // f2: "alpha beta epsilon zeta"   (shares 2/6 with f1 → 0.333, just above 0.3)
    // f3: "epsilon zeta eta theta"    (shares 0/8 with f1 alone → 0; shares 2/6 with f2 → 0.333)
    // pre-fix: f3 compared against f1 only → no match → 3 separate clusters
    // post-fix: f3 compared against f1∪f2 = 6 tokens → 2/8 = 0.25 (still under threshold!)
    //          so the union must be wide enough to actually flip a case.
    const f1 = makeFinding({ message: "alpha beta gamma delta" });
    const f2 = makeFinding({ message: "alpha beta epsilon zeta theta" });
    const f3 = makeFinding({ message: "epsilon zeta theta iota kappa" });

    // sanity: each pairwise jaccard
    expect(jaccardSimilarity(tokenize(f1.message), tokenize(f3.message))).toBeLessThan(0.3);
    expect(jaccardSimilarity(tokenize(f2.message), tokenize(f3.message))).toBeGreaterThanOrEqual(
      0.3,
    );

    const result = clusterFindings([[f1], [f2], [f3]]);

    // After the union fix, the f1+f2 cluster's tokens are
    // {alpha, beta, gamma, delta, epsilon, zeta, theta} (7 tokens).
    // f3 (5 tokens) intersects {epsilon, zeta, theta} = 3, union = 9 → 0.333 ≥ 0.3.
    // So f3 joins the same cluster — vote count = 3.
    expect(result).toHaveLength(1);
    expect(result[0].voteCount).toBe(3);
    expect(result[0].variants).toHaveLength(3);
  });

  it("vote count remains distinct-passes after the token union (no double-counting)", () => {
    // multiple findings from the same pass joining the same cluster should
    // still count as one vote; the union must not change distinct-pass semantics.
    const f1 = makeFinding({ message: "alpha beta gamma delta" });
    const f2a = makeFinding({ message: "alpha beta epsilon" });
    const f2b = makeFinding({ message: "epsilon zeta gamma delta" });

    const result = clusterFindings([[f1], [f2a, f2b]]);
    expect(result).toHaveLength(1);
    expect(result[0].voteCount).toBe(2);
    // all three findings end up as variants
    expect(result[0].variants).toHaveLength(3);
  });

  it("does not over-merge unrelated findings on the same file:line via the wider vocabulary", () => {
    // sanity bound: even with token union, two genuinely unrelated findings on
    // the same file at nearby lines should still cluster separately if their
    // wording doesn't share enough with the cluster's accumulated vocabulary.
    const f1 = makeFinding({
      line: 10,
      message: "potential null reference dereference handler",
    });
    const f2 = makeFinding({
      line: 11,
      message: "potential null reference different bug elsewhere",
    });
    const f3 = makeFinding({
      line: 12,
      message: "missing await async race condition",
    });

    const result = clusterFindings([[f1], [f2], [f3]]);

    // f1 + f2 cluster (high overlap), f3 stays separate (no shared tokens
    // with the f1+f2 union).
    expect(result).toHaveLength(2);
    const cluster1 = result.find((c) => c.variants.length === 2);
    const cluster2 = result.find((c) => c.variants.length === 1);
    expect(cluster1).toBeDefined();
    expect(cluster2).toBeDefined();
  });

  it("union expands within a single pass as well as across passes", () => {
    // joins within one pass also expand the comparison vocabulary, so a later
    // entry in the same pass benefits from the union.
    const f1 = makeFinding({ message: "alpha beta gamma" });
    const f2 = makeFinding({ message: "alpha gamma delta epsilon" });
    const f3 = makeFinding({ message: "delta epsilon zeta theta" });

    const result = clusterFindings([[f1, f2, f3]]);

    // f1 + f2 cluster, then f3 has 2/6 overlap with the union (delta, epsilon)
    // = 0.333 ≥ 0.3 → joins the same cluster.
    expect(result).toHaveLength(1);
    // single-pass run, distinct-pass vote count = 1 even with 3 variants
    expect(result[0].voteCount).toBe(1);
    expect(result[0].variants).toHaveLength(3);
  });
});

describe("clusterObservations", () => {
  it("clusters observations the same way as findings", () => {
    const o1 = makeObservation({ line: 10 });
    const o2 = makeObservation({ line: 12 });
    const o3 = makeObservation({
      line: 50,
      message: "completely unrelated observation about code style",
    });

    const result = clusterObservations([[o1, o3], [o2]]);
    expect(result).toHaveLength(2);

    const clusteredObs = result.find((c) => c.voteCount === 2);
    expect(clusteredObs).toBeDefined();
    expect(clusteredObs!.variants).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    expect(clusterObservations([])).toEqual([]);
  });

  it("picks highest severity representative for observations", () => {
    const o1 = makeObservation({ severity: "suggestion" });
    const o2 = makeObservation({ severity: "critical" });
    const result = clusterObservations([[o1], [o2]]);
    expect(result).toHaveLength(1);
    expect(result[0].representative.severity).toBe("critical");
  });
});

describe("getClusterConfig env overrides", () => {
  const keys = [
    "RUSTY_CLUSTER_LINE_WINDOW",
    "RUSTY_CLUSTER_JACCARD",
    "RUSTY_CLUSTER_CATEGORY_JACCARD",
  ];
  afterEach(() => {
    delete process.env.RUSTY_CLUSTER_LINE_WINDOW;
    delete process.env.RUSTY_CLUSTER_JACCARD;
    delete process.env.RUSTY_CLUSTER_CATEGORY_JACCARD;
  });

  it("defaults to the historical constants", () => {
    expect(getClusterConfig()).toEqual({ lineWindow: 5, jaccard: 0.3, categoryJaccard: 0.2 });
  });

  it("honors valid env values", () => {
    process.env.RUSTY_CLUSTER_LINE_WINDOW = "12";
    process.env.RUSTY_CLUSTER_JACCARD = "0.5";
    process.env.RUSTY_CLUSTER_CATEGORY_JACCARD = "0";
    expect(getClusterConfig()).toEqual({ lineWindow: 12, jaccard: 0.5, categoryJaccard: 0 });
  });

  it("falls back on empty, garbage, negative and non-finite values", () => {
    for (const bad of ["", "abc", "-1", "Infinity", "NaN", "  "]) {
      for (const k of keys) process.env[k] = bad;
      expect(getClusterConfig()).toEqual({ lineWindow: 5, jaccard: 0.3, categoryJaccard: 0.2 });
    }
  });

  it("changes clustering behavior when the line window is widened", () => {
    const passes = [[makeFinding({ line: 10 })], [makeFinding({ line: 20 })]];
    expect(clusterFindings(passes)).toHaveLength(2);
    process.env.RUSTY_CLUSTER_LINE_WINDOW = "10";
    expect(clusterFindings(passes)).toHaveLength(1);
  });
});
