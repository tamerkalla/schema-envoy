import { describe, expect, it } from "vitest";
import { adapt, explain, target } from "../src/index.js";
import * as B from "./fixtures/baseline.js";
import { ALL_TARGETS, FIXTURE_SCHEMAS } from "./fixtures/schemas.js";
import type { AdaptReport } from "../src/types.js";

const B5 = adapt(B.B5_SOURCE, "openai.strict", { onDivergence: "report" }).report;

describe("7. explain", () => {
  it("7. names the target and the source version", () => {
    const text = explain(B5);
    expect(typeof text).toBe("string");
    expect(text).toContain("openai.strict");
    expect(text).toContain(target("openai.strict").sourceVersion);
    expect(text).toContain(target("openai.strict").sourceUrl);
    expect(text).toContain("captured 2026-08-24");
  });

  it("7. renders one line per divergence", () => {
    const text = explain(B5);
    const rendered = text.split("\n").filter((entry) => entry.trimStart().startsWith("["));
    expect(rendered.length).toBe(B5.divergences.length);
    for (const divergence of B5.divergences) {
      expect(
        rendered.some(
          (entry) => entry.includes(divergence.pointer) && entry.includes(divergence.keyword),
        ),
      ).toBe(true);
    }
  });

  it("7. distinguishes a documented removal from a conservative guess", () => {
    const text = explain(B5);
    expect(text).toContain("(documented unsupported)");
    const gemini = adapt(B.B1_SOURCE, "gemini.functionDeclarationParameters", {
      onDivergence: "report",
    }).report;
    expect(explain(gemini)).toContain("(undocumented)");
    expect(explain(gemini)).not.toContain("(documented unsupported)");
  });

  it("7. is deterministic across runs", () => {
    for (const fixture of FIXTURE_SCHEMAS) {
      for (const targetId of ALL_TARGETS) {
        const first = adapt(fixture.schema, targetId, { onDivergence: "report" }).report;
        const second = adapt(fixture.schema, targetId, { onDivergence: "report" }).report;
        expect(explain(second)).toBe(explain(first));
      }
    }
  });

  it("7. says plainly that equivalence is evidence and not a proof", () => {
    const clean = adapt(
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      "gemini.functionDeclarationParameters",
    ).report;
    const text = explain(clean);
    expect(text).toContain("no divergence");
    expect(text).toContain("That is evidence, not a proof.");
  });

  it("7. renders warnings when the conversion produced any", () => {
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 8; i += 1) {
      deep = { type: "object", properties: { next: deep }, required: ["next"] };
    }
    const report = adapt(deep, "openai.strict", { onDivergence: "report" }).report;
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(explain(report)).toContain("warnings:");
  });

  it("7. never throws, even on a report that makes no sense", () => {
    const broken = null as unknown as AdaptReport;
    expect(explain(broken)).toBe("schema-envoy: report could not be rendered");
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    const withCircularWitness = {
      ...B5,
      divergences: [
        {
          pointer: "#",
          keyword: "pattern",
          effect: "widen" as const,
          evidence: "value" as const,
          documented: false,
          reason: "a reason",
          witness: circular,
        },
      ],
    };
    expect(explain(withCircularWitness)).toContain("[widen]");
  });
});
