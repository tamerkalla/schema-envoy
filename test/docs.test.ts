import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

interface Example {
  lang: "ts" | "bash";
  code: string;
  expected: string;
}

// Finds every (code block, claimed output) pair in a markdown document. The
// convention this project's docs follow: a fenced ```ts or ```bash block,
// then a line reading "Output:" or "Expected output:", then a fenced
// ```text block holding the exact text the code is claimed to print.
function extractExamples(markdown: string): Example[] {
  const re =
    /```(ts|bash)\n((?:(?!```)[\s\S])*?)\n```\n\n(?:Output|Expected output):\n\n```text\n((?:(?!```)[\s\S])*?)\n```/g;
  const examples: Example[] = [];
  for (const m of markdown.matchAll(re)) {
    examples.push({ lang: m[1] as "ts" | "bash", code: m[2] as string, expected: m[3] as string });
  }
  return examples;
}

describe("README.md structure", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const paragraphs = readme.split("\n\n");
  const firstParagraphIndex = readme.indexOf(paragraphs.find((p) => p.trim() && !p.startsWith("#"))!);

  test("the badge row appears character-for-character, after the opening hook", () => {
    const badges = [
      "[![build](https://github.com/tamerkalla/schema-envoy/actions/workflows/release.yml/badge.svg)](https://github.com/tamerkalla/schema-envoy/actions/workflows/release.yml)",
      "[![npm](https://img.shields.io/npm/v/schema-envoy.svg)](https://www.npmjs.com/package/schema-envoy)",
      "[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)",
      "[![provenance](https://img.shields.io/badge/provenance-attested-brightgreen.svg)](https://www.npmjs.com/package/schema-envoy)",
    ].join("\n");
    const badgeIndex = readme.indexOf(badges);
    expect(badgeIndex).toBeGreaterThan(-1);
    expect(badgeIndex).toBeGreaterThan(firstParagraphIndex);
  });

  test("does not make an unqualified universal claim about silent deletion", () => {
    const claimSection = readme.slice(0, readme.indexOf("## Install") > -1 ? readme.indexOf("## Install") : readme.indexOf("```bash"));
    expect(claimSection).toMatch(/For most of them, that deletion is silent/);
    expect(claimSection).not.toMatch(/That deletion is silent\./);
    expect(claimSection).toMatch(/Vercel AI SDK/);
  });

  test("names the open, unmerged upstream PR with a date", () => {
    expect(readme).toMatch(/vercel\/ai#19664/);
    expect(readme).toMatch(/open, unmerged/);
    expect(readme).toMatch(/27 August 2026/);
  });

  test("the pitch points at residual() by name", () => {
    expect(readme).toMatch(/`residual\(\)`.*compiled validator/s);
  });

  test("links to schema-fit's npm page, not its GitHub repo, in Related", () => {
    expect(readme).toMatch(/\[`schema-fit`\]\(https:\/\/www\.npmjs\.com\/package\/schema-fit\)/);
  });

  test("links to VERIFY.md", () => {
    expect(readme).toMatch(/\[VERIFY\.md\]\(\.\/VERIFY\.md\)/);
  });
});

describe("every code example in README.md is executed and its output matches", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const examples = extractExamples(readme);
  const cliPath = join(ROOT, "dist", "cli.js");

  test("at least one example was found", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  for (const [i, example] of examples.entries()) {
    test(`example ${i + 1} (${example.lang}) prints the claimed output`, () => {
      const dir = mkdtempSync(join(tmpdir(), "schema-envoy-docs-"));
      try {
        if (example.lang === "ts") {
          const script = join(ROOT, `.tmp-doc-example-${i}.mjs`);
          writeFileSync(script, example.code);
          try {
            const result = spawnSync(process.execPath, [script], { cwd: ROOT, encoding: "utf8" });
            expect(result.stderr).toBe("");
            expect(result.status).toBe(0);
            expect(result.stdout.trim()).toBe(example.expected.trim());
          } finally {
            rmSync(script, { force: true });
          }
        } else {
          const prepared = example.code
            .replace(
              /npx --yes schema-envoy@latest/g,
              `${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)}`,
            )
            .replace(/npx schema-envoy/g, `${JSON.stringify(process.execPath)} ${JSON.stringify(cliPath)}`);
          const result = spawnSync("bash", ["-c", prepared], { cwd: dir, encoding: "utf8" });
          expect(result.stdout.trim()).toBe(example.expected.trim());
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("every code example in VERIFY.md is executed and its output matches", () => {
  const verify = readFileSync(join(ROOT, "VERIFY.md"), "utf8");
  const examples = extractExamples(verify);

  test("does not require this repository to be checked out", () => {
    expect(verify).toMatch(/does not require this repository to be checked out/);
  });

  test("installs by the latest tag into a clean directory", () => {
    expect(verify).toMatch(/npm install schema-envoy@latest/);
    expect(verify).toMatch(/mkdir -p/);
  });

  test("at least one example was found", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  let tarballPath: string;
  let packDir: string;

  beforeAll(() => {
    packDir = mkdtempSync(join(tmpdir(), "schema-envoy-verify-pack-"));
    const pack = spawnSync("npm", ["pack", "--silent", "--pack-destination", packDir], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(pack.status).toBe(0);
    const tarballName = pack.stdout.trim().split("\n").pop()!.trim();
    tarballPath = join(packDir, tarballName);
    expect(existsSync(tarballPath)).toBe(true);
  }, 120_000);

  afterAll(() => {
    rmSync(packDir, { recursive: true, force: true });
  });

  for (const [i, example] of examples.entries()) {
    test(`example ${i + 1} reproduces the claimed output`, () => {
      const dir = mkdtempSync(join(tmpdir(), "schema-envoy-verify-run-"));
      try {
        // The doc installs from the registry; the test instead unpacks the
        // tarball this repository just built into node_modules, and copies
        // this repo's own dependency tree over — reproducing the installed
        // layout without `npm install`, which for a fresh, lockfile-less
        // project needs to hit the network to resolve versions, and no test
        // may reach the network.
        const replacement = [
          `cp -r ${JSON.stringify(join(ROOT, "node_modules"))} node_modules`,
          "rm -rf node_modules/schema-envoy",
          `tar -xzf ${JSON.stringify(tarballPath)} -C node_modules`,
          "mv node_modules/package node_modules/schema-envoy",
          "mkdir -p node_modules/.bin",
          "ln -sf ../schema-envoy/dist/cli.js node_modules/.bin/schema-envoy",
        ].join("\n");
        const prepared = example.code
          .replace(
            /npm init -y >\/dev\/null 2>&1\nnpm install schema-envoy@latest >\/dev\/null 2>&1/,
            replacement,
          )
          .replace(/npx schema-envoy/g, "node_modules/.bin/schema-envoy");
        const result = spawnSync("bash", ["-c", prepared], { cwd: dir, encoding: "utf8" });
        expect(result.stdout.trim()).toBe(example.expected.trim());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
