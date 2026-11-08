import type { Workbench } from "./workbench.ts";

// LAN sharing is an explicit project-list grant, not access to local settings,
// source inventories, model choices, chats, jobs or source statistics.
export function lanState(ready: boolean) {
  return {
    version: "0.2.1",
    readOnly: true,
    workspace: "",
    workspaces: [],
    integrations: [],
    catalog: { connected: false, plugins: [], errors: [], scanning: false },
    runner: { ready: false, presets: [] },
    ready,
    canControl: false,
    jobs: [],
    chats: [],
  };
}

export function lanWorkbench(view: ReturnType<Workbench["view"]>) {
  const snapshot = view.snapshot;
  return {
    source: "LocalDesk",
    connected: view.connected,
    stale: view.stale,
    error: "",
    scanning: view.scanning,
    fetchedAt: view.fetchedAt,
    snapshot: snapshot && {
      version: snapshot.version,
      scanned_at: snapshot.scanned_at,
      duration_ms: snapshot.duration_ms,
      projects: snapshot.projects.map((p) => ({
        name: p.name,
        path: p.path,
        is_git: p.is_git,
        has_remote: p.has_remote,
        is_dirty: p.is_dirty,
        is_unpushed: p.is_unpushed,
        has_multiple_branches: p.has_multiple_branches,
        branch: p.branch,
        changed_count: p.changed_count,
        ahead_count: p.ahead_count,
        behind_count: p.behind_count,
        upstream: p.upstream,
      })),
    },
  };
}
