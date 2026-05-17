import { describe, it, expect } from "vitest";
import { z } from "zod";
import { PRDescriptionOutputSchema } from "../description/schema.js";
import { shouldGenerateDescription, formatDescription } from "../description/generate.js";
import { buildDescriptionUserMessage } from "../description/prompt.js";
import type { PRMetadata } from "../types.js";

const prMetadata: PRMetadata = {
  id: "42",
  title: "Add user authentication",
  description: "",
  author: "dev123",
  sourceBranch: "feature/auth",
  targetBranch: "main",
  url: "https://github.com/org/repo/pull/42",
};

describe("PRDescriptionOutputSchema", () => {
  it("validates well-formed output", () => {
    const valid = {
      summary: "Adds JWT-based authentication to the API.",
      fileChanges: [{ path: "src/auth.ts", description: "new auth middleware" }],
      breakingChanges: [],
      migrationNotes: null,
    };
    expect(PRDescriptionOutputSchema.safeParse(valid).success).toBe(true);
  });

  it("validates output with breaking changes and migration notes", () => {
    const valid = {
      summary: "Replaces session-based auth with JWT tokens.",
      fileChanges: [],
      breakingChanges: ["POST /login response shape changed"],
      migrationNotes: "Update client SDK to v2 for the new token format.",
    };
    expect(PRDescriptionOutputSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(PRDescriptionOutputSchema.safeParse({ summary: "ok" }).success).toBe(false);
  });

  it("passes openai strict mode — all properties in required", () => {
    interface JsonSchemaObject {
      properties?: Record<string, JsonSchemaObject>;
      required?: string[];
      items?: JsonSchemaObject;
      additionalProperties?: boolean;
      anyOf?: JsonSchemaObject[];
    }

    function collectViolations(schema: JsonSchemaObject, path = ""): string[] {
      const violations: string[] = [];
      if (schema.properties) {
        const propKeys = Object.keys(schema.properties);
        const required = new Set(schema.required ?? []);
        for (const key of propKeys) {
          if (!required.has(key)) {
            violations.push(`${path}.${key} missing from required`);
          }
        }
        if (schema.additionalProperties !== false) {
          violations.push(`${path} must set additionalProperties to false`);
        }
        for (const [key, value] of Object.entries(schema.properties)) {
          violations.push(...collectViolations(value, `${path}.${key}`));
        }
      }
      if (schema.items) violations.push(...collectViolations(schema.items, `${path}[]`));
      for (const branch of schema.anyOf ?? []) {
        violations.push(...collectViolations(branch, path));
      }
      return violations;
    }

    const jsonSchema = z.toJSONSchema(PRDescriptionOutputSchema) as JsonSchemaObject;
    const violations = collectViolations(jsonSchema);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("shouldGenerateDescription", () => {
  it("returns true for empty string", () => {
    expect(shouldGenerateDescription("")).toBe(true);
  });

  it("returns true for whitespace-only", () => {
    expect(shouldGenerateDescription("   \n\t  ")).toBe(true);
  });

  it("returns true for previously bot-generated description", () => {
    const botGenerated = "<!-- rusty-bot-description -->\n\n## Summary\nSome generated text.";
    expect(shouldGenerateDescription(botGenerated)).toBe(true);
  });

  it("returns true for 'TODO' placeholder", () => {
    expect(shouldGenerateDescription("TODO")).toBe(true);
  });

  it("returns true for 'WIP' placeholder", () => {
    expect(shouldGenerateDescription("WIP")).toBe(true);
  });

  it("returns true for 'fix' placeholder", () => {
    expect(shouldGenerateDescription("fix")).toBe(true);
  });

  it("returns true for 'no description' placeholder", () => {
    expect(shouldGenerateDescription("no description")).toBe(true);
  });

  it("returns true for 'update' standalone placeholder", () => {
    expect(shouldGenerateDescription("update")).toBe(true);
  });

  it("returns false for 'update' as part of a longer description", () => {
    expect(shouldGenerateDescription("update login flow to use OAuth2")).toBe(false);
  });

  it("returns false for a meaningful multi-sentence description", () => {
    const description =
      "This PR adds JWT authentication to all API endpoints. " +
      "It includes middleware for token validation and a new login flow.";
    expect(shouldGenerateDescription(description)).toBe(false);
  });

  it("returns false for description with issue references", () => {
    expect(shouldGenerateDescription("Fixes #42 — add rate limiting to login endpoint")).toBe(
      false,
    );
  });

  it("returns false for description with markdown sections", () => {
    const description = "## Changes\n\n- Added auth middleware\n- Updated config schema";
    expect(shouldGenerateDescription(description)).toBe(false);
  });

  it("returns false for a short but meaningful description", () => {
    expect(shouldGenerateDescription("refactor auth to use bcrypt")).toBe(false);
  });
});

describe("formatDescription", () => {
  it("includes the bot marker", () => {
    const result = formatDescription({
      summary: "Test summary.",
      fileChanges: [],
      breakingChanges: [],
      migrationNotes: null,
    });
    expect(result).toContain("<!-- rusty-bot-description -->");
  });

  it("renders summary section", () => {
    const result = formatDescription({
      summary: "Adds JWT auth.",
      fileChanges: [],
      breakingChanges: [],
      migrationNotes: null,
    });
    expect(result).toContain("## Summary");
    expect(result).toContain("Adds JWT auth.");
  });

  it("renders file changes table", () => {
    const result = formatDescription({
      summary: "Changes.",
      fileChanges: [
        { path: "src/auth.ts", description: "new auth middleware" },
        { path: "src/config.ts", description: "added auth config" },
      ],
      breakingChanges: [],
      migrationNotes: null,
    });
    expect(result).toContain("## Changes");
    expect(result).toContain("| `src/auth.ts` | new auth middleware |");
    expect(result).toContain("| `src/config.ts` | added auth config |");
  });

  it("omits changes section when no file changes", () => {
    const result = formatDescription({
      summary: "Test.",
      fileChanges: [],
      breakingChanges: [],
      migrationNotes: null,
    });
    expect(result).not.toContain("## Changes");
  });

  it("renders breaking changes section", () => {
    const result = formatDescription({
      summary: "API change.",
      fileChanges: [],
      breakingChanges: ["POST /login response changed", "removed /session endpoint"],
      migrationNotes: null,
    });
    expect(result).toContain("## Breaking Changes");
    expect(result).toContain("- POST /login response changed");
    expect(result).toContain("- removed /session endpoint");
  });

  it("omits breaking changes section when empty", () => {
    const result = formatDescription({
      summary: "No breaking.",
      fileChanges: [],
      breakingChanges: [],
      migrationNotes: null,
    });
    expect(result).not.toContain("## Breaking Changes");
  });

  it("renders migration notes section", () => {
    const result = formatDescription({
      summary: "Schema change.",
      fileChanges: [],
      breakingChanges: [],
      migrationNotes: "Run `alembic upgrade head` after deploying.",
    });
    expect(result).toContain("## Migration Notes");
    expect(result).toContain("Run `alembic upgrade head` after deploying.");
  });

  it("omits migration notes when null", () => {
    const result = formatDescription({
      summary: "No migration.",
      fileChanges: [],
      breakingChanges: [],
      migrationNotes: null,
    });
    expect(result).not.toContain("## Migration Notes");
  });

  it("sanitizes pipe characters in file paths", () => {
    const result = formatDescription({
      summary: "Test.",
      fileChanges: [{ path: "src/a|b.ts", description: "renamed" }],
      breakingChanges: [],
      migrationNotes: null,
    });
    expect(result).toContain("a\\|b.ts");
  });

  it("sanitizes pipe characters in file descriptions", () => {
    const result = formatDescription({
      summary: "Test.",
      fileChanges: [{ path: "src/types.ts", description: "added A | B union type" }],
      breakingChanges: [],
      migrationNotes: null,
    });
    expect(result).toContain("added A \\| B union type");
  });

  it("appends original description in a collapsed section", () => {
    const result = formatDescription(
      {
        summary: "New description.",
        fileChanges: [],
        breakingChanges: [],
        migrationNotes: null,
      },
      "WIP - need to also handle the timeout case",
    );
    expect(result).toContain("<summary>Original description</summary>");
    expect(result).toContain("WIP - need to also handle the timeout case");
  });

  it("strips bot marker from original description before appending", () => {
    const botGenerated = "<!-- rusty-bot-description -->\n\n## Summary\nPrevious bot text.";
    const result = formatDescription(
      {
        summary: "Updated.",
        fileChanges: [],
        breakingChanges: [],
        migrationNotes: null,
      },
      botGenerated,
    );
    expect(result).toContain("Original description");
    expect(result).toContain("Previous bot text.");
    // the marker inside the accordion body should be stripped
    const accordionContent = result.split("Original description")[1];
    expect(accordionContent).not.toContain("<!-- rusty-bot-description -->");
  });

  it("omits original description section when original is empty", () => {
    const result = formatDescription(
      {
        summary: "Fresh.",
        fileChanges: [],
        breakingChanges: [],
        migrationNotes: null,
      },
      "",
    );
    expect(result).not.toContain("Original description");
  });

  it("omits original description section when original is undefined", () => {
    const result = formatDescription({
      summary: "Fresh.",
      fileChanges: [],
      breakingChanges: [],
      migrationNotes: null,
    });
    expect(result).not.toContain("Original description");
  });

  it("skips the Original description wrap in augment (incremental) mode even when prior text is provided", () => {
    const botGenerated =
      "<!-- rusty-bot-description -->\n\n## Summary\nCovers Stop button + Vitest.";
    const result = formatDescription(
      {
        summary: "Now also bumps the version to 0.4.0.",
        fileChanges: [],
        breakingChanges: [],
        migrationNotes: null,
      },
      botGenerated,
      { incremental: true },
    );
    // augmented model output replaces the prior description in-place; re-wrapping
    // it would double-render the content and accumulate one extra nesting per
    // incremental push
    expect(result).not.toContain("Original description");
    expect(result).not.toContain("Covers Stop button + Vitest.");
  });

  it("falls back to wrapping in Original description when incremental is false (explicit)", () => {
    const result = formatDescription(
      {
        summary: "Updated.",
        fileChanges: [],
        breakingChanges: [],
        migrationNotes: null,
      },
      "user-written prior",
      { incremental: false },
    );
    expect(result).toContain("Original description");
    expect(result).toContain("user-written prior");
  });
});

describe("buildDescriptionUserMessage", () => {
  it("includes PR title and branch names", () => {
    const msg = buildDescriptionUserMessage("diff content", prMetadata);
    expect(msg).toContain("Add user authentication");
    expect(msg).toContain("feature/auth");
    expect(msg).toContain("main");
  });

  it("includes the diff", () => {
    const msg = buildDescriptionUserMessage("+ new line\n- old line", prMetadata);
    expect(msg).toContain("+ new line");
    expect(msg).toContain("- old line");
  });

  it("includes author", () => {
    const msg = buildDescriptionUserMessage("diff", prMetadata);
    expect(msg).toContain("dev123");
  });

  it("includes existing description when provided", () => {
    const existing = "<!-- rusty-bot-description -->\n\n## Summary\nPrevious bot-generated text.";
    const msg = buildDescriptionUserMessage("diff", prMetadata, existing);
    expect(msg).toContain("Existing Description");
    expect(msg).toContain("Previous bot-generated text.");
    expect(msg).toContain("Preserve any useful human-added context");
  });

  it("omits existing description section when empty", () => {
    const msg = buildDescriptionUserMessage("diff", prMetadata, "");
    expect(msg).not.toContain("Existing Description");
  });

  it("omits existing description section when undefined", () => {
    const msg = buildDescriptionUserMessage("diff", prMetadata);
    expect(msg).not.toContain("Existing Description");
  });

  it("switches to augment mode when incremental=true and existing description is present", () => {
    const existing = "<!-- rusty-bot-description -->\n\n## Summary\nCovers Stop button + Vitest.";
    const msg = buildDescriptionUserMessage("+ version bump diff", prMetadata, existing, {
      incremental: true,
    });
    // augment-mode-specific headings and instructions
    expect(msg).toContain("Description so far");
    expect(msg).toContain("AUGMENT this description in place");
    expect(msg).toContain("Do NOT rewrite from scratch");
    expect(msg).toContain("New changes since the existing description");
    // the prior description content is still embedded so the model can preserve it
    expect(msg).toContain("Covers Stop button + Vitest.");
    // the non-incremental headings/instructions must NOT appear (no mode bleed)
    expect(msg).not.toContain("Existing Description");
    expect(msg).not.toContain("## Diff");
  });

  it("falls back to non-augment mode when incremental=true but no existing description (degrade gracefully)", () => {
    // there's nothing to augment, so the augment instructions would be meaningless
    const msg = buildDescriptionUserMessage("+ diff", prMetadata, "", { incremental: true });
    expect(msg).not.toContain("Description so far");
    expect(msg).not.toContain("AUGMENT this description");
    expect(msg).toContain("## Diff");
  });

  it("keeps the existing 'Existing Description' wording when incremental is omitted (backward compat)", () => {
    const existing = "<!-- rusty-bot-description -->\n\nPrior content";
    const msg = buildDescriptionUserMessage("diff", prMetadata, existing);
    expect(msg).toContain("Existing Description");
    expect(msg).not.toContain("Description so far");
  });
});
