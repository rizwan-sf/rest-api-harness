import path from "node:path";
import ts from "typescript";
import { lineOf, parseTsFiles, visit } from "./ast.js";
import type { Gate, Violation } from "./types.js";

/** Compiler flags the workspace tsconfig must keep enabled. */
export const REQUIRED_COMPILER_FLAGS = [
  "strict",
  "noUncheckedIndexedAccess",
  "exactOptionalPropertyTypes",
  "noImplicitOverride",
  "noFallthroughCasesInSwitch",
] as const;

const SUPPRESSIONS = /@ts-(ignore|nocheck|expect-error)|eslint-disable/;

/**
 * Standard: "Strict type safety" (static half; `tsc --noEmit` is its own gate).
 */
export const typeSafetyGate: Gate = {
  name: "type-safety",
  kind: "static",
  async run({ root }) {
    const violations: Violation[] = [];
    const push = (v: Omit<Violation, "gate" | "severity">): void => {
      violations.push({ gate: "type-safety", severity: "error", ...v });
    };

    // 1. tsconfig strictness cannot be weakened.
    const configPath = path.join(root, "tsconfig.json");
    const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
    if (error || typeof config !== "object" || config === null) {
      push({ rule: "tsconfig-missing", file: "tsconfig.json", message: "tsconfig.json is missing or unreadable." });
    } else {
      const options = ts.parseJsonConfigFileContent(config, ts.sys, root).options;
      for (const flag of REQUIRED_COMPILER_FLAGS) {
        if (options[flag] !== true) {
          push({ rule: "tsconfig-weakened", file: "tsconfig.json", message: `compilerOptions.${flag} must be true.` });
        }
      }
    }

    // 2. Escape hatches in source (tests included — they are code too).
    for (const dir of ["src", "test"]) {
      for (const { rel, sf } of await parseTsFiles(root, dir)) {
        sf.text.split("\n").forEach((lineText, i) => {
          const m = SUPPRESSIONS.exec(lineText);
          if (m) push({ rule: "type-suppression", file: rel, line: i + 1, message: `Suppression comment "${m[0]}" is not allowed.` });
        });

        visit(sf, (node) => {
          if (node.kind === ts.SyntaxKind.AnyKeyword) {
            push({ rule: "explicit-any", file: rel, line: lineOf(sf, node), message: "`any` is banned; use `unknown` and narrow with Zod or type guards." });
          }
          if (ts.isAsExpression(node) && ts.isAsExpression(node.expression) && node.expression.type.kind === ts.SyntaxKind.UnknownKeyword) {
            push({ rule: "double-assertion", file: rel, line: lineOf(sf, node), message: "`as unknown as T` defeats the type checker; parse or narrow instead." });
          }
          if (ts.isNonNullExpression(node)) {
            push({ rule: "non-null-assertion", file: rel, line: lineOf(sf, node), message: "Non-null assertion `!` is banned; handle the undefined case explicitly." });
          }
        });
      }
    }
    return violations;
  },
};
