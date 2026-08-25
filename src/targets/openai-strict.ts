import type { TargetProfile } from "../types.js";

/**
 * OpenAI structured outputs with `strict: true`. Unlike the Gemini surfaces
 * this source publishes an explicit list of unsupported keywords, so every
 * removal drawn from `deny` is reported with `documented: true`.
 */
export const openaiStrict: TargetProfile = Object.freeze({
  id: "openai.strict",
  label: "OpenAI structured outputs (strict)",
  sourceUrl: "https://developers.openai.com/api/docs/guides/structured-outputs",
  sourceVersion: "documented behaviour as of 2026-08-24",
  capturedAt: "2026-08-24",
  dialect: "json-schema-subset",
  allow: Object.freeze([
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "anyOf",
    "$defs",
    "$ref",
    "$anchor",
    "$id",
    "description",
    "title",
    "const",
  ]),
  deny: Object.freeze([
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minimum",
    "maximum",
    "multipleOf",
    "patternProperties",
    "unevaluatedProperties",
    "propertyNames",
    "minProperties",
    "maxProperties",
    "unevaluatedItems",
    "contains",
    "minContains",
    "maxContains",
    "minItems",
    "maxItems",
    "uniqueItems",
  ]),
  rewrites: Object.freeze([
    {
      keyword: "required",
      to: "required(all-properties)",
      description:
        "Every property name is added to required. Strict mode has no notion of an optional property.",
    },
    {
      keyword: "type",
      to: "type(nullable)",
      description:
        "A property that was not previously required is re-typed to also permit null, so that the forced required entry does not narrow the schema.",
    },
    {
      keyword: "additionalProperties",
      to: "additionalProperties(false)",
      description: "Every object node is closed with additionalProperties: false.",
    },
  ]),
  notes: Object.freeze([
    "$defs and recursive $ref are supported by this target and are passed through untouched.",
    "A root schema may not be anyOf; a root anyOf is reported as an unrepresentable divergence.",
    "The documented structural limits are 100 object properties in total and five levels of nesting. Exceeding either is a request-time rejection rather than a change in the accepted value set, so it is reported as a warning and not as a divergence.",
    "Strict mode constrains structure only. It does not enforce pattern, format, minimum, maximum, multipleOf, minItems, maxItems or uniqueItems, which is why the residual validator matters most for this target.",
  ]),
} satisfies TargetProfile);
