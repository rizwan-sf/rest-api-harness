import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { exec, tail } from "./exec.js";
import type { Gate, Violation } from "./types.js";

const PackageJsonSchema = z.object({
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

export async function readPackageJson(root: string): Promise<z.infer<typeof PackageJsonSchema> | undefined> {
  try {
    return PackageJsonSchema.parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")));
  } catch {
    return undefined;
  }
}

/** Governance: the agent may only depend on allow-listed packages. Runs before any install. */
export const dependencyGate: Gate = {
  name: "dependencies",
  kind: "static",
  async run({ root, task }) {
    const pkg = await readPackageJson(root);
    if (!pkg) {
      return [{ gate: "dependencies", rule: "package-json-invalid", severity: "error", file: "package.json", message: "package.json is missing or invalid." }];
    }
    const allowed = new Set(task.policy.allowedDependencies);
    const declared = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    return declared
      .filter((d) => !allowed.has(d))
      .map<Violation>((d) => ({
        gate: "dependencies",
        rule: "dependency-not-allowed",
        severity: "error",
        file: "package.json",
        message: `Dependency "${d}" is not on the task's allow-list (${[...allowed].join(", ")}).`,
      }));
  },
};

const TSC_LINE = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/;

/** Standard: "Strict type safety" — the code must actually compile under the strict tsconfig. */
export const typecheckGate: Gate = {
  name: "typecheck",
  kind: "dynamic",
  async run({ root }) {
    const res = await exec("npx", ["--no-install", "tsc", "--noEmit", "-p", "tsconfig.json"], { cwd: root, timeoutMs: 180_000 });
    if (res.code === 0) return [];
    const violations: Violation[] = [];
    for (const line of res.stdout.split("\n")) {
      const m = TSC_LINE.exec(line.trim());
      if (m) {
        const [, file, lineNo, code, message] = m;
        violations.push({ gate: "typecheck", rule: code ?? "TS", severity: "error", file: file ?? "", line: Number(lineNo), message: message ?? "" });
      }
    }
    if (violations.length === 0) {
      violations.push({ gate: "typecheck", rule: "tsc-failed", severity: "error", message: tail(res.stdout + res.stderr) });
    }
    return violations;
  },
};

/** The workspace's own test suite must exist and pass. */
export const testsGate: Gate = {
  name: "tests",
  kind: "dynamic",
  async run({ root, task }) {
    if (!task.acceptance.requireTests) return [];
    const pkg = await readPackageJson(root);
    if (!pkg?.scripts?.["test"]) {
      return [{ gate: "tests", rule: "no-test-script", severity: "error", file: "package.json", message: 'package.json must define a "test" script.' }];
    }
    const res = await exec("npm", ["test", "--silent"], { cwd: root, timeoutMs: 300_000 });
    if (res.code === 0) return [];
    return [
      {
        gate: "tests",
        rule: res.timedOut ? "tests-timeout" : "tests-failed",
        severity: "error",
        message: tail(res.stdout + "\n" + res.stderr, 60),
      },
    ];
  },
};
