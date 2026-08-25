import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import { InvalidSchemaError, SchemaProbeError } from "./errors.js";
import { ANNOTATION_KEYWORDS } from "./normalize.js";
import type {
  DifferentialResult,
  Divergence,
  Removal,
  Rewrite,
} from "./types.js";

/** Witnesses stored per direction. */
export const WITNESS_CAP = 8;

export type Predicate = (value: unknown) => boolean;

/**
 * A fresh ajv instance with `ajv-formats` registered. Without the formats
 * plugin ajv ignores `format` outright, and a dropped `format` keyword would
 * falsely appear to change nothing.
 */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  return ajv;
}

export type CompileOutcome =
  | { ok: true; validate: ValidateFunction }
  | { ok: false; message: string };

export function tryCompile(schema: unknown): CompileOutcome {
  try {
    const ajv = createAjv();
    return { ok: true, validate: ajv.compile(schema as object) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Wrap an ajv validator so that a thrown exception becomes a probe failure
 * rather than being read as `false`, and so that a non-boolean result fails
 * loudly instead of being coerced.
 */
export function makePredicate(
  validate: (value: unknown) => unknown,
  label: string,
): Predicate {
  return (value: unknown): boolean => {
    let result: unknown;
    try {
      result = validate(value);
    } catch (error) {
      throw new SchemaProbeError(
        `${label} validator threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof result !== "boolean") {
      throw new SchemaProbeError(
        `${label} validator returned ${typeof result} instead of a boolean`,
      );
    }
    return result;
  };
}

export function classify(
  values: readonly unknown[],
  acceptedBySource: Predicate,
  acceptedByConverted: Predicate,
): DifferentialResult {
  let agreed = 0;
  let widened = 0;
  let narrowed = 0;
  const widenedWitnesses: unknown[] = [];
  const narrowedWitnesses: unknown[] = [];

  for (const value of values) {
    const inSource = acceptedBySource(value);
    const inConverted = acceptedByConverted(value);
    if (inSource === inConverted) {
      agreed += 1;
    } else if (inConverted) {
      widened += 1;
      if (widenedWitnesses.length < WITNESS_CAP) widenedWitnesses.push(value);
    } else {
      narrowed += 1;
      if (narrowedWitnesses.length < WITNESS_CAP) narrowedWitnesses.push(value);
    }
  }

  return {
    checked: values.length,
    agreed,
    widened,
    narrowed,
    widenedWitnesses,
    narrowedWitnesses,
  };
}

export function differential(
  source: unknown,
  converted: unknown,
  values: readonly unknown[],
): DifferentialResult {
  if (!Array.isArray(values) || values.length === 0) {
    throw new SchemaProbeError("the corpus is empty, so no divergence could be observed");
  }
  const compiledSource = tryCompile(source);
  if (!compiledSource.ok) {
    throw new InvalidSchemaError("#", `source schema did not compile: ${compiledSource.message}`);
  }
  const compiledConverted = tryCompile(converted);
  if (!compiledConverted.ok) {
    throw new InvalidSchemaError(
      "#",
      `converted schema did not compile: ${compiledConverted.message}`,
    );
  }
  return classify(
    values,
    makePredicate(compiledSource.validate, "source"),
    makePredicate(compiledConverted.validate, "converted"),
  );
}

export interface FloorInput {
  corpusSize: number;
  sourceCompiled: boolean;
  convertedCompiled: boolean;
  differential: DifferentialResult;
  removed: readonly Removal[];
  rewritten: readonly Rewrite[];
  divergences: readonly Divergence[];
}

/**
 * The sanity floor from section 8.7. A conversion that deleted keywords and
 * then reported perfect equivalence is a broken harness, not a clean result.
 */
export function assertSanityFloor(input: FloorInput): void {
  if (input.corpusSize <= 0) {
    throw new SchemaProbeError("the union corpus is empty");
  }
  if (!input.sourceCompiled) {
    throw new SchemaProbeError("the normalized source schema did not compile");
  }
  if (!input.convertedCompiled) {
    throw new SchemaProbeError("the converted schema did not compile");
  }
  const { checked, agreed, widened, narrowed } = input.differential;
  if (checked !== agreed + widened + narrowed) {
    throw new SchemaProbeError(
      `checked (${checked}) does not equal agreed + widened + narrowed (${agreed + widened + narrowed})`,
    );
  }
  if (input.removed.length + input.rewritten.length > 0 && input.divergences.length === 0) {
    const onlyAnnotations = input.removed.every((entry) =>
      ANNOTATION_KEYWORDS.includes(entry.keyword),
    );
    if (!onlyAnnotations) {
      throw new SchemaProbeError(
        "the conversion removed or rewrote keywords but reported no divergence",
      );
    }
  }
}

export function formatErrors(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (!errors) return [];
  return errors.map((error) => {
    const path = error.instancePath === "" ? "#" : error.instancePath;
    return `${path} ${error.message ?? "is invalid"}`;
  });
}
