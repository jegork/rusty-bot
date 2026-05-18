import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { ReviewStyle, FocusArea } from "@rusty-bot/core";

export interface RepoConfig {
  owner: string;
  repo: string;
  style: ReviewStyle;
  focusAreas: FocusArea[];
  ignorePatterns: string[];
  consensusPasses?: number;
  consensusThreshold?: number | null;
  generateDescription?: boolean;
  renameTitleToConventional?: boolean;
}

export interface RepoConfigWithId extends RepoConfig {
  id: string;
}

export interface ReviewRecord {
  id: string;
  owner: string;
  repo: string;
  prNumber: number;
  timestamp: string;
  findingsCount: number;
  criticalCount: number;
  warningCount: number;
  suggestionCount: number;
  modelUsed: string;
  tokenCount: number;
  recommendation: string;
  prUrl: string;
  triageModelUsed?: string;
  triageTokenCount?: number;
  filesSkipped?: number;
  filesSkimmed?: number;
  filesDeepReviewed?: number;
}

interface StorageData {
  configs: Record<string, RepoConfig>;
  reviews: ReviewRecord[];
  settings: Record<string, string>;
}

const DATA_DIR = join(process.cwd(), "data");
const DATA_FILE = join(DATA_DIR, "config.json");

function makeConfigKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

async function loadData(): Promise<StorageData> {
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    return JSON.parse(raw) as StorageData;
  } catch {
    return { configs: {}, reviews: [], settings: {} };
  }
}

async function saveData(data: StorageData): Promise<void> {
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// serialize all writes through a promise chain — every mutating storage call
// follows a load→mutate→save pattern that isn't atomic. without this, two
// reviews completing roughly simultaneously can both read the same `data`,
// each apply their mutation in memory, and the second `saveData` wins —
// clobbering the first review's record entirely.
//
// this is a band-aid on the JSON-file storage choice. atomic row-level writes
// would eliminate the need for the lock; see FOLLOWUPS.md for the migration
// note. shipping the band-aid because the race is observable today and the
// migration is a separate, larger piece of work.
let writeQueue: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  // keep the chain unbroken even when fn rejects — otherwise an error in one
  // caller would break serialization for the next
  writeQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function getRepoConfig(owner: string, repo: string): Promise<RepoConfig | null> {
  const data = await loadData();
  return data.configs[makeConfigKey(owner, repo)] ?? null;
}

export async function setRepoConfig(
  owner: string,
  repo: string,
  config: RepoConfig,
): Promise<void> {
  await withWriteLock(async () => {
    const data = await loadData();
    data.configs[makeConfigKey(owner, repo)] = config;
    await saveData(data);
  });
}

export async function listRepoConfigs(): Promise<RepoConfigWithId[]> {
  const data = await loadData();
  return Object.entries(data.configs).map(([id, config]) => ({ id, ...config }));
}

export async function saveReview(review: ReviewRecord): Promise<string> {
  return withWriteLock(async () => {
    const data = await loadData();
    data.reviews.push(review);
    await saveData(data);
    return review.id;
  });
}

export async function listReviews(limit = 50, offset = 0): Promise<ReviewRecord[]> {
  const data = await loadData();
  // newest first
  const sorted = [...data.reviews].reverse();
  return sorted.slice(offset, offset + limit);
}

/** like listReviews but returns the total count alongside the page in a single
 * file read — avoids the read-twice pattern callers were using when they
 * needed both the items and the total for pagination metadata. */
export async function listReviewsPage(
  limit: number,
  offset: number,
): Promise<{ items: ReviewRecord[]; total: number }> {
  const data = await loadData();
  const sorted = [...data.reviews].reverse();
  return { items: sorted.slice(offset, offset + limit), total: data.reviews.length };
}

export async function getReview(id: string): Promise<ReviewRecord | null> {
  const data = await loadData();
  return data.reviews.find((r) => r.id === id) ?? null;
}

export async function getSetting(key: string): Promise<string | null> {
  const data = await loadData();
  return data.settings[key] ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await withWriteLock(async () => {
    const data = await loadData();
    data.settings[key] = value;
    await saveData(data);
  });
}

export async function getSettings(): Promise<Record<string, string>> {
  const data = await loadData();
  return { ...data.settings };
}
