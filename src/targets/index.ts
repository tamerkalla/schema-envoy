import { UnknownTargetError } from "../errors.js";
import type { TargetId, TargetProfile } from "../types.js";
import { geminiFunctionDeclarationParameters } from "./gemini-function-declaration-parameters.js";
import { geminiParametersJsonSchema } from "./gemini-parameters-json-schema.js";
import { openaiStrict } from "./openai-strict.js";

const PROFILES: readonly TargetProfile[] = Object.freeze([
  geminiParametersJsonSchema,
  geminiFunctionDeclarationParameters,
  openaiStrict,
]);

export function targets(): readonly TargetProfile[] {
  return PROFILES;
}

export function targetIds(): readonly string[] {
  return PROFILES.map((p) => p.id);
}

export function isTargetId(id: unknown): id is TargetId {
  return typeof id === "string" && PROFILES.some((p) => p.id === id);
}

export function target(id: TargetId): TargetProfile {
  const found = PROFILES.find((p) => p.id === id);
  if (!found) throw new UnknownTargetError(String(id), targetIds());
  return found;
}
