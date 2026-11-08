import { VERSION } from "../version.ts";
import type { LocStat, ProjectSnapshot, ProjectStore } from "../db/store.ts";
import { scanRoot } from "./scan.ts";
import type { RuntimeFacts, RuntimeProvider } from "./runtime.ts";
import type { LocProvider } from "./loc_job.ts";

export type ScanFn = (root: string) => Promise<ProjectSnapshot[]>;

export type PathExistsFn = (path: string) => boolean;

export type AppOptions = {
  store: ProjectStore;
  root: string;
  scan?: ScanFn;
  rescanMs?: number;
  runtime?: RuntimeProvider;
  loc?: LocProvider;
  pathExists?: PathExistsFn;
};

export type LocJson = {
  profile: string;
  core: number;
  test: number;
  counted_at: string;
  parts?: { id: string; core: number }[];
};

export type ProjectJson = {
  name: string;
  path: string;
  is_git: boolean;
  has_remote: boolean;
  is_dirty: boolean;
  is_unpushed: boolean;
  has_multiple_branches: boolean;
  branch: string | null;
  changed_count: number | null;
  ahead_count: number | null;
  behind_count: number | null;
  upstream: string | null;
  runtime?: RuntimeFacts;
  loc?: LocJson;
};

export type ProjectsResponse = {
  version: string;
  scanned_at: string | null;
  duration_ms: number | null;
  projects: ProjectJson[];
};

export type HealthResponse = {
  ok: true;
  version: string;
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export function directoryExists(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

export function createApp(options: AppOptions) {
  const scan = options.scan ?? scanRoot;
  const rescanMs = options.rescanMs ?? 30_000;
  const pathExists = options.pathExists ?? directoryExists;
  const loc = options.loc;
  let closed = false;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cachedProjects: { at: number; body: ProjectsResponse } | null = null;
  const currentProjects = (): ProjectsResponse => {
    const now = performance.now();
    if (cachedProjects && now - cachedProjects.at < 250) {
      return cachedProjects.body;
    }
    const body = projectsBody(options.store, options.runtime, pathExists);
    cachedProjects = { at: now, body };
    return body;
  };

  const scanNow = (): Promise<void> => {
    if (inflight) return inflight;
    inflight = (async () => {
      const t0 = performance.now();
      const rows = await scan(options.root);
      if (closed) return;
      options.store.replaceSnapshot(
        options.root,
        rows,
        Math.max(0, Math.round(performance.now() - t0)),
      );
      await options.runtime?.refresh(rows.map((row) => row.name));
      // Direct scanNow callers and HTTP scans must both see the new snapshot.
      cachedProjects = null;
      if (!closed && loc) {
        loc.refresh(rows.map((row) => ({ name: row.name, path: row.path })))
          .catch(() => {});
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  const tick = () => {
    if (closed || rescanMs <= 0) return;
    timer = setTimeout(() => {
      scanNow().catch(() => {}).finally(() => tick());
    }, rescanMs);
  };

  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, version: VERSION } satisfies HealthResponse);
    }
    if (request.method === "GET" && url.pathname === "/api/projects") {
      return json(currentProjects());
    }
    if (request.method === "POST" && url.pathname === "/api/scan") {
      await scanNow();
      return json(currentProjects());
    }
    return new Response("Not found", { status: 404 });
  };

  const close = () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
  };

  tick();
  return { fetch, close, scanNow };
}

function locJson(stat: LocStat): LocJson {
  return {
    profile: stat.profile,
    core: stat.core,
    test: stat.test,
    counted_at: stat.counted_at,
    ...(stat.parts ? { parts: stat.parts } : {}),
  };
}

export function projectsBody(
  store: ProjectStore,
  runtime?: RuntimeProvider,
  pathExists: PathExistsFn = directoryExists,
): ProjectsResponse {
  const run = store.latestRun();
  const locByName = new Map(store.listLoc().map((stat) => [stat.name, stat]));
  return {
    version: VERSION,
    scanned_at: run?.finished_at ?? null,
    duration_ms: run?.duration_ms ?? null,
    projects: store.listProjects()
      .filter((row) => pathExists(row.path))
      .map((row) => {
        const loc = locByName.get(row.name);
        return {
          name: row.name,
          path: row.path,
          is_git: row.is_git,
          has_remote: row.has_remote,
          is_dirty: row.is_dirty,
          is_unpushed: row.is_unpushed,
          has_multiple_branches: row.has_multiple_branches,
          branch: row.branch,
          changed_count: row.changed_count,
          ahead_count: row.ahead_count,
          behind_count: row.behind_count,
          upstream: row.upstream,
          ...(runtime ? { runtime: runtime.factsFor(row.name) } : {}),
          ...(loc ? { loc: locJson(loc) } : {}),
        };
      }),
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: JSON_HEADERS });
}
