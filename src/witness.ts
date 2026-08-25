import type { ChangeIndex, ChangeKind } from "./convert.js";
import { childPointer, deepClone, isPlainObject, resolveRef, setKey } from "./normalize.js";

export const DEFAULT_WITNESS_BUDGET = 512;
export const MAX_WITNESS_BUDGET = 4096;

export const NOT_A_MEMBER = "__envoy_not_a_member__";
export const INVALID_FORMAT = "__envoy_invalid_format__";
export const EXTRA_KEY = "__envoy_extra__";
export const BAD_NAME = "__envoy_bad_name__";
export const NOT_A_NUMBER_MEMBER = -2147483648;

/**
 * The keyword order in which candidate mutations are produced at a single
 * pointer. Pointer order comes first; this table breaks the tie.
 */
export const MUTATION_ORDER: readonly string[] = Object.freeze([
  "pattern",
  "format",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "const",
  "enum",
  "minItems",
  "maxItems",
  "uniqueItems",
  "additionalProperties",
  "propertyNames",
  "required",
  "oneOf",
  "type",
]);

export interface Candidate {
  value: unknown;
  pointer: string;
  keyword: string;
}

type Seed = { ok: true; value: unknown } | { ok: false };

const UNSEEDABLE: Seed = { ok: false };

/**
 * Build a seed instance for a node. An unseedable node is not an error; it
 * simply contributes no value-evidence, and its parent leaves it out.
 */
export function buildSeed(node: unknown, root: unknown, stack: readonly unknown[]): Seed {
  if (node === true) return { ok: true, value: {} };
  if (node === false) return UNSEEDABLE;
  if (!isPlainObject(node)) return UNSEEDABLE;
  if (stack.includes(node)) return UNSEEDABLE;
  const nextStack = [...stack, node];

  if (Object.prototype.hasOwnProperty.call(node, "const")) {
    return { ok: true, value: deepClone(node["const"]) };
  }
  if (Array.isArray(node["enum"]) && node["enum"].length > 0) {
    return { ok: true, value: deepClone(node["enum"][0]) };
  }
  if (typeof node["$ref"] === "string") {
    const resolved = resolveRef(root, node["$ref"]);
    if (resolved === undefined) return UNSEEDABLE;
    return buildSeed(resolved, root, nextStack);
  }
  if (Array.isArray(node["anyOf"]) && node["anyOf"].length > 0) {
    return buildSeed(node["anyOf"][0], root, nextStack);
  }
  if (Array.isArray(node["oneOf"]) && node["oneOf"].length > 0) {
    return buildSeed(node["oneOf"][0], root, nextStack);
  }
  if (Object.prototype.hasOwnProperty.call(node, "pattern")) return UNSEEDABLE;

  const type = Array.isArray(node["type"]) ? node["type"][0] : node["type"];
  switch (type) {
    case "string": {
      const min = typeof node["minLength"] === "number" ? node["minLength"] : 1;
      return { ok: true, value: "a".repeat(Math.max(min, 1)) };
    }
    case "integer":
    case "number": {
      if (typeof node["minimum"] === "number") return { ok: true, value: node["minimum"] };
      if (typeof node["exclusiveMinimum"] === "number") {
        return { ok: true, value: node["exclusiveMinimum"] + 1 };
      }
      return { ok: true, value: 0 };
    }
    case "boolean":
      return { ok: true, value: false };
    case "null":
      return { ok: true, value: null };
    case "array": {
      const count = typeof node["minItems"] === "number" ? node["minItems"] : 0;
      if (count <= 0) return { ok: true, value: [] };
      const item = buildSeed(node["items"], root, nextStack);
      if (!item.ok) return { ok: true, value: [] };
      return { ok: true, value: Array.from({ length: count }, () => deepClone(item.value)) };
    }
    case "object":
      return { ok: true, value: seedObject(node, root, nextStack) };
    default:
      if (isPlainObject(node["properties"])) {
        return { ok: true, value: seedObject(node, root, nextStack) };
      }
      return { ok: true, value: {} };
  }
}

function seedObject(
  node: Record<string, unknown>,
  root: unknown,
  stack: readonly unknown[],
): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  const properties = isPlainObject(node["properties"]) ? node["properties"] : {};
  const required = Array.isArray(node["required"]) ? node["required"] : [];
  for (const name of required) {
    if (typeof name !== "string") continue;
    const child = properties[name];
    if (child === undefined) continue;
    const seed = buildSeed(child, root, stack);
    if (!seed.ok) continue;
    setKey(value, name, seed.value);
  }
  return value;
}

function getAt(root: unknown, path: readonly (string | number)[]): unknown {
  let node: unknown = root;
  for (const token of path) {
    if (Array.isArray(node) && typeof token === "number") node = node[token];
    else if (isPlainObject(node) && typeof token === "string") node = node[token];
    else return undefined;
  }
  return node;
}

function withValueAt(
  root: unknown,
  path: readonly (string | number)[],
  value: unknown,
): unknown {
  if (path.length === 0) return deepClone(value);
  const clone = deepClone(root);
  let node: unknown = clone;
  for (let i = 0; i < path.length - 1; i += 1) {
    const token = path[i] as string | number;
    let next = Array.isArray(node) && typeof token === "number" ? node[token] : isPlainObject(node) ? node[token as string] : undefined;
    if (next === undefined || (!isPlainObject(next) && !Array.isArray(next))) {
      next = {};
      if (Array.isArray(node) && typeof token === "number") node[token] = next;
      else if (isPlainObject(node)) setKey(node, String(token), next);
      else return undefined;
    }
    node = next;
  }
  const last = path[path.length - 1] as string | number;
  if (Array.isArray(node) && typeof last === "number") node[last] = deepClone(value);
  else if (isPlainObject(node)) setKey(node, String(last), deepClone(value));
  else return undefined;
  return clone;
}

interface Site {
  pointer: string;
  path: (string | number)[];
  node: Record<string, unknown>;
  keywords: Map<string, ChangeKind>;
}

/** How many distinct nodes the site walk will visit before giving up. */
export const MAX_SITES = 4096;

/** Collect, in pointer order, every node at which a keyword changed. */
function collectSites(root: unknown, changes: ChangeIndex): Site[] {
  const sites: Site[] = [];
  const visited = new Set<string>();
  const stack: unknown[] = [];

  const walk = (node: unknown, pointer: string, path: (string | number)[]): void => {
    if (!isPlainObject(node)) return;
    if (stack.includes(node)) return;
    if (sites.length >= MAX_SITES) return;
    const key = `${pointer}|${path.join("/")}`;
    if (visited.has(key)) return;
    visited.add(key);
    stack.push(node);

    const keywords = changes.get(pointer);
    if (keywords && keywords.size > 0) sites.push({ pointer, path, node, keywords });

    if (typeof node["$ref"] === "string") {
      const ref = node["$ref"];
      const resolved = resolveRef(root, ref);
      const refPointer = ref === "#" || ref.startsWith("#/") ? ref : pointer;
      if (isPlainObject(resolved)) walk(resolved, refPointer, path);
    }
    if (isPlainObject(node["properties"])) {
      const properties = node["properties"];
      for (const name of Object.keys(properties)) {
        walk(properties[name], childPointer(pointer, "properties", name), [...path, name]);
      }
    }
    if (isPlainObject(node["items"])) {
      walk(node["items"], childPointer(pointer, "items"), [...path, 0]);
    }
    if (Array.isArray(node["prefixItems"])) {
      node["prefixItems"].forEach((entry, index) => {
        walk(entry, childPointer(pointer, "prefixItems", index), [...path, index]);
      });
    }
    if (isPlainObject(node["additionalProperties"])) {
      walk(node["additionalProperties"], childPointer(pointer, "additionalProperties"), [
        ...path,
        EXTRA_KEY,
      ]);
    }
    if (isPlainObject(node["contains"])) {
      walk(node["contains"], childPointer(pointer, "contains"), [...path, 0]);
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      const list = node[key];
      if (!Array.isArray(list)) continue;
      list.forEach((entry, index) => {
        walk(entry, childPointer(pointer, key, index), path);
      });
    }
    for (const key of ["if", "then", "else", "not"]) {
      if (isPlainObject(node[key])) walk(node[key], childPointer(pointer, key), path);
    }
    stack.pop();
  };

  walk(root, "#", []);
  return sites;
}

function mutationsFor(
  site: Site,
  keyword: string,
  kind: ChangeKind,
  seedValue: unknown,
): unknown[] {
  const node = site.node;
  const value = node[keyword];
  switch (keyword) {
    case "pattern":
      return ["!"];
    case "format":
      return [INVALID_FORMAT];
    case "minLength":
      return typeof value === "number" ? ["a".repeat(Math.max(value - 1, 0))] : [];
    case "maxLength":
      return typeof value === "number" ? ["a".repeat(Math.max(value + 1, 0))] : [];
    case "minimum":
      return typeof value === "number" ? [value - 1] : [];
    case "maximum":
      return typeof value === "number" ? [value + 1] : [];
    case "exclusiveMinimum":
    case "exclusiveMaximum":
      return typeof value === "number" ? [value] : [];
    case "multipleOf":
      return typeof value === "number"
        ? [(typeof seedValue === "number" ? seedValue : 0) + value / 2]
        : [];
    case "const":
    case "enum": {
      const type = Array.isArray(node["type"]) ? node["type"][0] : node["type"];
      return type === "number" || type === "integer" ? [NOT_A_NUMBER_MEMBER] : [NOT_A_MEMBER];
    }
    case "minItems": {
      if (typeof value !== "number") return [];
      const base = Array.isArray(seedValue) ? seedValue : [];
      const target = Math.max(value - 1, 0);
      const filler = base.length > 0 ? base[0] : "a";
      const out = base.slice(0, target);
      while (out.length < target) out.push(deepClone(filler));
      return [out];
    }
    case "maxItems": {
      if (typeof value !== "number") return [];
      const base = Array.isArray(seedValue) ? seedValue : [];
      const filler = base.length > 0 ? base[0] : "a";
      const out = base.slice();
      while (out.length < value + 1) out.push(deepClone(filler));
      return [out];
    }
    case "uniqueItems": {
      const base = Array.isArray(seedValue) ? seedValue : [];
      if (base.length === 0) return [];
      return [[...base, deepClone(base[0])]];
    }
    case "additionalProperties": {
      const base = isPlainObject(seedValue) ? deepClone(seedValue) : {};
      setKey(base, EXTRA_KEY, 1);
      return [base];
    }
    case "propertyNames": {
      const base = isPlainObject(seedValue) ? deepClone(seedValue) : {};
      setKey(base, BAD_NAME, 1);
      return [base];
    }
    case "required": {
      const base = isPlainObject(seedValue) ? deepClone(seedValue) : {};
      if (kind === "rewritten") {
        // The provider forced optional properties into `required`; the seed,
        // which carries only the properties the source required, is the witness.
        return [base];
      }
      const required = Array.isArray(node["required"]) ? node["required"] : [];
      const first = required.find((name): name is string => typeof name === "string");
      if (first === undefined) return [];
      delete base[first];
      return [base];
    }
    case "oneOf": {
      const branches = Array.isArray(node["oneOf"]) ? node["oneOf"] : [];
      if (branches.length < 2) return [];
      const merged: Record<string, unknown> = {};
      for (const branch of branches.slice(0, 2)) {
        const seed = buildSeed(branch, node, []);
        if (!seed.ok || !isPlainObject(seed.value)) continue;
        for (const key of Object.keys(seed.value)) setKey(merged, key, seed.value[key]);
      }
      return Object.keys(merged).length > 0 ? [merged] : [];
    }
    case "type":
      return kind === "rewritten" ? [null] : [];
    default:
      return [];
  }
}

/**
 * Deterministic candidate generation. No pseudo-random generator is involved:
 * the output is a pure function of the schema, the change index and the budget.
 */
export function generateCandidates(
  normalized: Record<string, unknown> | boolean,
  changes: ChangeIndex,
  budget: number,
): Candidate[] {
  const clamped = Math.max(1, Math.min(Math.floor(budget), MAX_WITNESS_BUDGET));
  const rootSeed = buildSeed(normalized, normalized, []);
  const seedValue: unknown = rootSeed.ok ? rootSeed.value : null;
  const candidates: Candidate[] = [
    { value: deepClone(seedValue), pointer: "#", keyword: "seed" },
  ];

  const sites = collectSites(normalized, changes);
  for (const site of sites) {
    const ordered = [...site.keywords.keys()].sort((a, b) => {
      const ia = MUTATION_ORDER.indexOf(a);
      const ib = MUTATION_ORDER.indexOf(b);
      return (ia < 0 ? MUTATION_ORDER.length : ia) - (ib < 0 ? MUTATION_ORDER.length : ib);
    });
    for (const keyword of ordered) {
      if (candidates.length >= clamped) return candidates.slice(0, clamped);
      const kind = site.keywords.get(keyword) as ChangeKind;
      const local = getAt(seedValue, site.path);
      for (const mutation of mutationsFor(site, keyword, kind, local)) {
        if (candidates.length >= clamped) return candidates.slice(0, clamped);
        const built = withValueAt(seedValue, site.path, mutation);
        if (built === undefined) continue;
        candidates.push({ value: built, pointer: site.pointer, keyword });
      }
    }
  }
  return candidates.slice(0, clamped);
}

/**
 * A candidate becomes a witness only if it actually flips. Candidates whose
 * verdict agrees on both sides are discarded silently.
 */
export function selectWitnesses(
  candidates: readonly Candidate[],
  acceptedBySource: (value: unknown) => boolean,
  acceptedByConverted: (value: unknown) => boolean,
): { candidate: Candidate; effect: "widen" | "narrow" }[] {
  const kept: { candidate: Candidate; effect: "widen" | "narrow" }[] = [];
  for (const candidate of candidates) {
    const inSource = acceptedBySource(candidate.value);
    const inConverted = acceptedByConverted(candidate.value);
    if (inSource === inConverted) continue;
    kept.push({ candidate, effect: inConverted ? "widen" : "narrow" });
  }
  return kept;
}
