#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { adapt, differential, explain, targets } from "./index.js";
import { SchemaProbeError } from "./errors.js";
import { isTargetId, targetIds } from "./targets/index.js";
import type { DifferentialResult, TargetId } from "./types.js";

const USAGE = [
  "schema-envoy --target <id> [file]",
  "schema-envoy --targets",
  "schema-envoy --self-check",
  "",
  "  --target <id>  one of: " + targetIds().join(", "),
  "  --json         print { schema, report } as JSON",
  "  file           a JSON Schema; read from stdin when omitted",
].join("\n");

/**
 * The section 2 baselines, embedded so that `--self-check` runs against the
 * compiled library on a machine that has only the published tarball.
 */
const B1_SOURCE = {
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
};

const B1_CONVERTED = {
  type: "object",
  properties: {
    sku: { type: "string", pattern: "^[A-Z]{3}-\\d{4}$" },
    qty: { type: "integer", minimum: 1, maximum: 99 },
    currency: { type: "string" },
    tags: { type: "array", items: { type: "string" }, maxItems: 3 },
    discount: { type: "number" },
  },
  required: ["sku", "qty", "currency", "tags"],
};

const B2_SOURCE = {
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
};

const B2_CONVERTED = {
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
};

const B3_SOURCE = {
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
};

const B3_CONVERTED = {
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
};

const B4_SOURCE = {
  oneOf: [
    { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
  ],
};

const B4_CONVERTED = {
  anyOf: [
    { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
    { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
  ],
};

const B5_SOURCE = {
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
};

const B5_CONVERTED = {
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
};

function b1Corpus(): unknown[] {
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

function b2Corpus(): unknown[] {
  const out: unknown[] = [];
  for (const nickname of [undefined, "n"]) {
    for (const age of [undefined, 30]) {
      for (const address of [undefined, { city: "X" }, { city: "X", zip: "1" }]) {
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

function b3Corpus(): unknown[] {
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

const B4_CORPUS: unknown[] = [{ a: "1" }, { b: "1" }, { a: "1", b: "1" }, {}];

function b5Corpus(): unknown[] {
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

interface Baseline {
  id: string;
  label: string;
  source: unknown;
  converted: unknown;
  corpus: unknown[];
  expected: { checked: number; agreed: number; widened: number; narrowed: number };
  adaptTarget?: TargetId;
}

function baselines(): Baseline[] {
  return [
    {
      id: "B1",
      label: "gemini.functionDeclarationParameters",
      source: B1_SOURCE,
      converted: B1_CONVERTED,
      corpus: b1Corpus(),
      expected: { checked: 720, agreed: 648, widened: 72, narrowed: 0 },
      adaptTarget: "gemini.functionDeclarationParameters",
    },
    {
      id: "B2",
      label: "naive strict required-fill",
      source: B2_SOURCE,
      converted: B2_CONVERTED,
      corpus: b2Corpus(),
      expected: { checked: 12, agreed: 1, widened: 0, narrowed: 11 },
    },
    {
      id: "B3",
      label: "gemini.parametersJsonSchema",
      source: B3_SOURCE,
      converted: B3_CONVERTED,
      corpus: b3Corpus(),
      expected: { checked: 96, agreed: 2, widened: 94, narrowed: 0 },
      adaptTarget: "gemini.parametersJsonSchema",
    },
    {
      id: "B4",
      label: "oneOf read as anyOf",
      source: B4_SOURCE,
      converted: B4_CONVERTED,
      corpus: B4_CORPUS,
      expected: { checked: 4, agreed: 3, widened: 1, narrowed: 0 },
    },
    {
      id: "B5",
      label: "openai.strict",
      source: B5_SOURCE,
      converted: B5_CONVERTED,
      corpus: b5Corpus(),
      expected: { checked: 72, agreed: 36, widened: 35, narrowed: 1 },
      adaptTarget: "openai.strict",
    },
  ];
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortDeep(a)) === JSON.stringify(sortDeep(b));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortDeep(entry));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function counts(result: DifferentialResult): string {
  return `checked=${result.checked} agreed=${result.agreed} widened=${result.widened} narrowed=${result.narrowed}`;
}

function selfCheck(out: (line: string) => void): number {
  let failed = false;
  for (const baseline of baselines()) {
    const observed = differential(baseline.source, baseline.converted, baseline.corpus);
    let ok =
      observed.checked === baseline.expected.checked &&
      observed.agreed === baseline.expected.agreed &&
      observed.widened === baseline.expected.widened &&
      observed.narrowed === baseline.expected.narrowed;
    if (ok && baseline.adaptTarget) {
      const produced = adapt(baseline.source, baseline.adaptTarget, {
        onDivergence: "report",
      }).schema;
      ok = sameJson(produced, baseline.converted);
    }
    if (!ok) failed = true;
    out(`${baseline.id} ${baseline.label} ${ok ? "ok" : "FAIL"} ${counts(observed)}`);
  }
  return failed ? 1 : 0;
}

function listTargets(out: (line: string) => void): number {
  for (const profile of targets()) {
    out(
      `${profile.id}\t${profile.sourceVersion}\tallow=${profile.allow.length}\tdeny=${profile.deny.length}`,
    );
  }
  return 0;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: readonly string[]): Promise<number> {
  const stdout = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const stderr = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };

  let targetArg: string | undefined;
  let file: string | undefined;
  let json = false;
  let wantTargets = false;
  let wantSelfCheck = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--target") {
      i += 1;
      targetArg = argv[i];
      if (targetArg === undefined) {
        stderr("--target requires a target id");
        stderr(USAGE);
        return 2;
      }
    } else if (arg === "--targets") {
      wantTargets = true;
    } else if (arg === "--self-check") {
      wantSelfCheck = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      stdout(USAGE);
      return 0;
    } else if (arg.startsWith("-")) {
      stderr(`unknown option ${arg}`);
      stderr(USAGE);
      return 2;
    } else if (file === undefined) {
      file = arg;
    } else {
      stderr("at most one input file may be given");
      stderr(USAGE);
      return 2;
    }
  }

  if (wantTargets) return listTargets(stdout);
  if (wantSelfCheck) return selfCheck(stdout);

  if (targetArg === undefined) {
    stderr("--target is required unless --targets or --self-check is given");
    stderr(USAGE);
    return 2;
  }
  if (!isTargetId(targetArg)) {
    stderr(`unknown target ${targetArg}`);
    stderr(`valid ids: ${targetIds().join(", ")}`);
    return 2;
  }

  let text: string;
  try {
    text = file === undefined ? await readStdin() : readFileSync(file, "utf8");
  } catch (error) {
    stderr(`could not read input: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    stderr(`input is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  try {
    const result = adapt(parsed, targetArg, { onDivergence: "report" });
    if (json) {
      stdout(JSON.stringify({ schema: result.schema, report: result.report }));
    } else {
      stdout(explain(result.report));
    }
    return result.report.equivalent ? 0 : 1;
  } catch (error) {
    if (error instanceof SchemaProbeError) {
      stderr(error.message);
      return 3;
    }
    stderr(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

/**
 * Run only when this file is the process entry point. No top-level await and
 * no `import.meta`: both break the CJS half of the dual build.
 */
export function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== "string") return false;
  const base = entry.replace(/\\/g, "/").split("/").pop() ?? "";
  return base === "cli.js" || base === "cli.cjs" || base === "schema-envoy";
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 3;
    },
  );
}
