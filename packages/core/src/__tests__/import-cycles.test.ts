import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

// guards the judge <-> multi-call import cycle (and triage depending on the orchestrator)
describe("import cycles", () => {
  it.each(["../agent/judge.ts", "../triage/triage.ts"])("%s does not import multi-call", (rel) => {
    const source = readFileSync(new URL(rel, import.meta.url), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*multi-call\.js["']/);
  });
});
