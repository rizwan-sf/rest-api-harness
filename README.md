# rest-api-harness

An **agent harness** — not an agent — whose only job is to govern TypeScript REST API work.

The harness owns the loop, the tools, the sandbox and the verdict. A model provider only supplies the next turn.
The same task definition runs unchanged on **Anthropic** and **OpenAI**, for both **greenfield** (new API) and
**brownfield** (existing codebase) work.

```
            task.yaml (Zod-validated)
                    │
        ┌───────────▼────────────┐
        │        Runner          │  budget · turn loop · finish gate · final verdict
        │  ┌──────────────────┐  │
        │  │ ProviderSession  │◄─┼── anthropic | openai   (same prompt, same tools)
        │  └────────┬─────────┘  │
        │   tool calls (Zod-validated input)
        │  ┌────────▼─────────┐  │
        │  │ Sandboxed tools  │  │  list/read/write/edit/delete · run_checks · finish   (no shell)
        │  └────────┬─────────┘  │
        │  ┌────────▼─────────┐  │
        │  │      Gates       │  │  static after every edit · all gates on finish + final verdict
        │  └──────────────────┘  │
        └───────────┬────────────┘
                    ▼
        runs/<ts>-<task>-<provider>/  workspace/ · transcript.jsonl · report.json · gates.txt
```

## API standards and how each is enforced

| Standard | Static gate (AST, after every edit) | Dynamic gate (on `finish` and final verdict) |
|---|---|---|
| **Zod at every boundary** | `zod-boundary`: `req.body/query/params`, `process.env`, `JSON.parse(...)` and external `await res.json()` may only be read *inside* a `Schema.parse/safeParse(...)` call | `contract-probe`: invalid input must produce a 422 problem |
| **RFC 7807 errors, nothing else** | `problem-details`: needs a `(err, req, res, next)` middleware and the `application/problem+json` media type; bans `res.sendStatus(4xx/5xx)` and `res.status(4xx).json({...})` that bypass the problem helper | `contract-probe`: **every** observed 4xx/5xx must be `application/problem+json` with `type`, `title`, `status` (= HTTP status); the harness adds its own 404 and malformed-JSON probes |
| **Strict type safety** | `type-safety`: tsconfig must keep `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`; bans `any`, `as unknown as`, `!`, `@ts-ignore/@ts-expect-error/@ts-nocheck`, `eslint-disable` | `typecheck`: `tsc --noEmit` must be clean |
| **REST conventions** | `rest-conventions`: `/v1` versioning, plural kebab-case nouns, `:camelCase` params, no verbs / trailing slashes / extensions, POST→201 (+Location), DELETE→204 | `contract-probe`: task probes assert statuses, headers and body shape |
| Governance | `dependencies`: allow-listed packages only (checked **before** `npm install`) | `tests`: the workspace's own `npm test` must pass |

The reference passing error response:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{"type":"https://api.sf/problems/validation","title":"Request body failed validation","status":422,"detail":"email: Invalid email","instance":"/v1/users"}
```

## Greenfield vs brownfield

| | Greenfield | Brownfield |
|---|---|---|
| Workspace seeded from | `templates/greenfield` (strict tsconfig, empty `createApp()`) | an existing codebase (`fixtures/…`) |
| Baseline policy | `strict` — everything must pass | `ratchet` — violations present *before* the agent started are recorded and tolerated; any **new** one blocks. Identity is `gate+rule+file+message` (line-independent) and counted, so a second copy of an old violation is still caught. `strict` is also available. |
| Extra guardrails | — | `protectedPaths` (e.g. existing tests are read-only) |

## How the loop governs the agent

1. Task YAML is parsed with Zod; workspace is copied into `runs/…/workspace`.
2. Brownfield ratchet: all gates run once to capture the baseline.
3. Each turn, tool inputs are validated with Zod before execution. Paths are confined to the workspace;
   `node_modules`, `.git`, lockfiles and `protectedPaths` are never writable. There is **no shell tool** —
   installs, compilation, tests and HTTP probing are executed by the harness.
4. After any file change, the static gates run and new violations are appended to the tool result.
5. `finish` runs every gate. If any fails it is **rejected** with the violations (up to `maxFinishAttempts`).
6. Budgets: `maxTurns`, `maxOutputTokens`. Refusals end the run.
7. The verdict is re-computed independently after the loop — the agent's own claim is never trusted.

## Contract a workspace must follow

- `src/app.ts` exports `createApp()` returning an Express app (no `listen()`); the harness boots it on an
  ephemeral port in a child process to run probes.
- `package.json` has a `test` script.

## Usage

Requires Node ≥ 20.11.

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY and/or OPENAI_API_KEY
```

```bash
# one task, one provider
npx tsx src/cli.ts run tasks/greenfield-todos.yaml --provider anthropic

# same task on both providers + markdown comparison table
npx tsx src/cli.ts compare tasks/brownfield-users.yaml --providers anthropic,openai

# run the gates against any directory (no model involved) — useful in CI
npx tsx src/cli.ts check fixtures/brownfield-users --static
```

Defaults: Anthropic `claude-opus-5-5` (adaptive thinking, effort `high`, server-side refusal fallback enabled),
OpenAI `gpt-5`. Override with `ANTHROPIC_MODEL` / `OPENAI_MODEL` or `--model`.

## Writing a task

```yaml
id: brownfield-users
kind: brownfield            # or greenfield (+ template)
fixture: ../fixtures/brownfield-users
title: Paginate users and add partial updates
prompt: |
  ...
policy:
  baseline: ratchet         # strict | ratchet
  protectedPaths: [test/users.test.ts]
  allowedDependencies: [express, zod, ...]
budget: { maxTurns: 50, maxOutputTokens: 300000, maxFinishAttempts: 5 }
acceptance:
  requireTests: true
  probes:
    - name: patch user with invalid email
      request: { method: PATCH, path: /v1/users/1, body: { email: "nope" } }
      expect: { status: 422, problem: true }
```

See `src/task/schema.ts` for the full schema.

## Repository layout

```
src/
  cli.ts                 run | compare | check
  config/env.ts          Zod-validated environment
  task/                  task schema + loader
  providers/             provider-neutral session contract, Anthropic + OpenAI adapters
  tools/                 sandboxed workspace + Zod-validated tool registry
  gates/                 zod-boundary, problem-details, type-safety, rest-conventions,
                         dependencies, typecheck, tests, contract-probe; baseline ratchet
  probe/                 child-process HTTP prober (observes; the parent judges)
  loop/                  system prompt + runner
  report/                JSONL transcript
templates/greenfield/    scaffold for new APIs
fixtures/brownfield-users/  existing API with deliberate legacy debt
tasks/                   example task definitions
test/                    harness tests (gates, ratchet, probe judging, sandbox)
```

## Development

```bash
npm run typecheck
npm test
```
