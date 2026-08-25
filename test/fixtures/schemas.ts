import type { TargetId } from "../../src/types.js";

/**
 * The four working fixtures. Between them they exercise every keyword class
 * the three profiles treat differently, and every one of them is seedable, so
 * the non-vacuity floor in `test/witness.test.ts` has something to stand on.
 */

export const CATALOG_ITEM = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 2, maxLength: 10 },
    count: { type: "integer", minimum: 1, maximum: 5 },
    ratio: { type: "number", multipleOf: 0.5 },
  },
  required: ["name", "count", "ratio"],
  additionalProperties: false,
} as const;

export const TAG_LIST = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: { type: "string", maxLength: 4 },
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
    },
    label: { type: "string" },
  },
  required: ["entries", "label"],
} as const;

export const INVOICE_LINE = {
  type: "object",
  properties: {
    amount: { type: "number", exclusiveMinimum: 0, multipleOf: 0.25 },
    kind: { type: "string", enum: ["a", "b"] },
    codes: { type: "array", items: { type: "integer" }, minItems: 1, uniqueItems: true },
  },
  required: ["amount", "kind", "codes"],
} as const;

export const REFERENCED = {
  $defs: {
    entry: {
      type: "object",
      properties: { score: { type: "integer", minimum: 0 } },
      required: ["score"],
    },
  },
  type: "object",
  properties: {
    primary: { $ref: "#/$defs/entry" },
    ratio: { type: "number", multipleOf: 0.5 },
  },
  required: ["primary", "ratio"],
} as const;

export const FIXTURE_SCHEMAS: readonly { name: string; schema: unknown }[] = [
  { name: "CATALOG_ITEM", schema: CATALOG_ITEM },
  { name: "TAG_LIST", schema: TAG_LIST },
  { name: "INVOICE_LINE", schema: INVOICE_LINE },
  { name: "REFERENCED", schema: REFERENCED },
];

export const ALL_TARGETS: readonly TargetId[] = [
  "gemini.parametersJsonSchema",
  "gemini.functionDeclarationParameters",
  "openai.strict",
];

/** A schema already inside each target's accepted subset. */
export const IN_SUBSET: Record<TargetId, Record<string, unknown>> = {
  "gemini.functionDeclarationParameters": {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
  },
  "gemini.parametersJsonSchema": {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
  },
  "openai.strict": {
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
  },
};

/** A draft-07 schema exercising all four normalization rules at once. */
export const DRAFT07 = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  definitions: {
    positive: { type: "integer", minimum: 1, exclusiveMinimum: true },
  },
  properties: {
    n: { $ref: "#/definitions/positive" },
    pair: {
      type: "array",
      items: [{ type: "string" }, { type: "integer" }],
      additionalItems: { type: "boolean" },
    },
  },
  required: ["n"],
} as const;

/**
 * The same schema in strictly draft-07-legal form, so that a draft-07 ajv can
 * compile it for the cross-dialect equivalence check. It lifts to exactly the
 * same 2020-12 schema.
 */
export const DRAFT07_PORTABLE = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  definitions: {
    positive: { type: "integer", exclusiveMinimum: 1 },
  },
  properties: {
    n: { $ref: "#/definitions/positive" },
    pair: {
      type: "array",
      items: [{ type: "string" }, { type: "integer" }],
      additionalItems: { type: "boolean" },
    },
  },
  required: ["n"],
} as const;

export const DRAFT07_LIFTED = {
  type: "object",
  $defs: {
    positive: { type: "integer", exclusiveMinimum: 1 },
  },
  properties: {
    n: { $ref: "#/$defs/positive" },
    pair: {
      type: "array",
      prefixItems: [{ type: "string" }, { type: "integer" }],
      items: { type: "boolean" },
    },
  },
  required: ["n"],
} as const;

/** 24 values, written out. */
export const DRAFT07_CORPUS: readonly unknown[] = buildDraft07Corpus();

function buildDraft07Corpus(): unknown[] {
  const out: unknown[] = [];
  for (const n of [1, 2, 0, "x"]) {
    for (const pair of [
      undefined,
      ["a", 1],
      ["a", 1, true],
      ["a", 1, "no"],
      [1, "a"],
      [],
    ] as (unknown[] | undefined)[]) {
      const value: Record<string, unknown> = { n };
      if (pair !== undefined) value["pair"] = [...pair];
      out.push(value);
    }
  }
  return out;
}
