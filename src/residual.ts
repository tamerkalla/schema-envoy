import { InvalidSchemaError, SchemaProbeError, UnknownTargetError } from "./errors.js";
import { formatErrors, tryCompile, makePredicate } from "./differential.js";
import {
  ANNOTATION_KEYWORDS,
  collectRefs,
  deepClone,
  isPlainObject,
  normalize,
  resolveRef,
  setKey,
} from "./normalize.js";
import { isTargetId, target as lookupTarget, targetIds } from "./targets/index.js";
import type { JSONSchema, ResidualResult, TargetId, TargetProfile } from "./types.js";

/** Reference machinery: never a constraint in its own right. */
const REFERENCE_KEYWORDS: readonly string[] = Object.freeze([
  "$ref",
  "$defs",
  "definitions",
  "$id",
  "$anchor",
  "$schema",
  "$comment",
]);

/** Descended into rather than copied. */
const SCAFFOLD_KEYWORDS: readonly string[] = Object.freeze([
  "properties",
  "items",
  "prefixItems",
]);

/** Assert the shape every entry point requires of its input. */
export function assertSchemaShape(input: unknown): void {
  if (typeof input === "boolean") return;
  if (input === null || input === undefined) {
    throw new InvalidSchemaError("#", `a schema may not be ${String(input)}`);
  }
  if (Array.isArray(input)) throw new InvalidSchemaError("#", "a schema may not be an array");
  const kind = typeof input;
  if (kind !== "object") throw new InvalidSchemaError("#", `a schema may not be a ${kind}`);
}

export function resolveProfile(id: unknown): TargetProfile {
  if (!isTargetId(id)) throw new UnknownTargetError(String(id), targetIds());
  return lookupTarget(id);
}

/** Every `$ref` in the document must resolve inside the document. */
export function assertRefsResolvable(root: unknown): void {
  for (const entry of collectRefs(root)) {
    if (resolveRef(root, entry.ref) === undefined) {
      throw new InvalidSchemaError(entry.pointer, `$ref ${entry.ref} does not resolve`);
    }
  }
}

/** True when the profile leaves this keyword unenforced at the provider. */
export function isDropped(profile: TargetProfile, keyword: string): boolean {
  if (ANNOTATION_KEYWORDS.includes(keyword)) return false;
  if (REFERENCE_KEYWORDS.includes(keyword)) return false;
  if (SCAFFOLD_KEYWORDS.includes(keyword)) return false;
  if (!profile.allow.includes(keyword)) return true;
  // Accepted by the surface but reinterpreted, so not actually enforced.
  return profile.id === "gemini.parametersJsonSchema" && keyword === "oneOf";
}

interface Collector {
  enforcedHere: Set<string>;
  enforcedByProvider: Set<string>;
}

function residualNode(
  node: unknown,
  root: unknown,
  profile: TargetProfile,
  collector: Collector,
  stack: readonly unknown[],
): Record<string, unknown> | null {
  if (!isPlainObject(node)) return null;
  if (stack.includes(node)) return null;
  const nextStack = [...stack, node];
  const kept: Record<string, unknown> = {};

  if (typeof node["$ref"] === "string") {
    const resolved = resolveRef(root, node["$ref"]);
    const inlined = residualNode(resolved, root, profile, collector, nextStack);
    if (inlined) for (const key of Object.keys(inlined)) setKey(kept, key, inlined[key]);
  }

  for (const key of Object.keys(node)) {
    if (REFERENCE_KEYWORDS.includes(key) || SCAFFOLD_KEYWORDS.includes(key)) continue;
    if (ANNOTATION_KEYWORDS.includes(key)) continue;
    if (!isDropped(profile, key)) {
      collector.enforcedByProvider.add(key);
      continue;
    }
    setKey(kept, key, deepClone(node[key]));
    collector.enforcedHere.add(key);
  }

  if (isPlainObject(node["properties"])) {
    if (profile.allow.includes("properties")) collector.enforcedByProvider.add("properties");
    const properties = node["properties"];
    const children: Record<string, unknown> = {};
    for (const name of Object.keys(properties)) {
      const child = residualNode(properties[name], root, profile, collector, nextStack);
      if (child) setKey(children, name, child);
    }
    if (Object.keys(children).length > 0) {
      setKey(kept, "type", "object");
      setKey(kept, "properties", children);
    }
  }

  if (isPlainObject(node["items"])) {
    if (profile.allow.includes("items")) collector.enforcedByProvider.add("items");
    const child = residualNode(node["items"], root, profile, collector, nextStack);
    if (child) {
      setKey(kept, "type", "array");
      setKey(kept, "items", child);
    }
  }

  if (Array.isArray(node["prefixItems"])) {
    if (!profile.allow.includes("prefixItems")) {
      // The surface drops positional typing outright, so the residual keeps
      // the whole tuple rather than descending into it.
      setKey(kept, "type", "array");
      setKey(kept, "prefixItems", deepClone(node["prefixItems"]));
      collector.enforcedHere.add("prefixItems");
    } else {
      collector.enforcedByProvider.add("prefixItems");
      const entries = node["prefixItems"].map((entry) =>
        residualNode(entry, root, profile, collector, nextStack),
      );
      if (entries.some((entry) => entry !== null)) {
        setKey(kept, "type", "array");
        setKey(
          kept,
          "prefixItems",
          entries.map((entry) => entry ?? true),
        );
      }
    }
  }

  return Object.keys(kept).length > 0 ? kept : null;
}

/**
 * A compiled validator over precisely the constraints the provider drops, so
 * that the constraints the caller wrote are still enforced somewhere.
 */
export function residual(schema: unknown, targetId: TargetId): ResidualResult {
  const profile = resolveProfile(targetId);
  assertSchemaShape(schema);
  const normalized = normalize(schema);
  assertRefsResolvable(normalized.schema);

  const collector: Collector = {
    enforcedHere: new Set<string>(),
    enforcedByProvider: new Set<string>(),
  };
  const built = residualNode(normalized.schema, normalized.schema, profile, collector, []);

  let residualSchema: JSONSchema = true;
  if (built) {
    if (isPlainObject(normalized.schema) && isPlainObject(normalized.schema["$defs"])) {
      setKey(built, "$defs", deepClone(normalized.schema["$defs"]));
    }
    residualSchema = built;
  }

  const compiled = tryCompile(residualSchema);
  if (!compiled.ok) {
    throw new SchemaProbeError(`residual schema did not compile: ${compiled.message}`);
  }
  const predicate = makePredicate(compiled.validate, "residual");

  return {
    schema: residualSchema,
    validate: (value: unknown) => predicate(value),
    errors: (value: unknown) => (predicate(value) ? [] : formatErrors(compiled.validate.errors)),
    enforcedByProvider: Object.freeze([...collector.enforcedByProvider].sort()),
    enforcedHere: Object.freeze([...collector.enforcedHere].sort()),
  };
}
