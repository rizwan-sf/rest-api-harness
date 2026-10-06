import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const NEVER_WRITABLE = ["node_modules", ".git", "package-lock.json"];
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist"]);

export class SandboxViolation extends Error {}

/**
 * The agent's only window onto the filesystem. Every path is resolved inside
 * the workspace root; escapes, protected paths and tool-managed files are refused.
 */
export class Workspace {
  /** Workspace-relative paths written during the run, for the report. */
  readonly touched = new Set<string>();

  constructor(
    readonly root: string,
    private readonly protectedPaths: readonly string[] = [],
  ) {}

  static async seed(sourceDir: string, root: string, protectedPaths: readonly string[]): Promise<Workspace> {
    await mkdir(root, { recursive: true });
    await cp(sourceDir, root, {
      recursive: true,
      filter: (src) => !IGNORED_DIRS.has(path.basename(src)),
    });
    return new Workspace(root, protectedPaths);
  }

  resolve(rel: string): string {
    const abs = path.resolve(this.root, rel);
    const relative = path.relative(this.root, abs);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new SandboxViolation(`Path escapes the workspace: ${rel}`);
    }
    return abs;
  }

  private assertWritable(rel: string): string {
    const abs = this.resolve(rel);
    const normalized = path.relative(this.root, abs).split(path.sep).join("/");
    const blocked = [...NEVER_WRITABLE, ...this.protectedPaths].find(
      (p) => normalized === p || normalized.startsWith(`${p}/`),
    );
    if (blocked) throw new SandboxViolation(`Path is protected by harness policy: ${normalized}`);
    this.touched.add(normalized);
    return abs;
  }

  async read(rel: string): Promise<string> {
    return readFile(this.resolve(rel), "utf8");
  }

  async write(rel: string, contents: string): Promise<void> {
    const abs = this.assertWritable(rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }

  async replace(rel: string, oldText: string, newText: string): Promise<void> {
    const current = await this.read(rel);
    const count = current.split(oldText).length - 1;
    if (count !== 1) {
      throw new Error(`old_text must match exactly once in ${rel}, matched ${count} times`);
    }
    await this.write(rel, current.replace(oldText, () => newText));
  }

  async remove(rel: string): Promise<void> {
    await rm(this.assertWritable(rel), { recursive: true, force: true });
  }

  /** All files under `dir`, workspace-relative, excluding dependency/build dirs. */
  async list(dir = "."): Promise<string[]> {
    const out: string[] = [];
    const walk = async (absDir: string): Promise<void> => {
      for (const entry of await readdir(absDir, { withFileTypes: true })) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        const abs = path.join(absDir, entry.name);
        if (entry.isDirectory()) await walk(abs);
        else out.push(path.relative(this.root, abs).split(path.sep).join("/"));
      }
    };
    const start = this.resolve(dir);
    if ((await stat(start)).isDirectory()) await walk(start);
    return out.sort();
  }
}
