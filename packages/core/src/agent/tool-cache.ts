import type { RepoCheckout } from "../repo/checkout.js";
import type { CodeGraphIndex } from "../repo/codegraph.js";
import type { CodeSearchResult, GitProvider } from "../types.js";
import { SearchUnavailableError } from "./search-errors.js";

const DEFAULT_SEARCH_COOLDOWN_MS = 60_000;

// "pr-head" searches the PR's own code on disk; "remote" goes through the
// platform API, whose search only indexes the default branch.
export type SearchScope = "pr-head" | "remote";

export interface CodeSource {
  scope: SearchScope;
  /** true when a pr-head source is the merge commit rather than the PR head itself */
  approximate: boolean;
  searchCode(query: string): Promise<CodeSearchResult[]>;
  getFileContent(path: string): Promise<string | null>;
}

export function providerCodeSource(provider: GitProvider, ref: string): CodeSource {
  return {
    scope: "remote",
    approximate: false,
    searchCode: (query) => provider.searchCode(query),
    getFileContent: (path) => provider.getFileContent(path, ref),
  };
}

export function checkoutCodeSource(checkout: RepoCheckout): CodeSource {
  return {
    scope: "pr-head",
    approximate: checkout.approximate,
    searchCode: (query) => checkout.grep(query),
    getFileContent: (path) => checkout.readFile(path),
  };
}

export class ToolCache {
  private searchCache = new Map<
    string,
    Promise<{ results: { file: string; line: number; content: string }[]; count: number }>
  >();
  private fileCache = new Map<string, Promise<{ content: string | null }>>();
  private exploreCache = new Map<string, Promise<{ content: string | null }>>();
  private symbolCache = new Map<string, Promise<{ content: string | null }>>();
  private searchUnavailableUntil = 0;

  readonly scope: SearchScope;
  readonly approximate: boolean;

  constructor(private source: CodeSource) {
    this.scope = source.scope;
    this.approximate = source.approximate;
  }

  searchCode(query: string) {
    const remainingMs = this.searchUnavailableUntil - Date.now();
    if (remainingMs > 0) {
      return Promise.reject(new SearchUnavailableError("rate_limited", remainingMs));
    }
    const existing = this.searchCache.get(query);
    if (existing) return existing;
    const p = this.source
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
    const p = this.source.getFileContent(path).then((content) => ({ content }));
    this.fileCache.set(path, p);
    return p;
  }

  exploreCode(graph: CodeGraphIndex, query: string) {
    const existing = this.exploreCache.get(query);
    if (existing) return existing;
    const p = graph.explore(query).then((content) => ({ content }));
    this.exploreCache.set(query, p);
    return p;
  }

  findSymbol(graph: CodeGraphIndex, name: string) {
    const existing = this.symbolCache.get(name);
    if (existing) return existing;
    const p = graph.node(name).then((content) => ({ content }));
    this.symbolCache.set(name, p);
    return p;
  }
}
