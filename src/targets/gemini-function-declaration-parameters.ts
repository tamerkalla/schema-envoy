import type { TargetProfile } from "../types.js";

/**
 * The legacy `FunctionDeclaration.parameters` surface: an OpenAPI 3.0 style
 * `Schema` object. The allowlist below is the complete set of fields on the
 * `Schema` interface of `@google/genai@2.18.0`, in declaration order.
 *
 * `deny` is empty on purpose. The source is an exhaustive interface rather
 * than a denylist, so a keyword that does not appear here is not "documented
 * as unsupported" — it is simply not expressible, and the report says so by
 * flagging every such removal as undocumented.
 */
export const geminiFunctionDeclarationParameters: TargetProfile = Object.freeze({
  id: "gemini.functionDeclarationParameters",
  label: "Gemini FunctionDeclaration.parameters",
  sourceUrl: "https://www.npmjs.com/package/@google/genai/v/2.18.0",
  sourceVersion: "@google/genai@2.18.0",
  capturedAt: "2026-08-24",
  dialect: "openapi-3.0-subset",
  allow: Object.freeze([
    "anyOf",
    "default",
    "description",
    "enum",
    "example",
    "format",
    "items",
    "maxItems",
    "maxLength",
    "maxProperties",
    "maximum",
    "minItems",
    "minLength",
    "minProperties",
    "minimum",
    "nullable",
    "pattern",
    "properties",
    "propertyOrdering",
    "required",
    "title",
    "type",
  ]),
  deny: Object.freeze([]),
  rewrites: Object.freeze([
    {
      keyword: "type",
      to: "nullable",
      description:
        "A property listed in required whose schema also permits null gains a sibling nullable: true. Purely additive; it never removes anything.",
    },
  ]),
  notes: Object.freeze([
    "$ref is not expressible in this surface at all, so a schema containing $ref after normalization yields an unrepresentable divergence rather than a removal.",
    "const has no representation on this interface and is dropped. Rewriting it to enum would silently re-narrow the schema, which is exactly the kind of unreported change this package exists to surface.",
    "This surface is an OpenAPI 3.0 style Schema object, not JSON Schema: nullability is expressed with the nullable keyword rather than a union with the null type.",
  ]),
} satisfies TargetProfile);
