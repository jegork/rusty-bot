import type { Finding, Observation, Severity, FocusArea } from "../types.js";

const LINE_PROXIMITY_WINDOW = 5;
const JACCARD_THRESHOLD = 0.3;
const CATEGORY_BONUS_THRESHOLD = 0.2;

export interface FindingCluster {
  representative: Finding;
  voteCount: number;
  variants: Finding[];
}

export interface ObservationCluster {
  representative: Observation;
  voteCount: number;
  variants: Observation[];
}

interface Clusterable {
  file: string;
  line: number;
  severity: Severity;
  category: FocusArea;
  message: string;
}

interface TaggedItem<T extends Clusterable> {
  item: T;
  passIndex: number;
}

interface InternalCluster<T extends Clusterable> {
  items: TaggedItem<T>[];
  messageTokens: Set<string>;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 2,
  warning: 1,
  suggestion: 0,
};

export function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[\s\p{P}]+/u)
      .filter((t) => t.length > 0),
  );
}

export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return intersection / union;
}

function clusterItems<T extends Clusterable>(
  passResults: readonly (readonly T[])[],
): InternalCluster<T>[] {
  const clusters: InternalCluster<T>[] = [];

  for (let passIndex = 0; passIndex < passResults.length; passIndex++) {
    const pass = passResults[passIndex];
    for (const item of pass) {
      const tokens = tokenize(item.message);
      let matched = false;

      for (const cluster of clusters) {
        const rep = cluster.items[0].item;
        if (rep.file !== item.file) continue;
        if (Math.abs(rep.line - item.line) > LINE_PROXIMITY_WINDOW) continue;

        const similarity = jaccardSimilarity(tokens, cluster.messageTokens);
        const threshold =
          rep.category === item.category ? CATEGORY_BONUS_THRESHOLD : JACCARD_THRESHOLD;

        if (similarity >= threshold) {
          cluster.items.push({ item, passIndex });
          // Union the joining item's tokens into the cluster's comparison set.
          // Without this, similarity on later joins is always measured against
          // the first-arriving finding's specific wording — meaning a 3rd pass
          // that's much closer to the 2nd pass's wording than the 1st can still
          // miss the cluster. With diverse cross-model ensembles, that's a
          // structural disadvantage. See CONSENSUS-QUALITY-WRITEUP.md
          // experiment 1.
          for (const t of tokens) cluster.messageTokens.add(t);
          matched = true;
          break;
        }
      }

      if (!matched) {
        clusters.push({
          items: [{ item, passIndex }],
          messageTokens: new Set(tokens),
        });
      }
    }
  }

  return clusters;
}

function pickRepresentative<T extends Clusterable>(items: T[]): T {
  // copy before sorting — Array.prototype.sort mutates in place, and `items`
  // here is the caller's cluster.items.map() result whose ordering callers
  // downstream may rely on
  return [...items].sort((a, b) => {
    const sevDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sevDiff !== 0) return sevDiff;
    return b.message.length - a.message.length;
  })[0];
}

function countDistinctPasses<T extends Clusterable>(tagged: TaggedItem<T>[]): number {
  return new Set(tagged.map((t) => t.passIndex)).size;
}

export function clusterFindings(passResults: readonly (readonly Finding[])[]): FindingCluster[] {
  return clusterItems(passResults).map((cluster) => {
    const allItems = cluster.items.map((t) => t.item);
    return {
      representative: pickRepresentative([...allItems]),
      voteCount: countDistinctPasses(cluster.items),
      variants: allItems,
    };
  });
}

export function clusterObservations(
  passResults: readonly (readonly Observation[])[],
): ObservationCluster[] {
  return clusterItems(passResults).map((cluster) => {
    const allItems = cluster.items.map((t) => t.item);
    return {
      representative: pickRepresentative([...allItems]),
      voteCount: countDistinctPasses(cluster.items),
      variants: allItems,
    };
  });
}
