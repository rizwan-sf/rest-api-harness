import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateObservations } from "../src/gates/contract-probe.js";
import { runGates } from "../src/gates/index.js";
import type { Violation } from "../src/gates/types.js";
import { TaskSchema, type Task } from "../src/task/schema.js";
import { SandboxViolation, Workspace } from "../src/tools/workspace.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(repoRoot, "fixtures/brownfield-users");

const task: Task = TaskSchema.parse({
  id: "test",
  title: "test",
  prompt: "-",
  kind: "brownfield",
  fixture: ".",
  acceptance: {},
});

const STRICT_TSCONFIG = JSON.stringify({
  compilerOptions: {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    noImplicitOverride: true,
    noFallthroughCasesInSwitch: true,
  },
});

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "harness-test-"));
  for (const [rel, content] of Object.entries({ "tsconfig.json": STRICT_TSCONFIG, ...files })) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), content);
  }
  return root;
}

const rules = (vs: readonly Violation[]): string[] => vs.map((v) => `${v.gate}/${v.rule}`);

const COMPLIANT_APP = `
import express, { type Express, type ErrorRequestHandler } from "express";
import { z } from "zod";

const CreateWidget = z.object({ name: z.string().min(1) });
const WidgetParams = z.object({ widgetId: z.string() });

export function createApp(): Express {
  const app = express();
  const router = express.Router();
  router.post("/", (req, res) => {
    const input = CreateWidget.parse(req.body);
    res.status(201).location("/v1/widgets/1").json({ data: { id: "1", ...input } });
  });
  router.get("/:widgetId", (req, res) => {
    const { widgetId } = WidgetParams.parse(req.params);
    res.json({ data: { id: widgetId } });
  });
  router.delete("/:widgetId", (_req, res) => {
    res.status(204).send();
  });
  app.use("/v1/widgets", router);
  const onError: ErrorRequestHandler = (err, req, res, _next) => {
    res.status(500).type("application/problem+json").json({ type: "about:blank", title: "Internal", status: 500, instance: req.originalUrl });
  };
  app.use(onError);
  return app;
}
`;

describe("static gates", () => {
  it("accept a compliant app", async () => {
    const root = await project({ "src/app.ts": COMPLIANT_APP });
    const report = await runGates({ root, task }, { staticOnly: true, only: ["zod-boundary", "problem-details", "type-safety", "rest-conventions"] });
    expect(report.blocking).toEqual([]);
  });

  it("flag the legacy debt in the brownfield fixture", async () => {
    const report = await runGates({ root: fixture, task }, { staticOnly: true });
    expect(rules(report.blocking)).toEqual(
      expect.arrayContaining([
        "zod-boundary/request-unvalidated",
        "problem-details/ad-hoc-error-response",
        "rest-conventions/verb-in-path",
        "rest-conventions/segment-casing",
        "rest-conventions/delete-status",
      ]),
    );
  });

  it("flag type-safety escape hatches and a weakened tsconfig", async () => {
    const root = await project({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: false } }),
      "src/bad.ts": [
        "export const a: any = 1;",
        "// @ts-ignore",
        "export const b = (1 as unknown as string);",
        "export const c = [1][0]!;",
      ].join("\n"),
    });
    const report = await runGates({ root, task }, { only: ["type-safety"] });
    expect(rules(report.blocking)).toEqual(
      expect.arrayContaining([
        "type-safety/tsconfig-weakened",
        "type-safety/explicit-any",
        "type-safety/type-suppression",
        "type-safety/double-assertion",
        "type-safety/non-null-assertion",
      ]),
    );
  });

  it("flag unvalidated env and JSON.parse", async () => {
    const root = await project({
      "src/config.ts": 'import { z } from "zod";\nexport const port = process.env.PORT;\nexport const data = JSON.parse("{}");\nexport const ok = z.object({}).parse(JSON.parse("{}"));',
    });
    const report = await runGates({ root, task }, { only: ["zod-boundary"] });
    expect(rules(report.blocking).sort()).toEqual(["zod-boundary/env-unvalidated", "zod-boundary/json-unvalidated"]);
  });
});

describe("ratchet baseline", () => {
  it("tolerates pre-existing violations but catches new copies", async () => {
    const before = await runGates({ root: fixture, task }, { staticOnly: true });
    const baseline = before.results.flatMap((r) => r.violations);

    const unchanged = await runGates({ root: fixture, task }, { staticOnly: true, baseline });
    expect(unchanged.blocking).toEqual([]);

    // Drop one baseline entry: the same violation now counts as newly introduced.
    const shrunk = baseline.slice(1);
    const regressed = await runGates({ root: fixture, task }, { staticOnly: true, baseline: shrunk });
    expect(regressed.blocking).toHaveLength(baseline[0]?.severity === "error" ? 1 : 0);
  });
});

describe("contract probe judging", () => {
  const probe = {
    name: "invalid user",
    request: { method: "POST" as const, path: "/v1/users", body: { email: "nope" } },
    expect: { status: 422, problem: true },
  };

  it("accepts the reference RFC 7807 response", () => {
    const violations = evaluateObservations(
      [probe],
      [
        {
          name: probe.name,
          status: 422,
          headers: { "content-type": "application/problem+json; charset=utf-8" },
          bodyText: JSON.stringify({
            type: "https://api.sf/problems/validation",
            title: "Request body failed validation",
            status: 422,
            detail: "email: Invalid email",
            instance: "/v1/users",
          }),
        },
      ],
    );
    expect(violations).toEqual([]);
  });

  it("rejects a plain JSON error body", () => {
    const violations = evaluateObservations(
      [probe],
      [{ name: probe.name, status: 422, headers: { "content-type": "application/json" }, bodyText: '{"error":"bad email"}' }],
    );
    expect(rules(violations)).toEqual(["contract-probe/not-rfc7807", "contract-probe/not-rfc7807"]);
  });

  it("rejects a problem whose status disagrees with HTTP", () => {
    const violations = evaluateObservations(
      [probe],
      [
        {
          name: probe.name,
          status: 422,
          headers: { "content-type": "application/problem+json" },
          bodyText: JSON.stringify({ type: "about:blank", title: "Bad", status: 400 }),
        },
      ],
    );
    expect(violations[0]?.message).toContain("must equal the HTTP status");
  });

  it("requires problem documents on unexpected error responses too", () => {
    const happy = { ...probe, expect: { status: 201 } };
    const violations = evaluateObservations(
      [happy],
      [{ name: probe.name, status: 500, headers: { "content-type": "text/html" }, bodyText: "<h1>oops</h1>" }],
    );
    expect(rules(violations)).toContain("contract-probe/status-mismatch");
    expect(rules(violations)).toContain("contract-probe/not-rfc7807");
  });
});

describe("workspace sandbox", () => {
  it("refuses path escapes and protected paths", async () => {
    const root = await project({ "test/locked.test.ts": "" });
    const ws = new Workspace(root, ["test/locked.test.ts"]);
    await expect(ws.write("../outside.ts", "x")).rejects.toBeInstanceOf(SandboxViolation);
    await expect(ws.write("test/locked.test.ts", "x")).rejects.toBeInstanceOf(SandboxViolation);
    await expect(ws.write("node_modules/evil/index.js", "x")).rejects.toBeInstanceOf(SandboxViolation);
    await ws.write("src/ok.ts", "export {};");
    expect(await ws.read("src/ok.ts")).toBe("export {};");
  });
});
