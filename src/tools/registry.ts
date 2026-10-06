import { z } from "zod";
import { GATE_NAMES } from "../gates/index.js";
import type { ToolSpec } from "../providers/types.js";
import type { Workspace } from "./workspace.js";

export interface ToolContext {
  workspace: Workspace;
  runChecks(gates: readonly string[] | undefined): Promise<string>;
  finish(summary: string): Promise<{ accepted: boolean; message: string }>;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** The agent changed files; the loop runs fast static gates afterwards. */
  mutated?: boolean;
  /** The harness accepted `finish`; the loop ends. */
  finished?: boolean;
}

interface ToolDef<S extends z.ZodType> {
  name: string;
  description: string;
  input: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolOutcome>;
}

const tool = <S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> => def;
const ok = (content: string, extra: Partial<ToolOutcome> = {}): ToolOutcome => ({ content, isError: false, ...extra });

const RelPath = z.string().min(1).describe("Path relative to the workspace root, e.g. src/routes/users.ts");

/**
 * Deliberately small tool surface: no shell. Installs, compilation, tests and
 * HTTP probing are run *by the harness* through `run_checks` and `finish`.
 */
export const TOOLS = [
  tool({
    name: "list_files",
    description: "List files in the workspace (node_modules and dist are excluded).",
    input: z.object({ dir: z.string().optional().describe("Directory to list, defaults to the workspace root") }),
    async run({ dir }, { workspace }) {
      const files = await workspace.list(dir ?? ".");
      return ok(files.length ? files.join("\n") : "(no files)");
    },
  }),
  tool({
    name: "read_file",
    description: "Read a UTF-8 text file from the workspace.",
    input: z.object({ path: RelPath }),
    async run({ path }, { workspace }) {
      return ok(await workspace.read(path));
    },
  }),
  tool({
    name: "write_file",
    description: "Create or overwrite a file with the full given content.",
    input: z.object({ path: RelPath, content: z.string() }),
    async run({ path, content }, { workspace }) {
      await workspace.write(path, content);
      return ok(`wrote ${path} (${content.length} chars)`, { mutated: true });
    },
  }),
  tool({
    name: "edit_file",
    description: "Replace exactly one occurrence of old_text with new_text in a file. Fails if old_text is absent or ambiguous.",
    input: z.object({ path: RelPath, old_text: z.string().min(1), new_text: z.string() }),
    async run({ path, old_text, new_text }, { workspace }) {
      await workspace.replace(path, old_text, new_text);
      return ok(`edited ${path}`, { mutated: true });
    },
  }),
  tool({
    name: "delete_file",
    description: "Delete a file or directory from the workspace.",
    input: z.object({ path: RelPath }),
    async run({ path }, { workspace }) {
      await workspace.remove(path);
      return ok(`deleted ${path}`, { mutated: true });
    },
  }),
  tool({
    name: "run_checks",
    description:
      "Run the harness quality gates (installs dependencies if package.json changed, type-checks, runs tests, boots the app and probes it). " +
      `Optionally restrict to specific gates: ${GATE_NAMES.join(", ")}.`,
    input: z.object({ gates: z.array(z.enum(GATE_NAMES as [string, ...string[]])).optional() }),
    async run({ gates }, ctx) {
      return ok(await ctx.runChecks(gates));
    },
  }),
  tool({
    name: "finish",
    description:
      "Declare the task complete. The harness runs every gate; if any fails, finish is rejected with the violations and you must keep working.",
    input: z.object({ summary: z.string().min(1).describe("What you changed and why") }),
    async run({ summary }, ctx) {
      const { accepted, message } = await ctx.finish(summary);
      return { content: message, isError: !accepted, finished: accepted };
    },
  }),
] as const;

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input) as Record<string, unknown>;
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}

/** Validate untrusted model output with Zod, then execute. Errors become tool errors, never crashes. */
export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const def = TOOLS.find((t) => t.name === name);
  if (!def) return { content: `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}`, isError: true };

  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    return { content: `Invalid input for ${name}:\n${z.prettifyError(parsed.error)}`, isError: true };
  }
  try {
    // The union of tool definitions erases the per-tool input type; `parsed.data` was produced by this tool's own schema.
    return await (def.run as (input: unknown, ctx: ToolContext) => Promise<ToolOutcome>)(parsed.data, ctx);
  } catch (err) {
    return { content: err instanceof Error ? err.message : String(err), isError: true };
  }
}
