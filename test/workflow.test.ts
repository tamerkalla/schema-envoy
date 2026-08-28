import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

/**
 * Everything here runs against the parsed YAML object. Nothing here matches
 * text: both workflow files carry comments that name `registry-url` and
 * `NODE_AUTH_TOKEN` in order to warn against them, and a text match would fire
 * on the warnings.
 */

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}

interface Workflow {
  name?: string;
  on?: Record<string, unknown>;
  jobs: Record<string, { permissions?: Record<string, string>; steps: Step[] }>;
}

function parse(path: string): Workflow {
  return load(readFileSync(path, "utf8")) as Workflow;
}

function triggers(workflow: Workflow): Record<string, unknown> {
  const parsed = workflow as unknown as Record<string, unknown>;
  const found = parsed["on"] ?? parsed["true"];
  return (found ?? {}) as Record<string, unknown>;
}

function hasKeyAnywhere(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasKeyAnywhere(entry, key));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, key)) return true;
    return Object.keys(record).some((name) => hasKeyAnywhere(record[name], key));
  }
  return false;
}

function label(step: Step): string {
  return step.name ?? step.uses ?? step.run ?? "";
}

const release = parse(".github/workflows/release.yml");
const ci = parse(".github/workflows/ci.yml");
const steps = release.jobs["publish"]?.steps ?? [];

describe("12. workflow configuration", () => {
  it("12. a registry url is supplied only on the token path", () => {
    for (const step of steps) {
      if (step.with && "registry-url" in step.with) {
        expect(step.if ?? "").toContain("'token'");
      }
    }
    expect(steps.filter((step) => step.with && "registry-url" in step.with).length).toBe(1);
  });

  it("12. an auth token is supplied only on the token path", () => {
    for (const step of steps) {
      if (step.env && "NODE_AUTH_TOKEN" in step.env) {
        expect(step.if ?? "").toContain("'token'");
      }
    }
    expect(steps.filter((step) => step.env && "NODE_AUTH_TOKEN" in step.env).length).toBe(1);
  });

  it("12. the publish job asks for exactly the permissions it needs", () => {
    const permissions = release.jobs["publish"]?.permissions ?? {};
    expect(permissions["contents"]).toBe("write");
    expect(permissions["id-token"]).toBe("write");
  });

  it("12. the steps run in the order the release depends on", () => {
    expect(steps.length).toBe(13);
    expect(label(steps[0] as Step)).toContain("actions/checkout");
    expect(label(steps[1] as Step)).toBe("Plan");
    expect(label(steps[2] as Step)).toContain("actions/setup-node");
    expect(label(steps[3] as Step)).toContain("actions/setup-node");
    expect(label(steps[4] as Step)).toContain("npm install -g");
    expect(label(steps[5] as Step)).toBe("npm ci");
    expect(label(steps[6] as Step)).toBe("npm test");
    expect(label(steps[7] as Step)).toBe("npm run build");
    expect(label(steps[8] as Step)).toBe("Bump and tag");
    expect(label(steps[9] as Step)).toContain("Publish");
    expect(label(steps[10] as Step)).toContain("Publish");
    expect(label(steps[11] as Step)).toContain("Push version commit and tag");
    expect(label(steps[12] as Step)).toContain("Release");
  });

  it("12. the release verifies before the version moves", () => {
    const test = steps.findIndex((step) => step.run === "npm test");
    const bump = steps.findIndex((step) => step.name === "Bump and tag");
    const publish = steps.findIndex((step) => (step.name ?? "").startsWith("Publish"));
    const push = steps.findIndex((step) => (step.run ?? "").startsWith("git push"));
    expect(test).toBeLessThan(bump);
    expect(bump).toBeLessThan(publish);
    expect(publish).toBeLessThan(push);
  });

  it("12. the release triggers on workflow_dispatch and on push to main, never on a tag", () => {
    const on = triggers(release) as { push?: { branches?: string[] } };
    expect(Object.prototype.hasOwnProperty.call(on, "workflow_dispatch")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(on, "push")).toBe(true);
    expect(on.push?.branches).toEqual(["main"]);
    expect(hasKeyAnywhere(on, "tags")).toBe(false);
    expect(hasKeyAnywhere(release, "tags")).toBe(false);
  });

  it("12. workflow_dispatch exposes both bump and auth as choice inputs", () => {
    const on = triggers(release) as {
      workflow_dispatch?: { inputs?: Record<string, { type: string; options: string[] }> };
    };
    const inputs = on.workflow_dispatch?.inputs ?? {};
    expect(inputs["bump"]?.options).toEqual(["patch", "minor", "major"]);
    expect(inputs["auth"]?.options).toEqual(["oidc", "token"]);
  });

  it("12. a push only releases when the version still reads 0.0.0", () => {
    const plan = steps.find((step) => step.name === "Plan");
    expect(plan?.run ?? "").toContain('"$v" = "0.0.0"');
    expect(plan?.run ?? "").toContain("release=false");
  });

  it("12. only the Plan and bump steps carry a multi-line script", () => {
    const multiline = steps.filter((step) => (step.run ?? "").includes("\n"));
    expect(multiline.length).toBe(2);
    expect(multiline.map((step) => step.name).sort()).toEqual(["Bump and tag", "Plan"]);
  });

  it("12. CI goes green on a fork with no secrets configured", () => {
    const on = triggers(ci) as { push?: { "branches-ignore"?: string[] } };
    expect(Object.prototype.hasOwnProperty.call(on, "workflow_dispatch")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(on, "push")).toBe(true);
    expect(on.push?.["branches-ignore"]).toEqual(["main"]);
    const verify = ci.jobs["verify"]?.steps ?? [];
    for (const step of verify) {
      expect(step.env).toBeUndefined();
      expect(step.if).toBeUndefined();
      expect(Object.keys(step.with ?? {})).not.toContain("registry-url");
    }
    expect(verify.map((step) => label(step))).toEqual([
      "actions/checkout@v4",
      "actions/setup-node@v4",
      "npm ci",
      "npm run typecheck",
      "npm test",
      "npm run build",
    ]);
  });

  it("12. every package script is a single line", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
      version: string;
      files: string[];
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const script of Object.values(pkg.scripts)) {
      expect(script.includes("\n")).toBe(false);
    }
    // Not pinned to 0.0.0: that is the pre-release placeholder, and the
    // release workflow moves it on every run. The standing invariant is the
    // shape. Keeping the placeholder off npm is the workflow's job, done by
    // bumping before publish, not a test's.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.files).toEqual(["dist", "README.md", "VERIFY.md", "LICENSE"]);
    for (const range of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) {
      expect(/^\d+\.\d+\.\d+$/.test(range)).toBe(true);
    }
  });
});
