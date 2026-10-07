import { describe, it, expect } from "vitest";
import { parseArgs } from "../args.js";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe("parseArgs", () => {
  it("returns defaults when no args are provided", () => {
    const args = parseArgs([], EMPTY_ENV);
    expect(args.baseRef).toBe("main");
    expect(args.headRef).toBe("HEAD");
    expect(args.style).toBe("balanced");
    expect(args.format).toBe("markdown");
    expect(args.failOnCritical).toBe(false);
    expect(args.focusAreas).toEqual(["security", "performance", "bugs", "style", "tests", "docs"]);
    expect(args.ignorePatterns).toEqual([]);
  });

  it("parses repo, base, head, and style", () => {
    const args = parseArgs(
      ["--repo", "/tmp/repo", "--base", "develop", "--head", "feature-branch", "--style", "strict"],
      EMPTY_ENV,
    );
    expect(args.repoPath).toBe("/tmp/repo");
    expect(args.baseRef).toBe("develop");
    expect(args.headRef).toBe("feature-branch");
    expect(args.style).toBe("strict");
  });

  it("parses focus areas as a comma list", () => {
    const args = parseArgs(["--focus", "security,bugs"], EMPTY_ENV);
    expect(args.focusAreas).toEqual(["security", "bugs"]);
  });

  it("rejects unknown focus areas", () => {
    expect(() => parseArgs(["--focus", "security,wat"], EMPTY_ENV)).toThrow(/unknown focus area/);
  });

  it("rejects an empty --focus value instead of silently expanding to all", () => {
    expect(() => parseArgs(["--focus", ""], EMPTY_ENV)).toThrow(/at least one focus area/);
    expect(() => parseArgs(["--focus", ",, "], EMPTY_ENV)).toThrow(/at least one focus area/);
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["--bogus"], EMPTY_ENV)).toThrow(/unknown option/);
  });

  it("rejects invalid style", () => {
    expect(() => parseArgs(["--style", "ferocious"], EMPTY_ENV)).toThrow(/invalid review style/);
  });

  it("rejects invalid format", () => {
    expect(() => parseArgs(["--format", "yaml"], EMPTY_ENV)).toThrow(/invalid format/);
  });

  it("requires a value after a flag that takes one", () => {
    expect(() => parseArgs(["--base"], EMPTY_ENV)).toThrow(/requires a value/);
    expect(() => parseArgs(["--base", "--head", "x"], EMPTY_ENV)).toThrow(/requires a value/);
  });

  it("supports --fail-on-critical and --help", () => {
    const args = parseArgs(["--fail-on-critical", "--help"], EMPTY_ENV);
    expect(args.failOnCritical).toBe(true);
    expect(args.help).toBe(true);
  });

  it("parses ignore patterns", () => {
    const args = parseArgs(["--ignore", "dist/**,*.lock"], EMPTY_ENV);
    expect(args.ignorePatterns).toEqual(["dist/**", "*.lock"]);
  });

  it("supports --flag=value syntax for value-bearing flags", () => {
    const args = parseArgs(
      ["--repo=/tmp/r", "--style=strict", "--focus=security,bugs", "--ignore=dist/**,*.lock"],
      EMPTY_ENV,
    );
    expect(args.repoPath).toBe("/tmp/r");
    expect(args.style).toBe("strict");
    expect(args.focusAreas).toEqual(["security", "bugs"]);
    expect(args.ignorePatterns).toEqual(["dist/**", "*.lock"]);
  });

  describe("environment variable defaults", () => {
    it("reads RUSTY_REVIEW_STYLE, RUSTY_FOCUS_AREAS, RUSTY_IGNORE_PATTERNS, RUSTY_FAIL_ON_CRITICAL", () => {
      const args = parseArgs([], {
        RUSTY_REVIEW_STYLE: "strict",
        RUSTY_FOCUS_AREAS: "security,bugs",
        RUSTY_IGNORE_PATTERNS: "dist/**, *.lock",
        RUSTY_FAIL_ON_CRITICAL: "true",
      });
      expect(args.style).toBe("strict");
      expect(args.focusAreas).toEqual(["security", "bugs"]);
      expect(args.ignorePatterns).toEqual(["dist/**", "*.lock"]);
      expect(args.failOnCritical).toBe(true);
    });

    it("flag values override environment variable values", () => {
      const args = parseArgs(["--style", "lenient", "--focus", "performance"], {
        RUSTY_REVIEW_STYLE: "strict",
        RUSTY_FOCUS_AREAS: "security,bugs",
      });
      expect(args.style).toBe("lenient");
      expect(args.focusAreas).toEqual(["performance"]);
    });

    it("RUSTY_FAIL_ON_CRITICAL only opts in on the literal 'true'", () => {
      expect(parseArgs([], { RUSTY_FAIL_ON_CRITICAL: "false" }).failOnCritical).toBe(false);
      expect(parseArgs([], { RUSTY_FAIL_ON_CRITICAL: "1" }).failOnCritical).toBe(false);
      expect(parseArgs([], { RUSTY_FAIL_ON_CRITICAL: "" }).failOnCritical).toBe(false);
      expect(parseArgs([], { RUSTY_FAIL_ON_CRITICAL: "true" }).failOnCritical).toBe(true);
    });

    it("rejects an invalid RUSTY_REVIEW_STYLE", () => {
      expect(() => parseArgs([], { RUSTY_REVIEW_STYLE: "ferocious" })).toThrow(
        /invalid RUSTY_REVIEW_STYLE/,
      );
    });

    it("rejects unknown values in RUSTY_FOCUS_AREAS", () => {
      expect(() => parseArgs([], { RUSTY_FOCUS_AREAS: "security,wat" })).toThrow(
        /RUSTY_FOCUS_AREAS/,
      );
    });
  });
});

describe("parseArgs scope creep flag", () => {
  it("is off by default", () => {
    expect(parseArgs([], EMPTY_ENV).flagScopeCreep).toBe(false);
  });

  it("reads RUSTY_FLAG_SCOPE_CREEP=true from the environment", () => {
    expect(parseArgs([], { RUSTY_FLAG_SCOPE_CREEP: "true" }).flagScopeCreep).toBe(true);
  });

  it("ignores values other than the literal true", () => {
    expect(parseArgs([], { RUSTY_FLAG_SCOPE_CREEP: "1" }).flagScopeCreep).toBe(false);
  });
});
