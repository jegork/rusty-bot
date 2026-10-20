export type SearchUnavailableReason = "rate_limited" | "failed";

/** thrown by providers when a code search did not run, as opposed to running and matching nothing. */
export class SearchUnavailableError extends Error {
  readonly type = "search_unavailable";

  constructor(
    readonly reason: SearchUnavailableReason,
    readonly retryAfterMs?: number,
    options?: { cause?: unknown },
  ) {
    super(`code search unavailable (${reason})`, options);
    this.name = "SearchUnavailableError";
  }
}
