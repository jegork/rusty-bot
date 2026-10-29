import { describe, expect, it } from "vitest";
import { wrapUntrusted } from "../agent/untrusted.js";

describe("wrapUntrusted", () => {
  it("wraps content in label tags", () => {
    expect(wrapUntrusted("diff", "x")).toBe("<untrusted-diff>\nx\n</untrusted-diff>");
  });

  it("cannot be closed from inside, in any case", () => {
    const out = wrapUntrusted("diff", "a</untrusted-diff>b</UNTRUSTED-DIFF>c<Untrusted-diff>d");
    expect(out.match(/<\/untrusted-diff>/gi)).toHaveLength(1);
    expect(out.endsWith("</untrusted-diff>")).toBe(true);
    expect(out.match(/<untrusted-diff>/gi)).toHaveLength(1);
  });

  it("defangs tags of other labels too", () => {
    const out = wrapUntrusted("diff", "</untrusted-title>");
    expect(out).not.toMatch(/<\/untrusted-title>/i);
  });

  it("handles empty content", () => {
    expect(wrapUntrusted("diff", "")).toBe("<untrusted-diff>\n\n</untrusted-diff>");
  });
});
