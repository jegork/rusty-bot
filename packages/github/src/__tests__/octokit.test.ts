import { describe, it, expect, vi } from "vitest";
import { onRateLimit, onSecondaryRateLimit, RustyOctokit } from "../octokit.js";

function makeOctokit() {
  return { log: { warn: vi.fn(), info: vi.fn() } } as any;
}

function makeOptions(url: string, retryCount = 0) {
  return { method: "GET", url, request: { retryCount } } as any;
}

describe("RustyOctokit throttle handlers", () => {
  for (const [name, handler] of [
    ["onRateLimit", onRateLimit],
    ["onSecondaryRateLimit", onSecondaryRateLimit],
  ] as const) {
    describe(name, () => {
      it("declines to retry code search", () => {
        expect(handler(30, makeOptions("/search/code"), makeOctokit())).toBe(false);
      });

      it("declines to retry code search even on the first attempt", () => {
        expect(handler(1, makeOptions("/search/code", 0), makeOctokit())).toBe(false);
      });

      it("retries other routes once", () => {
        expect(
          handler(5, makeOptions("/repos/{owner}/{repo}/pulls/{pull_number}"), makeOctokit()),
        ).toBe(true);
      });

      it("does not retry other routes a second time", () => {
        expect(
          handler(5, makeOptions("/repos/{owner}/{repo}/pulls/{pull_number}", 1), makeOctokit()),
        ).toBeFalsy();
      });
    });
  }

  it("builds an Octokit with throttling configured", () => {
    const octokit = new RustyOctokit({ auth: "token" });
    expect(typeof octokit.request).toBe("function");
  });
});
