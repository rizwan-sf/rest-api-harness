import ts from "typescript";
import { isTestFile, lineOf, parseTsFiles, stringLiteralValue, visit } from "./ast.js";
import type { Gate, Violation } from "./types.js";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const ROUTER_NAME = /^(app|router|\w+Router|\w+Routes)$/;
const VERB_SEGMENT = /^(get|create|update|delete|remove|add|fetch|list|set|make|do)([A-Z_-]|$)/i;
const KEBAB_SEGMENT = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PARAM_SEGMENT = /^:[a-z][a-zA-Z0-9]*$/;
const VERSION_PREFIX = /^\/v\d+(\/|$)/;

interface Route {
  method: string;
  path: string;
  handlerText: string;
  file: string;
  line: number;
}

/**
 * Standard: "REST conventions".
 *   - every API path is versioned (/v1/...), via a route or a router mount
 *   - path segments are lowercase kebab-case nouns; params are :camelCase
 *   - no verbs in paths, no trailing slashes, no file extensions
 *   - POST that creates answers 201 + Location; DELETE answers 204
 */
export const restConventionsGate: Gate = {
  name: "rest-conventions",
  kind: "static",
  async run({ root }) {
    const violations: Violation[] = [];
    const routes: Route[] = [];
    const mounts: string[] = [];

    for (const { rel, sf } of (await parseTsFiles(root)).filter((f) => !isTestFile(f.rel))) {
      visit(sf, (node) => {
        if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
        const target = node.expression.expression;
        if (!ts.isIdentifier(target) || !ROUTER_NAME.test(target.text)) return;
        const method = node.expression.name.text;
        const routePath = stringLiteralValue(node.arguments[0]);
        if (routePath === undefined) return;

        if (method === "use") {
          mounts.push(routePath);
          checkPath(routePath, rel, lineOf(sf, node), violations);
        } else if (HTTP_METHODS.has(method)) {
          const handlers = node.arguments.slice(1).map((a) => a.getText(sf)).join("\n");
          routes.push({ method, path: routePath, handlerText: handlers, file: rel, line: lineOf(sf, node) });
          checkPath(routePath, rel, lineOf(sf, node), violations);
        }
      });
    }

    const versioned = [...mounts, ...routes.map((r) => r.path)].some((p) => VERSION_PREFIX.test(p));
    if (routes.length > 0 && !versioned) {
      violations.push({
        gate: "rest-conventions",
        rule: "unversioned-api",
        severity: "error",
        message: "No route or router mount carries a version prefix like /v1.",
      });
    }

    for (const r of routes) {
      const at = { gate: "rest-conventions", file: r.file, line: r.line } as const;
      if (r.method === "post" && /\.status\(\s*200\s*\)/.test(r.handlerText)) {
        violations.push({ ...at, rule: "post-status", severity: "error", message: `POST ${r.path} responds 200; resource creation must respond 201 (or 202 for async work).` });
      }
      if (r.method === "post" && /\.status\(\s*201\s*\)/.test(r.handlerText) && !/location/i.test(r.handlerText)) {
        violations.push({ ...at, rule: "created-location", severity: "warning", message: `POST ${r.path} responds 201 without a Location header.` });
      }
      if (r.method === "delete" && /\.(json|send)\(\s*[^)\s]/.test(r.handlerText) && !/204/.test(r.handlerText)) {
        violations.push({ ...at, rule: "delete-status", severity: "error", message: `DELETE ${r.path} returns a body; successful deletes must respond 204 No Content.` });
      }
    }
    return violations;
  },
};

function checkPath(routePath: string, file: string, line: number, out: Violation[]): void {
  const at = { gate: "rest-conventions", severity: "error", file, line } as const;
  if (routePath.length > 1 && routePath.endsWith("/")) {
    out.push({ ...at, rule: "trailing-slash", message: `Path "${routePath}" has a trailing slash.` });
  }
  for (const segment of routePath.split("/").filter(Boolean)) {
    if (segment.startsWith(":")) {
      if (!PARAM_SEGMENT.test(segment)) out.push({ ...at, rule: "param-naming", message: `Path param "${segment}" must be :camelCase.` });
      continue;
    }
    if (/^v\d+$/.test(segment)) continue;
    if (segment.includes(".")) {
      out.push({ ...at, rule: "file-extension", message: `Path "${routePath}" contains a file extension; use content negotiation.` });
    } else if (!KEBAB_SEGMENT.test(segment)) {
      out.push({ ...at, rule: "segment-casing", message: `Path segment "${segment}" must be lowercase kebab-case.` });
    }
    if (VERB_SEGMENT.test(segment)) {
      out.push({ ...at, rule: "verb-in-path", message: `Path segment "${segment}" is a verb; model resources as nouns and let the HTTP method carry the action.` });
    }
  }
}
