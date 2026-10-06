import { appendFile } from "node:fs/promises";

export type TranscriptEvent =
  | { type: "run_start"; task: string; provider: string; model: string }
  | { type: "baseline"; violations: number }
  | { type: "assistant"; turn: number; text: string; toolCalls: { name: string; input: unknown }[]; stop: string; usage: { inputTokens: number; outputTokens: number } }
  | { type: "tool_result"; turn: number; name: string; isError: boolean; content: string }
  | { type: "harness"; turn: number; message: string }
  | { type: "run_end"; outcome: string };

/** Append-only JSONL log of everything the agent saw and did. */
export class Transcript {
  constructor(private readonly file: string) {}

  async log(event: TranscriptEvent): Promise<void> {
    await appendFile(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
  }
}
