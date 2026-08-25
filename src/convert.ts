import { InvalidSchemaError } from "./errors.js";
import {
  ANNOTATION_KEYWORDS,
  MAX_DEPTH,
  SCHEMA_LIST_KEYWORDS,
  SCHEMA_MAP_KEYWORDS,
  SCHEMA_VALUE_KEYWORDS,
  childPointer,
  deepClone,
  isPlainObject,
  setKey,
} from "./normalize.js";
import type { Divergence, Removal, Rewrite, TargetProfile, Warning } from "./types.js";

/** Documented structural limits of `openai.strict`. */
export const OPENAI_MAX_PROPERTIES = 100;
export const OPENAI_MAX_NESTING = 5;

export type ChangeKind = "removed" | "rewritten";

/** pointer -> keyword -> how the keyword changed. */
export type ChangeIndex = Map<string, Map<string, ChangeKind>>;

export interface ConvertResult {
  schema: Record<string, unknown> | boolean;
  removed: Removal[];
  rewritten: Rewrite[];
  warnings: Warning[];
  divergences: Divergence[];
  changes: ChangeIndex;
}

interface Ctx {
  profile: TargetProfile;
  removed: Removal[];
  rewritten: Rewrite[];
  warnings: Warning[];
  divergences: Divergence[];
  changes: ChangeIndex;
  propertyCount: number;
  maxDepth: number;
}

function note(ctx: Ctx, pointer: string, keyword: string, kind: ChangeKind): void {
  let bucket = ctx.changes.get(pointer);
  if (!bucket) {
    bucket = new Map<string, ChangeKind>();
    ctx.changes.set(pointer, bucket);
  }
  bucket.set(keyword, kind);
}

function removalReason(profile: TargetProfile, keyword: string, documented: boolean): string {
  return documented
    ? `${keyword} is documented as unsupported by ${profile.label}; it is dropped and the provider will not enforce it`
    : `${keyword} does not appear in the published ${profile.label} surface, so it is dropped conservatively; the provider's source does not say either way`;
}

function recordRemoval(ctx: Ctx, pointer: string, keyword: string, reason?: string): void {
  const documented = ctx.profile.deny.includes(keyword);
  ctx.removed.push({ pointer, keyword, documented });
  note(ctx, pointer, keyword, "removed");
  if (ANNOTATION_KEYWORDS.includes(keyword)) return;
  ctx.divergences.push({
    pointer,
    keyword,
    effect: "widen",
    evidence: "keyword",
    documented,
    reason: reason ?? removalReason(ctx.profile, keyword, documented),
  });
}

export function convert(
  normalized: Record<string, unknown> | boolean,
  profile: TargetProfile,
): ConvertResult {
  const ctx: Ctx = {
    profile,
    removed: [],
    rewritten: [],
    warnings: [],
    divergences: [],
    changes: new Map(),
    propertyCount: 0,
    maxDepth: 0,
  };
  const schema = convertNode(normalized, "#", ctx, 1, true) as Record<string, unknown> | boolean;

  if (profile.id === "openai.strict") {
    if (ctx.propertyCount > OPENAI_MAX_PROPERTIES) {
      ctx.warnings.push({
        pointer: "#",
        message: `${ctx.propertyCount} object properties exceeds the documented limit of ${OPENAI_MAX_PROPERTIES}; the request will be rejected before the schema is applied`,
      });
    }
    if (ctx.maxDepth > OPENAI_MAX_NESTING) {
      ctx.warnings.push({
        pointer: "#",
        message: `${ctx.maxDepth} levels of nesting exceeds the documented limit of ${OPENAI_MAX_NESTING}; the request will be rejected before the schema is applied`,
      });
    }
  }

  return {
    schema,
    removed: ctx.removed,
    rewritten: ctx.rewritten,
    warnings: ctx.warnings,
    divergences: ctx.divergences,
    changes: ctx.changes,
  };
}

function convertNode(node: unknown, pointer: string, ctx: Ctx, depth: number, isRoot: boolean): unknown {
  if (typeof node === "boolean") return node;
  if (!isPlainObject(node)) return deepClone(node);
  if (depth > MAX_DEPTH) {
    throw new InvalidSchemaError(pointer, `maximum descent depth ${MAX_DEPTH} exceeded`);
  }
  if (depth > ctx.maxDepth) ctx.maxDepth = depth;
  if (isPlainObject(node["properties"])) {
    ctx.propertyCount += Object.keys(node["properties"]).length;
  }

  const profile = ctx.profile;
  const hasRef = typeof node["$ref"] === "string";
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(node)) {
    if (key === "$ref" && profile.id === "gemini.functionDeclarationParameters") {
      ctx.removed.push({ pointer, keyword: "$ref", documented: false });
      note(ctx, pointer, "$ref", "removed");
      ctx.divergences.push({
        pointer,
        keyword: "$ref",
        effect: "unrepresentable",
        evidence: "keyword",
        documented: false,
        reason: `${profile.label} has no reference mechanism at all, so $ref cannot be expressed on this surface`,
      });
      continue;
    }
    if (hasRef && profile.id === "gemini.parametersJsonSchema" && !key.startsWith("$")) {
      recordRemoval(
        ctx,
        pointer,
        key,
        `a subschema carrying $ref may not carry the non-$ sibling ${key} on ${profile.label}, so the sibling is removed`,
      );
      continue;
    }
    if (profile.allow.includes(key)) {
      setKey(out, key, convertChild(key, node[key], pointer, ctx, depth));
      continue;
    }
    recordRemoval(ctx, pointer, key);
  }

  applyRewrites(node, out, pointer, ctx, isRoot);
  return out;
}

function convertChild(
  key: string,
  value: unknown,
  pointer: string,
  ctx: Ctx,
  depth: number,
): unknown {
  if (SCHEMA_VALUE_KEYWORDS.includes(key)) {
    if (typeof value === "boolean" || isPlainObject(value)) {
      return convertNode(value, childPointer(pointer, key), ctx, depth + 1, false);
    }
    return deepClone(value);
  }
  if (SCHEMA_MAP_KEYWORDS.includes(key) && isPlainObject(value)) {
    const mapped: Record<string, unknown> = {};
    for (const name of Object.keys(value)) {
      setKey(
        mapped,
        name,
        convertNode(value[name], childPointer(pointer, key, name), ctx, depth + 1, false),
      );
    }
    return mapped;
  }
  if (SCHEMA_LIST_KEYWORDS.includes(key) && Array.isArray(value)) {
    return value.map((entry, index) =>
      convertNode(entry, childPointer(pointer, key, index), ctx, depth + 1, false),
    );
  }
  return deepClone(value);
}

function permitsNull(schema: unknown): boolean {
  if (!isPlainObject(schema)) return false;
  const type = schema["type"];
  if (type === "null") return true;
  if (Array.isArray(type) && type.includes("null")) return true;
  const anyOf = schema["anyOf"];
  if (Array.isArray(anyOf)) return anyOf.some((branch) => permitsNull(branch));
  return false;
}

function applyRewrites(
  source: Record<string, unknown>,
  out: Record<string, unknown>,
  pointer: string,
  ctx: Ctx,
  isRoot: boolean,
): void {
  const profile = ctx.profile;

  if (profile.id === "gemini.parametersJsonSchema" && Array.isArray(out["oneOf"])) {
    const branches = out["oneOf"] as unknown[];
    delete out["oneOf"];
    const existing = Array.isArray(out["anyOf"]) ? (out["anyOf"] as unknown[]) : [];
    setKey(out, "anyOf", [...existing, ...branches]);
    ctx.rewritten.push({ pointer, from: "oneOf", to: "anyOf" });
    note(ctx, pointer, "oneOf", "rewritten");
    ctx.divergences.push({
      pointer,
      keyword: "oneOf",
      effect: "widen",
      evidence: "keyword",
      documented: false,
      reason: `${profile.label} reinterprets oneOf as anyOf, so any value matching more than one branch is accepted where the source rejected it`,
    });
  }

  if (profile.id === "gemini.functionDeclarationParameters" && isPlainObject(out["properties"])) {
    const properties = out["properties"] as Record<string, unknown>;
    const required = Array.isArray(out["required"]) ? (out["required"] as unknown[]) : [];
    for (const name of Object.keys(properties)) {
      if (!required.includes(name)) continue;
      const child = properties[name];
      if (!isPlainObject(child) || child["nullable"] === true) continue;
      if (!permitsNull(child)) continue;
      setKey(child, "nullable", true);
      const childPtr = childPointer(pointer, "properties", name);
      ctx.rewritten.push({ pointer: childPtr, from: "type", to: "nullable" });
      note(ctx, childPtr, "type", "rewritten");
    }
  }

  if (profile.id === "openai.strict") {
    if (isRoot && Array.isArray(source["anyOf"])) {
      ctx.divergences.push({
        pointer,
        keyword: "anyOf",
        effect: "unrepresentable",
        evidence: "keyword",
        documented: false,
        reason: `${profile.label} does not accept anyOf at the root of a schema`,
      });
    }
    if (isPlainObject(out["properties"])) {
      applyStrictObjectRewrites(source, out, pointer, ctx);
    }
  }
}

function applyStrictObjectRewrites(
  source: Record<string, unknown>,
  out: Record<string, unknown>,
  pointer: string,
  ctx: Ctx,
): void {
  const profile = ctx.profile;
  const properties = out["properties"] as Record<string, unknown>;
  const names = Object.keys(properties);
  const original = Array.isArray(source["required"])
    ? (source["required"] as unknown[]).filter((n): n is string => typeof n === "string")
    : [];
  const missing = names.filter((name) => !original.includes(name));

  if (missing.length > 0) {
    setKey(out, "required", [...original, ...missing]);
    ctx.rewritten.push({ pointer, from: "required", to: "required(all-properties)" });
    note(ctx, pointer, "required", "rewritten");
    ctx.divergences.push({
      pointer,
      keyword: "required",
      effect: "narrow",
      evidence: "keyword",
      documented: false,
      reason: `${profile.label} has no optional properties, so ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} forced into required`,
    });
    for (const name of missing) {
      const childPtr = childPointer(pointer, "properties", name);
      const child = properties[name];
      setKey(properties, name, nullable(child));
      ctx.rewritten.push({ pointer: childPtr, from: "type", to: "type(nullable)" });
      note(ctx, childPtr, "type", "rewritten");
      ctx.divergences.push({
        pointer: childPtr,
        keyword: "type",
        effect: "widen",
        evidence: "keyword",
        documented: false,
        reason: `${name} was optional, so it is re-typed to also permit null now that it is required`,
      });
    }
  }

  if (out["additionalProperties"] !== false) {
    setKey(out, "additionalProperties", false);
    ctx.rewritten.push({ pointer, from: "additionalProperties", to: "additionalProperties(false)" });
    note(ctx, pointer, "additionalProperties", "rewritten");
    ctx.divergences.push({
      pointer,
      keyword: "additionalProperties",
      effect: "narrow",
      evidence: "keyword",
      documented: false,
      reason: `${profile.label} closes every object, so additionalProperties is forced to false`,
    });
  }
}

function nullable(child: unknown): unknown {
  if (isPlainObject(child)) {
    const type = child["type"];
    if (typeof type === "string") {
      setKey(child, "type", [type, "null"]);
      return child;
    }
    if (Array.isArray(type)) {
      if (!type.includes("null")) setKey(child, "type", [...type, "null"]);
      return child;
    }
  }
  return { anyOf: [child, { type: "null" }] };
}
