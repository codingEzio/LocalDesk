import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type ProjectSnapshot,
  ProjectStore,
} from "../../backend/projects/db/store.ts";

type GitDetails = {
  branch: string | null;
  changed_count: number | null;
  ahead_count: number | null;
  behind_count: number | null;
  upstream: string | null;
};

function details(value: unknown): GitDetails {
  return value as GitDetails;
}

function sample(
  name: string,
  extra: Partial<ProjectSnapshot> & Partial<GitDetails> = {},
): ProjectSnapshot {
  return {
    name,
    path: `/tmp/${name}`,
    is_git: true,
    has_remote: false,
    is_dirty: false,
    is_unpushed: false,
    has_multiple_branches: false,
    ...extra,
  } as ProjectSnapshot;
}

Deno.test("empty snapshot stores a finished run and no projects", () => {
  const db = new ProjectStore(":memory:");
  try {
    const run = db.replaceSnapshot("/tmp/root", []);
    assertEquals(run.root, "/tmp/root");
    assertEquals(run.finished_at !== null, true);
    assertEquals(typeof run.duration_ms, "number");
    assertEquals(db.listProjects(), []);
    assertEquals(db.latestRun()?.id, run.id);
  } finally {
    db.close();
  }
});

Deno.test("replaceSnapshot replaces the previous project rows", () => {
  const db = new ProjectStore(":memory:");
  try {
    db.replaceSnapshot("/tmp/root", [sample("Atlas", { is_dirty: true })]);
    db.replaceSnapshot("/tmp/root", [
      sample("Folio", { is_unpushed: true }),
      sample("Agenda"),
    ]);
    const names = db.listProjects().map((row) => row.name);
    assertEquals(names, ["Agenda", "Folio"]);
  } finally {
    db.close();
  }
});

Deno.test("listProjects sorts A-Z by name", () => {
  const db = new ProjectStore(":memory:");
  try {
    db.replaceSnapshot("/tmp/root", [
      sample("ok", { has_remote: true }),
      sample("zeta"),
      sample("plain", { is_git: false }),
      sample("folder", { is_git: false }),
      sample("ahead", { is_unpushed: true }),
      sample("beta", { is_dirty: true }),
      sample("aardvark", { is_dirty: true }),
      sample("split", { has_remote: true, has_multiple_branches: true }),
      sample("mixed", { is_dirty: true, has_multiple_branches: true }),
      sample("gamma", { is_dirty: true, is_unpushed: true }),
      sample("atlas", {
        is_dirty: true,
        is_unpushed: true,
        has_multiple_branches: true,
      }),
    ]);
    assertEquals(
      db.listProjects().map((row) => row.name),
      [
        "aardvark",
        "ahead",
        "atlas",
        "beta",
        "folder",
        "gamma",
        "mixed",
        "ok",
        "plain",
        "split",
        "zeta",
      ],
    );
  } finally {
    db.close();
  }
});

Deno.test("snapshot survives reopen on the same file", () => {
  const dir = Deno.makeTempDirSync();
  const path = join(dir, "projstatus.sqlite3");
  const first = new ProjectStore(path);
  try {
    first.replaceSnapshot("/home/example/X/Project", [
      sample("Atlas", {
        path: "/home/example/X/Project/Atlas",
        is_dirty: true,
        branch: "main",
        changed_count: 2,
        ahead_count: 1,
        behind_count: 0,
        upstream: "origin/main",
      }),
    ]);
  } finally {
    first.close();
  }
  const second = new ProjectStore(path);
  try {
    const rows = second.listProjects();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].name, "Atlas");
    assertEquals(rows[0].is_dirty, true);
    assertEquals(details(rows[0]).branch, "main");
    assertEquals(details(rows[0]).changed_count, 2);
    assertEquals(details(rows[0]).ahead_count, 1);
    assertEquals(details(rows[0]).behind_count, 0);
    assertEquals(details(rows[0]).upstream, "origin/main");
    assertEquals(second.latestRun()?.root, "/home/example/X/Project");
  } finally {
    second.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("legacy v1 database migrates details columns without changing rows", () => {
  const dir = Deno.makeTempDirSync();
  const path = join(dir, "legacy.sqlite3");
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE scan_runs (
        id INTEGER PRIMARY KEY,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        root TEXT NOT NULL
      );
      CREATE TABLE projects (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        is_git INTEGER NOT NULL,
        has_remote INTEGER NOT NULL,
        is_dirty INTEGER NOT NULL,
        is_unpushed INTEGER NOT NULL,
        has_multiple_branches INTEGER NOT NULL,
        scan_run_id INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO scan_runs (id, started_at, finished_at, duration_ms, root)
        VALUES (7, '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:01.000Z', 1, '/tmp/root');
      INSERT INTO projects (
        name, path, is_git, has_remote, is_dirty, is_unpushed,
        has_multiple_branches, scan_run_id, updated_at
      ) VALUES ('Legacy', '/tmp/Legacy', 1, 1, 1, 0, 0, 7, '2026-09-09T00:00:01.000Z');
      PRAGMA user_version=1;
    `);
  } finally {
    legacy.close();
  }

  const migrated = new ProjectStore(path);
  try {
    const rows = migrated.listProjects();
    assertEquals(rows.length, 1);
    assertEquals(rows[0].name, "Legacy");
    assertEquals(rows[0].is_dirty, true);
    assertEquals(details(rows[0]).branch, null);
    assertEquals(details(rows[0]).changed_count, null);
    assertEquals(details(rows[0]).ahead_count, null);
    assertEquals(details(rows[0]).behind_count, null);
    assertEquals(details(rows[0]).upstream, null);
    assertEquals(
      (migrated.connection.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }).user_version,
      3,
    );
  } finally {
    migrated.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test("loc stats survive replaceSnapshot and can be pruned", () => {
  const db = new ProjectStore(":memory:");
  try {
    db.replaceSnapshot("/tmp/root", [sample("Atlas")]);
    db.upsertLoc({
      name: "Atlas",
      profile: "rust",
      core: 17000,
      test: 800,
      counted_at: "2026-09-11T00:00:00.000Z",
      fingerprint: "rust:1:1:1",
      parts: null,
    });
    db.replaceSnapshot("/tmp/root", [sample("Folio")]);
    const kept = db.listLoc();
    assertEquals(kept.length, 1);
    assertEquals(kept[0].name, "Atlas");
    assertEquals(kept[0].core, 17000);
    db.deleteLoc(["Atlas"]);
    assertEquals(db.listLoc(), []);
  } finally {
    db.close();
  }
});
