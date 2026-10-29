import { Agent, setGlobalDispatcher } from "undici";
import { logger } from "./logger.js";

const log = logger.child({ module: "http-config" });

/** node 18+ undici default. raised here because slow LLM routes (notably
 * Requesty → Kimi) routinely buffer >300s before sending the first response
 * header, especially on large prompts with active tool-calling. */
const DEFAULT_HEADERS_TIMEOUT_MS = 600_000;

/** body timeout matches headers — once headers arrive, the body should follow
 * promptly even on long generations because each chunk resets the timer. */
const DEFAULT_BODY_TIMEOUT_MS = 600_000;

let configured = false;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

/**
 * configure undici's global dispatcher so all `fetch` calls (including
 * ai-sdk → upstream LLM) get longer headers/body timeouts than
 * the 300s default. idempotent — safe to call from each CLI entry point.
 *
 * controlled by:
 *   - `RUSTY_LLM_HEADERS_TIMEOUT_MS` (default 600000 = 10 min)
 *   - `RUSTY_LLM_BODY_TIMEOUT_MS` (default 600000 = 10 min)
 *
 * affects all outbound fetch calls (LLM routes, GitHub/GitLab/ADO APIs).
 * that's intentional — every consumer here is upstream API I/O, and
 * raising the timeout never harms a fast request.
 */
export function configureGlobalHttp(): void {
  if (configured) return;
  configured = true;

  const headersTimeout = parsePositiveInt(
    process.env.RUSTY_LLM_HEADERS_TIMEOUT_MS,
    DEFAULT_HEADERS_TIMEOUT_MS,
  );
  const bodyTimeout = parsePositiveInt(
    process.env.RUSTY_LLM_BODY_TIMEOUT_MS,
    DEFAULT_BODY_TIMEOUT_MS,
  );

  setGlobalDispatcher(
    new Agent({
      headersTimeout,
      bodyTimeout,
      // keep-alive defaults are fine; we don't churn many distinct hosts.
    }),
  );

  log.info({ headersTimeout, bodyTimeout }, "configured global http dispatcher");
}
