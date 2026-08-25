import { InvalidSchemaError } from "./errors.js";
import type { Removal, Rewrite } from "./types.js";

/** Maximum schema-node descent, counting the root as level 1. */
export const MAX_DEPTH = 64;

/**
 * Keywords whose removal cannot change which values a schema accepts.
 * Exhaustive, and referenced by the sanity floor in `src/differential.ts`.
 */
export const ANNOTATION_KEYWORDS: readonly string[] = Object.freeze([
  "$schema",
  "title",
  "description",
  "$comment",
  "examples",
  "default",
  "$id",
]);

/** Keywords whose value is a single subschema. */
export const SCHEMA_VALUE_KEYWORDS: readonly string[] = Object.freeze([
  "items",
  "additionalItems",
  "additionalProperties",
  "unevaluatedItems",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "if",
  "then",
  "else",
  "not",
]);

/** Keywords whose value is a record of name to subschema. */
export const SCHEMA_MAP_KEYWORDS: readonly string[] = Object.freeze([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

/** Keywords whose value is an array of subschemas. */
export const SCHEMA_LIST_KEYWORDS: readonly string[] = Object.freeze([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep clone that never writes through `__proto__`. */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => deepClone(entry)) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      Object.defineProperty(out, key, {
        value: deepClone((value as Record<string, unknown>)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out as unknown as T;
  }
  return value;
}

/** Assign without ever tripping the `__proto__` setter. */
export function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function escapeToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

export function childPointer(pointer: string, ...tokens: (string | number)[]): string {
  let out = pointer;
  for (const token of tokens) out += `/${escapeToken(String(token))}`;
  return out;
}

/** Resolve a local `$ref` against the document root. Returns undefined when unresolvable. */
export function resolveRef(root: unknown, ref: string): unknown {
  if (ref === "#" || ref === "") return root;
  if (ref.startsWith("#/")) {
    let node: unknown = root;
    for (const raw of ref.slice(2).split("/")) {
      const token = decodePointerToken(raw);
      if (Array.isArray(node)) {
        const index = Number(token);
        if (!Number.isInteger(index) || index < 0 || index >= node.length) return undefined;
        node = node[index];
      } else if (isPlainObject(node)) {
        if (!Object.prototype.hasOwnProperty.call(node, token)) return undefined;
        node = node[token];
      } else {
        return undefined;
      }
    }
    return node;
  }
  if (ref.startsWith("#")) {
    return findAnchor(root, ref.slice(1));
  }
  return undefined;
}

/** Percent-decode a pointer token, then unescape `~1` and `~0`, in that order. */
function decodePointerToken(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return decoded.replace(/~1/g, "/").replace(/~0/g, "~");
}

function findAnchor(node: unknown, anchor: string): unknown {
  if (Array.isArray(node)) {
    for (const entry of node) {
      const found = findAnchor(entry, anchor);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isPlainObject(node)) return undefined;
  if (node["$anchor"] === anchor) return node;
  for (const key of Object.keys(node)) {
    const found = findAnchor(node[key], anchor);
    if (found !== undefined) return found;
  }
  return undefined;
}

export interface NormalizeResult {
  schema: Record<string, unknown> | boolean;
  rewrites: Rewrite[];
  removed: Removal[];
  /** The `$schema` value found at the root, if any. */
  dialect: string | undefined;
}

/**
 * Lift draft-07 to draft 2020-12. Exactly four rules, applied at every node.
 */
export function normalize(input: unknown): NormalizeResult {
  const rewrites: Rewrite[] = [];
  const removed: Removal[] = [];
  const clone = deepClone(input);
  let dialect: string | undefined;
  if (isPlainObject(clone) && typeof clone["$schema"] === "string") {
    dialect = clone["$schema"];
  }
  const schema = normalizeNode(clone, "#", rewrites, removed, 1);
  return { schema: schema as Record<string, unknown> | boolean, rewrites, removed, dialect };
}

function normalizeNode(
  node: unknown,
  pointer: string,
  rewrites: Rewrite[],
  removed: Removal[],
  depth: number,
): unknown {
  if (typeof node === "boolean") return node;
  if (!isPlainObject(node)) return node;
  if (depth > MAX_DEPTH) {
    throw new InvalidSchemaError(pointer, `maximum descent depth ${MAX_DEPTH} exceeded`);
  }

  const out: Record<string, unknown> = {};
  for (const key of Object.keys(node)) setKey(out, key, node[key]);

  // Rule 4: record and drop $schema.
  if (Object.prototype.hasOwnProperty.call(out, "$schema")) {
    delete out["$schema"];
    removed.push({ pointer, keyword: "$schema", documented: false });
  }

  // Rule 1: definitions -> $defs.
  if (Object.prototype.hasOwnProperty.call(out, "definitions")) {
    const definitions = out["definitions"];
    delete out["definitions"];
    if (!Object.prototype.hasOwnProperty.call(out, "$defs")) {
      setKey(out, "$defs", definitions);
    }
    rewrites.push({ pointer, from: "definitions", to: "$defs" });
  }
  if (typeof out["$ref"] === "string" && out["$ref"].startsWith("#/definitions/")) {
    setKey(out, "$ref", `#/$defs/${out["$ref"].slice("#/definitions/".length)}`);
    rewrites.push({ pointer, from: "#/definitions", to: "#/$defs" });
  }

  // Rule 2: boolean exclusiveMinimum / exclusiveMaximum.
  liftExclusive(out, pointer, "minimum", "exclusiveMinimum", rewrites);
  liftExclusive(out, pointer, "maximum", "exclusiveMaximum", rewrites);

  // Rule 3: tuple-form items -> prefixItems, additionalItems -> items.
  if (Array.isArray(out["items"])) {
    const tuple = out["items"];
    delete out["items"];
    setKey(out, "prefixItems", tuple);
    rewrites.push({ pointer, from: "items", to: "prefixItems" });
    if (Object.prototype.hasOwnProperty.call(out, "additionalItems")) {
      const rest = out["additionalItems"];
      delete out["additionalItems"];
      setKey(out, "items", rest);
      rewrites.push({ pointer, from: "additionalItems", to: "items" });
    }
  }

  for (const key of Object.keys(out)) {
    const value = out[key];
    if (SCHEMA_VALUE_KEYWORDS.includes(key)) {
      setKey(out, key, normalizeNode(value, childPointer(pointer, key), rewrites, removed, depth + 1));
    } else if (SCHEMA_MAP_KEYWORDS.includes(key) && isPlainObject(value)) {
      const mapped: Record<string, unknown> = {};
      for (const name of Object.keys(value)) {
        setKey(
          mapped,
          name,
          normalizeNode(value[name], childPointer(pointer, key, name), rewrites, removed, depth + 1),
        );
      }
      setKey(out, key, mapped);
    } else if (SCHEMA_LIST_KEYWORDS.includes(key) && Array.isArray(value)) {
      setKey(
        out,
        key,
        value.map((entry, index) =>
          normalizeNode(entry, childPointer(pointer, key, index), rewrites, removed, depth + 1),
        ),
      );
    }
  }

  return out;
}

function liftExclusive(
  node: Record<string, unknown>,
  pointer: string,
  bound: "minimum" | "maximum",
  exclusive: "exclusiveMinimum" | "exclusiveMaximum",
  rewrites: Rewrite[],
): void {
  if (node[exclusive] !== true) return;
  const value = node[bound];
  if (typeof value !== "number") return;
  setKey(node, exclusive, value);
  delete node[bound];
  rewrites.push({ pointer, from: bound, to: exclusive });
}

/**
 * Collect every `$ref` in the document together with the pointer it sits at,
 * so that unresolvable references can be reported before any conversion work.
 */
export function collectRefs(root: unknown): { pointer: string; ref: string }[] {
  const found: { pointer: string; ref: string }[] = [];
  const walk = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, childPointer(pointer, index)));
      return;
    }
    if (!isPlainObject(node)) return;
    if (typeof node["$ref"] === "string") found.push({ pointer, ref: node["$ref"] });
    for (const key of Object.keys(node)) {
      if (key === "$ref") continue;
      walk(node[key], childPointer(pointer, key));
    }
  };
  walk(root, "#");
  return found;
}
