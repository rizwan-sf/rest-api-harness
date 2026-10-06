#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { env } from "./config/env.js";
import { formatReport, runGates } from "./gates/index.js";
import { runTask, type RunReport } from "./loop/runner.js";
import { createProvider } from "./providers/index.js";
import { PROVIDER_IDS } from "./providers/types.js";
import { loadTask } from "./task/load.js";
import { TaskSchema } from "./task/schema.js";

const USAGE = `ts-rest-harness — governs TypeScript REST API work by AI agents

Usage:
  harness run <task.yaml> --provider <anthropic|openai> [--model <id>]
  harness compare <task.yaml> [--providers anthropic,openai]
  harness check <dir> [--task <task.yaml>] [--static]

Examples:
  harness run tasks/greenfield-todos.yaml --provider anthropic
  harness compare tasks/brownfield-users.yaml
  harness check fixtures/brownfield-users --static`;

const ProviderList = z
  .string()
  .transform((s) => s.split(",").map((p) => p.trim()))
  .pipe(z.array(z.enum(PROVIDER_IDS)).min(1));

const ArgsSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("run"), target: z.string(), provider: z.enum(PROVIDER_IDS), model: z.string().optional() }),
  z.object({ command: z.literal("compare"), target: z.string(), providers: ProviderList.default(["anthropic", "openai"]) }),
  z.object({ command: z.literal("check"), target: z.string(), task: z.string().optional(), static: z.boolean().default(false) }),
]);

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      providers: { type: "string" },
      model: { type: "string" },
      task: { type: "string" },
      static: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, target] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return 0;
  }

  const parsed = ArgsSchema.safeParse({ command, target, ...values });
  if (!parsed.success) {
    console.error(`${z.prettifyError(parsed.error)}\n\n${USAGE}`);
    return 2;
  }
  const args = parsed.data;

  switch (args.command) {
    case "run": {
      const report = await runTask(await loadTask(args.target), createProvider(args.provider, args.model), env.HARNESS_RUNS_DIR);
      printRun(report);
      return report.outcome === "passed" ? 0 : 1;
    }
    case "compare": {
      const loaded = await loadTask(args.target);
      const reports: RunReport[] = [];
      // Sequential on purpose: identical machine conditions for each provider.
      for (const id of args.providers) {
        const report = await runTask(loaded, createProvider(id), env.HARNESS_RUNS_DIR);
        printRun(report);
        reports.push(report);
      }
      const file = await writeComparison(loaded.task.id, reports);
      console.log(`\nComparison written to ${file}`);
      return reports.every((r) => r.outcome === "passed") ? 0 : 1;
    }
    case "check": {
      const task = args.task
        ? (await loadTask(args.task)).task
        : TaskSchema.parse({ id: "adhoc-check", title: "Ad-hoc check", prompt: "-", kind: "brownfield", fixture: ".", acceptance: {} });
      const report = await runGates(
        { root: path.resolve(args.target), task },
        args.static ? { staticOnly: true } : {},
      );
      console.log(formatReport(report));
      return report.passed ? 0 : 1;
    }
  }
}

function printRun(r: RunReport): void {
  console.log(
    [
      `\n=== ${r.task} on ${r.provider} (${r.model}) ===`,
      `outcome:   ${r.outcome}`,
      `turns:     ${r.turns}   finish attempts: ${r.finishAttempts}`,
      `tokens:    in ${r.usage.inputTokens}  out ${r.usage.outputTokens}`,
      `duration:  ${(r.durationMs / 1000).toFixed(1)}s`,
      `run dir:   ${r.runDir}`,
      formatReport(r.finalGates),
    ].join("\n"),
  );
}

async function writeComparison(taskId: string, reports: RunReport[]): Promise<string> {
  const gateNames = reports[0]?.finalGates.results.map((g) => g.gate) ?? [];
  const header = `| metric | ${reports.map((r) => `${r.provider} (${r.model})`).join(" | ")} |`;
  const sep = `|---|${reports.map(() => "---").join("|")}|`;
  const row = (label: string, f: (r: RunReport) => string): string => `| ${label} | ${reports.map(f).join(" | ")} |`;
  const md = [
    `# ${taskId}: provider comparison`,
    "",
    header,
    sep,
    row("outcome", (r) => r.outcome),
    row("turns", (r) => String(r.turns)),
    row("finish attempts", (r) => String(r.finishAttempts)),
    row("output tokens", (r) => String(r.usage.outputTokens)),
    row("duration (s)", (r) => (r.durationMs / 1000).toFixed(1)),
    row("files touched", (r) => String(r.filesTouched.length)),
    ...gateNames.map((g) =>
      row(`gate: ${g}`, (r) => {
        const res = r.finalGates.results.find((x) => x.gate === g);
        return res?.skipped ? "skipped" : res?.passed ? "pass" : "FAIL";
      }),
    ),
    "",
  ].join("\n");
  await mkdir(env.HARNESS_RUNS_DIR, { recursive: true });
  const file = path.join(env.HARNESS_RUNS_DIR, `compare-${taskId}-${Date.now()}.md`);
  await writeFile(file, md);
  return file;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
