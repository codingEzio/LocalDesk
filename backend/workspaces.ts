import { integrations } from "./integrations.ts";
import { basename, dirname, join } from "node:path";
import { settings } from "./config.ts";
import { shouldSkipDir } from "./projects/backend/exclude.ts";

export async function resolveWorkspace(
  input: unknown = settings.workspace,
): Promise<string> {
  if (typeof input !== "string" || !input) throw new Error("Invalid workspace");
  const source = input === settings.workspace ? "workspace" : "projects";
  integrations.require(source);
  const path = await Deno.realPath(input);
  if (!(await Deno.stat(path)).isDirectory) {
    throw new Error("Workspace is not a directory");
  }
  if (source === "workspace") return path;
  const projectsRoot = await Deno.realPath(settings.projectsRoot);
  if (dirname(path) !== projectsRoot || shouldSkipDir(basename(path))) {
    throw new Error(
      "Choose the workspace or an active project in the project directory",
    );
  }
  try {
    if ((await Deno.stat(join(path, ".project-status-ignore"))).isFile) {
      throw new Error("Project is excluded from the workbench");
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return path;
}
