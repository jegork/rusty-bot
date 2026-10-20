import type { GitProvider } from "../types.js";
import { SearchUnavailableError } from "./search-errors.js";

const DEFAULT_SEARCH_COOLDOWN_MS = 60_000;

export class ToolCache {
  private searchCache = new Map<
    string,
    Promise<{ results: { file: string; line: number; content: string }[]; count: number }>
  >();
  private fileCache = new Map<string, Promise<{ content: string | null }>>();
  private searchUnavailableUntil = 0;

  constructor(
    private provider: GitProvider,
    private ref: string,
  ) {}

  searchCode(query: string) {
    const remainingMs = this.searchUnavailableUntil - Date.now();
    if (remainingMs > 0) {
      return Promise.reject(new SearchUnavailableError("rate_limited", remainingMs));
    }
    const existing = this.searchCache.get(query);
    if (existing) return existing;
    const p = this.provider
      .searchCode(query)
      .then((results) => ({ results, count: results.length }))
      .catch((err: unknown) => {
        // an unavailable search must not be replayed from the cache forever
        if (this.searchCache.get(query) === p) this.searchCache.delete(query);
        if (err instanceof SearchUnavailableError && err.reason === "rate_limited") {
          this.searchUnavailableUntil =
            Date.now() + (err.retryAfterMs ?? DEFAULT_SEARCH_COOLDOWN_MS);
        }
        throw err;
      });
    this.searchCache.set(query, p);
    return p;
  }

  getFileContent(path: string) {
    const existing = this.fileCache.get(path);
    if (existing) return existing;
    const p = this.provider.getFileContent(path, this.ref).then((content) => ({ content }));
    this.fileCache.set(path, p);
    return p;
  }
}
