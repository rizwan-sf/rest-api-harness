import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a command without a shell. Output is capped so a runaway process cannot flood the transcript. */
export function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv },
): Promise<ExecResult> {
  const cap = 200_000;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env, CI: "1" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs ?? 120_000);

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < cap) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < cap) stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

export function tail(text: string, lines = 40): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}
