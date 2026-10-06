import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { TaskSchema, type Task } from "./schema.js";

export interface LoadedTask {
  task: Task;
  /** Absolute path of the directory the workspace is seeded from. */
  sourceDir: string;
}

export async function loadTask(file: string): Promise<LoadedTask> {
  const abs = path.resolve(file);
  const text = await readFile(abs, "utf8");
  const result = TaskSchema.safeParse(parseYaml(text));
  if (!result.success) {
    throw new Error(`Invalid task definition ${file}:\n${result.error.message}`);
  }
  const task = result.data;
  const rel = task.kind === "greenfield" ? task.template : task.fixture;
  return { task, sourceDir: path.resolve(path.dirname(abs), rel) };
}
