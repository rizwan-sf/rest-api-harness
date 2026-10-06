import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { exec, tail } from "../gates/exec.js";
import { formatReport, runGates, type GateReport } from "../gates/index.js";
import type { GateContext, Violation } from "../gates/types.js";
import type { Provider, ToolResult, TurnInput } from "../providers/types.js";
import { Transcript } from "../report/transcript.js";
import type { LoadedTask } from "../task/load.js";
import { executeTool, toolSpecs, type ToolContext } from "../tools/registry.js";
import { Workspace } from "../tools/workspace.js";
import { buildSystemPrompt, buildTaskMessage } from "./prompt.js";

export type Outcome = "passed" | "failed_gates" | "budget_exhausted" | "refused" | "error";

export interface RunReport {
  task: string;
  kind: string;
  provider: string;
  model: string;
  outcome: Outcome;
  turns: number;
  finishAttempts: number;
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
  baselineViolations: number;
  filesTouched: string[];
  finalGates: GateReport;
  agentSummary?: string;
  runDir: string;
}

export async function runTask(loaded: LoadedTask, provider: Provider, runsDir: string): Promise<RunReport> {
  const { task, sourceDir } = loaded;
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.resolve(runsDir, `${stamp}-${task.id}-${provider.id}`);
  await mkdir(runDir, { recursive: true });

  const transcript = new Transcript(path.join(runDir, "transcript.jsonl"));
  const workspace = await Workspace.seed(sourceDir, path.join(runDir, "workspace"), task.policy.protectedPaths);
  const ctx: GateContext = { root: workspace.root, task };
  await transcript.log({ type: "run_start", task: task.id, provider: provider.id, model: provider.model });

  const installer = new Installer(workspace.root);

  // Brownfield ratchet: snapshot the violations that exist before the agent touches anything.
  let baseline: Violation[] | undefined;
  if (task.policy.baseline === "ratchet") {
    await installer.ensure(ctx);
    const before = await runGates(ctx);
    baseline = before.results.flatMap((r) => r.violations);
    await transcript.log({ type: "baseline", violations: baseline.length });
  }

  const gates = async (opts: { staticOnly?: boolean; only?: readonly string[] } = {}): Promise<GateReport> => {
    if (!opts.staticOnly) await installer.ensure(ctx);
    return runGates(ctx, { ...opts, ...(baseline ? { baseline } : {}) });
  };

  let finishAttempts = 0;
  let agentSummary: string | undefined;
  const toolCtx: ToolContext = {
    workspace,
    runChecks: async (only) => formatReport(await gates(only ? { only } : {})),
    finish: async (summary) => {
      finishAttempts++;
      const report = await gates();
      if (report.passed) {
        agentSummary = summary;
        return { accepted: true, message: "finish accepted: all gates passed." };
      }
      const left = task.budget.maxFinishAttempts - finishAttempts;
      return { accepted: false, message: `finish REJECTED (${left} attempt(s) left).\n${formatReport(report)}` };
    },
  };

  const session = provider.createSession({ system: buildSystemPrompt(task), tools: toolSpecs() });
  const usage = { inputTokens: 0, outputTokens: 0 };
  let input: TurnInput = { kind: "user", text: buildTaskMessage(task) };
  let outcome: Outcome | undefined;
  let turn = 0;

  try {
    while (!outcome) {
      if (turn >= task.budget.maxTurns || usage.outputTokens >= task.budget.maxOutputTokens) {
        outcome = "budget_exhausted";
        break;
      }
      turn++;
      const result = await session.next(input);
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      await transcript.log({
        type: "assistant",
        turn,
        text: result.text,
        toolCalls: result.toolCalls.map((c) => ({ name: c.name, input: c.input })),
        stop: result.stop,
        usage: result.usage,
      });

      if (result.stop === "refusal") {
        outcome = "refused";
        break;
      }

      if (result.toolCalls.length === 0) {
        // The agent stopped talking without finishing. Push it back to work.
        const message =
          result.stop === "max_tokens"
            ? "Your last response hit the output limit. Continue with smaller steps (e.g. split large files)."
            : "The task is not complete until you call `finish` and it is accepted. Continue.";
        await transcript.log({ type: "harness", turn, message });
        input = { kind: "user", text: message };
        continue;
      }

      const results: ToolResult[] = [];
      let mutated = false;
      for (const call of result.toolCalls) {
        const out = await executeTool(call.name, call.input, toolCtx);
        mutated ||= out.mutated === true;
        if (out.finished) outcome = "passed";
        results.push({ id: call.id, content: out.content, isError: out.isError });
        await transcript.log({ type: "tool_result", turn, name: call.name, isError: out.isError, content: out.content });
      }
      if (!outcome && finishAttempts >= task.budget.maxFinishAttempts) outcome = "failed_gates";

      // In-loop governance: surface new static violations immediately, attached to the last result.
      if (mutated && !outcome) {
        const feedback = await staticFeedback(gates, workspace);
        const last = results.at(-1);
        if (feedback && last) {
          last.content += `\n\n[harness] ${feedback}`;
          await transcript.log({ type: "harness", turn, message: feedback });
        }
      }
      input = { kind: "tool_results", results };
    }
  } catch (err) {
    outcome = "error";
    await transcript.log({ type: "harness", turn, message: `run error: ${err instanceof Error ? err.stack ?? err.message : String(err)}` });
  }

  // The verdict is the harness's, not the agent's: always re-verify independently.
  let finalGates: GateReport;
  try {
    finalGates = await gates();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    finalGates = { passed: false, results: [], blocking: [{ gate: "harness", rule: "verification-error", severity: "error", message }] };
  }
  if (outcome === "passed" && !finalGates.passed) outcome = "failed_gates";
  await transcript.log({ type: "run_end", outcome: outcome ?? "error" });

  const report: RunReport = {
    task: task.id,
    kind: task.kind,
    provider: provider.id,
    model: provider.model,
    outcome: outcome ?? "error",
    turns: turn,
    finishAttempts,
    usage,
    durationMs: Date.now() - started,
    baselineViolations: baseline?.length ?? 0,
    filesTouched: [...workspace.touched].sort(),
    finalGates,
    ...(agentSummary ? { agentSummary } : {}),
    runDir,
  };
  await writeFile(path.join(runDir, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(path.join(runDir, "gates.txt"), formatReport(finalGates, { includeTolerated: true }));
  return report;
}

async function staticFeedback(
  gates: (opts: { staticOnly: boolean }) => Promise<GateReport>,
  workspace: Workspace,
): Promise<string | undefined> {
  const report = await gates({ staticOnly: true });
  const relevant = report.blocking.filter((v) => !v.file || workspace.touched.has(v.file));
  if (relevant.length === 0) return undefined;
  const lines = relevant.slice(0, 15).map((v) => `[${v.gate}/${v.rule}] ${v.file ?? ""}${v.line ? `:${v.line}` : ""} ${v.message}`);
  return `static gates found ${relevant.length} violation(s) to fix:\n${lines.join("\n")}`;
}

/** Re-installs only when package.json changed, and only after the dependency allow-list passes. */
class Installer {
  private lastHash: string | undefined;

  constructor(private readonly root: string) {}

  async ensure(ctx: GateContext): Promise<void> {
    let pkg: string;
    try {
      pkg = await readFile(path.join(this.root, "package.json"), "utf8");
    } catch {
      return;
    }
    const hash = createHash("sha256").update(pkg).digest("hex");
    if (hash === this.lastHash) return;

    const deps = await runGates(ctx, { only: ["dependencies"] });
    if (!deps.passed) return; // the dependency gate will report it; never install disallowed packages

    const res = await exec("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: this.root, timeoutMs: 300_000 });
    if (res.code !== 0) throw new Error(`npm install failed:\n${tail(res.stderr || res.stdout)}`);
    this.lastHash = hash;
  }
}
