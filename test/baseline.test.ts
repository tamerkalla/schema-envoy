import { describe, expect, it } from "vitest";
import { adapt, differential } from "../src/index.js";
import { createAjv, makePredicate } from "../src/differential.js";
import {
  SCHEMA_LIST_KEYWORDS,
  SCHEMA_MAP_KEYWORDS,
  SCHEMA_VALUE_KEYWORDS,
  isPlainObject,
} from "../src/normalize.js";
import * as B from "./fixtures/baseline.js";

/** Every keyword name appearing at any schema node, property names excluded. */
function keywords(schema: unknown, into: Set<string> = new Set()): Set<string> {
  if (!isPlainObject(schema)) return into;
  for (const key of Object.keys(schema)) {
    into.add(key);
    const value = schema[key];
    if (SCHEMA_VALUE_KEYWORDS.includes(key)) keywords(value, into);
    else if (SCHEMA_MAP_KEYWORDS.includes(key) && isPlainObject(value)) {
      for (const name of Object.keys(value)) keywords(value[name], into);
    } else if (SCHEMA_LIST_KEYWORDS.includes(key) && Array.isArray(value)) {
      for (const entry of value) keywords(entry, into);
    }
  }
  return into;
}

function removedKeywords(source: unknown, converted: unknown): string[] {
  const after = keywords(converted);
  const out: string[] = [];
  for (const keyword of keywords(source)) {
    if (!after.has(keyword)) out.push(keyword);
  }
  out.sort();
  return out;
}

function acceptedCount(schema: unknown, corpus: readonly unknown[]): number {
  const predicate = makePredicate(createAjv().compile(schema as object), "probe");
  let count = 0;
  for (const value of corpus) {
    if (predicate(value)) count += 1;
  }
  return count;
}

describe("1. baselines", () => {
  it("1. B1 gemini.functionDeclarationParameters converts to the recorded schema", () => {
    const result = adapt(B.B1_SOURCE, "gemini.functionDeclarationParameters", {
      onDivergence: "report",
    });
    expect(result.schema).toEqual(B.B1_CONVERTED);
  });

  it("1. B1 differential is 720 / 648 / 72 / 0", () => {
    const observed = differential(B.B1_SOURCE, B.B1_CONVERTED, B.B1_CORPUS);
    expect(B.B1_CORPUS.length).toBe(720);
    expect(observed.checked).toBe(720);
    expect(observed.agreed).toBe(648);
    expect(observed.widened).toBe(72);
    expect(observed.narrowed).toBe(0);
  });

  it("1. B1a names the six keywords the B1 conversion removes", () => {
    expect(removedKeywords(B.B1_SOURCE, B.B1_CONVERTED)).toEqual([
      "$schema",
      "additionalProperties",
      "const",
      "exclusiveMaximum",
      "exclusiveMinimum",
      "multipleOf",
    ]);
  });

  it("1. B2 naive strict required-fill is 12 / 1 / 0 / 11", () => {
    const observed = differential(B.B2_SOURCE, B.B2_CONVERTED, B.B2_CORPUS);
    expect(B.B2_CORPUS.length).toBe(12);
    expect(observed.checked).toBe(12);
    expect(observed.agreed).toBe(1);
    expect(observed.widened).toBe(0);
    expect(observed.narrowed).toBe(11);
  });

  it("1. B3 gemini.parametersJsonSchema converts to the recorded schema", () => {
    const result = adapt(B.B3_SOURCE, "gemini.parametersJsonSchema", {
      onDivergence: "report",
    });
    expect(result.schema).toEqual(B.B3_CONVERTED);
  });

  it("1. B3 differential is 96 / 2 / 94 / 0", () => {
    const observed = differential(B.B3_SOURCE, B.B3_CONVERTED, B.B3_CORPUS);
    expect(B.B3_CORPUS.length).toBe(96);
    expect(observed.checked).toBe(96);
    expect(observed.agreed).toBe(2);
    expect(observed.widened).toBe(94);
    expect(observed.narrowed).toBe(0);
  });

  it("1. B3a the source accepts 2 of the 96 B3 values", () => {
    expect(acceptedCount(B.B3_SOURCE, B.B3_CORPUS)).toBe(2);
  });

  it("1. B3b the converted schema accepts all 96 B3 values", () => {
    expect(acceptedCount(B.B3_CONVERTED, B.B3_CORPUS)).toBe(96);
  });

  it("1. B3c names the seven keywords the B3 conversion removes", () => {
    expect(removedKeywords(B.B3_SOURCE, B.B3_CONVERTED)).toEqual([
      "const",
      "exclusiveMinimum",
      "maxLength",
      "minLength",
      "multipleOf",
      "pattern",
      "uniqueItems",
    ]);
  });

  it("1. B4 oneOf read as anyOf is 4 / 3 / 1 / 0", () => {
    const observed = differential(B.B4_SOURCE, B.B4_CONVERTED, B.B4_CORPUS);
    expect(B.B4_CORPUS.length).toBe(4);
    expect(observed.checked).toBe(4);
    expect(observed.agreed).toBe(3);
    expect(observed.widened).toBe(1);
    expect(observed.narrowed).toBe(0);
    expect(observed.widenedWitnesses).toEqual([{ a: "1", b: "1" }]);
  });

  it("1. B5 openai.strict converts to the recorded schema", () => {
    const result = adapt(B.B5_SOURCE, "openai.strict", { onDivergence: "report" });
    expect(result.schema).toEqual(B.B5_CONVERTED);
  });

  it("1. B5 differential is 72 / 36 / 35 / 1", () => {
    const observed = differential(B.B5_SOURCE, B.B5_CONVERTED, B.B5_CORPUS);
    expect(B.B5_CORPUS.length).toBe(72);
    expect(observed.checked).toBe(72);
    expect(observed.agreed).toBe(36);
    expect(observed.widened).toBe(35);
    expect(observed.narrowed).toBe(1);
  });

  it("1. B5a the source accepts 2 of the 72 B5 values", () => {
    expect(acceptedCount(B.B5_SOURCE, B.B5_CORPUS)).toBe(2);
  });

  it("1. B5b the converted schema accepts 36 of the 72 B5 values", () => {
    expect(acceptedCount(B.B5_CONVERTED, B.B5_CORPUS)).toBe(36);
  });

  it("1. B5c retypes the optional note property as string or null", () => {
    const result = adapt(B.B5_SOURCE, "openai.strict", { onDivergence: "report" });
    const schema = result.schema as Record<string, unknown>;
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["note"]?.["type"]).toEqual(["string", "null"]);
  });

  it("1. B5 depends on ajv-formats being registered", () => {
    const predicate = makePredicate(
      createAjv().compile({ type: "string", format: "email" }),
      "formats",
    );
    expect(predicate("a@b.co")).toBe(true);
    expect(predicate("nope")).toBe(false);
  });
});
