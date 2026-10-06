/**
 * Provider-neutral contract. The harness loop only ever talks to these types,
 * which is what lets one task definition run unchanged on any provider.
 *
 * Each session keeps its own provider-native, append-only transcript so that
 * provider-specific blocks (thinking, fallbacks, reasoning items) round-trip
 * untouched.
 */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the tool input (generated from the tool's Zod schema). */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw, unvalidated model output. The harness validates it with Zod. */
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export type StopReason = "tool_use" | "end_turn" | "max_tokens" | "refusal" | "other";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface TurnResult {
  text: string;
  toolCalls: ToolCall[];
  stop: StopReason;
  usage: Usage;
}

export type TurnInput =
  | { kind: "user"; text: string }
  | { kind: "tool_results"; results: ToolResult[] };

export interface ProviderSession {
  next(input: TurnInput): Promise<TurnResult>;
}

export interface Provider {
  readonly id: ProviderId;
  readonly model: string;
  createSession(opts: { system: string; tools: ToolSpec[] }): ProviderSession;
}

export const PROVIDER_IDS = ["anthropic", "openai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];
