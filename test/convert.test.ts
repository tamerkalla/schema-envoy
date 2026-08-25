import { describe, expect, it } from "vitest";
import { OPENAI_MAX_NESTING, OPENAI_MAX_PROPERTIES, convert } from "../src/convert.js";
import { targets } from "../src/targets/index.js";
import { openaiStrict } from "../src/targets/openai-strict.js";
import { geminiParametersJsonSchema } from "../src/targets/gemini-parameters-json-schema.js";
import { geminiFunctionDeclarationParameters } from "../src/targets/gemini-function-declaration-parameters.js";

/** One plausible value per keyword, used to probe each allowlist entry alone. */
const SAMPLE: Record<string, unknown> = {
  $anchor: "spot",
  $defs: { thing: { type: "string" } },
  $id: "https://example.com/schema",
  $ref: "#/$defs/thing",
  additionalProperties: false,
  anyOf: [{ type: "string" }, { type: "integer" }],
  const: "fixed",
  default: "a",
  description: "a description",
  enum: ["a", "b"],
  example: "a",
  format: "email",
  items: { type: "string" },
  maxItems: 3,
  maxLength: 8,
  maxProperties: 4,
  maximum: 10,
  minItems: 1,
  minLength: 2,
  minProperties: 1,
  minimum: 0,
  nullable: true,
  oneOf: [{ type: "string" }, { type: "integer" }],
  pattern: "^a$",
  prefixItems: [{ type: "string" }],
  properties: { a: { type: "string" } },
  propertyOrdering: ["a"],
  required: ["a"],
  title: "a title",
  type: "object",
};

const DENIED_SAMPLE: Record<string, unknown> = {
  minLength: 1,
  maxLength: 2,
  pattern: "^a$",
  format: "email",
  minimum: 0,
  maximum: 1,
  multipleOf: 2,
  patternProperties: { "^a$": { type: "string" } },
  unevaluatedProperties: false,
  propertyNames: { pattern: "^a$" },
  minProperties: 0,
  maxProperties: 2,
  unevaluatedItems: false,
  contains: { type: "string" },
  minContains: 1,
  maxContains: 2,
  minItems: 1,
  maxItems: 2,
  uniqueItems: true,
};

function probeNode(keyword: string): Record<string, unknown> {
  const node: Record<string, unknown> = { [keyword]: SAMPLE[keyword] };
  if (keyword === "properties") node["required"] = ["a"];
  return node;
}

describe("3. conversion", () => {
  for (const profile of targets()) {
    it(`3. ${profile.id} passes every allowed keyword through untouched`, () => {
      for (const keyword of profile.allow) {
        expect(SAMPLE).toHaveProperty(keyword);
        if (profile.rewrites.some((rule) => rule.keyword === keyword && keyword === "oneOf")) {
          continue;
        }
        const result = convert(probeNode(keyword), profile);
        const schema = result.schema as Record<string, unknown>;
        expect(schema[keyword]).toEqual(SAMPLE[keyword]);
      }
    });

    it(`3. ${profile.id} drops a keyword no published source mentions`, () => {
      const result = convert({ allOf: [{ type: "string" }] }, profile);
      expect(result.schema).toEqual({});
      expect(result.removed).toContainEqual({ pointer: "#", keyword: "allOf", documented: false });
      expect(result.divergences[0]?.documented).toBe(false);
    });
  }

  it("3. openai.strict removes every documented-unsupported keyword", () => {
    const result = convert({ type: "object", ...DENIED_SAMPLE }, openaiStrict);
    const schema = result.schema as Record<string, unknown>;
    for (const keyword of openaiStrict.deny) {
      expect(Object.prototype.hasOwnProperty.call(schema, keyword)).toBe(false);
      expect(result.removed).toContainEqual({ pointer: "#", keyword, documented: true });
    }
    expect(result.removed.filter((entry) => entry.documented).length).toBe(19);
  });

  it("3. gemini.parametersJsonSchema rewrites oneOf to anyOf and reports a widening", () => {
    const result = convert({ oneOf: SAMPLE["oneOf"] as unknown[] }, geminiParametersJsonSchema);
    expect(result.schema).toEqual({ anyOf: SAMPLE["oneOf"] });
    expect(result.rewritten).toContainEqual({ pointer: "#", from: "oneOf", to: "anyOf" });
    const divergence = result.divergences.find((entry) => entry.keyword === "oneOf");
    expect(divergence?.effect).toBe("widen");
    expect(divergence?.reason).toContain("anyOf");
  });

  it("3. gemini.functionDeclarationParameters marks a required nullable property", () => {
    const result = convert(
      {
        type: "object",
        properties: { a: { type: ["string", "null"] } },
        required: ["a"],
      },
      geminiFunctionDeclarationParameters,
    );
    const schema = result.schema as Record<string, Record<string, Record<string, unknown>>>;
    expect(schema["properties"]?.["a"]?.["nullable"]).toBe(true);
    expect(result.rewritten).toContainEqual({
      pointer: "#/properties/a",
      from: "type",
      to: "nullable",
    });
  });

  it("3. gemini.functionDeclarationParameters cannot express $ref at all", () => {
    const result = convert({ $ref: "#/$defs/thing" }, geminiFunctionDeclarationParameters);
    expect(result.schema).toEqual({});
    const divergence = result.divergences.find((entry) => entry.keyword === "$ref");
    expect(divergence?.effect).toBe("unrepresentable");
  });

  it("3. gemini.parametersJsonSchema strips non-$ siblings of $ref", () => {
    const result = convert(
      { $ref: "#/$defs/thing", $id: "https://example.com/x", title: "t", minimum: 1 },
      geminiParametersJsonSchema,
    );
    expect(result.schema).toEqual({ $ref: "#/$defs/thing", $id: "https://example.com/x" });
    expect(result.removed.map((entry) => entry.keyword).sort()).toEqual(["minimum", "title"]);
  });

  it("3. openai.strict fills required, retypes optionals and closes the object", () => {
    const result = convert(
      { type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] },
      openaiStrict,
    );
    expect(result.schema).toEqual({
      type: "object",
      properties: { a: { type: "string" }, b: { type: ["string", "null"] } },
      required: ["a", "b"],
      additionalProperties: false,
    });
    expect(result.rewritten).toContainEqual({
      pointer: "#",
      from: "required",
      to: "required(all-properties)",
    });
    expect(result.rewritten).toContainEqual({
      pointer: "#/properties/b",
      from: "type",
      to: "type(nullable)",
    });
    expect(result.rewritten).toContainEqual({
      pointer: "#",
      from: "additionalProperties",
      to: "additionalProperties(false)",
    });
  });

  it("3. openai.strict wraps a typeless optional property in anyOf with null", () => {
    const result = convert(
      { type: "object", properties: { a: { $ref: "#/$defs/thing" } } },
      openaiStrict,
    );
    const schema = result.schema as Record<string, Record<string, unknown>>;
    expect(schema["properties"]?.["a"]).toEqual({
      anyOf: [{ $ref: "#/$defs/thing" }, { type: "null" }],
    });
  });

  it("3. openai.strict appends null to an array type", () => {
    const result = convert(
      { type: "object", properties: { a: { type: ["string", "integer"] } } },
      openaiStrict,
    );
    const schema = result.schema as Record<string, Record<string, Record<string, unknown>>>;
    expect(schema["properties"]?.["a"]?.["type"]).toEqual(["string", "integer", "null"]);
  });

  it("3. openai.strict cannot express a root anyOf", () => {
    const result = convert({ anyOf: [{ type: "string" }] }, openaiStrict);
    const divergence = result.divergences.find((entry) => entry.keyword === "anyOf");
    expect(divergence?.effect).toBe("unrepresentable");
  });

  it("3. openai.strict warns rather than diverges on the documented structural limits", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < OPENAI_MAX_PROPERTIES + 1; i += 1) {
      properties[`p${i}`] = { type: "string" };
    }
    const wide = convert({ type: "object", properties, required: Object.keys(properties) }, openaiStrict);
    expect(wide.warnings.some((entry) => entry.message.includes("object properties"))).toBe(true);

    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < OPENAI_MAX_NESTING + 1; i += 1) {
      deep = { type: "object", properties: { next: deep }, required: ["next"] };
    }
    const nested = convert(deep, openaiStrict);
    expect(nested.warnings.some((entry) => entry.message.includes("nesting"))).toBe(true);
    expect(nested.divergences.every((entry) => entry.keyword !== "nesting")).toBe(true);
  });

  it("3. boolean subschemas survive conversion", () => {
    const result = convert({ type: "object", additionalProperties: true }, geminiParametersJsonSchema);
    expect(result.schema).toEqual({ type: "object", additionalProperties: true });
    expect(convert(true, openaiStrict).schema).toBe(true);
    expect(convert(false, openaiStrict).schema).toBe(false);
  });
});
