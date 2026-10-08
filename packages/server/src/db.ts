import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

/**
 * Schema notes
 *
 * - funnel_versions.config_json: the whole funnel config as JSON. New steps,
 *   new events, new result ids never require a migration.
 * - sessions.answers_json: raw user answers live ONLY here (TTL'd), never in events.
 * - events.properties_json: event-specific properties as JSON.
 * - events.event_id is the PRIMARY KEY → `INSERT OR IGNORE` gives idempotency.
 * - funnel_version / variant on events are denormalised from the session at
 *   insert time so analytics never has to trust the client.
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS funnel_versions (
  version        TEXT PRIMARY KEY,
  funnel_id      TEXT NOT NULL,
  name           TEXT,
  status         TEXT NOT NULL DEFAULT 'draft',    -- draft | published | archived
  is_active      INTEGER NOT NULL DEFAULT 0,
  config_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  published_at   TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_funnel_versions_active ON funnel_versions(is_active) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS publication_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  action        TEXT NOT NULL,                      -- publish | rollback
  from_version  TEXT,
  to_version    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id      TEXT PRIMARY KEY,
  funnel_version  TEXT NOT NULL REFERENCES funnel_versions(version),
  variant         TEXT NOT NULL,
  variant_source  TEXT NOT NULL DEFAULT 'assigned', -- assigned | override
  current_step_id TEXT,
  answers_json    TEXT NOT NULL DEFAULT '{}',
  utm_json        TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_version_variant ON sessions(funnel_version, variant);

CREATE TABLE IF NOT EXISTS events (
  event_id          TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(session_id),
  event_type        TEXT NOT NULL,
  step_id           TEXT,
  funnel_version    TEXT NOT NULL,
  variant           TEXT NOT NULL,
  client_timestamp  TEXT NOT NULL,
  server_timestamp  TEXT NOT NULL,
  utm_source        TEXT,
  utm_medium        TEXT,
  utm_campaign      TEXT,
  properties_json   TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type_step ON events(event_type, step_id);
CREATE INDEX IF NOT EXISTS idx_events_version_variant ON events(funnel_version, variant);
CREATE INDEX IF NOT EXISTS idx_events_campaign ON events(utm_campaign);

-- counters that are cheap to keep and useful on the dashboard
CREATE TABLE IF NOT EXISTS ingest_stats (
  key    TEXT PRIMARY KEY,
  value  INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO ingest_stats(key, value) VALUES ('accepted', 0), ('duplicate', 0), ('rejected', 0);
`;

export function openDb(file: string): Db {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.exec(SCHEMA);
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}
