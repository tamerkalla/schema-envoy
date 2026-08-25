/**
 * The verified baseline from section 2 of the specification.
 *
 * Every corpus here is an explicit enumeration. Nothing in this file is
 * produced by a pseudo-random generator, and no count asserted against it is
 * re-derived at test time.
 *
 * The B1 source schema is `z.toJSONSchema()` output transcribed by hand; zod
 * is deliberately not a dependency of this package.
 */

export const B1_SOURCE = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    sku: { type: "string", pattern: "^[A-Z]{3}-\\d{4}$" },
    qty: { type: "integer", minimum: 1, maximum: 99, multipleOf: 1 },
    currency: { type: "string", const: "USD" },
    tags: { type: "array", items: { type: "string" }, maxItems: 3 },
    discount: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1 },
  },
  required: ["sku", "qty", "currency", "tags"],
  additionalProperties: false,
} as const;

export const B1_CONVERTED = {
  type: "object",
  properties: {
    sku: { type: "string", pattern: "^[A-Z]{3}-\\d{4}$" },
    qty: { type: "integer", minimum: 1, maximum: 99 },
    currency: { type: "string" },
    tags: { type: "array", items: { type: "string" }, maxItems: 3 },
    discount: { type: "number" },
  },
  required: ["sku", "qty", "currency", "tags"],
} as const;

export const B1_CORPUS: readonly unknown[] = buildB1();

function buildB1(): unknown[] {
  const out: unknown[] = [];
  for (const sku of ["ABC-1234", "abc-1234", "ABC-12"]) {
    for (const qty of [1, 50, 99, 0, 100, 2.5]) {
      for (const currency of ["USD", "EUR"]) {
        for (const tags of [[], ["a"], ["a", "b", "c"], ["a", "b", "c", "d"]]) {
          for (const discount of [undefined, 0.5, 0, 1, 1.5]) {
            const value: Record<string, unknown> = { sku, qty, currency, tags: [...tags] };
            if (discount !== undefined) value["discount"] = discount;
            out.push(value);
          }
        }
      }
    }
  }
  return out;
}

export const B2_SOURCE = {
  type: "object",
  properties: {
    id: { type: "string" },
    nickname: { type: "string" },
    age: { type: "integer" },
    address: {
      type: "object",
      properties: { city: { type: "string" }, zip: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    },
  },
  required: ["id"],
  additionalProperties: false,
} as const;

/**
 * The naive strict conversion: required-filling without the nullable rewrite.
 * A literal fixture, not something `adapt()` produces. It exists to justify
 * why `openai.strict` performs the nullable rewrite at all.
 */
export const B2_CONVERTED = {
  type: "object",
  properties: {
    id: { type: "string" },
    nickname: { type: "string" },
    age: { type: "integer" },
    address: {
      type: "object",
      properties: { city: { type: "string" }, zip: { type: "string" } },
      required: ["city", "zip"],
      additionalProperties: false,
    },
  },
  required: ["id", "nickname", "age", "address"],
  additionalProperties: false,
} as const;

export const B2_CORPUS: readonly unknown[] = buildB2();

function buildB2(): unknown[] {
  const out: unknown[] = [];
  for (const nickname of [undefined, "n"]) {
    for (const age of [undefined, 30]) {
      for (const address of [
        undefined,
        { city: "X" },
        { city: "X", zip: "1" },
      ] as (Record<string, unknown> | undefined)[]) {
        const value: Record<string, unknown> = { id: "u1" };
        if (nickname !== undefined) value["nickname"] = nickname;
        if (age !== undefined) value["age"] = age;
        if (address !== undefined) value["address"] = { ...address };
        out.push(value);
      }
    }
  }
  return out;
}

export const B3_SOURCE = {
  type: "object",
  properties: {
    code: { type: "string", pattern: "^[A-Z]{2}$" },
    kind: { const: "invoice" },
    name: { type: "string", minLength: 2, maxLength: 8 },
    price: { type: "number", exclusiveMinimum: 0, multipleOf: 0.5 },
    ids: { type: "array", items: { type: "integer" }, uniqueItems: true },
  },
  required: ["code", "kind", "name", "price", "ids"],
  additionalProperties: false,
} as const;

export const B3_CONVERTED = {
  type: "object",
  properties: {
    code: { type: "string" },
    kind: {},
    name: { type: "string" },
    price: { type: "number" },
    ids: { type: "array", items: { type: "integer" } },
  },
  required: ["code", "kind", "name", "price", "ids"],
  additionalProperties: false,
} as const;

export const B3_CORPUS: readonly unknown[] = buildB3();

function buildB3(): unknown[] {
  const out: unknown[] = [];
  for (const code of ["AB", "abc"]) {
    for (const kind of ["invoice", "receipt"]) {
      for (const name of ["ab", "x", "abcdefghij"]) {
        for (const price of [1, 1.5, 0, 1.25]) {
          for (const ids of [
            [1, 2],
            [1, 1],
          ]) {
            out.push({ code, kind, name, price, ids: [...ids] });
          }
        }
      }
    }
  }
  return out;
}

/** Google documents that `oneOf` is interpreted the same way as `anyOf`. */
export const B4_SOURCE = {
  oneOf: [
    { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
  ],
} as const;

export const B4_CONVERTED = {
  anyOf: [
    { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
  ],
} as const;

export const B4_CORPUS: readonly unknown[] = [
  { a: "1" },
  { b: "1" },
  { a: "1", b: "1" },
  {},
];

export const B5_SOURCE = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    slug: { type: "string", pattern: "^[a-z-]+$", minLength: 3 },
    score: { type: "integer", minimum: 0, maximum: 10 },
    tags: { type: "array", items: { type: "string" }, maxItems: 2, uniqueItems: true },
    note: { type: "string" },
  },
  required: ["email", "slug", "score", "tags"],
  additionalProperties: false,
} as const;

export const B5_CONVERTED = {
  type: "object",
  properties: {
    email: { type: "string" },
    slug: { type: "string" },
    score: { type: "integer" },
    tags: { type: "array", items: { type: "string" } },
    note: { type: ["string", "null"] },
  },
  required: ["email", "slug", "score", "tags", "note"],
  additionalProperties: false,
} as const;

export const B5_CORPUS: readonly unknown[] = buildB5();

function buildB5(): unknown[] {
  const out: unknown[] = [];
  for (const email of ["a@b.co", "nope"]) {
    for (const slug of ["abc", "AB"]) {
      for (const score of [5, -1, 11]) {
        for (const tags of [["x"], ["x", "y", "z"], ["x", "x"]]) {
          for (const note of [undefined, "n"]) {
            const value: Record<string, unknown> = { email, slug, score, tags: [...tags] };
            if (note !== undefined) value["note"] = note;
            out.push(value);
          }
        }
      }
    }
  }
  return out;
}
