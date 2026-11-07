import { DatabaseSync } from "node:sqlite";
import { dirname } from "node:path";
import {
  LOC_STATS_SQL,
  MIGRATION_SQL,
  PROJECT_DETAIL_COLUMNS,
  SCHEMA_VERSION,
} from "./schema.ts";

export type ProjectGitDetails = {
  branch: string | null;
  changed_count: number | null;
  ahead_count: number | null;
  behind_count: number | null;
  upstream: string | null;
};

export type ProjectSnapshot = {
  name: string;
  path: string;
  is_git: boolean;
  has_remote: boolean;
  is_dirty: boolean;
  is_unpushed: boolean;
  has_multiple_branches: boolean;
} & Partial<ProjectGitDetails>;

export type ProjectRow =
  & Omit<ProjectSnapshot, keyof ProjectGitDetails>
  & ProjectGitDetails
  & {
    scan_run_id: number;
    updated_at: string;
  };

export type ScanRun = {
  id: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  root: string;
};

export type LocPart = { id: string; core: number };

export type LocStat = {
  name: string;
  profile: string;
  core: number;
  test: number;
  counted_at: string;
  fingerprint: string;
  parts: LocPart[] | null;
};

type ScanRunRecord = {
  id: number;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  root: string;
};

type ProjectRecord = {
  name: string;
  path: string;
  is_git: number;
  has_remote: number;
  is_dirty: number;
  is_unpushed: number;
  has_multiple_branches: number;
  branch: string | null;
  changed_count: number | null;
  ahead_count: number | null;
  behind_count: number | null;
  upstream: string | null;
  scan_run_id: number;
  updated_at: string;
};

type LocRecord = {
  name: string;
  profile: string;
  core: number;
  test: number;
  counted_at: string;
  fingerprint: string;
  parts_json: string | null;
};

function asBool(value: number): boolean {
  return value !== 0;
}

function parseParts(value: string | null): LocPart[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    const parts = parsed.filter((item): item is LocPart =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as LocPart).id === "string" &&
      typeof (item as LocPart).core === "number"
    );
    return parts.length > 0 ? parts : null;
  } catch {
    return null;
  }
}

export class ProjectStore {
  readonly connection: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      Deno.mkdirSync(dirname(path), { recursive: true });
    }
    this.connection = new DatabaseSync(path);
    const db = this.connection;
    db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    const version =
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version;
    if (version < 1) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(MIGRATION_SQL);
        db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
      } catch (error) {
        db.exec("ROLLBACK");
        db.close();
        throw error;
      }
    } else if (version < SCHEMA_VERSION) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const columns = new Set(
          (db.prepare("PRAGMA table_info(projects)").all() as {
            name: string;
          }[]).map((column) => column.name),
        );
        if (version < 2) {
          for (const [name, type] of PROJECT_DETAIL_COLUMNS) {
            if (!columns.has(name)) {
              db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${type}`);
            }
          }
        }
        if (version < 3) {
          db.exec(LOC_STATS_SQL);
        }
        db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
      } catch (error) {
        db.exec("ROLLBACK");
        db.close();
        throw error;
      }
    }
  }

  replaceSnapshot(
    root: string,
    projects: ProjectSnapshot[],
    durationMs?: number,
  ): ScanRun {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const db = this.connection;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM projects");
      db.exec("DELETE FROM scan_runs");
      db.prepare(
        "INSERT INTO scan_runs (started_at, finished_at, duration_ms, root) VALUES (?, NULL, NULL, ?)",
      ).run(startedAt, root);
      const runId =
        (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number })
          .id;
      const insert = db.prepare(
        `INSERT INTO projects (
          name, path, is_git, has_remote, is_dirty, is_unpushed,
          has_multiple_branches, branch, changed_count, ahead_count,
          behind_count, upstream, scan_run_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updatedAt = new Date().toISOString();
      for (const project of projects) {
        insert.run(
          project.name,
          project.path,
          project.is_git ? 1 : 0,
          project.has_remote ? 1 : 0,
          project.is_dirty ? 1 : 0,
          project.is_unpushed ? 1 : 0,
          project.has_multiple_branches ? 1 : 0,
          project.branch ?? null,
          project.changed_count ?? null,
          project.ahead_count ?? null,
          project.behind_count ?? null,
          project.upstream ?? null,
          runId,
          updatedAt,
        );
      }
      const elapsed = Math.max(
        0,
        Math.round(durationMs ?? (performance.now() - t0)),
      );
      const finishedAt = new Date().toISOString();
      db.prepare(
        "UPDATE scan_runs SET finished_at = ?, duration_ms = ? WHERE id = ?",
      ).run(finishedAt, elapsed, runId);
      db.exec("COMMIT");
      return {
        id: runId,
        started_at: startedAt,
        finished_at: finishedAt,
        duration_ms: elapsed,
        root,
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  listProjects(): ProjectRow[] {
    const rows = this.connection.prepare(
      `SELECT name, path, is_git, has_remote, is_dirty, is_unpushed,
              has_multiple_branches, branch, changed_count, ahead_count,
              behind_count, upstream, scan_run_id, updated_at
       FROM projects
       ORDER BY name COLLATE NOCASE ASC`,
    ).all() as ProjectRecord[];
    return rows.map((row) => ({
      name: row.name,
      path: row.path,
      is_git: asBool(row.is_git),
      has_remote: asBool(row.has_remote),
      is_dirty: asBool(row.is_dirty),
      is_unpushed: asBool(row.is_unpushed),
      has_multiple_branches: asBool(row.has_multiple_branches),
      branch: row.branch,
      changed_count: row.changed_count,
      ahead_count: row.ahead_count,
      behind_count: row.behind_count,
      upstream: row.upstream,
      scan_run_id: row.scan_run_id,
      updated_at: row.updated_at,
    }));
  }

  latestRun(): ScanRun | null {
    const row = this.connection.prepare(
      "SELECT id, started_at, finished_at, duration_ms, root FROM scan_runs ORDER BY id DESC LIMIT 1",
    ).get() as ScanRunRecord | undefined;
    if (!row) return null;
    return {
      id: row.id,
      started_at: row.started_at,
      finished_at: row.finished_at,
      duration_ms: row.duration_ms,
      root: row.root,
    };
  }

  upsertLoc(stat: LocStat): void {
    this.connection.prepare(
      `INSERT INTO loc_stats (
        name, profile, core, test, counted_at, fingerprint, parts_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        profile = excluded.profile,
        core = excluded.core,
        test = excluded.test,
        counted_at = excluded.counted_at,
        fingerprint = excluded.fingerprint,
        parts_json = excluded.parts_json`,
    ).run(
      stat.name,
      stat.profile,
      stat.core,
      stat.test,
      stat.counted_at,
      stat.fingerprint,
      stat.parts ? JSON.stringify(stat.parts) : null,
    );
  }

  listLoc(): LocStat[] {
    const rows = this.connection.prepare(
      `SELECT name, profile, core, test, counted_at, fingerprint, parts_json
       FROM loc_stats`,
    ).all() as LocRecord[];
    return rows.map((row) => ({
      name: row.name,
      profile: row.profile,
      core: row.core,
      test: row.test,
      counted_at: row.counted_at,
      fingerprint: row.fingerprint,
      parts: parseParts(row.parts_json),
    }));
  }

  deleteLoc(names: string[]): void {
    if (names.length === 0) return;
    const del = this.connection.prepare("DELETE FROM loc_stats WHERE name = ?");
    for (const name of names) del.run(name);
  }

  close() {
    this.connection.close();
  }
}
