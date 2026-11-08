import { integrations } from "./integrations.ts";
import { basename, dirname, join, resolve } from "node:path";
import { settings } from "./config.ts";
import { shouldSkipDir } from "./projects/backend/exclude.ts";

let projectRoot: string | undefined;
let workspaceCanonical = integrations.workspaceCanonical();

function verifyWorkspaceIdentity(canonical: string): string {
  const previous = integrations.workspaceCanonical() || workspaceCanonical;
  if (previous && previous !== canonical) {
    throw new Error("Workspace identity changed");
  }
  workspaceCanonical = canonical;
  return canonical;
}

/** Cache only paths whose source is connected. Disconnected paths are never probed. */
export async function refreshSourcePaths() {
  if (integrations.connected("workspace")) {
    try {
      await integrations.read("workspace", async () => {
        verifyWorkspaceIdentity(await Deno.realPath(settings.workspace));
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  if (integrations.connected("projects")) {
    try {
      await integrations.read("projects", async () => {
        projectRoot = await Deno.realPath(settings.projectsRoot);
      });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}
await refreshSourcePaths();

export function knownWorkspaceSource(
  input: unknown,
): "workspace" | "projects" | null {
  if (typeof input !== "string" || !input) return null;
  const value = resolve(input);
  if (
    value === resolve(settings.workspace) || value === workspaceCanonical ||
    value === integrations.workspaceCanonical()
  ) return "workspace";
  if (
    dirname(value) === resolve(settings.projectsRoot) ||
    (projectRoot && dirname(value) === projectRoot)
  ) return "projects";
  return null;
}

/** Unknown aliases are resolved only when both sources are connected. */
export async function workspaceSource(
  input: unknown,
): Promise<"workspace" | "projects"> {
  if (typeof input !== "string" || !input) throw new Error("Invalid workspace");
  const known = knownWorkspaceSource(input);
  if (known) {
    if (
      known === "projects" && integrations.connected("workspace") &&
      integrations.connected("projects")
    ) {
      const workspaceAlias = await integrations.read(
        "workspace",
        () =>
          integrations.read("projects", async () => {
            const path = await Deno.realPath(input);
            const workspace = await Deno.realPath(settings.workspace);
            verifyWorkspaceIdentity(workspace);
            return path === workspace;
          }),
      );
      if (workspaceAlias) return "workspace";
    }
    if (
      known === "projects" && !integrations.connected("workspace") &&
      !(workspaceCanonical || integrations.workspaceCanonical())
    ) {
      throw new Error("Workspace identity unavailable while disconnected");
    }
    return known;
  }
  if (
    !integrations.connected("workspace") || !integrations.connected("projects")
  ) {
    throw new Error("Workspace source cannot be determined while disconnected");
  }
  return await integrations.read(
    "workspace",
    () =>
      integrations.read("projects", async () => {
        const path = await Deno.realPath(input);
        const workspace = await Deno.realPath(settings.workspace);
        verifyWorkspaceIdentity(workspace);
        return path === workspace ? "workspace" : "projects";
      }),
  );
}

export async function resolveWorkspace(
  input: unknown = settings.workspace,
): Promise<string> {
  const source = await workspaceSource(input);
  return await integrations.read(source, async () => {
    if (
      source === "projects" && !integrations.connected("workspace") &&
      (await Deno.lstat(input as string)).isSymlink
    ) {
      throw new Error(
        "Project aliases are unavailable while workspace is disconnected",
      );
    }
    const path = await Deno.realPath(input as string);
    if (!(await Deno.stat(path)).isDirectory) {
      throw new Error("Workspace is not a directory");
    }
    const canonicalWorkspace = integrations.connected("workspace")
      ? await integrations.read(
        "workspace",
        async () =>
          verifyWorkspaceIdentity(await Deno.realPath(settings.workspace)),
      )
      : (integrations.workspaceCanonical() || workspaceCanonical);
    if (path === canonicalWorkspace) {
      if (source !== "workspace") {
        throw new Error("Source disconnected: workspace");
      }
      return path;
    }
    if (source !== "projects") throw new Error("Workspace identity changed");
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
  });
}
