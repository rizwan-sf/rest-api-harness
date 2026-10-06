import type { Task } from "../task/schema.js";

export type Severity = "error" | "warning";

export interface Violation {
  gate: string;
  rule: string;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
}

export interface GateResult {
  gate: string;
  passed: boolean;
  violations: Violation[];
  /** Set when the gate could not run (e.g. a prerequisite gate failed). */
  skipped?: string;
  durationMs: number;
}

export interface GateContext {
  /** Absolute workspace root. */
  root: string;
  task: Task;
}

export interface Gate {
  name: string;
  /** Static gates are cheap (AST only) and run after every agent edit. */
  kind: "static" | "dynamic";
  run(ctx: GateContext): Promise<Violation[]>;
}
