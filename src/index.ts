import { convert } from "./convert.js";
import { assertSanityFloor, classify, makePredicate, tryCompile } from "./differential.js";
import { InvalidSchemaError, SchemaDivergenceError, SchemaProbeError } from "./errors.js";
import { explain } from "./explain.js";
import { deepClone, normalize } from "./normalize.js";
import { assertRefsResolvable, assertSchemaShape, resolveProfile } from "./residual.js";
import type {
  AdaptOptions,
  AdaptReport,
  AdaptResult,
  Divergence,
  JSONSchema,
  TargetId,
} from "./types.js";
import {
  DEFAULT_WITNESS_BUDGET,
  generateCandidates,
  selectWitnesses,
} from "./witness.js";

export type {
  AdaptOptions,
  AdaptReport,
  AdaptResult,
  DifferentialResult,
  Divergence,
  DivergenceEffect,
  DivergenceEvidence,
  JSONSchema,
  Removal,
  ResidualResult,
  Rewrite,
  RewriteRule,
  TargetId,
  TargetProfile,
  Warning,
} from "./types.js";

export {
  InvalidSchemaError,
  SchemaDivergenceError,
  SchemaEnvoyError,
  SchemaProbeError,
  UnknownTargetError,
} from "./errors.js";

export { differential } from "./differential.js";
export { explain } from "./explain.js";
export { residual } from "./residual.js";
export { target, targets } from "./targets/index.js";

/**
 * Convert a JSON Schema into a provider's accepted subset and report every
 * value whose accept/reject status changed as a result.
 *
 * Throws by default when the conversion changes the accepted value set;
 * silence is opt-in via `onDivergence: "report"`.
 */
export function adapt(
  schema: unknown,
  targetId: TargetId,
  options?: AdaptOptions,
): AdaptResult {
  const profile = resolveProfile(targetId);
  assertSchemaShape(schema);

  const normalized = normalize(deepClone(schema));
  assertRefsResolvable(normalized.schema);

  const compiledSource = tryCompile(normalized.schema);
  if (!compiledSource.ok) {
    throw new InvalidSchemaError("#", `ajv refused to compile the schema: ${compiledSource.message}`);
  }

  const converted = convert(normalized.schema, profile);

  const compiledConverted = tryCompile(converted.schema);
  if (!compiledConverted.ok) {
    throw new SchemaProbeError(
      `the converted schema did not compile: ${compiledConverted.message}`,
    );
  }

  const acceptedBySource = makePredicate(compiledSource.validate, "source");
  const acceptedByConverted = makePredicate(compiledConverted.validate, "converted");

  const budget = options?.witnessBudget ?? DEFAULT_WITNESS_BUDGET;
  const candidates = generateCandidates(normalized.schema, converted.changes, budget);
  const flipped = selectWitnesses(candidates, acceptedBySource, acceptedByConverted);

  const removed = [...normalized.removed, ...converted.removed];
  const rewritten = [...normalized.rewrites, ...converted.rewritten];
  const divergences: Divergence[] = converted.divergences.map((entry) => ({ ...entry }));

  for (const { candidate, effect } of flipped) {
    const match = divergences.find(
      (entry) =>
        entry.pointer === candidate.pointer &&
        entry.keyword === candidate.keyword &&
        entry.evidence === "keyword",
    );
    if (!match) continue;
    match.evidence = "value";
    match.witness = candidate.value;
    if (match.effect !== "unrepresentable") match.effect = effect;
  }

  const extra = options?.corpus ?? [];
  const corpus: unknown[] = [...candidates.map((entry) => entry.value), ...extra];
  const result = classify(corpus, acceptedBySource, acceptedByConverted);

  const report: AdaptReport = {
    target: profile.id,
    sourceUrl: profile.sourceUrl,
    sourceVersion: profile.sourceVersion,
    capturedAt: profile.capturedAt,
    removed,
    rewritten,
    warnings: converted.warnings,
    divergences,
    differential: result,
    equivalent: divergences.length === 0,
  };

  assertSanityFloor({
    corpusSize: corpus.length,
    sourceCompiled: true,
    convertedCompiled: true,
    differential: result,
    removed,
    rewritten,
    divergences,
  });

  if (divergences.length > 0 && (options?.onDivergence ?? "throw") === "throw") {
    throw new SchemaDivergenceError(explain(report).split("\n")[0] as string, report);
  }

  return { schema: converted.schema as JSONSchema, report };
}
