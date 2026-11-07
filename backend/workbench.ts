import { integrations } from "./integrations.ts";
import { join } from "node:path";
import { local, settings } from "./config.ts";
import { ProjectStore } from "./projects/db/store.ts";
import { createApp, type ProjectsResponse } from "./projects/backend/server.ts";
import { createRuntimeProvider } from "./projects/backend/runtime.ts";
import { createLocProvider } from "./projects/backend/loc_job.ts";

/** Own the monitor's migrated scanner, SQLite history and bounded runtime facts. */
export class Workbench {
  private store = new ProjectStore(join(local, "projects.sqlite3"));
  private loc = createLocProvider(this.store);
  private locTask: Promise<void> = Promise.resolve();
  private app = createApp({
    store: this.store,
    root: settings.projectsRoot,
    rescanMs: 0,
    runtime: createRuntimeProvider(
      settings.projectsRoot,
      settings.runtimeRegistry,
    ),
    loc: {
      refresh: (projects) =>
        this.locTask = this.loc.refresh(projects).then(() => this.capture()),
    },
  });
  private snapshot: ProjectsResponse | null = null;
  private fetchedAt: string | null = null;
  private error = "";
  private busy: Promise<void> | null = null;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  view() {
    return {
      source: "X-LocalDesk",
      fetchedAt: this.fetchedAt,
      connected: integrations.connected("projects"),
      stale: !!this.error,
      error: this.error,
      scanning: !!this.busy,
      snapshot: integrations.connected("projects") ? this.snapshot : null,
    };
  }
  async start() {
    if (integrations.connected("projects")) {
      await this.capture();
      void this.refresh();
    }
  }
  private async capture() {
    this.snapshot =
      await (await this.app.fetch(new Request("http://localhost/api/projects")))
        .json();
    this.fetchedAt = new Date().toISOString();
  }
  refresh(): Promise<void> {
    if (this.busy) return this.busy;
    if (this.stopped || !integrations.connected("projects")) {
      return Promise.resolve();
    }
    clearTimeout(this.timer);
    this.busy = (async () => {
      try {
        await integrations.read("projects", async () => {
          await this.app.scanNow();
          await this.locTask;
          await this.capture();
        });
        this.error = "";
      } catch (e) {
        this.error = String(e);
      } finally {
        this.busy = null;
        if (!this.stopped) {
          this.timer = setTimeout(
            () => void this.refresh(),
            settings.projectScanIntervalMs,
          );
        }
      }
    })();
    return this.busy;
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.app.close();
    await this.busy;
    await this.locTask.catch(() => {});
    this.store.close();
  }
}
