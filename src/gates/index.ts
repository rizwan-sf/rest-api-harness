import { contractProbeGate } from "./contract-probe.js";
import { problemDetailsGate } from "./problem-details.js";
import { dependencyGate, testsGate, typecheckGate } from "./process-gates.js";
import { restConventionsGate } from "./rest-conventions.js";
import { typeSafetyGate } from "./type-safety.js";
import type { Gate, GateContext, GateResult, Violation } from "./types.js";
import { zodBoundaryGate } from "./zod-boundary.js";

/** Order matters: cheap static gates first; dynamic gates only run if the code compiles. */
export const ALL_GATES: readonly Gate[] = [
  dependencyGate,
  zodBoundaryGate,
  problemDetailsGate,
  typeSafetyGate,
  restConventionsGate,
  typecheckGate,
  testsGate,
  contractProbeGate,
];

export const GATE_NAMES = ALL_GATES.map((g) => g.name);

export interface GateReport {
  passed: boolean;
  results: GateResult[];
  /** Violations that count against the run after baseline filtering. */
  blocking: Violation[];
}

export interface RunGatesOptions {
  only?: readonly string[];
  staticOnly?: boolean;
  /** Ratchet mode: violations present in the baseline are tolerated. */
  baseline?: readonly Violation[];
}

export async function runGates(ctx: GateContext, opts: RunGatesOptions = {}): Promise<GateReport> {
  const gates = ALL_GATES.filter(
    (g) => (!opts.only || opts.only.includes(g.name)) && (!opts.staticOnly || g.kind === "static"),
  );
  const tolerated = opts.baseline ? fingerprintCounts(opts.baseline) : new Map<string, number>();
  const results: GateResult[] = [];
  const blocking: Violation[] = [];
  let typecheckFailed = false;

  for (const gate of gates) {
    const started = Date.now();
    if (typecheckFailed && (gate.name === "tests" || gate.name === "contract-probe")) {
      results.push({ gate: gate.name, passed: false, violations: [], skipped: "typecheck failed", durationMs: 0 });
      continue;
    }

    let violations: Violation[];
    try {
      violations = await gate.run(ctx);
    } catch (err) {
      violations = [{ gate: gate.name, rule: "gate-crashed", severity: "error", message: err instanceof Error ? err.message : String(err) }];
    }

    const newErrors = violations.filter((v) => v.severity === "error" && !consume(tolerated, fingerprint(v)));
    blocking.push(...newErrors);
    if (gate.name === "typecheck" && newErrors.length > 0) typecheckFailed = true;
    results.push({ gate: gate.name, passed: newErrors.length === 0, violations, durationMs: Date.now() - started });
  }

  return { passed: results.every((r) => r.passed), results, blocking };
}

/**
 * Line numbers shift as code is edited, so identity is gate+rule+file+message.
 * Counted, so adding a second copy of a pre-existing violation is still caught.
 */
export function fingerprint(v: Violation): string {
  return [v.gate, v.rule, v.file ?? "", v.message].join("|");
}

function fingerprintCounts(violations: readonly Violation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of violations) counts.set(fingerprint(v), (counts.get(fingerprint(v)) ?? 0) + 1);
  return counts;
}

function consume(counts: Map<string, number>, key: string): boolean {
  const n = counts.get(key) ?? 0;
  if (n === 0) return false;
  counts.set(key, n - 1);
  return true;
}

/** Compact, model-facing rendering of a gate report. */
export function formatReport(report: GateReport, opts: { includeTolerated?: boolean } = {}): string {
  const lines: string[] = [report.passed ? "ALL GATES PASSED" : `GATES FAILED (${report.blocking.length} blocking violation(s))`];
  for (const r of report.results) {
    const status = r.skipped ? `SKIPPED (${r.skipped})` : r.passed ? "pass" : "FAIL";
    lines.push(`- ${r.gate}: ${status}`);
  }
  const shown = opts.includeTolerated ? report.results.flatMap((r) => r.violations) : report.blocking;
  for (const v of shown.slice(0, 50)) {
    const where = v.file ? `${v.file}${v.line ? `:${v.line}` : ""} ` : "";
    lines.push(`  [${v.gate}/${v.rule}] ${where}${v.message}`);
  }
  if (shown.length > 50) lines.push(`  … and ${shown.length - 50} more`);
  return lines.join("\n");
}
