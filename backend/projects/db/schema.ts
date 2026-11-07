export const MIGRATION_SQL = `
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
  branch TEXT,
  changed_count INTEGER,
  ahead_count INTEGER,
  behind_count INTEGER,
  upstream TEXT,
  scan_run_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE loc_stats (
  name TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  core INTEGER NOT NULL,
  test INTEGER NOT NULL,
  counted_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  parts_json TEXT
);
`;

export const PROJECT_DETAIL_COLUMNS = [
  ["branch", "TEXT"],
  ["changed_count", "INTEGER"],
  ["ahead_count", "INTEGER"],
  ["behind_count", "INTEGER"],
  ["upstream", "TEXT"],
] as const;

export const LOC_STATS_SQL = `
CREATE TABLE IF NOT EXISTS loc_stats (
  name TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  core INTEGER NOT NULL,
  test INTEGER NOT NULL,
  counted_at TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  parts_json TEXT
);
`;

export const SCHEMA_VERSION = 3;
