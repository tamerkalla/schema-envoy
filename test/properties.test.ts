import { describe, expect, it } from "vitest";
import { adapt, differential, explain, residual } from "../src/index.js";
import * as B from "./fixtures/baseline.js";
import { ALL_TARGETS, FIXTURE_SCHEMAS, IN_SUBSET } from "./fixtures/schemas.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function snapshot(value: unknown): string {
  return JSON.stringify(value);
}

describe("9. properties", () => {
  it("9. adapt is deterministic", () => {
    for (const fixture of FIXTURE_SCHEMAS) {
      for (const targetId of ALL_TARGETS) {
        const a = adapt(fixture.schema, targetId, { onDivergence: "report" });
        const b = adapt(fixture.schema, targetId, { onDivergence: "report" });
        expect(snapshot(b.schema)).toBe(snapshot(a.schema));
        expect(snapshot(b.report)).toBe(snapshot(a.report));
      }
    }
  });

  it("9. adapt, differential, residual and explain never mutate their arguments", () => {
    for (const fixture of FIXTURE_SCHEMAS) {
      const frozen = deepFreeze(JSON.parse(JSON.stringify(fixture.schema)) as unknown);
      const before = snapshot(frozen);
      for (const targetId of ALL_TARGETS) {
        const result = adapt(frozen, targetId, { onDivergence: "report" });
        expect(snapshot(frozen)).toBe(before);
        const frozenReport = deepFreeze(result.report);
        expect(typeof explain(frozenReport)).toBe("string");
        residual(frozen, targetId);
        expect(snapshot(frozen)).toBe(before);
      }
      const corpus = deepFreeze([{ a: 1 }, { b: 2 }] as unknown[]);
      differential(frozen, frozen, corpus);
      expect(snapshot(frozen)).toBe(before);
      expect(snapshot(corpus)).toBe('[{"a":1},{"b":2}]');
    }
  });

  it("9. the returned schema is a fresh object, not a view of the input", () => {
    const input: Record<string, unknown> = {
      type: "object",
      properties: { a: { type: "string", pattern: "^a$" } },
      required: ["a"],
    };
    const result = adapt(input, "openai.strict", { onDivergence: "report" });
    const properties = result.schema as Record<string, Record<string, Record<string, unknown>>>;
    expect(properties["properties"]?.["a"]).not.toBe(
      (input["properties"] as Record<string, unknown>)["a"],
    );
  });

  it("9. adapt is idempotent: a second pass removes nothing", () => {
    for (const fixture of FIXTURE_SCHEMAS) {
      for (const targetId of ALL_TARGETS) {
        const once = adapt(fixture.schema, targetId, { onDivergence: "report" });
        const twice = adapt(once.schema, targetId, { onDivergence: "report" });
        expect(twice.report.removed).toEqual([]);
        expect(snapshot(twice.schema)).toBe(snapshot(once.schema));
      }
    }
  });

  it("9. a schema already inside a subset round-trips unchanged", () => {
    for (const targetId of ALL_TARGETS) {
      const input = IN_SUBSET[targetId];
      const result = adapt(input, targetId);
      expect(result.schema).toEqual(input);
      expect(result.report.equivalent).toBe(true);
      expect(result.report.removed).toEqual([]);
      expect(result.report.rewritten).toEqual([]);
      expect(result.report.divergences).toEqual([]);
    }
  });

  it("9. the extra corpus is evaluated after the generated witnesses", () => {
    const extra = [{ made: "up" }, 42];
    const withExtra = adapt(B.B1_SOURCE, "gemini.functionDeclarationParameters", {
      onDivergence: "report",
      corpus: extra,
    });
    const without = adapt(B.B1_SOURCE, "gemini.functionDeclarationParameters", {
      onDivergence: "report",
    });
    expect(withExtra.report.differential.checked).toBe(
      without.report.differential.checked + extra.length,
    );
  });
});
