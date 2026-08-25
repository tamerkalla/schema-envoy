import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { invokedDirectly, main } from "../src/cli.js";

const CLI = join("dist", "cli.js");
const workspace = mkdtempSync(join(tmpdir(), "schema-envoy-cli-"));

const EQUIVALENT = join(workspace, "equivalent.json");
const DIVERGENT = join(workspace, "divergent.json");
const BROKEN_REF = join(workspace, "broken-ref.json");
const NOT_JSON = join(workspace, "not-json.json");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: readonly string[], input = ""): Run {
  const result = spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8" });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

async function inProcess(args: readonly string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const capture = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture as never);
  vi.spyOn(process.stderr, "write").mockImplementation(capture as never);
  const code = await main(args);
  return { code, out: chunks.join("") };
}

beforeAll(() => {
  writeFileSync(
    EQUIVALENT,
    JSON.stringify({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }),
  );
  writeFileSync(
    DIVERGENT,
    JSON.stringify({
      type: "object",
      properties: { a: { type: "string", pattern: "^a$" } },
      required: ["a"],
    }),
  );
  writeFileSync(
    BROKEN_REF,
    JSON.stringify({
      type: "object",
      patternProperties: { "^a$": { $defs: { x: { type: "string" } } } },
      properties: { b: { $ref: "#/patternProperties/%5Ea%24/$defs/x" } },
      required: ["b"],
    }),
  );
  writeFileSync(NOT_JSON, "this is not json");
  if (!existsSync(CLI)) {
    execFileSync("npm", ["run", "build"], { stdio: "ignore" });
  }
}, 300_000);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("11. cli", () => {
  it("11. --targets lists one line per profile and exits 0", () => {
    const result = run(["--targets"]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("gemini.parametersJsonSchema");
    expect(lines[0]).toContain("allow=21");
    expect(lines[0]).toContain("deny=0");
    expect(lines[2]).toContain("deny=19");
  });

  it("11. --self-check reproduces every baseline and exits 0", () => {
    const result = run(["--self-check"]);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines.length).toBe(5);
    expect(lines.every((line) => line.includes(" ok "))).toBe(true);
    expect(result.stdout).toContain("checked=720 agreed=648 widened=72 narrowed=0");
    expect(result.stdout).toContain("checked=12 agreed=1 widened=0 narrowed=11");
    expect(result.stdout).toContain("checked=96 agreed=2 widened=94 narrowed=0");
    expect(result.stdout).toContain("checked=4 agreed=3 widened=1 narrowed=0");
    expect(result.stdout).toContain("checked=72 agreed=36 widened=35 narrowed=1");
  });

  it("11. an equivalent conversion exits 0 and prints the explanation", () => {
    const result = run(["--target", "gemini.functionDeclarationParameters", EQUIVALENT]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no divergence");
  });

  it("11. a divergent conversion exits 1", () => {
    const result = run(["--target", "openai.strict", DIVERGENT]);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("[widen]");
  });

  it("11. --json prints the schema and report and nothing else", () => {
    const result = run(["--target", "openai.strict", "--json", DIVERGENT]);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { schema: unknown; report: { target: string } };
    expect(parsed.report.target).toBe("openai.strict");
    expect(parsed.schema).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
      additionalProperties: false,
    });
  });

  it("11. the schema is read from stdin when no file is given", () => {
    const result = run(["--target", "openai.strict"], '{"type":"string"}');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("no divergence");
  });

  it("11. an unknown target exits 2 with the valid ids on stderr", () => {
    const result = run(["--target", "nope"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("unknown target nope");
    expect(result.stderr).toContain("gemini.parametersJsonSchema");
    expect(result.stderr).toContain("openai.strict");
    expect(result.stdout).toBe("");
  });

  it("11. a missing --target exits 2", () => {
    expect(run([]).code).toBe(2);
    expect(run(["--json"]).code).toBe(2);
    expect(run(["--target"]).code).toBe(2);
    expect(run(["--bogus"]).code).toBe(2);
    expect(run(["--target", "openai.strict", EQUIVALENT, DIVERGENT]).code).toBe(2);
  });

  it("11. unreadable and unparsable input exit 2", () => {
    const missing = run(["--target", "openai.strict", join(workspace, "nope.json")]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("could not read input");
    const garbage = run(["--target", "openai.strict", NOT_JSON]);
    expect(garbage.code).toBe(2);
    expect(garbage.stderr).toContain("not valid JSON");
  });

  it("11. an unusable schema exits 2", () => {
    const result = run(["--target", "openai.strict"], "null");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("invalid schema");
  });

  it("11. a conversion that breaks a reference exits 3", () => {
    const result = run(["--target", "openai.strict", BROKEN_REF]);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("probe failed");
  });

  it("11. --help prints usage and exits 0", () => {
    const result = run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("schema-envoy --target");
    expect(run(["-h"]).code).toBe(0);
  });

  it("11. importing the module does not run the command", () => {
    expect(typeof main).toBe("function");
  });

  it("11. the same flags behave identically in process", async () => {
    expect((await inProcess(["--targets"])).code).toBe(0);
    expect((await inProcess(["--self-check"])).out).toContain("B5 openai.strict ok");
    expect((await inProcess(["--self-check"])).code).toBe(0);
    expect((await inProcess(["--help"])).code).toBe(0);
    expect((await inProcess([])).code).toBe(2);
    expect((await inProcess(["--target", "nope"])).code).toBe(2);
    expect((await inProcess(["--target"])).code).toBe(2);
    expect((await inProcess(["--bogus"])).code).toBe(2);
    expect((await inProcess(["--target", "openai.strict", EQUIVALENT, DIVERGENT])).code).toBe(2);
    expect((await inProcess(["--target", "openai.strict", NOT_JSON])).code).toBe(2);
    expect((await inProcess(["--target", "openai.strict", join(workspace, "nope.json")])).code).toBe(2);
    expect((await inProcess(["--target", "openai.strict", DIVERGENT])).code).toBe(1);
    expect((await inProcess(["--target", "openai.strict", "--json", DIVERGENT])).code).toBe(1);
    expect(
      (await inProcess(["--target", "gemini.functionDeclarationParameters", EQUIVALENT])).code,
    ).toBe(0);
    expect((await inProcess(["--target", "openai.strict", BROKEN_REF])).code).toBe(3);
  });
});

describe("11. cli internals", () => {
  it("11. the entry guard fires only when the file is the process entry point", () => {
    const original = process.argv[1];
    for (const entry of ["/x/dist/cli.js", "/x/dist/cli.cjs", "/x/.bin/schema-envoy"]) {
      process.argv[1] = entry;
      expect(invokedDirectly()).toBe(true);
    }
    for (const entry of ["/x/node_modules/vitest/vitest.mjs", "/x/index.js"]) {
      process.argv[1] = entry;
      expect(invokedDirectly()).toBe(false);
    }
    process.argv[1] = original as string;
  });

  it("11. stdin is read when no file is named", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      value: Readable.from(['{"type":', '"string"}']),
      configurable: true,
    });
    const result = await inProcess(["--target", "openai.strict", "--json"]);
    Object.defineProperty(process, "stdin", original as PropertyDescriptor);
    expect(result.code).toBe(0);
    expect(result.out).toContain('"schema":{"type":"string"}');
  });

  it("11. a stdin chunk that arrives as a string is handled", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", {
      value: Readable.from([Buffer.from('{"type":"integer"}')]),
      configurable: true,
    });
    const result = await inProcess(["--target", "openai.strict"]);
    Object.defineProperty(process, "stdin", original as PropertyDescriptor);
    expect(result.code).toBe(0);
  });
});
