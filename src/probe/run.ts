/**
 * Child-process entry point (run with tsx inside the workspace).
 *
 * Imports the agent's `createApp()`, serves it on an ephemeral port, fires the
 * probes and prints raw observations. Judging happens in the parent process so
 * that a misbehaving app can never influence its own verdict.
 */
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { PROBE_MARKER, ProbeInputSchema, type Observation, type ProbeOutput } from "./protocol.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

function emit(out: ProbeOutput): void {
  process.stdout.write(`\n${PROBE_MARKER}${JSON.stringify(out)}\n`);
}

async function main(): Promise<void> {
  const input = ProbeInputSchema.parse(JSON.parse(await readStdin()));
  const mod: unknown = await import(pathToFileURL(input.appModule).href);
  const createApp = typeof mod === "object" && mod !== null && "createApp" in mod ? mod.createApp : undefined;
  if (typeof createApp !== "function") {
    emit({ ok: false, error: `${input.appModule} must export a createApp() function` });
    return;
  }

  const app: unknown = await createApp();
  if (typeof app !== "function") {
    emit({ ok: false, error: "createApp() must return a request listener (an Express app)" });
    return;
  }

  const server = createServer(app as RequestListener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const observations: Observation[] = [];
  try {
    for (const probe of input.probes) {
      const { method, path, headers, body, rawBody } = probe.request;
      const payload = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { ...(payload !== undefined ? { "content-type": "application/json" } : {}), ...headers },
        ...(payload !== undefined ? { body: payload } : {}),
        redirect: "manual",
      });
      observations.push({
        name: probe.name,
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        bodyText: await res.text(),
      });
    }
  } finally {
    server.close();
  }
  emit({ ok: true, observations });
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    emit({ ok: false, error: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
    process.exit(0);
  },
);
