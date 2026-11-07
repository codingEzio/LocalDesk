import { VERSION } from "../../backend/projects/version.ts";

export type ProjectJson = {
  name: string;
  path: string;
  is_git: boolean;
  has_remote: boolean;
  is_dirty: boolean;
  is_unpushed: boolean;
  has_multiple_branches: boolean;
};

export type ProjectsResponse = {
  version: string;
  scanned_at: string | null;
  duration_ms: number | null;
  projects: ProjectJson[];
};

export function isProjectsResponse(value: unknown): value is ProjectsResponse {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  if (body.version !== VERSION) return false;
  if (body.scanned_at !== null && typeof body.scanned_at !== "string") {
    return false;
  }
  if (body.duration_ms !== null && typeof body.duration_ms !== "number") {
    return false;
  }
  if (!Array.isArray(body.projects)) return false;
  return body.projects.every(isProjectJson);
}

function isProjectJson(value: unknown): value is ProjectJson {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.name === "string" &&
    typeof row.path === "string" &&
    typeof row.is_git === "boolean" &&
    typeof row.has_remote === "boolean" &&
    typeof row.is_dirty === "boolean" &&
    typeof row.is_unpushed === "boolean" &&
    typeof row.has_multiple_branches === "boolean" &&
    !("scan_run_id" in row);
}
