import { join } from "node:path";
import { atomicJson, loadJson, local, settings } from "./config.ts";

export type SourceId = "workspace" | "projects";
const ids: SourceId[] = ["workspace", "projects"];
/** Two built-in source connections, not a plugin execution system. */
export class Integrations {
  private state = { workspace: true, projects: true };
  private pending = new Set<SourceId>();
  private readers = { workspace: 0, projects: 0 };
  private mutations: Promise<unknown> = Promise.resolve();
  private file = join(local, "integrations.json");
  async init() {
    const saved = await loadJson(this.file, this.state);
    if (ids.some((id) => typeof saved[id] !== "boolean")) {
      throw new Error("Invalid saved source connections");
    }
    this.state = saved;
  }
  connected(id: SourceId) {
    return this.state[id] && !this.pending.has(id);
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
      connected: this.state[id],
      changing: this.pending.has(id),
    }));
  }
  change(id: unknown, connected: unknown, hasActiveJobs: () => boolean) {
    if (!ids.includes(id as SourceId) || typeof connected !== "boolean") {
      return Promise.reject(new Error("Invalid source connection"));
    }
    const source = id as SourceId;
    const action = this.mutations.then(async () => {
      if (this.state[source] === connected) return;
      if (!connected && hasActiveJobs()) {
        throw new Error(
          "Finish or stop queued/running jobs in Activity before disconnecting. Connection unchanged.",
        );
      }
      this.pending.add(source); // Reject new reads before waiting for existing work.
      try {
        const deadline = Date.now() + 30000;
        while (this.readers[source]) {
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
        const next = { ...this.state, [source]: connected };
        await atomicJson(this.file, next);
        this.state = next;
      } finally {
        this.pending.delete(source);
      }
    });
    this.mutations = action.catch(() => {});
    return action;
  }
}
export const integrations = new Integrations();
await integrations.init();
