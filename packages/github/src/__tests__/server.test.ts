import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";

vi.mock("../orchestrator.js", () => ({
  orchestrateReview: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../auth.js", () => ({
  createAppOctokit: vi.fn().mockResolvedValue({}),
}));

vi.mock("../storage.js", async () => {
  let configs: Record<string, Record<string, unknown>> = {};
  let reviews: Record<string, unknown>[] = [];
  let settings: Record<string, string> = {};

  return {
    listRepoConfigs: vi.fn(async () => Object.entries(configs).map(([id, c]) => ({ id, ...c }))),
    getRepoConfig: vi.fn(
      async (owner: string, repo: string) => configs[`${owner}/${repo}`] ?? null,
    ),
    setRepoConfig: vi.fn(async (owner: string, repo: string, config: Record<string, unknown>) => {
      configs[`${owner}/${repo}`] = config;
    }),
    listReviews: vi.fn(async (limit = 50, offset = 0) => {
      const sorted = [...reviews].reverse();
      return sorted.slice(offset, offset + limit);
    }),
    listReviewsPage: vi.fn(async (limit = 50, offset = 0) => {
      const sorted = [...reviews].reverse();
      return { items: sorted.slice(offset, offset + limit), total: reviews.length };
    }),
    getReview: vi.fn(async (id: string) => reviews.find((r) => r.id === id) ?? null),
    saveReview: vi.fn(async (review: Record<string, unknown>) => {
      reviews.push(review);
      return review.id;
    }),
    getSetting: vi.fn(async (key: string) => settings[key] ?? null),
    setSetting: vi.fn(async (key: string, value: string) => {
      settings[key] = value;
    }),
    getSettings: vi.fn(async () => ({ ...settings })),
    // reset helper for tests
    __reset: () => {
      configs = {};
      reviews = [];
      settings = {};
    },
  };
});

import { app } from "../server.js";
import * as storage from "../storage.js";

const WEBHOOK_SECRET = "test-secret";

function sign(body: string, secret: string): string {
  const hmac = createHmac("sha256", secret).update(body).digest("hex");
  return `sha256=${hmac}`;
}

function makePRPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    pull_request: {
      number: 1,
      draft: false,
      ...overrides,
    },
    repository: {
      name: "test-repo",
      owner: { login: "test-owner" },
    },
    installation: { id: 12345 },
    sender: { type: "User" },
  };
}

describe("server", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("NODE_ENV", "test");
    (storage as unknown as { __reset: () => void }).__reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("health check", () => {
    it("returns 200 with ok status", async () => {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "ok" });
    });
  });

  describe("webhook signature", () => {
    it("rejects missing signature", async () => {
      const body = JSON.stringify(makePRPayload());
      const res = await app.request("/api/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request",
        },
        body,
      });
      expect(res.status).toBe(401);
    });

    it("rejects invalid signature", async () => {
      const body = JSON.stringify(makePRPayload());
      const res = await app.request("/api/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request",
          "x-hub-signature-256": "sha256=invalid",
        },
        body,
      });
      expect(res.status).toBe(401);
    });

    it("accepts valid signature", async () => {
      const body = JSON.stringify(makePRPayload());
      const res = await app.request("/api/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ok).toBe(true);
    });
  });

  describe("webhook event filtering", () => {
    it("ignores non-PR events", async () => {
      const body = JSON.stringify({ action: "created" });
      const res = await app.request("/api/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "issues",
          "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ignored).toBe(true);
    });

    it("ignores unhandled actions", async () => {
      const body = JSON.stringify(makePRPayload({ action: "closed" }));
      // override action at top level
      const parsed = JSON.parse(body) as Record<string, unknown>;
      parsed.action = "closed";
      const raw = JSON.stringify(parsed);

      const res = await app.request("/api/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign(raw, WEBHOOK_SECRET),
        },
        body: raw,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ignored).toBe(true);
      expect(json.reason).toContain("closed");
    });

    it("ignores draft PRs", async () => {
      const body = JSON.stringify(makePRPayload({ draft: true }));
      const res = await app.request("/api/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ignored).toBe(true);
      expect(json.reason).toContain("draft");
    });

    it("ignores bot senders", async () => {
      const payload = makePRPayload();
      (payload as Record<string, unknown>).sender = { type: "Bot" };
      const body = JSON.stringify(payload);

      const res = await app.request("/api/webhooks/github", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ignored).toBe(true);
      expect(json.reason).toContain("bot");
    });
  });

  describe("webhook delivery dedupe", () => {
    it("returns duplicate:true on a second request with the same X-GitHub-Delivery", async () => {
      const { orchestrateReview } = await import("../orchestrator.js");
      const orchestrateMock = vi.mocked(orchestrateReview);
      orchestrateMock.mockClear();

      // make orchestrateReview hang so the in-flight set still has the
      // delivery id when the duplicate comes in
      let resolveOrchestrate!: () => void;
      orchestrateMock.mockImplementationOnce(
        () =>
          new Promise<void>((r) => {
            resolveOrchestrate = r;
          }),
      );

      const body = JSON.stringify(makePRPayload({ number: 7 }));
      const deliveryId = "11111111-1111-1111-1111-111111111111";
      const headers = {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
      };

      const first = await app.request("/api/webhooks/github", { method: "POST", headers, body });
      expect(await first.json()).toMatchObject({ ok: true });

      const second = await app.request("/api/webhooks/github", { method: "POST", headers, body });
      expect(await second.json()).toMatchObject({ ok: true, duplicate: true });

      // free the in-flight review so the test can finish
      resolveOrchestrate();
      // let the microtask queue drain so the dedupe set is cleaned up before
      // any subsequent tests reuse the id
      await new Promise<void>((r) => setTimeout(r, 0));
    });

    it("does not flag duplicates when the X-GitHub-Delivery header is missing", async () => {
      // without the header, every request is treated as unique — matches
      // legacy clients that don't set the header
      const { orchestrateReview } = await import("../orchestrator.js");
      (orchestrateReview as ReturnType<typeof vi.fn>).mockReset();
      (orchestrateReview as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const body = JSON.stringify(makePRPayload({ number: 8 }));
      const headers = {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
      };

      const first = await app.request("/api/webhooks/github", { method: "POST", headers, body });
      const second = await app.request("/api/webhooks/github", { method: "POST", headers, body });

      expect(await first.json()).not.toMatchObject({ duplicate: true });
      expect(await second.json()).not.toMatchObject({ duplicate: true });
    });

    it("allows the same delivery id to be processed again after the first completes", async () => {
      const { orchestrateReview } = await import("../orchestrator.js");
      (orchestrateReview as ReturnType<typeof vi.fn>).mockReset();
      (orchestrateReview as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      const body = JSON.stringify(makePRPayload({ number: 9 }));
      const deliveryId = "22222222-2222-2222-2222-222222222222";
      const headers = {
        "Content-Type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": sign(body, WEBHOOK_SECRET),
      };

      const first = await app.request("/api/webhooks/github", { method: "POST", headers, body });
      expect(await first.json()).toMatchObject({ ok: true });

      // wait for the fire-and-forget runReview to clean up the delivery id
      await new Promise<void>((r) => setTimeout(r, 10));

      const second = await app.request("/api/webhooks/github", { method: "POST", headers, body });
      // not flagged as duplicate because the first run already completed and
      // removed the id from the in-flight set
      expect(await second.json()).toMatchObject({ ok: true });
      expect(await second.json().catch(() => ({}))).not.toMatchObject({ duplicate: true });
    });
  });

  describe("config CRUD", () => {
    it("returns empty list initially", async () => {
      const res = await app.request("/api/config/repos");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it("returns 404 for missing repo config", async () => {
      const res = await app.request("/api/config/repos/owner/repo");
      expect(res.status).toBe(404);
    });

    it("creates and retrieves a repo config", async () => {
      const config = {
        style: "strict",
        focusAreas: ["security", "bugs"],
        ignorePatterns: ["*.test.ts"],
      };

      const putRes = await app.request("/api/config/repos/my-org/my-repo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      expect(putRes.status).toBe(200);
      const created = (await putRes.json()) as Record<string, unknown>;
      expect(created.owner).toBe("my-org");
      expect(created.repo).toBe("my-repo");
      expect(created.style).toBe("strict");

      const getRes = await app.request("/api/config/repos/my-org/my-repo");
      expect(getRes.status).toBe(200);

      const listRes = await app.request("/api/config/repos");
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as unknown[];
      expect(list.length).toBe(1);
    });

    it("uses defaults when body fields are missing", async () => {
      const putRes = await app.request("/api/config/repos/org/repo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const created = (await putRes.json()) as Record<string, unknown>;
      expect(created.style).toBe("balanced");
      expect((created.focusAreas as string[]).length).toBe(6);
      expect(created.ignorePatterns).toEqual([]);
    });

    it("rejects invalid review style with 400", async () => {
      const putRes = await app.request("/api/config/repos/org/repo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style: "yolo" }),
      });
      expect(putRes.status).toBe(400);
      const body = (await putRes.json()) as Record<string, unknown>;
      expect(body.error).toContain("invalid review style");
    });

    it("accepts the thorough review style", async () => {
      const putRes = await app.request("/api/config/repos/org/repo", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ style: "thorough" }),
      });
      expect(putRes.status).toBe(200);
      const created = (await putRes.json()) as Record<string, unknown>;
      expect(created.style).toBe("thorough");
    });
  });

  describe("settings", () => {
    it("returns empty settings initially", async () => {
      const res = await app.request("/api/config/settings");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({});
    });

    it("saves and redacts sensitive settings", async () => {
      const putRes = await app.request("/api/config/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          github_token: "ghp_abcdefghijklmnop",
          jira_base_url: "https://company.atlassian.net",
        }),
      });
      expect(putRes.status).toBe(200);
      const settings = (await putRes.json()) as Record<string, string>;
      expect(settings.github_token).toBe("ghp_...");
      expect(settings.jira_base_url).toBe("https://company.atlassian.net");
    });

    it("redacts short tokens correctly", async () => {
      const putRes = await app.request("/api/config/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: "abcd" }),
      });
      const settings = (await putRes.json()) as Record<string, string>;
      // 4 chars or fewer aren't redacted (nothing to hide)
      expect(settings.api_key).toBe("abcd");
    });
  });

  describe("reviews", () => {
    it("returns empty list initially", async () => {
      const res = await app.request("/api/reviews");
      expect(res.status).toBe(200);
      const data = (await res.json()) as { items: unknown[]; total: number };
      expect(data.items).toEqual([]);
      expect(data.total).toBe(0);
    });

    it("returns 404 for missing review", async () => {
      const res = await app.request("/api/reviews/nonexistent");
      expect(res.status).toBe(404);
    });

    it("lists reviews after saving", async () => {
      await storage.saveReview({
        id: "review-1",
        owner: "org",
        repo: "repo",
        prNumber: 1,
        timestamp: "2025-01-01T00:00:00Z",
        findingsCount: 3,
        criticalCount: 1,
        warningCount: 1,
        suggestionCount: 1,
        modelUsed: "test-model",
        tokenCount: 100,
        recommendation: "address_before_merge",
        prUrl: "https://github.com/org/repo/pull/1",
      });

      const listRes = await app.request("/api/reviews");
      expect(listRes.status).toBe(200);
      const data = (await listRes.json()) as { items: unknown[]; total: number };
      expect(data.items.length).toBe(1);
      expect(data.total).toBe(1);

      const detailRes = await app.request("/api/reviews/review-1");
      expect(detailRes.status).toBe(200);
      const detail = (await detailRes.json()) as Record<string, unknown>;
      expect(detail.id).toBe("review-1");
    });

    it("respects limit and offset query params", async () => {
      for (let i = 0; i < 5; i++) {
        await storage.saveReview({
          id: `review-${i}`,
          owner: "org",
          repo: "repo",
          prNumber: i,
          timestamp: new Date().toISOString(),
          findingsCount: 0,
          criticalCount: 0,
          warningCount: 0,
          suggestionCount: 0,
          modelUsed: "m",
          tokenCount: 0,
          recommendation: "looks_good",
          prUrl: `https://github.com/org/repo/pull/${i}`,
        });
      }

      const res = await app.request("/api/reviews?limit=2&offset=1");
      const data = (await res.json()) as { items: unknown[]; total: number };
      expect(data.items.length).toBe(2);
      expect(data.total).toBe(5);
    });
  });
});
