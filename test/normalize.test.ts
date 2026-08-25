import Ajv from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { createAjv, makePredicate } from "../src/differential.js";
import {
  MAX_DEPTH,
  childPointer,
  collectRefs,
  deepClone,
  escapeToken,
  normalize,
  resolveRef,
} from "../src/normalize.js";
import { InvalidSchemaError } from "../src/errors.js";
import {
  DRAFT07,
  DRAFT07_CORPUS,
  DRAFT07_LIFTED,
  DRAFT07_PORTABLE,
} from "./fixtures/schemas.js";

function draft07Predicate(schema: unknown): (value: unknown) => boolean {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  return makePredicate(ajv.compile(schema as object), "draft-07");
}

function lifted(schema: unknown): (value: unknown) => boolean {
  return makePredicate(createAjv().compile(schema as object), "2020-12");
}

describe("2. normalization", () => {
  it("2. rule 1 renames definitions to $defs and repoints every $ref", () => {
    const result = normalize({
      definitions: { thing: { type: "string" } },
      properties: { a: { $ref: "#/definitions/thing" } },
    });
    const schema = result.schema as Record<string, unknown>;
    expect(schema["definitions"]).toBeUndefined();
    expect(schema["$defs"]).toEqual({ thing: { type: "string" } });
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["a"]?.["$ref"]).toBe("#/$defs/thing");
    expect(result.rewrites).toContainEqual({ pointer: "#", from: "definitions", to: "$defs" });
    expect(result.rewrites).toContainEqual({
      pointer: "#/properties/a",
      from: "#/definitions",
      to: "#/$defs",
    });
  });

  it("2. rule 2 lifts boolean exclusiveMinimum and exclusiveMaximum", () => {
    const result = normalize({
      type: "number",
      minimum: 1,
      exclusiveMinimum: true,
      maximum: 9,
      exclusiveMaximum: true,
    });
    expect(result.schema).toEqual({ type: "number", exclusiveMinimum: 1, exclusiveMaximum: 9 });
    expect(result.rewrites).toContainEqual({ pointer: "#", from: "minimum", to: "exclusiveMinimum" });
    expect(result.rewrites).toContainEqual({ pointer: "#", from: "maximum", to: "exclusiveMaximum" });
  });

  it("2. rule 3 turns tuple items into prefixItems and additionalItems into items", () => {
    const result = normalize({
      type: "array",
      items: [{ type: "string" }, { type: "integer" }],
      additionalItems: { type: "boolean" },
    });
    expect(result.schema).toEqual({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: { type: "boolean" },
    });
    expect(result.rewrites).toContainEqual({ pointer: "#", from: "items", to: "prefixItems" });
    expect(result.rewrites).toContainEqual({ pointer: "#", from: "additionalItems", to: "items" });
  });

  it("2. rule 4 records and removes $schema", () => {
    const result = normalize({ $schema: "http://json-schema.org/draft-07/schema#", type: "string" });
    expect(result.schema).toEqual({ type: "string" });
    expect(result.dialect).toBe("http://json-schema.org/draft-07/schema#");
    expect(result.removed).toContainEqual({ pointer: "#", keyword: "$schema", documented: false });
  });

  it("2. the four rules combined lift the draft-07 fixture", () => {
    expect(normalize(DRAFT07).schema).toEqual(DRAFT07_LIFTED);
    expect(normalize(DRAFT07_PORTABLE).schema).toEqual(DRAFT07_LIFTED);
  });

  it("2. the draft-07 schema and its lifted form accept identical values", () => {
    const before = draft07Predicate(DRAFT07_PORTABLE);
    const after = lifted(normalize(DRAFT07_PORTABLE).schema);
    expect(DRAFT07_CORPUS.length).toBe(24);
    const disagreements = DRAFT07_CORPUS.filter((value) => before(value) !== after(value));
    expect(disagreements).toEqual([]);
    const accepted = DRAFT07_CORPUS.filter((value) => after(value)).length;
    expect(accepted).toBe(4);
  });

  it("2. normalization leaves the caller's object untouched", () => {
    const input = { definitions: { a: { type: "string" } } };
    const snapshot = JSON.stringify(input);
    normalize(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("2. collectRefs finds every reference and resolveRef resolves anchors", () => {
    const schema = {
      $defs: { spot: { $anchor: "spot", type: "string" } },
      properties: { a: { $ref: "#/$defs/spot" }, b: { $ref: "#spot" } },
    };
    const refs = collectRefs(schema);
    expect(refs).toEqual([
      { pointer: "#/properties/a", ref: "#/$defs/spot" },
      { pointer: "#/properties/b", ref: "#spot" },
    ]);
    expect(resolveRef(schema, "#spot")).toEqual({ $anchor: "spot", type: "string" });
    expect(resolveRef(schema, "#")).toBe(schema);
    expect(resolveRef(schema, "#/$defs/nope")).toBeUndefined();
    expect(resolveRef(schema, "https://example.com/x")).toBeUndefined();
  });
});

describe("2. pointers and cloning", () => {
  it("2. a pointer token is percent-decoded then unescaped", () => {
    const schema = { "a/b": { "c~d": { type: "string" } }, list: [{ type: "integer" }] };
    expect(resolveRef(schema, "#/a~1b/c~0d")).toEqual({ type: "string" });
    expect(resolveRef(schema, "#/%61~1b/c~0d")).toEqual({ type: "string" });
    expect(resolveRef(schema, "#/list/0")).toEqual({ type: "integer" });
    expect(resolveRef(schema, "#/list/1")).toBeUndefined();
    expect(resolveRef(schema, "#/list/x")).toBeUndefined();
    expect(resolveRef(schema, "#/list/-1")).toBeUndefined();
    expect(resolveRef(schema, "#/a~1b/c~0d/type/deeper")).toBeUndefined();
    expect(resolveRef(schema, "#/%E0%A4%A")).toBeUndefined();
  });

  it("2. an anchor is found through arrays and nested objects", () => {
    const schema = { anyOf: [{ type: "string" }, { $anchor: "here", type: "integer" }] };
    expect(resolveRef(schema, "#here")).toEqual({ $anchor: "here", type: "integer" });
    expect(resolveRef(schema, "#nowhere")).toBeUndefined();
    expect(resolveRef({ a: 1 }, "#nowhere")).toBeUndefined();
  });

  it("2. collectRefs walks arrays as well as objects", () => {
    const refs = collectRefs({ anyOf: [{ $ref: "#/a" }, { properties: { b: { $ref: "#/c" } } }] });
    expect(refs).toEqual([
      { pointer: "#/anyOf/0", ref: "#/a" },
      { pointer: "#/anyOf/1/properties/b", ref: "#/c" },
    ]);
  });

  it("2. childPointer escapes the tokens it appends", () => {
    expect(childPointer("#", "properties", "a/b")).toBe("#/properties/a~1b");
    expect(childPointer("#", "properties", "a~b")).toBe("#/properties/a~0b");
    expect(escapeToken("plain")).toBe("plain");
  });

  it("2. deepClone copies arrays and leaves primitives alone", () => {
    const input = { a: [1, { b: 2 }], c: "x", d: null };
    const copy = deepClone(input);
    expect(copy).toEqual(input);
    expect(copy.a).not.toBe(input.a);
    expect(deepClone(7)).toBe(7);
    expect(deepClone(null)).toBe(null);
  });

  it("2. a boolean or non-object schema normalizes to itself", () => {
    expect(normalize(true).schema).toBe(true);
    expect(normalize(false).schema).toBe(false);
    expect(normalize({ properties: { a: 7 } }).schema).toEqual({ properties: { a: 7 } });
    expect(normalize({ anyOf: "not-an-array" }).schema).toEqual({ anyOf: "not-an-array" });
    expect(normalize({ items: [] }).schema).toEqual({ prefixItems: [] });
  });

  it("2. an existing $defs is not overwritten by definitions", () => {
    const result = normalize({
      $defs: { a: { type: "string" } },
      definitions: { b: { type: "integer" } },
    });
    expect(result.schema).toEqual({ $defs: { a: { type: "string" } } });
    expect(result.rewrites).toContainEqual({ pointer: "#", from: "definitions", to: "$defs" });
  });

  it("2. a boolean exclusive bound without a numeric partner is left alone", () => {
    expect(normalize({ exclusiveMinimum: true }).schema).toEqual({ exclusiveMinimum: true });
    expect(normalize({ exclusiveMinimum: 3, minimum: 1 }).schema).toEqual({
      exclusiveMinimum: 3,
      minimum: 1,
    });
  });

  it("2. the depth limit is enforced during normalization", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 1; i < MAX_DEPTH + 1; i += 1) {
      deep = { type: "object", properties: { next: deep } };
    }
    expect(() => normalize(deep)).toThrow(InvalidSchemaError);
  });
});
