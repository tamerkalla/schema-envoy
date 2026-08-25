import { describe, expect, it } from "vitest";
import { adapt, differential } from "../src/index.js";
import { InvalidSchemaError, SchemaProbeError } from "../src/errors.js";
import { WITNESS_CAP, classify, createAjv, makePredicate, tryCompile } from "../src/differential.js";
import * as B from "./fixtures/baseline.js";
import { ALL_TARGETS, FIXTURE_SCHEMAS } from "./fixtures/schemas.js";

const ALWAYS = (): boolean => true;

describe("5. differential", () => {
  for (const fixture of FIXTURE_SCHEMAS) {
    for (const targetId of ALL_TARGETS) {
      it(`5. ${fixture.name} to ${targetId}: checked equals agreed plus widened plus narrowed`, () => {
        const report = adapt(fixture.schema, targetId, { onDivergence: "report" }).report;
        const d = report.differential;
        expect(d.checked).toBe(d.agreed + d.widened + d.narrowed);
      });
    }
  }

  it("5. an empty corpus is a probe failure, not a finding", () => {
    expect(() => differential(B.B1_SOURCE, B.B1_CONVERTED, [])).toThrow(SchemaProbeError);
    expect(() => differential(B.B1_SOURCE, B.B1_CONVERTED, [])).toThrow(/corpus is empty/);
  });

  it("5. two identical schemas never widen or narrow", () => {
    for (const fixture of FIXTURE_SCHEMAS) {
      const observed = differential(fixture.schema, fixture.schema, B.B1_CORPUS);
      expect(observed.widened).toBe(0);
      expect(observed.narrowed).toBe(0);
      expect(observed.agreed).toBe(observed.checked);
    }
  });

  it("5. a schema ajv refuses is an invalid schema on either side", () => {
    const broken = { type: "object", properties: { a: { type: 7 } } };
    expect(() => differential(broken, B.B1_CONVERTED, [1])).toThrow(InvalidSchemaError);
    expect(() => differential(B.B1_SOURCE, broken, [1])).toThrow(InvalidSchemaError);
  });

  it("5. witnesses are capped at eight in corpus order", () => {
    const observed = differential(B.B5_SOURCE, B.B5_CONVERTED, B.B5_CORPUS);
    expect(observed.widened).toBeGreaterThan(WITNESS_CAP);
    expect(observed.widenedWitnesses.length).toBe(WITNESS_CAP);
    expect(observed.narrowedWitnesses.length).toBe(1);
    const firstWidened = B.B5_CORPUS.find(
      (value) =>
        makePredicate(createAjv().compile(B.B5_CONVERTED as object), "c")(value) &&
        !makePredicate(createAjv().compile(B.B5_SOURCE as object), "s")(value),
    );
    expect(observed.widenedWitnesses[0]).toEqual(firstWidened);
  });

  it("5. classify counts a corpus against two predicates", () => {
    const observed = classify([1, 2, 3], ALWAYS, (value) => value !== 2);
    expect(observed).toEqual({
      checked: 3,
      agreed: 2,
      widened: 0,
      narrowed: 1,
      widenedWitnesses: [],
      narrowedWitnesses: [2],
    });
  });

  it("5. tryCompile reports failure instead of throwing", () => {
    const outcome = tryCompile({ type: 7 });
    expect(outcome.ok).toBe(false);
  });
});
