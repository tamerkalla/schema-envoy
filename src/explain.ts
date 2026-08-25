import type { AdaptReport, Divergence } from "./types.js";

function render(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}

function headline(report: AdaptReport): string {
  const count = report.divergences.length;
  if (count === 0) {
    return `schema-envoy: no divergence found converting to ${report.target}`;
  }
  return `schema-envoy: ${count} divergence${count === 1 ? "" : "s"} converting to ${report.target}`;
}

function line(divergence: Divergence): string {
  const parts = [
    `  [${divergence.effect}]`,
    divergence.pointer,
    divergence.keyword,
    divergence.documented ? "(documented unsupported)" : "(undocumented)",
    `evidence=${divergence.evidence}`,
    `- ${divergence.reason}`,
  ];
  if (divergence.evidence === "value") {
    parts.push(`- witness ${render(divergence.witness)}`);
  }
  return parts.join(" ");
}

/** A deterministic, human-readable rendering of a report. Never throws. */
export function explain(report: AdaptReport): string {
  try {
    const d = report.differential;
    const lines: string[] = [
      headline(report),
      `source: ${report.sourceUrl} (${report.sourceVersion}, captured ${report.capturedAt})`,
      `corpus: checked ${d.checked} - agreed ${d.agreed}, widened ${d.widened}, narrowed ${d.narrowed}`,
      `keywords: ${report.removed.length} removed, ${report.rewritten.length} rewritten`,
    ];
    if (report.divergences.length > 0) {
      lines.push("divergences:");
      for (const divergence of report.divergences) lines.push(line(divergence));
    }
    if (report.warnings.length > 0) {
      lines.push("warnings:");
      for (const warning of report.warnings) {
        lines.push(`  ${warning.pointer} - ${warning.message}`);
      }
    }
    lines.push(
      report.equivalent
        ? "equivalent over this corpus: no witness was found. That is evidence, not a proof."
        : "not equivalent: at least one value changed accept/reject status.",
    );
    return lines.join("\n");
  } catch {
    return "schema-envoy: report could not be rendered";
  }
}
