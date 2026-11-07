/** Optional read-only compatibility with schema 2 runtime registries.
 * Paths are relative to the configured projects root, or explicitly absolute.
 * LocalDesk neither allocates ports nor changes the registry or its services.
 */
import { basename, dirname, resolve } from "node:path";

/** Optional workspace integration supports the canonical registry directory
 * without making standalone LocalDesk depend on workspace-owned modules. */
export function registryWorkspaceRoot(path: string): string {
  const directory = dirname(resolve(path));
  return basename(directory) === "registry" &&
      basename(dirname(directory)) === ".runtime"
    ? dirname(dirname(directory))
    : directory;
}

export type PortProject = {
  slot: number | null;
  project: string;
  path: string | null;
  lifecycle: "active" | "archived" | "reserved";
  frontend: number | null;
  backend: number | null;
  endpoints: { frontend: boolean; backend: boolean };
  runtime: {
    kind: "web" | "native" | "none";
    composeFile: string | null;
    launchAgentLabel: string | null;
  };
  note?: string;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function textOrNull(value: unknown) {
  return value === null || (typeof value === "string" && value.length > 0);
}
function port(value: unknown) {
  return value === null ||
    (typeof value === "number" && Number.isInteger(value) && value > 0 &&
      value <= 65535);
}
function project(value: unknown): value is PortProject {
  if (!record(value) || !record(value.endpoints) || !record(value.runtime)) {
    return false;
  }
  return typeof value.project === "string" && value.project.length > 0 &&
    textOrNull(value.path) &&
    (value.slot === null ||
      (typeof value.slot === "number" && Number.isSafeInteger(value.slot) &&
        value.slot >= 0)) &&
    ["active", "archived", "reserved"].includes(String(value.lifecycle)) &&
    port(value.frontend) && port(value.backend) &&
    typeof value.endpoints.frontend === "boolean" &&
    typeof value.endpoints.backend === "boolean" &&
    ["web", "native", "none"].includes(String(value.runtime.kind)) &&
    textOrNull(value.runtime.composeFile) &&
    textOrNull(value.runtime.launchAgentLabel) &&
    (value.note === undefined || typeof value.note === "string");
}

export async function loadRegistry(
  path: string,
  readText: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<{ schemaVersion: 2; projects: PortProject[] }> {
  const value: unknown = JSON.parse(await readText(path));
  if (
    !record(value) || value.schemaVersion !== 2 ||
    !Array.isArray(value.projects) || !value.projects.every(project)
  ) {
    throw new Error(
      "Unsupported or invalid runtime registry (expected schemaVersion 2)",
    );
  }
  const names = new Set<string>();
  for (const entry of value.projects) {
    if (names.has(entry.project)) {
      throw new Error("Duplicate runtime registry project");
    }
    names.add(entry.project);
  }
  return { schemaVersion: 2, projects: value.projects };
}
