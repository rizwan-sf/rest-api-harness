import OpenAI from "openai";
import type { Provider, ProviderSession, StopReason, ToolSpec, TurnInput, TurnResult } from "./types.js";

export function createOpenAIProvider(opts: { apiKey: string; model: string }): Provider {
  const client = new OpenAI({ apiKey: opts.apiKey });
  return {
    id: "openai",
    model: opts.model,
    createSession: ({ system, tools }) => new OpenAISession(client, opts.model, system, tools),
  };
}

class OpenAISession implements ProviderSession {
  private readonly messages: OpenAI.Chat.ChatCompletionMessageParam[];
  private readonly tools: OpenAI.Chat.ChatCompletionTool[];

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    system: string,
    tools: ToolSpec[],
  ) {
    this.messages = [{ role: "system", content: system }];
    this.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: { type: "object", ...t.inputSchema } },
    }));
  }

  async next(input: TurnInput): Promise<TurnResult> {
    if (input.kind === "user") {
      this.messages.push({ role: "user", content: input.text });
    } else {
      for (const r of input.results) {
        // Chat Completions has no is_error flag; mark failures in-band.
        this.messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
      }
    }

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: this.messages,
      tools: this.tools,
      tool_choice: "auto",
    });

    const choice = completion.choices[0];
    if (!choice) throw new Error("OpenAI returned no choices");
    const msg = choice.message;
    this.messages.push(msg);

    const toolCalls: TurnResult["toolCalls"] = [];
    for (const call of msg.tool_calls ?? []) {
      if (call.type !== "function") continue;
      toolCalls.push({ id: call.id, name: call.function.name, input: safeJson(call.function.arguments) });
    }

    return {
      text: msg.content ?? "",
      toolCalls,
      stop: mapStop(choice.finish_reason, toolCalls.length > 0),
      usage: {
        inputTokens: completion.usage?.prompt_tokens ?? 0,
        outputTokens: completion.usage?.completion_tokens ?? 0,
      },
    };
  }
}

/** Unparseable arguments become a value the tool's Zod schema will reject with a clear error. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { __unparseable_arguments: text };
  }
}

function mapStop(reason: string, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || reason === "tool_calls") return "tool_use";
  if (reason === "stop") return "end_turn";
  if (reason === "length") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  return "other";
}
