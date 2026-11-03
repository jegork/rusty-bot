import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  ReviewOutputSchema,
  ScopeCreepReviewOutputSchema,
  RiskReviewOutputSchema,
  ScopeCreepRiskReviewOutputSchema,
  selectDeepReviewOutputSchema,
  SkimReviewOutputSchema,
} from "../agent/schema.js";
import { TriageOutputSchema } from "../triage/schema.js";

interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  items?: JsonSchemaObject;
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  allOf?: JsonSchemaObject[];
  additionalProperties?: boolean;
}

// openai strict mode requires every key in `properties` to also be in `required`.
// optional fields must be represented as required + nullable, not omitted from required.
function collectStrictViolations(schema: JsonSchemaObject, path = ""): string[] {
  const violations: string[] = [];

  if (schema.properties) {
    const propKeys = Object.keys(schema.properties);
    const required = new Set(schema.required ?? []);
    for (const key of propKeys) {
      if (!required.has(key)) {
        violations.push(`${path}.${key} is in properties but missing from required`);
      }
    }

    if (schema.additionalProperties !== false) {
      violations.push(`${path} must set additionalProperties to false`);
    }

    for (const [key, value] of Object.entries(schema.properties)) {
      violations.push(...collectStrictViolations(value, `${path}.${key}`));
    }
  }

  if (schema.items) {
    violations.push(...collectStrictViolations(schema.items, `${path}[]`));
  }

  for (const branch of [
    ...(schema.anyOf ?? []),
    ...(schema.oneOf ?? []),
    ...(schema.allOf ?? []),
  ]) {
    violations.push(...collectStrictViolations(branch, path));
  }

  return violations;
}

describe("ReviewOutputSchema strict mode compatibility", () => {
  it("has all properties listed in required (openai strict structured output)", () => {
    const jsonSchema = z.toJSONSchema(ReviewOutputSchema) as JsonSchemaObject;
    const violations = collectStrictViolations(jsonSchema);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("SkimReviewOutputSchema strict mode compatibility", () => {
  it("has all properties listed in required", () => {
    const jsonSchema = z.toJSONSchema(SkimReviewOutputSchema) as JsonSchemaObject;
    const violations = collectStrictViolations(jsonSchema);
    expect(violations, violations.join("\n")).toEqual([]);
  });

  it("includes suggestedFix in findings", () => {
    const jsonSchema = z.toJSONSchema(SkimReviewOutputSchema) as JsonSchemaObject;
    const findingsItems = jsonSchema.properties?.findings?.items;
    expect(findingsItems?.properties).toHaveProperty("suggestedFix");
  });
});

describe("TriageOutputSchema strict mode compatibility", () => {
  it("has all properties listed in required", () => {
    const jsonSchema = z.toJSONSchema(TriageOutputSchema) as JsonSchemaObject;
    const violations = collectStrictViolations(jsonSchema);
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("ScopeCreepReviewOutputSchema strict mode compatibility", () => {
  it("has all properties listed in required, including scopeCreep", () => {
    const jsonSchema = z.toJSONSchema(ScopeCreepReviewOutputSchema) as JsonSchemaObject;
    const violations = collectStrictViolations(jsonSchema);
    expect(violations, violations.join("\n")).toEqual([]);
    expect(jsonSchema.required).toContain("scopeCreep");
  });

  it("does not leak scopeCreep into the base schema", () => {
    const jsonSchema = z.toJSONSchema(ReviewOutputSchema) as JsonSchemaObject;
    expect(jsonSchema.required).not.toContain("scopeCreep");
  });
});

describe("risk assessment output schemas", () => {
  it("adds riskAssessment as a required strict-mode property", () => {
    const jsonSchema = z.toJSONSchema(RiskReviewOutputSchema) as JsonSchemaObject;
    const violations = collectStrictViolations(jsonSchema);
    expect(violations, violations.join("\n")).toEqual([]);
    expect(jsonSchema.required).toContain("riskAssessment");
    expect(jsonSchema.required).not.toContain("scopeCreep");
  });

  it("combines with scope creep without losing either field", () => {
    const jsonSchema = z.toJSONSchema(ScopeCreepRiskReviewOutputSchema) as JsonSchemaObject;
    expect(collectStrictViolations(jsonSchema)).toEqual([]);
    expect(jsonSchema.required).toEqual(expect.arrayContaining(["riskAssessment", "scopeCreep"]));
  });

  it("selects the schema matching the enabled sections", () => {
    expect(selectDeepReviewOutputSchema({})).toBe(ReviewOutputSchema);
    expect(selectDeepReviewOutputSchema({ scopeCreep: true })).toBe(ScopeCreepReviewOutputSchema);
    expect(selectDeepReviewOutputSchema({ riskAssessment: true })).toBe(RiskReviewOutputSchema);
    expect(selectDeepReviewOutputSchema({ scopeCreep: true, riskAssessment: true })).toBe(
      ScopeCreepRiskReviewOutputSchema,
    );
  });

  it("does not leak riskAssessment into the base or skim schema", () => {
    expect((z.toJSONSchema(ReviewOutputSchema) as JsonSchemaObject).required).not.toContain(
      "riskAssessment",
    );
    expect((z.toJSONSchema(SkimReviewOutputSchema) as JsonSchemaObject).required).not.toContain(
      "riskAssessment",
    );
  });

  it("lets the model answer the three questions but never pick the level", () => {
    const props = (z.toJSONSchema(RiskReviewOutputSchema) as JsonSchemaObject).properties
      ?.riskAssessment;
    expect(Object.keys(props?.properties ?? {}).sort()).toEqual([
      "detectability",
      "justification",
      "reasons",
      "reversibility",
      "scope",
    ]);
  });
});
