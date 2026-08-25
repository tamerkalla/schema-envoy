import { describe, expect, it } from "vitest";
import { residual, target } from "../src/index.js";
import { isDropped } from "../src/residual.js";
import { InvalidSchemaError, UnknownTargetError } from "../src/errors.js";
import { createAjv, makePredicate } from "../src/differential.js";
import * as B from "./fixtures/baseline.js";
import { ALL_TARGETS, IN_SUBSET } from "./fixtures/schemas.js";
import type { TargetId } from "../src/types.js";

const acceptedBySource = makePredicate(createAjv().compile(B.B5_SOURCE as object), "source");
const acceptedByConverted = makePredicate(createAjv().compile(B.B5_CONVERTED as object), "converted");

/** The values the provider would let through that the source schema rejects. */
const LET_THROUGH = B.B5_CORPUS.filter(
  (value) => acceptedByConverted(value) && !acceptedBySource(value),
);

describe("6. residual", () => {
  it("6. openai.strict leaves exactly these B5 constraints unenforced", () => {
    const result = residual(B.B5_SOURCE, "openai.strict");
    for (const keyword of [
      "format",
      "pattern",
      "minLength",
      "minimum",
      "maximum",
      "maxItems",
      "uniqueItems",
    ]) {
      expect(result.enforcedHere).toContain(keyword);
    }
    expect(result.enforcedByProvider).toContain("type");
    expect(result.enforcedByProvider).toContain("required");
    expect(result.enforcedByProvider).toContain("additionalProperties");
    for (const keyword of result.enforcedHere) {
      expect(result.enforcedByProvider).not.toContain(keyword);
    }
  });

  it("6. the residual validator rejects every value the provider would let through", () => {
    const result = residual(B.B5_SOURCE, "openai.strict");
    expect(LET_THROUGH.length).toBe(35);
    const survivors = LET_THROUGH.filter((value) => result.validate(value));
    expect(survivors).toEqual([]);
  });

  it("6. the residual validator accepts what the source accepts", () => {
    const result = residual(B.B5_SOURCE, "openai.strict");
    const accepted = B.B5_CORPUS.filter((value) => acceptedBySource(value));
    expect(accepted.length).toBe(2);
    for (const value of accepted) {
      expect(result.validate(value)).toBe(true);
      expect(result.errors(value)).toEqual([]);
    }
  });

  it("6. errors are ajv messages prefixed with their instance path", () => {
    const result = residual(B.B5_SOURCE, "openai.strict");
    const messages = result.errors({ email: "nope", slug: "AB", score: 99, tags: ["x", "x"] });
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message.startsWith("/") || message.startsWith("#")).toBe(true);
    }
    expect(messages.join(" ")).toContain("/email");
  });

  it("6. a schema already inside the subset needs no residual at all", () => {
    for (const targetId of ALL_TARGETS) {
      const result = residual(IN_SUBSET[targetId], targetId);
      expect(result.schema).toBe(true);
      expect(result.enforcedHere).toEqual([]);
      expect(result.validate({ anything: 1 })).toBe(true);
      expect(result.errors(null)).toEqual([]);
    }
  });

  it("6. the residual reaches constraints behind a reference", () => {
    const result = residual(
      {
        $defs: { entry: { type: "string", pattern: "^a$" } },
        type: "object",
        properties: { a: { $ref: "#/$defs/entry" } },
        required: ["a"],
      },
      "openai.strict",
    );
    expect(result.enforcedHere).toContain("pattern");
    expect(result.validate({ a: "a" })).toBe(true);
    expect(result.validate({ a: "zzz" })).toBe(false);
  });

  it("6. the residual keeps positional typing a surface cannot express", () => {
    const result = residual(
      { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }] },
      "openai.strict",
    );
    expect(result.enforcedHere).toContain("prefixItems");
    expect(result.validate(["a", 1])).toBe(true);
    expect(result.validate([1, "a"])).toBe(false);
  });

  it("6. residual rejects an unknown target and an unusable schema", () => {
    expect(() => residual({}, "nope" as TargetId)).toThrow(UnknownTargetError);
    expect(() => residual(null, "openai.strict")).toThrow(InvalidSchemaError);
    expect(() => residual([], "openai.strict")).toThrow(InvalidSchemaError);
    expect(() => residual({ $ref: "#/$defs/missing" }, "openai.strict")).toThrow(
      InvalidSchemaError,
    );
  });

  it("6. residual never throws merely because the conversion diverges", () => {
    for (const targetId of ALL_TARGETS) {
      const result = residual(B.B1_SOURCE, targetId);
      expect(typeof result.validate).toBe("function");
    }
  });

  it("6. gemini.parametersJsonSchema keeps oneOf, which the surface reinterprets", () => {
    const result = residual(B.B4_SOURCE, "gemini.parametersJsonSchema");
    expect(result.enforcedHere).toContain("oneOf");
    expect(result.validate({ a: "1" })).toBe(true);
    expect(result.validate({ a: "1", b: "1" })).toBe(false);
  });
});

describe("6. residual internals", () => {
  it("6. isDropped separates annotation, scaffolding and reference keywords", () => {
    const openai = target("openai.strict");
    expect(isDropped(openai, "title")).toBe(false);
    expect(isDropped(openai, "$ref")).toBe(false);
    expect(isDropped(openai, "properties")).toBe(false);
    expect(isDropped(openai, "type")).toBe(false);
    expect(isDropped(openai, "pattern")).toBe(true);
    expect(isDropped(openai, "oneOf")).toBe(true);
    expect(isDropped(target("gemini.parametersJsonSchema"), "oneOf")).toBe(true);
    expect(isDropped(target("gemini.parametersJsonSchema"), "minItems")).toBe(false);
  });

  it("6. a surface that keeps prefixItems descends into it instead of copying it", () => {
    const result = residual(
      {
        type: "array",
        prefixItems: [{ type: "string", minLength: 2 }, { type: "integer" }],
      },
      "gemini.parametersJsonSchema",
    );
    expect(result.enforcedHere).toContain("minLength");
    expect(result.enforcedHere).not.toContain("prefixItems");
    expect(result.enforcedByProvider).toContain("prefixItems");
    expect(result.validate(["ab", 1])).toBe(true);
    expect(result.validate(["a", 1])).toBe(false);
  });

  it("6. the residual descends into array items", () => {
    const result = residual(
      { type: "array", items: { type: "string", pattern: "^a$" } },
      "openai.strict",
    );
    expect(result.schema).toEqual({ type: "array", items: { pattern: "^a$" } });
    expect(result.enforcedByProvider).toContain("items");
    expect(result.validate(["a"])).toBe(true);
    expect(result.validate(["z"])).toBe(false);
  });

  it("6. a cyclic reference contributes nothing rather than looping", () => {
    const result = residual(
      {
        $defs: {
          node: {
            type: "object",
            properties: { next: { $ref: "#/$defs/node" }, tag: { type: "string", minLength: 2 } },
          },
        },
        $ref: "#/$defs/node",
      },
      "openai.strict",
    );
    expect(result.enforcedHere).toContain("minLength");
    expect(result.validate({ tag: "ab" })).toBe(true);
    expect(result.validate({ tag: "a" })).toBe(false);
  });

  it("6. a boolean subschema contributes nothing", () => {
    expect(residual(true, "openai.strict").schema).toBe(true);
    expect(residual(false, "openai.strict").schema).toBe(true);
    expect(
      residual({ type: "object", properties: { a: true } }, "openai.strict").schema,
    ).toBe(true);
  });

  it("6. $defs travels with a residual that needs it", () => {
    const result = residual(
      {
        $defs: { small: { type: "string", maxLength: 1 } },
        allOf: [{ $ref: "#/$defs/small" }],
      },
      "openai.strict",
    );
    const schema = result.schema as Record<string, unknown>;
    expect(schema["$defs"]).toEqual({ small: { type: "string", maxLength: 1 } });
    expect(result.validate("a")).toBe(true);
    expect(result.validate("ab")).toBe(false);
  });
});
