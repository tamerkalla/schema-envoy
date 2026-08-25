/**
 * Public type surface. Everything here is re-exported from `src/index.ts`
 * and appears in the emitted declaration file.
 */

export type TargetId =
  | "gemini.parametersJsonSchema"
  | "gemini.functionDeclarationParameters"
  | "openai.strict";

export type JSONSchema = Record<string, unknown> | boolean;

export type DivergenceEffect = "widen" | "narrow" | "unrepresentable";
export type DivergenceEvidence = "value" | "keyword";

export interface Divergence {
  /** RFC 6901 JSON Pointer into the normalized source schema. */
  pointer: string;
  keyword: string;
  effect: DivergenceEffect;
  evidence: DivergenceEvidence;
  /** True when the profile's `deny` list names this keyword. */
  documented: boolean;
  reason: string;
  /** Present if and only if `evidence === "value"`. */
  witness?: unknown;
}

export interface Removal {
  pointer: string;
  keyword: string;
  documented: boolean;
}

export interface Rewrite {
  pointer: string;
  from: string;
  to: string;
}

export interface Warning {
  pointer: string;
  message: string;
}

export interface RewriteRule {
  readonly keyword: string;
  readonly to: string;
  readonly description: string;
}

export interface TargetProfile {
  readonly id: TargetId;
  readonly label: string;
  readonly sourceUrl: string;
  readonly sourceVersion: string;
  /** Literal capture date; never a clock read. */
  readonly capturedAt: string;
  readonly dialect: "openapi-3.0-subset" | "json-schema-subset";
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly rewrites: readonly RewriteRule[];
  readonly notes: readonly string[];
}

export interface DifferentialResult {
  checked: number;
  agreed: number;
  widened: number;
  narrowed: number;
  /** Capped at 8, in corpus order. */
  widenedWitnesses: readonly unknown[];
  /** Capped at 8, in corpus order. */
  narrowedWitnesses: readonly unknown[];
}

export interface AdaptReport {
  target: TargetId;
  sourceUrl: string;
  sourceVersion: string;
  capturedAt: string;
  removed: readonly Removal[];
  rewritten: readonly Rewrite[];
  warnings: readonly Warning[];
  divergences: readonly Divergence[];
  differential: DifferentialResult;
  /** `divergences.length === 0`. */
  equivalent: boolean;
}

export interface AdaptOptions {
  /** Default `"throw"`. */
  onDivergence?: "throw" | "report";
  /** Extra values, evaluated in addition to generated witnesses. */
  corpus?: readonly unknown[];
  /** Default 512; hard maximum 4096. */
  witnessBudget?: number;
}

export interface AdaptResult {
  schema: JSONSchema;
  report: AdaptReport;
}

export interface ResidualResult {
  /** Only the constraints the target drops. */
  schema: JSONSchema;
  validate: (value: unknown) => boolean;
  errors: (value: unknown) => readonly string[];
  /** Keyword names the target does enforce. */
  enforcedByProvider: readonly string[];
  /** Keyword names this validator enforces. */
  enforcedHere: readonly string[];
}
