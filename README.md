# schema-envoy

Every LLM provider accepts a *subset* of JSON Schema, not JSON Schema. Every library that
talks to those providers closes the gap the same way: it walks the schema and deletes the
keywords the provider does not list. That deletion is silent. The resulting schema is valid,
the API call succeeds, and the schema now accepts values your own validator rejects.

That is not a bug anyone is going to fix, because the deletion is the documented behaviour of
the provider rather than a defect in it.

[![CI](https://github.com/tamerkalla/schema-envoy/actions/workflows/ci.yml/badge.svg)](https://github.com/tamerkalla/schema-envoy/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/schema-envoy.svg)](https://www.npmjs.com/package/schema-envoy)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![provenance](https://img.shields.io/badge/provenance-attested-brightgreen.svg)](https://www.npmjs.com/package/schema-envoy)

`schema-envoy` performs the conversion and tells you exactly what it cost. Three things come
back:

1. the provider-valid schema,
2. a report naming every keyword removed or rewritten, with a concrete witness value whose
   accept/reject status changed,
3. a **residual validator** — a compiled validator over precisely the constraints the provider
   dropped — so the constraints you wrote are enforced somewhere, at the boundary where the
   model's output comes back.

By default `adapt()` throws when the conversion changes the accepted value set. Silence is
opt-in, not the default.

```bash
npm install schema-envoy
```

```ts
import { adapt, explain, residual } from "schema-envoy";

const source = {
  type: "object",
  properties: {
    email: { type: "string", format: "email" },
    score: { type: "integer", minimum: 0, maximum: 10 },
  },
  required: ["email", "score"],
  additionalProperties: false,
};

// adapt(source, "openai.strict") would throw SchemaDivergenceError here,
// because strict mode will not enforce `format`, `minimum` or `maximum`.
// Opt into a report to inspect the cost instead of throwing.
const { schema, report } = adapt(source, "openai.strict", { onDivergence: "report" });

console.log(explain(report)); // every keyword dropped, with a witness value

// Send `schema` to the provider, then check what comes back
// against the constraints the provider dropped.
const guard = residual(source, "openai.strict");
if (!guard.validate(modelOutput)) console.error(guard.errors(modelOutput));
```

## What the report says

```ts
report.removed;      // { pointer, keyword, documented }[]
report.rewritten;    // { pointer, from, to }[]
report.warnings;     // { pointer, message }[]  — request-time limits, not value changes
report.divergences;  // { pointer, keyword, effect, evidence, documented, reason, witness? }[]
report.differential; // { checked, agreed, widened, narrowed, ...Witnesses }
report.equivalent;   // divergences.length === 0
```

Every divergence carries an `effect` of `widen`, `narrow` or `unrepresentable`, and an
`evidence` of `value` or `keyword`. `evidence: "value"` means a concrete input was found whose
accept/reject status differs between the two schemas — the divergence is proved by
construction. `evidence: "keyword"` means the constraint was demonstrably dropped but no
witness could be built for it, usually because the surrounding schema is not seedable.

`documented` is the difference between two very different claims:

- `documented: true` — the provider's published source names this keyword as unsupported. The
  removal is the provider's stated behaviour.
- `documented: false` — the provider's published source does not mention the keyword either
  way. This package drops it conservatively rather than gambling that it is honoured, and says
  so. `explain()` renders the two differently for exactly this reason.

**`equivalent: true` means no witness was found, not that none exists.** The differential is
evidence over a finite corpus, not a proof over all values. Nothing in this package claims
semantic equivalence.

## Targets

| id | surface | source |
|---|---|---|
| `gemini.parametersJsonSchema` | `responseJsonSchema` / `parametersJsonSchema` | `@google/genai@2.18.0` |
| `gemini.functionDeclarationParameters` | legacy `FunctionDeclaration.parameters` | `@google/genai@2.18.0` |
| `openai.strict` | structured outputs with `strict: true` | OpenAI structured-outputs guide |

Each profile carries the URL, the version and the capture date it was read from, and is a
frozen object you can inspect:

```ts
import { target, targets } from "schema-envoy";

targets().map((profile) => profile.id);
target("openai.strict").deny;        // the 19 keywords documented as unsupported
target("openai.strict").sourceUrl;
```

A profile is an assertion about somebody else's API. There is no target here that was not read
from a citable published source with an enumerated keyword list, and adding one requires the
same.

## Measured

Numbers below were produced by running the code against the versions named, and are asserted
as exact integers by the test suite. `corpus` is an explicit enumeration; `widened` counts
values the source rejects and the converted schema accepts.

| baseline | target | corpus | agreed | widened | narrowed |
|---|---|---|---|---|---|
| B1 | `gemini.functionDeclarationParameters` | 720 | 648 | 72 | 0 |
| B2 | naive strict required-fill | 12 | 1 | 0 | 11 |
| B3 | `gemini.parametersJsonSchema` | 96 | 2 | 94 | 0 |
| B4 | `oneOf` read as `anyOf` | 4 | 3 | 1 | 0 |
| B5 | `openai.strict` | 72 | 36 | 35 | 1 |

B5 is a five-property schema that accepted 2 of its 72-value corpus before conversion and 36
after. Strict mode constrains *structure*: it does not enforce `pattern`, `format`, `minimum`,
`maximum`, `multipleOf`, `minItems`, `maxItems` or `uniqueItems`. B2 is the naive conversion —
required-filling without re-typing the newly required properties as nullable — and shows why
`openai.strict` performs that rewrite: without it the conversion *narrows*, rejecting 11 of 12
values the source accepted.

Reproduce all five yourself:

```bash
npx --yes schema-envoy@latest --self-check
```

See [VERIFY.md](./VERIFY.md).

## API

```ts
adapt(schema, target, options?): { schema, report }
differential(source, converted, values): DifferentialResult
residual(schema, target): ResidualResult
explain(report): string
targets(): readonly TargetProfile[]
target(id): TargetProfile
```

`AdaptOptions`:

| option | default | meaning |
|---|---|---|
| `onDivergence` | `"throw"` | `"report"` returns the report instead of throwing |
| `corpus` | `[]` | extra values, evaluated in addition to the generated witnesses |
| `witnessBudget` | `512` | candidate cap; hard maximum 4096 |

Errors: `SchemaEnvoyError` is the base. `SchemaDivergenceError` carries the full `report`.
`UnknownTargetError` carries the `id`. `InvalidSchemaError` carries the `pointer`.
`SchemaProbeError` carries a `detail` and means the differential could not be performed at
all — it is never downgraded to a finding, and an empty divergence list caused by a probe
failure is never returned as `equivalent: true`.

`adapt`, `differential`, `residual` and `explain` deep-clone their inputs and never mutate an
argument. Witness generation is deterministic: no pseudo-random generator is used anywhere in
this package, and no module reads the clock.

## How it works

1. **Normalize.** Draft-07 is lifted to draft 2020-12: `definitions` to `$defs`, boolean
   `exclusiveMinimum`/`exclusiveMaximum` to their numeric form, tuple `items` to `prefixItems`
   with `additionalItems` becoming `items`, and `$schema` recorded and dropped.
2. **Convert.** The normalized schema is walked depth-first in source key order. Each keyword
   is passed through, rewritten, or dropped according to the profile.
3. **Generate witnesses.** A seed instance is built from the source schema, then mutated at
   every pointer where a keyword changed. A candidate becomes a witness only if it actually
   flips; candidates that agree on both sides are discarded silently.
4. **Differential.** Both schemas are compiled with separate `ajv` instances — with
   `ajv-formats` registered, so `format` is genuinely evaluated — and the corpus is classified
   into agreed, widened and narrowed.
5. **Sanity floor.** A conversion that deleted keywords and then reported perfect equivalence
   is a broken harness, not a clean result, and fails loudly.

## CLI

```
schema-envoy --target <id> [file]   # explain the conversion; --json for machine output
schema-envoy --targets              # id, source version, allow count, deny count
schema-envoy --self-check           # reproduce the five baselines
```

Exit codes: `0` equivalent (or self-check passed), `1` divergences found (or self-check
failed), `2` usage error, `3` probe failure. The CLI is a debugging and demonstration surface;
the library is the product.

## Scope

The input is JSON Schema, so this package depends on no schema library and no provider SDK —
it works with zod, valibot, arktype, typebox, hand-written schemas and raw MCP tool schemas
alike. It converts and reports; it never makes the provider call, and it never rewrites your
source schema.

## Related

[`schema-fit`](https://github.com/tamerkalla/schema-fit) solves the mirror
problem. It rewrites a schema so a provider will accept it while guaranteeing it
never widens what the schema allows — narrowing instead, and telling you where.

Use `schema-fit` when widening is unacceptable and you would rather lose values
than gain them. Use `schema-envoy` when the provider's subset forces widening
anyway and you need to know exactly which values it let through.

## License

MIT
