import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderSession, StopReason, ToolSpec, TurnInput, TurnResult } from "./types.js";

export function createAnthropicProvider(opts: { apiKey: string; model: string }): Provider {
  const client = new Anthropic({ apiKey: opts.apiKey });
  return {
    id: "anthropic",
    model: opts.model,
    createSession: ({ system, tools }) => new AnthropicSession(client, opts.model, system, tools),
  };
}

class AnthropicSession implements ProviderSession {
  private readonly messages: Anthropic.Beta.BetaMessageParam[] = [];
  private readonly tools: Anthropic.Beta.BetaTool[];

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
    private readonly system: string,
    tools: ToolSpec[],
  ) {
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: "object", ...t.inputSchema },
    }));
  }

  async next(input: TurnInput): Promise<TurnResult> {
    this.messages.push(
      input.kind === "user"
        ? { role: "user", content: input.text }
        : {
            role: "user",
            content: input.results.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.id,
              content: r.content,
              is_error: r.isError,
            })),
          },
    );

    // Streaming avoids HTTP timeouts on long agentic turns.
    const stream = this.client.beta.messages.stream({
      model: this.model,
      max_tokens: 64_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      // Server-side refusal fallback: a declined turn is re-run on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: this.system,
      tools: this.tools,
      messages: this.messages,
    });
    const response = await stream.finalMessage();

    // Append the full content verbatim (thinking + fallback blocks included):
    // the transcript must stay append-only for preserved thinking to hold.
    this.messages.push({ role: "assistant", content: response.content });

    let text = "";
    const toolCalls: TurnResult["toolCalls"] = [];
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
    }

    return {
      text,
      // Never run tools from a refused or truncated turn.
      toolCalls: response.stop_reason === "tool_use" ? toolCalls : [],
      stop: mapStop(response.stop_reason),
      usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens },
    };
  }
}

function mapStop(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
    case "end_turn":
    case "max_tokens":
    case "refusal":
      return reason;
    default:
      return "other";
  }
}
