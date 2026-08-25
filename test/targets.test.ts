import { describe, expect, it } from "vitest";
import { target, targets } from "../src/index.js";
import { UnknownTargetError } from "../src/errors.js";
import type { TargetId } from "../src/types.js";

const EXPECTED_ALLOW: Record<TargetId, number> = {
  "gemini.functionDeclarationParameters": 22,
  "gemini.parametersJsonSchema": 21,
  "openai.strict": 14,
};

const EXPECTED_DENY: Record<TargetId, number> = {
  "gemini.functionDeclarationParameters": 0,
  "gemini.parametersJsonSchema": 0,
  "openai.strict": 19,
};

describe("8. targets", () => {
  it("8. there are exactly three profiles with unique ids", () => {
    const all = targets();
    expect(all.length).toBe(3);
    expect(new Set(all.map((profile) => profile.id)).size).toBe(3);
  });

  for (const profile of targets()) {
    it(`8. ${profile.id} allow and deny are disjoint and duplicate-free`, () => {
      expect(new Set(profile.allow).size).toBe(profile.allow.length);
      expect(new Set(profile.deny).size).toBe(profile.deny.length);
      const overlap = profile.allow.filter((keyword) => profile.deny.includes(keyword));
      expect(overlap).toEqual([]);
    });

    it(`8. ${profile.id} lists the counted number of keywords`, () => {
      expect(profile.allow.length).toBe(EXPECTED_ALLOW[profile.id]);
      expect(profile.deny.length).toBe(EXPECTED_DENY[profile.id]);
    });

    it(`8. ${profile.id} cites a source it was actually read from`, () => {
      expect(profile.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(profile.sourceUrl.startsWith("https://")).toBe(true);
      expect(profile.sourceVersion.length).toBeGreaterThan(0);
      expect(profile.notes.length).toBeGreaterThan(0);
      expect(Object.isFrozen(profile)).toBe(true);
    });
  }

  it("8. the gemini function-declaration allowlist is the interface, in order", () => {
    expect(target("gemini.functionDeclarationParameters").allow).toEqual([
      "anyOf",
      "default",
      "description",
      "enum",
      "example",
      "format",
      "items",
      "maxItems",
      "maxLength",
      "maxProperties",
      "maximum",
      "minItems",
      "minLength",
      "minProperties",
      "minimum",
      "nullable",
      "pattern",
      "properties",
      "propertyOrdering",
      "required",
      "title",
      "type",
    ]);
  });

  it("8. the gemini parametersJsonSchema allowlist is the documented list, in order", () => {
    expect(target("gemini.parametersJsonSchema").allow).toEqual([
      "$id",
      "$defs",
      "$ref",
      "$anchor",
      "type",
      "format",
      "title",
      "description",
      "enum",
      "items",
      "prefixItems",
      "minItems",
      "maxItems",
      "minimum",
      "maximum",
      "anyOf",
      "oneOf",
      "properties",
      "additionalProperties",
      "required",
      "propertyOrdering",
    ]);
  });

  it("8. the openai denylist is the documented unsupported list, in order", () => {
    expect(target("openai.strict").deny).toEqual([
      "minLength",
      "maxLength",
      "pattern",
      "format",
      "minimum",
      "maximum",
      "multipleOf",
      "patternProperties",
      "unevaluatedProperties",
      "propertyNames",
      "minProperties",
      "maxProperties",
      "unevaluatedItems",
      "contains",
      "minContains",
      "maxContains",
      "minItems",
      "maxItems",
      "uniqueItems",
    ]);
  });

  it("8. the profiles record what their notes are obliged to record", () => {
    expect(target("gemini.functionDeclarationParameters").notes.join(" ")).toContain("$ref");
    const gemini = target("gemini.parametersJsonSchema").notes.join(" ");
    expect(gemini).toContain("Cyclic");
    expect(gemini).toContain("$ref");
    const openai = target("openai.strict").notes.join(" ");
    expect(openai).toContain("$defs");
    expect(openai).toContain("anyOf");
    expect(openai).toContain("100");
    expect(openai).toContain("five levels");
  });

  it("8. an unknown id is refused", () => {
    expect(() => target("nope" as TargetId)).toThrow(UnknownTargetError);
    try {
      target("nope" as TargetId);
    } catch (error) {
      expect((error as UnknownTargetError).id).toBe("nope");
      expect((error as Error).message).toContain("openai.strict");
    }
  });
});
