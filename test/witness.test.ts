import { describe, expect, it } from "vitest";
import { adapt } from "../src/index.js";
import { createAjv, makePredicate } from "../src/differential.js";
import { normalize } from "../src/normalize.js";
import { convert } from "../src/convert.js";
import type { ChangeIndex, ChangeKind } from "../src/convert.js";
import { target } from "../src/targets/index.js";
import {
  DEFAULT_WITNESS_BUDGET,
  MAX_WITNESS_BUDGET,
  MUTATION_ORDER,
  buildSeed,
  generateCandidates,
} from "../src/witness.js";
import { ALL_TARGETS, FIXTURE_SCHEMAS } from "./fixtures/schemas.js";
import type { TargetId } from "../src/types.js";

function predicates(schema: unknown, targetId: TargetId): {
  source: (value: unknown) => boolean;
  converted: (value: unknown) => boolean;
} {
  const normalized = normalize(schema);
  const converted = convert(normalized.schema, target(targetId));
  return {
    source: makePredicate(createAjv().compile(normalized.schema as object), "source"),
    converted: makePredicate(createAjv().compile(converted.schema as object), "converted"),
  };
}

function seed(node: unknown): unknown {
  const built = buildSeed(node, node, []);
  if (!built.ok) throw new Error("expected a seedable node");
  return built.value;
}

describe("4. witnesses", () => {
  for (const fixture of FIXTURE_SCHEMAS) {
    for (const targetId of ALL_TARGETS) {
      it(`4. ${fixture.name} to ${targetId}: every stored witness genuinely flips`, () => {
        const { source, converted } = predicates(fixture.schema, targetId);
        const report = adapt(fixture.schema, targetId, { onDivergence: "report" }).report;
        for (const witness of report.differential.widenedWitnesses) {
          expect(source(witness)).toBe(false);
          expect(converted(witness)).toBe(true);
        }
        for (const witness of report.differential.narrowedWitnesses) {
          expect(source(witness)).toBe(true);
          expect(converted(witness)).toBe(false);
        }
      });

      it(`4. ${fixture.name} to ${targetId}: at least one divergence carries a value`, () => {
        const report = adapt(fixture.schema, targetId, { onDivergence: "report" }).report;
        const withValues = report.divergences.filter((entry) => entry.evidence === "value");
        expect(withValues.length).toBeGreaterThanOrEqual(1);
        for (const entry of withValues) {
          expect(Object.prototype.hasOwnProperty.call(entry, "witness")).toBe(true);
        }
      });

      it(`4. ${fixture.name} to ${targetId}: keyword evidence never carries a witness`, () => {
        const report = adapt(fixture.schema, targetId, { onDivergence: "report" }).report;
        const bare = report.divergences.filter((entry) => entry.evidence === "keyword");
        for (const entry of bare) {
          expect(entry.witness).toBeUndefined();
        }
      });
    }
  }

  it("4. two adapt calls on the same input produce deeply equal reports", () => {
    for (const fixture of FIXTURE_SCHEMAS) {
      for (const targetId of ALL_TARGETS) {
        const first = adapt(fixture.schema, targetId, { onDivergence: "report" });
        const second = adapt(fixture.schema, targetId, { onDivergence: "report" });
        expect(second.report).toEqual(first.report);
        expect(second.schema).toEqual(first.schema);
      }
    }
  });

  it("4. the witness budget is honoured", () => {
    const unbounded = adapt(FIXTURE_SCHEMAS[0]!.schema, "openai.strict", {
      onDivergence: "report",
    });
    expect(unbounded.report.differential.checked).toBeGreaterThan(2);
    const bounded = adapt(FIXTURE_SCHEMAS[0]!.schema, "openai.strict", {
      onDivergence: "report",
      witnessBudget: 2,
    });
    expect(bounded.report.differential.checked).toBe(2);
    expect(DEFAULT_WITNESS_BUDGET).toBe(512);
    expect(MAX_WITNESS_BUDGET).toBe(4096);
  });

  it("4. the budget is clamped to the hard maximum", () => {
    const normalized = normalize(FIXTURE_SCHEMAS[0]!.schema);
    const converted = convert(normalized.schema, target("openai.strict"));
    const candidates = generateCandidates(normalized.schema, converted.changes, 1_000_000);
    expect(candidates.length).toBeLessThanOrEqual(MAX_WITNESS_BUDGET);
    const single = generateCandidates(normalized.schema, converted.changes, 0);
    expect(single.length).toBe(1);
  });

  it("4. candidate generation is a pure function of schema and budget", () => {
    const normalized = normalize(FIXTURE_SCHEMAS[2]!.schema);
    const converted = convert(normalized.schema, target("gemini.parametersJsonSchema"));
    const first = generateCandidates(normalized.schema, converted.changes, 64);
    const second = generateCandidates(normalized.schema, converted.changes, 64);
    expect(second).toEqual(first);
  });

  it("4. seeds follow the documented table", () => {
    expect(seed({ const: 7 })).toBe(7);
    expect(seed({ enum: ["x", "y"] })).toBe("x");
    expect(seed({ type: "string", minLength: 3 })).toBe("aaa");
    expect(seed({ type: "string" })).toBe("a");
    expect(seed({ type: "integer", minimum: 4 })).toBe(4);
    expect(seed({ type: "number", exclusiveMinimum: 2 })).toBe(3);
    expect(seed({ type: "number" })).toBe(0);
    expect(seed({ type: "boolean" })).toBe(false);
    expect(seed({ type: "null" })).toBe(null);
    expect(seed({ type: "array" })).toEqual([]);
    expect(seed({ type: "array", minItems: 2, items: { type: "string" } })).toEqual(["a", "a"]);
    expect(seed({ anyOf: [{ type: "boolean" }, { type: "string" }] })).toBe(false);
    expect(seed({ oneOf: [{ type: "integer" }, { type: "string" }] })).toBe(0);
    expect(seed(true)).toEqual({});
    expect(
      seed({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        required: ["a"],
      }),
    ).toEqual({ a: "a" });
  });

  it("4. a pattern node and a cycle are unseedable, which is not an error", () => {
    expect(buildSeed({ type: "string", pattern: "^a$" }, {}, []).ok).toBe(false);
    expect(buildSeed(false, {}, []).ok).toBe(false);
    expect(buildSeed({ $ref: "#/$defs/missing" }, {}, []).ok).toBe(false);
    const cyclic: Record<string, unknown> = { type: "object" };
    cyclic["properties"] = { self: cyclic };
    cyclic["required"] = ["self"];
    expect(buildSeed(cyclic, cyclic, []).ok).toBe(true);
  });

  it("4. the mutation table order is the documented one", () => {
    expect(MUTATION_ORDER.slice(0, 9)).toEqual([
      "pattern",
      "format",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
      "multipleOf",
    ]);
    expect(MUTATION_ORDER).toContain("uniqueItems");
    expect(MUTATION_ORDER).toContain("propertyNames");
  });
});

/** A schema whose every node carries something the mutation table names. */
const KITCHEN_SINK = {
  type: "object",
  properties: {
    str: { type: "string", minLength: 2, maxLength: 4, format: "email" },
    num: {
      type: "number",
      minimum: 1,
      maximum: 9,
      exclusiveMinimum: 0,
      exclusiveMaximum: 10,
      multipleOf: 2,
    },
    lit: { const: "x" },
    numLit: { type: "integer", enum: [1, 2] },
    arr: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 2,
      maxItems: 3,
      uniqueItems: true,
    },
    obj: {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
      propertyNames: { pattern: "^a$" },
    },
    tuple: { type: "array", prefixItems: [{ type: "string" }] },
    branch: {
      oneOf: [
        { type: "object", properties: { p: { type: "string" } }, required: ["p"] },
        { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      ],
    },
    open: { type: "object", additionalProperties: { type: "string", maxLength: 1 } },
    holder: { type: "array", contains: { type: "string", minLength: 5 } },
    combined: { allOf: [{ type: "object" }], anyOf: [{ type: "object" }] },
    conditional: { if: { type: "object" }, then: { type: "object" }, else: { type: "object" }, not: { type: "null" } },
  },
  required: ["str", "num", "lit", "numLit", "arr", "obj", "tuple", "branch"],
};

function changesOf(entries: readonly [string, string, ChangeKind][]): ChangeIndex {
  const map: ChangeIndex = new Map();
  for (const [pointer, keyword, kind] of entries) {
    const bucket = map.get(pointer) ?? new Map<string, ChangeKind>();
    bucket.set(keyword, kind);
    map.set(pointer, bucket);
  }
  return map;
}

function candidatesFor(entries: readonly [string, string, ChangeKind][]): unknown[] {
  return generateCandidates(KITCHEN_SINK, changesOf(entries), 4096)
    .slice(1)
    .map((candidate) => candidate.value);
}

function at(value: unknown, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

describe("4. the mutation table", () => {
  it("4. string keywords mutate the seed string", () => {
    const [pattern, format, short, long] = candidatesFor([
      ["#/properties/str", "pattern", "removed"],
      ["#/properties/str", "format", "removed"],
      ["#/properties/str", "minLength", "removed"],
      ["#/properties/str", "maxLength", "removed"],
    ]);
    expect(at(pattern, "str")).toBe("!");
    expect(at(format, "str")).toBe("__envoy_invalid_format__");
    expect(at(short, "str")).toBe("a");
    expect(at(long, "str")).toBe("aaaaa");
  });

  it("4. numeric keywords step outside the bound they name", () => {
    const [low, high, exMin, exMax, multiple] = candidatesFor([
      ["#/properties/num", "minimum", "removed"],
      ["#/properties/num", "maximum", "removed"],
      ["#/properties/num", "exclusiveMinimum", "removed"],
      ["#/properties/num", "exclusiveMaximum", "removed"],
      ["#/properties/num", "multipleOf", "removed"],
    ]);
    expect(at(low, "num")).toBe(0);
    expect(at(high, "num")).toBe(10);
    expect(at(exMin, "num")).toBe(0);
    expect(at(exMax, "num")).toBe(10);
    expect(at(multiple, "num")).toBe(2);
  });

  it("4. const and enum mutate to a non-member of the right shape", () => {
    const [asString] = candidatesFor([["#/properties/lit", "const", "removed"]]);
    expect(at(asString, "lit")).toBe("__envoy_not_a_member__");
    const [asNumber] = candidatesFor([["#/properties/numLit", "enum", "removed"]]);
    expect(at(asNumber, "numLit")).toBe(-2147483648);
  });

  it("4. array keywords resize or duplicate the seed array", () => {
    const [short, long, duplicated] = candidatesFor([
      ["#/properties/arr", "minItems", "removed"],
      ["#/properties/arr", "maxItems", "removed"],
      ["#/properties/arr", "uniqueItems", "removed"],
    ]);
    expect(at(short, "arr")).toEqual(["a"]);
    expect(at(long, "arr")).toEqual(["a", "a", "a", "a"]);
    expect(at(duplicated, "arr")).toEqual(["a", "a", "a"]);
  });

  it("4. object keywords add a forbidden key or drop a required one", () => {
    const [extra, badName, missing] = candidatesFor([
      ["#/properties/obj", "additionalProperties", "removed"],
      ["#/properties/obj", "propertyNames", "removed"],
      ["#/properties/obj", "required", "removed"],
    ]);
    expect(at(at(extra, "obj"), "__envoy_extra__")).toBe(1);
    expect(at(at(badName, "obj"), "__envoy_bad_name__")).toBe(1);
    expect(at(missing, "obj")).toEqual({});
  });

  it("4. a filled required list is witnessed by the seed itself", () => {
    const [asIs] = candidatesFor([["#/properties/obj", "required", "rewritten"]]);
    expect(at(asIs, "obj")).toEqual({ a: "a" });
  });

  it("4. a nullable rewrite is witnessed by null", () => {
    const [nulled] = candidatesFor([["#/properties/str", "type", "rewritten"]]);
    expect(at(nulled, "str")).toBe(null);
    expect(candidatesFor([["#/properties/str", "type", "removed"]])).toEqual([]);
  });

  it("4. oneOf read as anyOf is witnessed by a value matching two branches", () => {
    const [merged] = candidatesFor([["#/properties/branch", "oneOf", "rewritten"]]);
    expect(at(merged, "branch")).toEqual({ p: "a", q: "a" });
  });

  it("4. a keyword the table does not name produces no candidate", () => {
    expect(candidatesFor([["#", "propertyOrdering", "removed"]])).toEqual([]);
    expect(candidatesFor([["#/properties/tuple", "minItems", "removed"]])).toEqual([]);
    expect(candidatesFor([["#/properties/holder", "uniqueItems", "removed"]])).toEqual([]);
  });

  it("4. the walk reaches items, prefixItems, additionalProperties and contains", () => {
    const reached = candidatesFor([
      ["#/properties/arr/items", "minLength", "removed"],
      ["#/properties/tuple/prefixItems/0", "pattern", "removed"],
      ["#/properties/open/additionalProperties", "maxLength", "removed"],
      ["#/properties/holder/contains", "minLength", "removed"],
    ]);
    expect(reached.length).toBe(4);
    expect(at(reached[1], "tuple")).toEqual(["!"]);
  });

  it("4. the walk reaches applicator branches", () => {
    const reached = candidatesFor([
      ["#/properties/combined/allOf/0", "pattern", "removed"],
      ["#/properties/combined/anyOf/0", "format", "removed"],
      ["#/properties/branch/oneOf/1", "pattern", "removed"],
      ["#/properties/conditional/if", "pattern", "removed"],
      ["#/properties/conditional/then", "format", "removed"],
      ["#/properties/conditional/else", "pattern", "removed"],
      ["#/properties/conditional/not", "format", "removed"],
    ]);
    expect(reached.length).toBe(7);
  });

  it("4. the walk follows a reference to the pointer it names", () => {
    const referencing = {
      $defs: { entry: { type: "string", minLength: 4 } },
      type: "object",
      properties: { a: { $ref: "#/$defs/entry" }, b: { $ref: "#/$defs/entry" } },
      required: ["a", "b"],
    };
    const changes: ChangeIndex = new Map([
      ["#/$defs/entry", new Map<string, ChangeKind>([["minLength", "removed"]])],
    ]);
    const produced = generateCandidates(referencing, changes, 4096).slice(1);
    expect(produced.length).toBe(2);
    expect(produced.every((candidate) => candidate.pointer === "#/$defs/entry")).toBe(true);
    expect(produced[0]?.value).toEqual({ a: "aaa", b: "aaaa" });
    expect(produced[1]?.value).toEqual({ a: "aaaa", b: "aaa" });
  });

  it("4. a self-referential walk terminates", () => {
    const cyclic: Record<string, unknown> = { type: "object", $ref: "#" };
    cyclic["properties"] = { self: { $ref: "#" } };
    const changes: ChangeIndex = new Map([
      ["#", new Map<string, ChangeKind>([["additionalProperties", "removed"]])],
    ]);
    expect(generateCandidates(cyclic, changes, 4096).length).toBeGreaterThan(0);
  });

  it("4. an unseedable root still yields a probe value", () => {
    const changes: ChangeIndex = new Map([
      ["#", new Map<string, ChangeKind>([["pattern", "removed"]])],
    ]);
    const produced = generateCandidates({ type: "string", pattern: "^a$" }, changes, 4096);
    expect(produced[0]?.value).toBe(null);
    expect(produced[1]?.value).toBe("!");
  });
});
