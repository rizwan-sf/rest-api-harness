import { z } from "zod";

/**
 * The harness eats its own cooking: environment is a boundary, so it is
 * parsed with Zod exactly once and everything else reads the typed result.
 */
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-5-5"),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().min(1).default("gpt-5"),
  HARNESS_RUNS_DIR: z.string().min(1).default("runs"),
});

export type Env = z.infer<typeof EnvSchema>;

// Treat empty strings (common in copied .env files) as unset.
const raw = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""),
);

export const env: Env = EnvSchema.parse(raw);
