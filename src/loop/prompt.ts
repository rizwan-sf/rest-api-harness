import { APP_ENTRY } from "../gates/contract-probe.js";
import { REQUIRED_COMPILER_FLAGS } from "../gates/type-safety.js";
import type { Task } from "../task/schema.js";

/**
 * The system prompt is identical across providers: same task definition,
 * same standards, same tools. Only the transport differs.
 */
export function buildSystemPrompt(task: Task): string {
  const mode =
    task.kind === "greenfield"
      ? "GREENFIELD: the workspace holds a minimal scaffold. Build the API from it."
      : task.policy.baseline === "ratchet"
        ? "BROWNFIELD (ratchet): the workspace is an existing codebase. Pre-existing violations are tolerated, but you must not introduce new ones. Fixing old violations in files you touch is encouraged. Keep existing behaviour working."
        : "BROWNFIELD (strict): the workspace is an existing codebase. Every gate must pass when you finish, including violations that pre-date you.";

  return `You are working inside a governed harness on a TypeScript REST API.

${mode}

# How this harness works
- You can only act through the provided tools. There is no shell.
- The harness installs dependencies, type-checks, runs tests and boots the app for you via \`run_checks\`.
- After every file change the harness runs fast static gates and appends any new violations to the tool result. Fix them before moving on.
- You are done only when \`finish\` is accepted. \`finish\` runs every gate; if any fails it is rejected and you must continue.
- Dependencies are allow-listed: ${task.policy.allowedDependencies.join(", ")}.
${task.policy.protectedPaths.length ? `- These paths are read-only: ${task.policy.protectedPaths.join(", ")}.\n` : ""}
# Contract the harness relies on
- \`${APP_ENTRY}\` exports \`createApp()\` returning an Express app (do not call listen() there). The harness boots it to probe HTTP behaviour.
- package.json has a \`test\` script (vitest) that exits 0.

# API standards (enforced, not advisory)
1. Zod at every boundary
   - Read req.body / req.query / req.params only through a Zod schema: \`const body = CreateUser.parse(req.body)\`.
   - Read process.env only through a Zod schema, once, in a config module.
   - Never use JSON.parse or external \`await res.json()\` results without parsing them with Zod.
   - A Zod failure on request input must become a 422 problem response.
2. RFC 7807 errors, nothing else
   - Every 4xx/5xx response is \`Content-Type: application/problem+json\` with at least \`type\` (URI), \`title\`, \`status\` (equal to the HTTP status); \`detail\` and \`instance\` (the request path) are expected.
   - Unknown routes → 404 problem. Malformed JSON → 400 problem. Validation → 422 problem. Unexpected errors → 500 problem without leaking stack traces.
   - Never use res.sendStatus(4xx/5xx) or res.status(4xx).json({ error }) — throw or forward a problem through one error middleware.
   Example:
     HTTP/1.1 422 Unprocessable Content
     Content-Type: application/problem+json
     {"type":"https://api.sf/problems/validation","title":"Request body failed validation","status":422,"detail":"email: Invalid email","instance":"/v1/users"}
3. Strict type safety
   - tsconfig keeps: ${REQUIRED_COMPILER_FLAGS.join(", ")} = true.
   - No \`any\`, no \`as unknown as\`, no non-null assertions (\`!\`), no @ts-ignore / @ts-expect-error / @ts-nocheck / eslint-disable.
   - Derive types from Zod schemas with z.infer instead of duplicating them.
4. REST conventions
   - Version every route under /v1. Plural, lowercase kebab-case nouns; params are :camelCase; no verbs, trailing slashes or extensions in paths.
   - GET 200, POST create 201 + Location header, PUT/PATCH 200, DELETE 204 with no body.
   - Collections that can grow are paginated (limit/cursor or limit/offset validated by Zod).

Work in small verified steps: read the relevant code, make a change, run checks, then finish.`;
}

export function buildTaskMessage(task: Task): string {
  return `# Task: ${task.title}\n\n${task.prompt.trim()}\n\nStart by listing the workspace files.`;
}
