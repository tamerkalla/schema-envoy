import type { AdaptReport } from "./types.js";

export class SchemaEnvoyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class SchemaDivergenceError extends SchemaEnvoyError {
  readonly report: AdaptReport;

  constructor(message: string, report: AdaptReport) {
    super(message);
    this.report = report;
  }
}

export class SchemaProbeError extends SchemaEnvoyError {
  readonly detail: string;

  constructor(detail: string) {
    super(`probe failed: ${detail}`);
    this.detail = detail;
  }
}

export class UnknownTargetError extends SchemaEnvoyError {
  readonly id: string;

  constructor(id: string, known: readonly string[]) {
    super(`unknown target ${JSON.stringify(id)}; known targets: ${known.join(", ")}`);
    this.id = id;
  }
}

export class InvalidSchemaError extends SchemaEnvoyError {
  readonly pointer: string;

  constructor(pointer: string, detail: string) {
    super(`invalid schema at ${pointer}: ${detail}`);
    this.pointer = pointer;
  }
}
