import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PROBE_MARKER, ProbeOutputSchema, type Observation } from "../probe/protocol.js";
import type { Probe } from "../task/schema.js";
import { exec, tail } from "./exec.js";
import { PROBLEM_CONTENT_TYPE, ProblemDocumentSchema } from "./problem-schema.js";
import type { Gate, Violation } from "./types.js";

const here = fileURLToPath(import.meta.url);
const harnessRoot = path.resolve(path.dirname(here), "../..");
const probeScript = path.join(path.dirname(here), "..", "probe", here.endsWith(".ts") ? "run.ts" : "run.js");
const tsxBin = path.join(harnessRoot, "node_modules", ".bin", "tsx");

/** Convention every workspace must follow so the harness can boot the API. */
export const APP_ENTRY = "src/app.ts";

/** Probes the harness always adds, independent of the task. */
export function builtInProbes(taskProbes: readonly Probe[]): Probe[] {
  const probes: Probe[] = [
    {
      name: "[harness] unknown route is a 404 problem",
      request: { method: "GET", path: "/v1/__harness__/does-not-exist" },
      expect: { status: 404, problem: true },
    },
  ];
  const post = taskProbes.find((p) => p.request.method === "POST" || p.request.method === "PATCH" || p.request.method === "PUT");
  if (post) {
    probes.push({
      name: `[harness] malformed JSON to ${post.request.method} ${post.request.path} is a 400 problem`,
      request: { method: post.request.method, path: post.request.path, rawBody: '{"unterminated": ' },
      expect: { status: 400, problem: true },
    });
  }
  return probes;
}

/** Standard: "RFC 7807 errors, nothing else" + task acceptance, checked against real HTTP responses. */
export const contractProbeGate: Gate = {
  name: "contract-probe",
  kind: "dynamic",
  async run({ root, task }) {
    const fail = (rule: string, message: string): Violation[] => [{ gate: "contract-probe", rule, severity: "error", message }];

    try {
      await access(path.join(root, APP_ENTRY));
    } catch {
      return fail("missing-app-entry", `${APP_ENTRY} must exist and export createApp(): Express.`);
    }

    const probes = [...builtInProbes(task.acceptance.probes), ...task.acceptance.probes];
    const res = await exec(tsxBin, [probeScript], {
      cwd: root,
      timeoutMs: 60_000,
      input: JSON.stringify({ appModule: path.join(root, APP_ENTRY), probes }),
    });

    const line = res.stdout.split("\n").find((l) => l.startsWith(PROBE_MARKER));
    if (!line) return fail("probe-crashed", `The app could not be booted for probing:\n${tail(res.stdout + "\n" + res.stderr)}`);

    const output = ProbeOutputSchema.parse(JSON.parse(line.slice(PROBE_MARKER.length)));
    if (!output.ok) return fail("probe-crashed", output.error);

    return evaluateObservations(probes, output.observations);
  },
};

/** Pure judging logic — unit tested without booting anything. */
export function evaluateObservations(probes: readonly Probe[], observations: readonly Observation[]): Violation[] {
  const violations: Violation[] = [];
  probes.forEach((probe, i) => {
    const obs = observations[i];
    const label = `${probe.name} (${probe.request.method} ${probe.request.path})`;
    const push = (rule: string, message: string): void => {
      violations.push({ gate: "contract-probe", rule, severity: "error", message: `${label}: ${message}` });
    };
    if (!obs) {
      push("no-observation", "probe did not run");
      return;
    }

    if (obs.status !== probe.expect.status) {
      push("status-mismatch", `expected HTTP ${probe.expect.status}, got ${obs.status}. Body: ${obs.bodyText.slice(0, 300)}`);
    }

    // Every error response must be a problem document — not only the ones the task asked about.
    if (obs.status >= 400 || probe.expect.problem === true) {
      for (const problem of problemDocumentIssues(obs)) push("not-rfc7807", problem);
    }

    for (const [name, expected] of Object.entries(probe.expect.headers ?? {})) {
      const actual = obs.headers[name.toLowerCase()];
      if (actual === undefined || !actual.includes(expected)) {
        push("header-mismatch", `expected header ${name} to contain "${expected}", got "${actual ?? "<absent>"}"`);
      }
    }

    if (probe.expect.bodyHas?.length) {
      const body = safeJson(obs.bodyText);
      for (const dotted of probe.expect.bodyHas) {
        if (getPath(body, dotted) === undefined) push("body-missing-field", `response body has no "${dotted}"`);
      }
    }
  });
  return violations;
}

export function problemDocumentIssues(obs: Observation): string[] {
  const issues: string[] = [];
  const contentType = obs.headers["content-type"] ?? "";
  if (!contentType.startsWith(PROBLEM_CONTENT_TYPE)) {
    issues.push(`Content-Type must be application/problem+json, got "${contentType || "<absent>"}"`);
  }
  const parsed = ProblemDocumentSchema.safeParse(safeJson(obs.bodyText));
  if (!parsed.success) {
    issues.push(`body is not an RFC 7807 problem document: ${z.prettifyError(parsed.error).replace(/\n/g, "; ")}`);
  } else if (parsed.data.status !== obs.status) {
    issues.push(`problem "status" (${parsed.data.status}) must equal the HTTP status (${obs.status})`);
  }
  return issues;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function getPath(value: unknown, dotted: string): unknown {
  let current: unknown = value;
  for (const key of dotted.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
