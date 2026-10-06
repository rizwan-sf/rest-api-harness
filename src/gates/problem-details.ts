import ts from "typescript";
import { isTestFile, lineOf, parseTsFiles, visit } from "./ast.js";
import { PROBLEM_CONTENT_TYPE } from "./problem-schema.js";
import type { Gate, Violation } from "./types.js";

/**
 * Standard: "RFC 7807 errors, nothing else" (static half).
 *
 * The dynamic half lives in the contract-probe gate, which inspects real
 * responses. Statically we require:
 *   - an Express error-handling middleware (4-arity function)
 *   - the problem+json media type to be emitted somewhere
 *   - no ad-hoc error responses: `res.status(4xx|5xx).json/send(...)` and
 *     `res.sendStatus(4xx|5xx)` must go through the problem helper instead
 */
export const problemDetailsGate: Gate = {
  name: "problem-details",
  kind: "static",
  async run({ root }) {
    const files = (await parseTsFiles(root)).filter((f) => !isTestFile(f.rel));
    const violations: Violation[] = [];
    let hasErrorHandler = false;
    let mentionsMediaType = false;

    for (const { rel, sf } of files) {
      if (sf.text.includes(PROBLEM_CONTENT_TYPE)) mentionsMediaType = true;

      visit(sf, (node) => {
        if (isErrorMiddleware(node)) hasErrorHandler = true;
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;

        const method = node.expression.name.text;
        const firstArg = node.arguments[0];
        const status = firstArg && ts.isNumericLiteral(firstArg) ? Number(firstArg.text) : undefined;
        if (status === undefined || status < 400) return;

        if (method === "sendStatus") {
          violations.push({
            gate: "problem-details",
            rule: "bare-error-status",
            severity: "error",
            file: rel,
            line: lineOf(sf, node),
            message: `res.sendStatus(${status}) sends a non-RFC 7807 body. Throw/return a problem document instead.`,
          });
        }

        if (method === "status" && !chainProducesProblem(node)) {
          violations.push({
            gate: "problem-details",
            rule: "ad-hoc-error-response",
            severity: "error",
            file: rel,
            line: lineOf(sf, node),
            message: `res.status(${status}) responds without application/problem+json. Route all errors through the problem-details helper / error middleware.`,
          });
        }
      });
    }

    if (files.length > 0 && !hasErrorHandler) {
      violations.push({
        gate: "problem-details",
        rule: "missing-error-middleware",
        severity: "error",
        message: "No Express error-handling middleware `(err, req, res, next)` found; unhandled errors will not be RFC 7807.",
      });
    }
    if (files.length > 0 && !mentionsMediaType) {
      violations.push({
        gate: "problem-details",
        rule: "missing-media-type",
        severity: "error",
        message: `Errors must be served as Content-Type: ${PROBLEM_CONTENT_TYPE}; the media type never appears in src/.`,
      });
    }
    return violations;
  },
};

function isErrorMiddleware(node: ts.Node): boolean {
  if (!(ts.isArrowFunction(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node))) return false;
  if (node.parameters.length !== 4) return false;
  const first = node.parameters[0]?.name;
  return first !== undefined && ts.isIdentifier(first) && /^(err|error|e)$/i.test(first.text.replace(/^_/, ""));
}

/**
 * Walk the method chain that starts at `res.status(n)` and accept it if any link
 * sets the problem media type or sends a value produced by a `*problem*` helper.
 */
function chainProducesProblem(statusCall: ts.CallExpression): boolean {
  let current: ts.Node = statusCall;
  while (ts.isPropertyAccessExpression(current.parent) && ts.isCallExpression(current.parent.parent)) {
    const call = current.parent.parent;
    const text = call.getText();
    if (text.includes(PROBLEM_CONTENT_TYPE)) return true;
    const sent = call.arguments[0];
    if (sent && /problem/i.test(sent.getText())) return true;
    current = call;
  }
  return false;
}
