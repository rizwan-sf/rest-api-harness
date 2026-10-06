import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export interface ParsedFile {
  /** Workspace-relative, forward slashes. */
  rel: string;
  sf: ts.SourceFile;
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

export function isTestFile(rel: string): boolean {
  return /\.(test|spec)\.ts$/.test(rel) || rel.startsWith("test/") || rel.includes("/__tests__/");
}

/** Parse every .ts file under `<root>/<dir>`. Syntax-only; no type checker needed. */
export async function parseTsFiles(root: string, dir = "src"): Promise<ParsedFile[]> {
  const out: ParsedFile[] = [];
  const walk = async (abs: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const child = path.join(abs, e.name);
      if (e.isDirectory()) await walk(child);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) {
        const text = await readFile(child, "utf8");
        const rel = path.relative(root, child).split(path.sep).join("/");
        out.push({ rel, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true) });
      }
    }
  };
  await walk(path.join(root, dir));
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

export function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  node.forEachChild((c) => visit(c, fn));
}

const PARSE_METHODS = new Set(["parse", "safeParse", "parseAsync", "safeParseAsync"]);

/**
 * True when `node` sits (possibly nested) inside the arguments of a
 * `<schema>.parse(...)`-style call within the same function body.
 */
export function isInsideZodParse(node: ts.Node): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (parent) {
    if (ts.isFunctionLike(parent)) return false;
    if (
      ts.isCallExpression(parent) &&
      parent.arguments.some((a) => a === child) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      PARSE_METHODS.has(parent.expression.name.text)
    ) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/** `a.b.c` → "a.b.c"; anything non-trivial → undefined. */
export function dottedName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const left = dottedName(expr.expression);
    return left ? `${left}.${expr.name.text}` : undefined;
  }
  return undefined;
}

export function stringLiteralValue(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}
