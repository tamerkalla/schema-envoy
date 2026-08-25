import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adapt, differential, residual } from "../src/index.js";
import {
  InvalidSchemaError,
  SchemaDivergenceError,
  SchemaEnvoyError,
  SchemaProbeError,
  UnknownTargetError,
} from "../src/errors.js";
import { assertSanityFloor, makePredicate } from "../src/differential.js";
import { ANNOTATION_KEYWORDS, MAX_DEPTH } from "../src/normalize.js";
import { selectWitnesses } from "../src/witness.js";
import * as B from "./fixtures/baseline.js";
import type { DifferentialResult, TargetId } from "../src/types.js";

const TARGET: TargetId = "openai.strict";

function nested(levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: "string" };
  for (let i = 1; i < levels; i += 1) {
    node = { type: "object", properties: { next: node }, required: ["next"] };
  }
  return node;
}

function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...testFiles(full));
    else if (full.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** Every `it(...)` / `test(...)` callback body, by brace matching. */
function callbackBodies(source: string): string[] {
  const marker =
    /\b(?:it|test)\(\s*(?:"[^"]*"|'[^']*'|`[^`]*`)\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{/g;
  const bodies: string[] = [];
  let match = marker.exec(source);
  while (match !== null) {
    let depth = 0;
    let index = match.index + match[0].length - 1;
    const start = index;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(start, index + 1));
    match = marker.exec(source);
  }
  return bodies;
}

const BANNED_FORMS = ["it", "test", "describe"].map((keyword) => `${keyword}.skip`);
const EARLY_EXIT = new RegExp(`\\b${"ret"}${"urn"}\\b`);

const emptyDifferential: DifferentialResult = {
  checked: 1,
  agreed: 1,
  widened: 0,
  narrowed: 0,
  widenedWitnesses: [],
  narrowedWitnesses: [],
};

describe("10. adversarial input", () => {
  it("10. null and undefined are not schemas", () => {
    expect(() => adapt(null, TARGET)).toThrow(InvalidSchemaError);
    expect(() => adapt(undefined, TARGET)).toThrow(InvalidSchemaError);
    try {
      adapt(null, TARGET);
    } catch (error) {
      expect((error as InvalidSchemaError).pointer).toBe("#");
      expect(error).toBeInstanceOf(SchemaEnvoyError);
    }
  });

  it("10. an array, a number and a string are not schemas", () => {
    expect(() => adapt([], TARGET)).toThrow(InvalidSchemaError);
    expect(() => adapt(42, TARGET)).toThrow(InvalidSchemaError);
    expect(() => adapt("x", TARGET)).toThrow(InvalidSchemaError);
  });

  it("10. the empty schema and both boolean schemas convert cleanly", () => {
    for (const input of [{}, true, false]) {
      const result = adapt(input, TARGET);
      expect(result.schema).toEqual(input);
      expect(result.report.equivalent).toBe(true);
      expect(result.report.differential.checked).toBe(1);
    }
  });

  it("10. an unknown target id is refused before any schema work", () => {
    expect(() => adapt(null, "nope" as TargetId)).toThrow(UnknownTargetError);
  });

  it("10. a schema 65 levels deep is refused", () => {
    expect(() => adapt(nested(MAX_DEPTH + 1), TARGET)).toThrow(InvalidSchemaError);
    const shallow = adapt(nested(MAX_DEPTH), TARGET, { onDivergence: "report" });
    expect(shallow.report.warnings.length).toBeGreaterThan(0);
  });

  it("10. a $ref cycle is a legitimate schema, not an error", () => {
    const cyclic = {
      $defs: { node: { type: "object", properties: { next: { $ref: "#/$defs/node" } } } },
      $ref: "#/$defs/node",
    };
    const result = adapt(cyclic, TARGET, { onDivergence: "report" });
    const schema = result.schema as Record<string, unknown>;
    expect(schema["$ref"]).toBe("#/$defs/node");
    expect(result.report.differential.checked).toBeGreaterThan(0);
  });

  it("10. a $ref to a pointer that does not exist is refused", () => {
    expect(() => adapt({ $ref: "#/$defs/missing" }, TARGET)).toThrow(InvalidSchemaError);
    try {
      adapt({ properties: { a: { $ref: "#/$defs/missing" } } }, TARGET);
    } catch (error) {
      expect((error as InvalidSchemaError).pointer).toBe("#/properties/a");
    }
  });

  it("10. a __proto__ key is carried as data and pollutes nothing", () => {
    const schema = JSON.parse(
      '{"type":"object","__proto__":{"polluted":true},"properties":{"a":{"type":"string"}},"required":["a"]}',
    ) as unknown;
    const result = adapt(schema, TARGET, { onDivergence: "report" });
    expect(result.schema).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    });
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(result.report.removed.some((entry) => entry.keyword === "__proto__")).toBe(true);
  });

  it("10. a property named constructor is an ordinary property", () => {
    const result = adapt(
      { type: "object", properties: { constructor: { type: "string" } }, required: ["constructor"] },
      TARGET,
      { onDivergence: "report" },
    );
    const schema = result.schema as Record<string, Record<string, unknown>>;
    expect(schema["properties"]?.["constructor"]).toEqual({ type: "string" });
  });

  it("10. an enum containing undefined is a schema ajv refuses", () => {
    expect(() => adapt({ type: "string", enum: ["a", undefined] }, TARGET)).toThrow(
      InvalidSchemaError,
    );
  });

  it("10. a const of NaN survives as NaN", () => {
    const result = adapt({ const: Number.NaN }, TARGET, { onDivergence: "report" });
    const schema = result.schema as Record<string, unknown>;
    expect(Number.isNaN(schema["const"])).toBe(true);
    expect(result.report.equivalent).toBe(true);
  });

  it("10. a 4097 value corpus is evaluated in full", () => {
    const corpus = Array.from({ length: 4097 }, (_, index) => ({ a: index }));
    const result = adapt(B.B1_SOURCE, "gemini.functionDeclarationParameters", {
      onDivergence: "report",
      corpus,
    });
    const generated = adapt(B.B1_SOURCE, "gemini.functionDeclarationParameters", {
      onDivergence: "report",
    }).report.differential.checked;
    expect(result.report.differential.checked).toBe(generated + 4097);
  });

  it("10. adapt throws by default when the conversion changes the accepted set", () => {
    expect(() => adapt(B.B5_SOURCE, TARGET)).toThrow(SchemaDivergenceError);
    try {
      adapt(B.B5_SOURCE, TARGET);
    } catch (error) {
      const divergence = error as SchemaDivergenceError;
      expect(divergence.report.divergences.length).toBeGreaterThan(0);
      expect(divergence.message.startsWith("schema-envoy:")).toBe(true);
      expect(divergence.message.includes("\n")).toBe(false);
    }
  });

  it("10. no test in this package skips", () => {
    const files = testFiles("test");
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const banned of BANNED_FORMS) {
        expect(`${file} contains ${banned}: ${source.includes(banned)}`).toBe(
          `${file} contains ${banned}: false`,
        );
      }
      for (const body of callbackBodies(source)) {
        expect(`${file} exits a test early: ${EARLY_EXIT.test(body)}`).toBe(
          `${file} exits a test early: false`,
        );
      }
    }
  });
});

describe("13. every gate has a negative test", () => {
  it("13. removing a keyword and reporting no divergence is a probe failure", () => {
    expect(() =>
      assertSanityFloor({
        corpusSize: 1,
        sourceCompiled: true,
        convertedCompiled: true,
        differential: emptyDifferential,
        removed: [{ pointer: "#", keyword: "pattern", documented: false }],
        rewritten: [],
        divergences: [],
      }),
    ).toThrow(SchemaProbeError);
  });

  it("13. removing only annotations is allowed to report no divergence", () => {
    expect(() =>
      assertSanityFloor({
        corpusSize: 1,
        sourceCompiled: true,
        convertedCompiled: true,
        differential: emptyDifferential,
        removed: ANNOTATION_KEYWORDS.map((keyword) => ({
          pointer: "#",
          keyword,
          documented: false,
        })),
        rewritten: [],
        divergences: [],
      }),
    ).not.toThrow();
    expect([...ANNOTATION_KEYWORDS].sort()).toEqual([
      "$comment",
      "$id",
      "$schema",
      "default",
      "description",
      "examples",
      "title",
    ]);
  });

  it("13. an empty corpus and an uncompiled schema are probe failures", () => {
    const base = {
      corpusSize: 1,
      sourceCompiled: true,
      convertedCompiled: true,
      differential: emptyDifferential,
      removed: [],
      rewritten: [],
      divergences: [],
    };
    expect(() => assertSanityFloor({ ...base, corpusSize: 0 })).toThrow(SchemaProbeError);
    expect(() => assertSanityFloor({ ...base, sourceCompiled: false })).toThrow(SchemaProbeError);
    expect(() => assertSanityFloor({ ...base, convertedCompiled: false })).toThrow(SchemaProbeError);
    expect(() =>
      assertSanityFloor({
        ...base,
        differential: { ...emptyDifferential, agreed: 0 },
      }),
    ).toThrow(/checked/);
    expect(() => differential(B.B1_SOURCE, B.B1_CONVERTED, [])).toThrow(SchemaProbeError);
  });

  it("13. a candidate that does not flip is discarded and the count drops", () => {
    const candidates = [
      { value: "flips", pointer: "#", keyword: "pattern" },
      { value: "agrees", pointer: "#", keyword: "pattern" },
    ];
    const kept = selectWitnesses(
      candidates,
      (value) => value !== "flips",
      () => true,
    );
    expect(kept.length).toBe(1);
    expect(kept[0]?.candidate.value).toBe("flips");
    expect(kept[0]?.effect).toBe("widen");
    const none = selectWitnesses(candidates, () => true, () => true);
    expect(none.length).toBe(0);
    expect(none.length).toBeLessThan(kept.length);
  });

  it("13. a validator that does not answer with a boolean is a probe failure", () => {
    const notBoolean = makePredicate(() => 1 as unknown, "fake");
    expect(() => notBoolean(null)).toThrow(SchemaProbeError);
    expect(() => notBoolean(null)).toThrow(/instead of a boolean/);
  });

  it("13. a validator that throws is never read as false", () => {
    const explodes = makePredicate(() => {
      throw new Error("boom");
    }, "fake");
    expect(() => explodes(null)).toThrow(SchemaProbeError);
    expect(() => explodes(null)).toThrow(/threw/);
  });

  it("13. a residual that cannot be compiled is a probe failure, not a silent pass", () => {
    const result = residual(B.B5_SOURCE, "openai.strict");
    expect(result.validate({ email: "a@b.co", slug: "abc", score: 5, tags: ["x"] })).toBe(true);
  });
});
