import { z } from "zod";

const HttpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/** A single HTTP request the harness fires at the agent's app after the run. */
export const ProbeSchema = z.object({
  name: z.string().min(1),
  request: z.object({
    method: HttpMethod,
    path: z.string().startsWith("/"),
    headers: z.record(z.string(), z.string()).optional(),
    /** JSON body. Use `rawBody` to send deliberately malformed payloads. */
    body: z.unknown().optional(),
    rawBody: z.string().optional(),
  }),
  expect: z.object({
    status: z.number().int().min(100).max(599),
    /** Response must be a valid RFC 7807 problem document. Implied for status >= 400. */
    problem: z.boolean().optional(),
    /** Dotted paths that must exist in the JSON body, e.g. ["data.id"]. */
    bodyHas: z.array(z.string()).optional(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
});
export type Probe = z.infer<typeof ProbeSchema>;

const BudgetSchema = z.object({
  maxTurns: z.number().int().positive().default(40),
  maxOutputTokens: z.number().int().positive().default(400_000),
  /** How many times `finish` may be rejected by gates before the run is failed. */
  maxFinishAttempts: z.number().int().positive().default(5),
});

const DEFAULT_ALLOWED_DEPENDENCIES = [
  "express",
  "zod",
  "@types/express",
  "@types/node",
  "typescript",
  "tsx",
  "vitest",
  "supertest",
  "@types/supertest",
];

const PolicySchema = z.object({
  /**
   * strict  – every gate violation fails the run.
   * ratchet – brownfield mode: violations that existed before the agent
   *           started are tolerated, but no new ones may be introduced.
   */
  baseline: z.enum(["strict", "ratchet"]).default("strict"),
  /** Packages the agent may depend on. Anything else fails the dependency gate. */
  allowedDependencies: z.array(z.string()).default(DEFAULT_ALLOWED_DEPENDENCIES),
  /** Paths (relative to the workspace) the agent may not modify. */
  protectedPaths: z.array(z.string()).default([]),
});

const TaskBase = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  prompt: z.string().min(1),
  budget: BudgetSchema.default({ maxTurns: 40, maxOutputTokens: 400_000, maxFinishAttempts: 5 }),
  policy: PolicySchema.default({
    baseline: "strict",
    allowedDependencies: DEFAULT_ALLOWED_DEPENDENCIES,
    protectedPaths: [],
  }),
  acceptance: z.object({
    probes: z.array(ProbeSchema).default([]),
    /** Run the workspace's own `npm test` as a gate. */
    requireTests: z.boolean().default(true),
  }),
});

export const TaskSchema = z.discriminatedUnion("kind", [
  TaskBase.extend({
    kind: z.literal("greenfield"),
    /** Scaffold directory copied into the workspace, relative to the task file. */
    template: z.string().default("../templates/greenfield"),
  }),
  TaskBase.extend({
    kind: z.literal("brownfield"),
    /** Existing codebase copied into the workspace, relative to the task file. */
    fixture: z.string(),
  }),
]);

export type Task = z.infer<typeof TaskSchema>;
