import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, stat } from "node:fs/promises";
import type { FocusArea } from "@rusty-bot/core";
import { ReviewStyleSchema, configureGlobalHttp, logger } from "@rusty-bot/core";
import { validateWebhookSignature, parseWebhookEvent } from "./webhook.js";
import { createAppOctokit } from "./auth.js";
import { orchestrateReview } from "./orchestrator.js";
import {
  listRepoConfigs,
  getRepoConfig,
  setRepoConfig,
  listReviewsPage,
  getReview,
  getSettings,
  setSetting,
  type RepoConfig,
} from "./storage.js";

const log = logger.child({ package: "github" });

// in-memory webhook delivery dedupe. github retries webhooks on timeout, and
// a slow review dispatch would otherwise trigger a second full review for the
// same delivery. NOTE: this set is per-process — multi-instance deployments
// behind a load balancer need a shared-storage replacement (see FOLLOWUPS).
const inFlightDeliveries = new Set<string>();

// concurrency semaphore so a burst of webhooks doesn't exhaust the LLM rate
// limit or OOM the node process. NOTE: also per-process — see FOLLOWUPS.
const MAX_CONCURRENT_REVIEWS = (() => {
  const raw = process.env.RUSTY_MAX_CONCURRENT_REVIEWS;
  if (raw === undefined || raw === "") return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
})();
let activeReviews = 0;
const reviewQueue: (() => void)[] = [];

function acquireReviewSlot(): Promise<void> {
  if (activeReviews < MAX_CONCURRENT_REVIEWS) {
    activeReviews++;
    return Promise.resolve();
  }
  return new Promise((resolve) => reviewQueue.push(resolve));
}

function releaseReviewSlot(): void {
  const next = reviewQueue.shift();
  if (next) {
    // hand the slot directly to the next waiter — keeps activeReviews stable
    // at MAX_CONCURRENT_REVIEWS so we don't transiently exceed it
    next();
  } else {
    activeReviews--;
  }
}

export const app = new Hono();

app.use("*", cors());

app.get("/health", (c) => c.json({ status: "ok" }));

const SENSITIVE_KEY_PATTERNS = ["token", "key", "secret", "password"];

function redactSettings(settings: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(settings)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((p) => key.toLowerCase().includes(p));
    result[key] = isSensitive && value.length > 4 ? `${value.slice(0, 4)}...` : value;
  }
  return result;
}

app.post("/api/webhooks/github", async (c) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET ?? "";
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const deliveryId = c.req.header("x-github-delivery") ?? "";
  const rawBody = await c.req.text();

  if (!validateWebhookSignature(rawBody, signature, secret)) {
    return c.json({ error: "invalid signature" }, 401);
  }

  const body = JSON.parse(rawBody) as Record<string, unknown>;
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((v, k) => {
    headers[k] = v;
  });

  const { event, action, payload } = parseWebhookEvent(headers, body);

  if (event !== "pull_request") {
    return c.json({ ignored: true, reason: "not a pull_request event" });
  }

  if (!["opened", "synchronize", "reopened"].includes(action)) {
    return c.json({ ignored: true, reason: `action ${action} not handled` });
  }

  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (!pr) {
    return c.json({ ignored: true, reason: "no pull_request in payload" });
  }

  if (pr.draft === true) {
    return c.json({ ignored: true, reason: "draft PR" });
  }

  const sender = payload.sender as Record<string, unknown> | undefined;
  if (sender?.type === "Bot") {
    return c.json({ ignored: true, reason: "bot PR" });
  }

  // dedupe duplicate webhook deliveries (same X-GitHub-Delivery). github
  // retries on timeout; returning 200 fast prevents most retries, but this
  // guards the cases where the retry races our reply.
  if (deliveryId && inFlightDeliveries.has(deliveryId)) {
    log.info({ deliveryId }, "duplicate webhook delivery, ignoring");
    return c.json({ ok: true, duplicate: true });
  }
  if (deliveryId) inFlightDeliveries.add(deliveryId);

  const installation = payload.installation as Record<string, unknown> | undefined;
  const installationId = Number(installation?.id);
  const repoData = payload.repository as Record<string, unknown>;
  const ownerData = repoData.owner as Record<string, unknown>;
  const owner = ownerData.login as string;
  const repo = repoData.name as string;
  const pullNumber = pr.number as number;

  const appId = process.env.GITHUB_APP_ID ?? "";
  let privateKey = process.env.GITHUB_PRIVATE_KEY ?? "";
  if (!privateKey && process.env.GITHUB_PRIVATE_KEY_PATH) {
    privateKey = await readFile(process.env.GITHUB_PRIVATE_KEY_PATH, "utf-8");
  }

  // dispatch review async so we return 200 immediately; acquire a slot from
  // the concurrency semaphore before starting so bursts don't OOM or get
  // rate-limited by the LLM provider. release in finally so a thrown review
  // doesn't leak the slot.
  const runReview = async () => {
    await acquireReviewSlot();
    try {
      const octokit = await createAppOctokit(appId, privateKey, installationId);
      await orchestrateReview({ octokit, owner, repo, pullNumber, installationId });
    } catch (err: unknown) {
      log.error({ err }, "review failed");
    } finally {
      releaseReviewSlot();
      if (deliveryId) inFlightDeliveries.delete(deliveryId);
    }
  };

  runReview().catch((err: unknown) => log.error({ err }, "failed to dispatch review"));

  return c.json({ ok: true });
});

app.get("/api/config/repos", async (c) => {
  const configs = await listRepoConfigs();
  return c.json(configs);
});

app.get("/api/config/repos/:owner/:repo", async (c) => {
  const { owner, repo } = c.req.param();
  const config = await getRepoConfig(owner, repo);
  if (!config) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(config);
});

app.put("/api/config/repos/:owner/:repo", async (c) => {
  const { owner, repo } = c.req.param();
  const body: {
    style?: string;
    focusAreas?: FocusArea[];
    ignorePatterns?: string[];
    generateDescription?: boolean;
    renameTitleToConventional?: boolean;
    consensusPasses?: number;
    consensusThreshold?: number | null;
  } = await c.req.json();

  const parsedStyle = ReviewStyleSchema.safeParse(body.style);
  if (body.style !== undefined && !parsedStyle.success) {
    return c.json({ error: `invalid review style: ${body.style}` }, 400);
  }

  // carry forward existing optional fields not included in this request — PUT
  // semantics here are PATCH-shaped in practice (clients update one field at a
  // time), and the prior behavior of falling back to hard-coded defaults wiped
  // out anything the user had previously set when omitted from the body
  const existing = await getRepoConfig(owner, repo);

  const config: RepoConfig = {
    ...(existing ?? {}),
    owner,
    repo,
    style: parsedStyle.success ? parsedStyle.data : (existing?.style ?? "balanced"),
    focusAreas: body.focusAreas ??
      existing?.focusAreas ?? ["security", "performance", "bugs", "style", "tests", "docs"],
    ignorePatterns: body.ignorePatterns ?? existing?.ignorePatterns ?? [],
    ...(typeof body.generateDescription === "boolean"
      ? { generateDescription: body.generateDescription }
      : {}),
    ...(typeof body.renameTitleToConventional === "boolean"
      ? { renameTitleToConventional: body.renameTitleToConventional }
      : {}),
    ...(typeof body.consensusPasses === "number" ? { consensusPasses: body.consensusPasses } : {}),
    ...("consensusThreshold" in body ? { consensusThreshold: body.consensusThreshold } : {}),
  };

  await setRepoConfig(owner, repo, config);
  return c.json(config);
});

app.get("/api/config/settings", async (c) => {
  const settings = await getSettings();
  return c.json(redactSettings(settings));
});

app.put("/api/config/settings", async (c) => {
  const body: Record<string, string> = await c.req.json();
  for (const [key, value] of Object.entries(body)) {
    await setSetting(key, value);
  }
  const settings = await getSettings();
  return c.json(redactSettings(settings));
});

app.get("/api/reviews", async (c) => {
  const limit = Number(c.req.query("limit") ?? "50");
  const offset = Number(c.req.query("offset") ?? "0");
  const { items, total } = await listReviewsPage(limit, offset);
  return c.json({ items, total });
});

app.get("/api/reviews/:id", async (c) => {
  const { id } = c.req.param();
  const review = await getReview(id);
  if (!review) {
    return c.json({ error: "not found" }, 404);
  }
  return c.json(review);
});

// serve dashboard static files — must be after API routes
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const dashboardEnabled = process.env.RUSTY_DASHBOARD === "true";

if (dashboardEnabled) {
  const __serverDir = dirname(fileURLToPath(import.meta.url));
  const dashboardDir =
    process.env.RUSTY_DASHBOARD_DIR ?? resolve(__serverDir, "../../dashboard/dist");

  const serveDashboardFile = async (filePath: string): Promise<Response | null> => {
    try {
      const full = join(dashboardDir, filePath);
      if (!full.startsWith(dashboardDir)) return null;
      await stat(full);
      const content = await readFile(full);
      const ext = filePath.substring(filePath.lastIndexOf("."));
      return new Response(content, {
        headers: { "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream" },
      });
    } catch {
      return null;
    }
  };

  app.get("*", async (c) => {
    const path = c.req.path;
    const file = await serveDashboardFile(path);
    if (file) return file;
    const index = await serveDashboardFile("/index.html");
    if (index) return index;
    return c.json({ error: "not found" }, 404);
  });
}

if (process.env.NODE_ENV !== "test") {
  configureGlobalHttp();
  const port = Number(process.env.PORT ?? 3000);
  serve({ fetch: app.fetch, port });
  log.info({ port }, "server listening");
}
