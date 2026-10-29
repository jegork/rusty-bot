import { describe, it, expect, vi, afterEach } from "vitest";

const serve = vi.hoisted(() => vi.fn());
vi.mock("@hono/node-server", () => ({ serve }));

vi.mock("../orchestrator.js", () => ({ orchestrateReview: vi.fn() }));
vi.mock("../auth.js", () => ({ createAppOctokit: vi.fn() }));
vi.mock("../storage.js", () => ({}));

describe("server module import", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    serve.mockClear();
  });

  it("does not start listening when NODE_ENV is not test", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await import("../server.js");
    expect(serve).not.toHaveBeenCalled();
  });
});
