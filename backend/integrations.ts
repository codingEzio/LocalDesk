import { isAbsolute, join, relative, sep } from "node:path";
import { atomicJson, loadJson, local, settings } from "./config.ts";

export type SourceId = "workspace" | "projects";
const ids: SourceId[] = ["workspace", "projects"];
type State = {
  workspace: boolean;
  projects: boolean;
  workspaceCanonical?: string;
  projectsCanonical?: string;
  workspaceConfigured?: string;
  projectsConfigured?: string;
  pendingWorkspaceConfigured?: string;
  pendingProjectsConfigured?: string;
  requiresBoth?: boolean;
};

/** Whether either resolved source is equal to or below the other. */
function overlaps(a: string, b: string): boolean {
  const within = (parent: string, child: string) => {
    const path = relative(parent, child);
    return path === "" ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep));
  };
  return within(a, b) || within(b, a);
}

/** Two built-in source connections, not a plugin execution system. */
export class Integrations {
  private state: State = { workspace: true, projects: true };
  private pending = new Set<SourceId>();
  private revalidationRequired = false;
  private readers = { workspace: 0, projects: 0 };
  private mutations: Promise<unknown> = Promise.resolve();
  private file = join(local, "integrations.json");
  async init() {
    const raw = await loadJson<unknown>(this.file, this.state);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid saved source connections");
    }
    const saved = raw as Record<string, unknown>;
    if (
      ids.some((id) => typeof saved[id] !== "boolean") ||
      (saved.workspaceCanonical !== undefined &&
        (typeof saved.workspaceCanonical !== "string" ||
          !isAbsolute(saved.workspaceCanonical))) ||
      (saved.projectsCanonical !== undefined &&
        (typeof saved.projectsCanonical !== "string" ||
          !isAbsolute(saved.projectsCanonical))) ||
      (saved.requiresBoth !== undefined &&
        typeof saved.requiresBoth !== "boolean") ||
      (saved.pendingWorkspaceConfigured !== undefined &&
        (typeof saved.pendingWorkspaceConfigured !== "string" ||
          !isAbsolute(saved.pendingWorkspaceConfigured))) ||
      (saved.pendingProjectsConfigured !== undefined &&
        (typeof saved.pendingProjectsConfigured !== "string" ||
          !isAbsolute(saved.pendingProjectsConfigured))) ||
      (saved.workspaceConfigured !== undefined &&
        (typeof saved.workspaceConfigured !== "string" ||
          !isAbsolute(saved.workspaceConfigured))) ||
      (saved.projectsConfigured !== undefined &&
        (typeof saved.projectsConfigured !== "string" ||
          !isAbsolute(saved.projectsConfigured)))
    ) {
      throw new Error("Invalid saved source connections");
    }
    const original = JSON.stringify(saved);
    this.state = saved as State;
    let configuredChanged = false;
    for (const source of ids) {
      const key = source === "workspace"
        ? "workspaceCanonical"
        : "projectsCanonical";
      const configKey = source === "workspace"
        ? "workspaceConfigured"
        : "projectsConfigured";
      const pendingKey = source === "workspace"
        ? "pendingWorkspaceConfigured"
        : "pendingProjectsConfigured";
      const path = source === "workspace"
        ? settings.workspace
        : settings.projectsRoot;
      if (this.state[configKey] && this.state[configKey] !== path) {
        configuredChanged = true;
        if (!this.state[source] || this.state.requiresBoth) {
          this.state[pendingKey] = path;
        } else {
          delete this.state[key];
          this.state[configKey] = path;
          delete this.state[pendingKey];
        }
      } else {
        this.state[configKey] = path;
        delete this.state[pendingKey];
      }
    }
    this.revalidationRequired = !!(this.state.pendingWorkspaceConfigured ||
      this.state.pendingProjectsConfigured);
    if (this.revalidationRequired) this.state.requiresBoth = true;
    else delete this.state.requiresBoth;
    if (!this.revalidationRequired) {
      for (const source of ids) {
        if (!this.state[source]) continue;
        const key = source === "workspace"
          ? "workspaceCanonical"
          : "projectsCanonical";
        const path = source === "workspace"
          ? settings.workspace
          : settings.projectsRoot;
        try {
          const canonical = await Deno.realPath(path);
          if (this.state[key] && this.state[key] !== canonical) {
            throw new Error(
              `${source} identity changed; review the configured source`,
            );
          }
          this.state[key] = canonical;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }
      if (
        configuredChanged && this.state.workspace !== this.state.projects &&
        (!this.state.workspaceCanonical || !this.state.projectsCanonical ||
          overlaps(this.state.workspaceCanonical, this.state.projectsCanonical))
      ) {
        throw new Error(
          "Changed source overlap cannot be determined safely while the other source is disconnected",
        );
      }
    }
    if (JSON.stringify(this.state) !== original) {
      await atomicJson(this.file, this.state);
    }
  }
  workspaceCanonical() {
    return this.state.workspaceCanonical;
  }
  projectsCanonical() {
    return this.state.projectsCanonical;
  }
  connected(id: SourceId) {
    return this.state[id] && !this.pending.has(id) &&
      !this.revalidationRequired;
  }
  require(id: SourceId) {
    if (!this.connected(id)) throw new Error(`Source disconnected: ${id}`);
  }
  async read<T>(id: SourceId, action: () => Promise<T>): Promise<T> {
    this.require(id);
    this.readers[id]++;
    try {
      return await action();
    } finally {
      this.readers[id]--;
    }
  }
  view() {
    return ids.map((id) => ({
      id,
      path: id === "workspace" ? settings.workspace : settings.projectsRoot,
      connected: this.revalidationRequired ? false : this.state[id],
      changing: this.pending.has(id),
      requiresBoth: this.revalidationRequired,
    }));
  }
  change(id: unknown, connected: unknown, hasActiveJobs: () => boolean) {
    if (
      (id !== "both" && !ids.includes(id as SourceId)) ||
      typeof connected !== "boolean"
    ) {
      return Promise.reject(new Error("Invalid source connection"));
    }
    if (this.revalidationRequired && id !== "both") {
      return Promise.reject(
        new Error("Source paths changed; change both connections together."),
      );
    }
    const targets = id === "both" ? ids : [id as SourceId];
    const action = this.mutations.then(async () => {
      if (
        !this.revalidationRequired &&
        targets.every((source) => this.state[source] === connected)
      ) return;
      if (!connected && hasActiveJobs()) {
        throw new Error(
          "Finish or stop queued/running jobs in Activity before disconnecting. Connection unchanged.",
        );
      }
      // Both roots affect the overlap decision; stop new readers before checking.
      for (const source of ids) this.pending.add(source);
      try {
        const deadline = Date.now() + 30000;
        while (ids.some((source) => this.readers[source])) {
          if (Date.now() >= deadline) {
            throw new Error(
              "Source is still in use. Connection unchanged; try again after the operation finishes.",
            );
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        if (!connected && hasActiveJobs()) {
          throw new Error(
            "Finish or stop queued/running jobs in Activity before disconnecting. Connection unchanged.",
          );
        }
        const next: State = { ...this.state };
        for (const source of targets) next[source] = connected;
        for (const source of ids) {
          // Never probe a detached source unless this operation explicitly reconnects it.
          if (!this.state[source] && !(targets.includes(source) && connected)) {
            continue;
          }
          const key = source === "workspace"
            ? "workspaceCanonical"
            : "projectsCanonical";
          const path = source === "workspace"
            ? settings.workspace
            : settings.projectsRoot;
          const configKey = source === "workspace"
            ? "workspaceConfigured"
            : "projectsConfigured";
          const pendingKey = source === "workspace"
            ? "pendingWorkspaceConfigured"
            : "pendingProjectsConfigured";
          const rebinding = connected && targets.includes(source) &&
            next[pendingKey] === path;
          try {
            const canonical = await Deno.realPath(path);
            if (
              !rebinding && this.state[key] && canonical !== this.state[key]
            ) {
              throw new Error(
                `${source} identity changed; connection unchanged`,
              );
            }
            next[key] = canonical;
            if (rebinding) {
              next[configKey] = path;
              delete next[pendingKey];
            }
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound) || rebinding) {
              throw error;
            }
            // Preserve the last verified identity when the source is unavailable.
          }
        }
        if (next.workspace !== next.projects) {
          if (!next.workspaceCanonical || !next.projectsCanonical) {
            throw new Error(
              "Source overlap cannot be determined; change both connections together.",
            );
          }
          if (overlaps(next.workspaceCanonical, next.projectsCanonical)) {
            throw new Error(
              "Sources overlap; change both connections together.",
            );
          }
        }
        const needsValidation =
          !!(next.pendingWorkspaceConfigured || next.pendingProjectsConfigured);
        if (needsValidation) next.requiresBoth = true;
        else delete next.requiresBoth;
        await atomicJson(this.file, next);
        this.state = next;
        this.revalidationRequired = needsValidation;
      } finally {
        for (const source of ids) this.pending.delete(source);
      }
    });
    this.mutations = action.catch(() => {});
    return action;
  }
}
export const integrations = new Integrations();
await integrations.init();
