import type { TargetProfile } from "../types.js";

/**
 * The `responseJsonSchema` / `parametersJsonSchema` surface: a documented
 * subset of JSON Schema. The allowlist below is the keyword list documented
 * on `GenerateContentConfig.responseJsonSchema` in `@google/genai@2.18.0`,
 * in the order the source gives them.
 */
export const geminiParametersJsonSchema: TargetProfile = Object.freeze({
  id: "gemini.parametersJsonSchema",
  label: "Gemini parametersJsonSchema",
  sourceUrl: "https://www.npmjs.com/package/@google/genai/v/2.18.0",
  sourceVersion: "@google/genai@2.18.0",
  capturedAt: "2026-08-24",
  dialect: "json-schema-subset",
  allow: Object.freeze([
    "$id",
    "$defs",
    "$ref",
    "$anchor",
    "type",
    "format",
    "title",
    "description",
    "enum",
    "items",
    "prefixItems",
    "minItems",
    "maxItems",
    "minimum",
    "maximum",
    "anyOf",
    "oneOf",
    "properties",
    "additionalProperties",
    "required",
    "propertyOrdering",
  ]),
  deny: Object.freeze([]),
  rewrites: Object.freeze([
    {
      keyword: "oneOf",
      to: "anyOf",
      description:
        "The source states oneOf is interpreted the same way as anyOf. The two differ on any value matching more than one branch, so this rewrite always reports a widening.",
    },
  ]),
  notes: Object.freeze([
    "Cyclic references are unrolled only to a limited degree, and only within properties that are not required; a cycle reached through a required property is not expanded at all.",
    "A subschema carrying $ref may not carry any sibling key that does not begin with $. Such siblings are removed by the conversion and each removal is recorded.",
    "oneOf is accepted by the surface but is read as anyOf, which is why it is rewritten rather than passed through untouched.",
  ]),
} satisfies TargetProfile);
