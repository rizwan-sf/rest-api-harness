import ts from "typescript";
import { dottedName, isInsideZodParse, isTestFile, lineOf, parseTsFiles, visit } from "./ast.js";
import type { Gate, Violation } from "./types.js";

const REQUEST_INPUTS = new Set(["body", "query", "params"]);
const REQUEST_NAMES = new Set(["req", "request"]);

/**
 * Standard: "Zod at every boundary".
 *
 * Untrusted data may only be read *through* a Zod parse call:
 *   - request body / query / params
 *   - process.env
 *   - JSON.parse(...) results
 *   - fetch-style `await res.json()` results
 */
export const zodBoundaryGate: Gate = {
  name: "zod-boundary",
  kind: "static",
  async run({ root }) {
    const files = (await parseTsFiles(root)).filter((f) => !isTestFile(f.rel));
    const violations: Violation[] = [];
    let importsZod = false;

    for (const { rel, sf } of files) {
      const flag = (rule: string, node: ts.Node, message: string): void => {
        violations.push({ gate: "zod-boundary", rule, severity: "error", file: rel, line: lineOf(sf, node), message });
      };

      visit(sf, (node) => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "zod") {
          importsZod = true;
        }

        if (ts.isPropertyAccessExpression(node)) {
          const name = dottedName(node);

          if (
            ts.isIdentifier(node.expression) &&
            REQUEST_NAMES.has(node.expression.text) &&
            REQUEST_INPUTS.has(node.name.text) &&
            !isAssignmentTarget(node) &&
            !isInsideZodParse(node)
          ) {
            flag(
              "request-unvalidated",
              node,
              `${name} is read without a Zod parse. Use \`Schema.parse(${name})\` (or safeParse) and work with the typed result.`,
            );
          }

          if (name === "process.env" && !isInsideZodParse(node)) {
            flag("env-unvalidated", node, "process.env must be read once through a Zod schema (e.g. EnvSchema.parse(process.env)).");
          }
        }

        if (ts.isCallExpression(node)) {
          const callee = dottedName(node.expression);
          if (callee === "JSON.parse" && !isInsideZodParse(node)) {
            flag("json-unvalidated", node, "JSON.parse result must be passed straight into a Zod schema.");
          }
          // `await res.json()` with no args is reading an external body (fetch); Express's res.json(x) always has args.
          if (
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "json" &&
            node.arguments.length === 0 &&
            !isInsideZodParse(node)
          ) {
            flag("external-json-unvalidated", node, "Response bodies from external calls must be validated with Zod.");
          }
        }
      });
    }

    if (files.length > 0 && !importsZod) {
      violations.push({
        gate: "zod-boundary",
        rule: "zod-missing",
        severity: "error",
        message: "No source file imports zod; request validation must use Zod schemas.",
      });
    }
    return violations;
  },
};

function isAssignmentTarget(node: ts.Node): boolean {
  const p = node.parent;
  return ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}
