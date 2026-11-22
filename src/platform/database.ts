import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

/**
 * The whole schema, as an ordered list of migrations. `PRAGMA user_version` records
 * how many have been applied; opening a database applies the rest, each in its own
 * transaction. Never edit a migration that has shipped: append a new one.
 *
 * Migration 1 is the schema as it stood before migrations existed. It keeps
 * `IF NOT EXISTS` so databases created back then (user_version 0, tables present)
 * adopt it cleanly.
 */
export const MIGRATIONS: readonly string[] = [
  // 1: baseline (milestones 1–5)
  `
  -- Persistent logical identities (survive everything).
  CREATE TABLE IF NOT EXISTS agents (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    configuration   TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL
  );

  -- Each process incarnation of an agent (ephemeral facts, kept as history).
  CREATE TABLE IF NOT EXISTS runtimes (
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    incarnation INTEGER NOT NULL,
    pid         INTEGER NOT NULL,
    started_at  TEXT NOT NULL,
    exited_at   TEXT,
    exit_code   INTEGER,
    exit_signal TEXT,
    PRIMARY KEY (agent_id, incarnation)
  );

  -- Durable per-agent inbox. Owned by the platform, scoped to an agent identity
  -- (never to a runtime). claimed_by_incarnation fences claims to one process.
  CREATE TABLE IF NOT EXISTS inbox (
    id                     TEXT PRIMARY KEY,
    recipient_agent_id     TEXT NOT NULL REFERENCES agents(id),
    sender_agent_id        TEXT REFERENCES agents(id),   -- NULL = sent by the platform
    payload                TEXT NOT NULL,
    idempotency_key        TEXT,
    status                 TEXT NOT NULL,                -- pending | claimed | completed | failed
    attempts               INTEGER NOT NULL DEFAULT 0,
    created_at             TEXT NOT NULL,
    claimed_at             TEXT,
    claimed_by_incarnation INTEGER,
    acknowledged_at        TEXT,
    result                 TEXT,
    last_error             TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS inbox_idempotency
    ON inbox (recipient_agent_id, idempotency_key);
  CREATE INDEX IF NOT EXISTS inbox_pending
    ON inbox (recipient_agent_id, status);

  -- Filesystem grants and the audit log of every allow/deny decision.
  CREATE TABLE IF NOT EXISTS fs_grants (
    agent_id   TEXT NOT NULL REFERENCES agents(id),
    path       TEXT NOT NULL,
    access     TEXT NOT NULL,
    granted_by TEXT REFERENCES agents(id),
    created_at TEXT NOT NULL,
    PRIMARY KEY (agent_id, path)
  );
  CREATE TABLE IF NOT EXISTS fs_audit (
    at       TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    op       TEXT NOT NULL,
    path     TEXT NOT NULL,
    allowed  INTEGER NOT NULL,
    reason   TEXT NOT NULL
  );

  -- Listeners, and what each has already seen. The snapshot survives platform
  -- restarts, which is how files created while the platform was down get noticed.
  CREATE TABLE IF NOT EXISTS listeners (
    id               TEXT PRIMARY KEY,
    target_agent_id  TEXT NOT NULL REFERENCES agents(id),
    path             TEXT NOT NULL,
    events           TEXT NOT NULL,
    payload_template TEXT,
    state            TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    last_scan_at     TEXT,
    last_error       TEXT
  );
  CREATE TABLE IF NOT EXISTS listener_files (
    listener_id TEXT NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
    path        TEXT NOT NULL,
    mtime_ms    REAL NOT NULL,
    size        INTEGER NOT NULL,
    PRIMARY KEY (listener_id, path)
  );

  -- Durable workflows: progress, per-step state, and an append-only transition log.
  CREATE TABLE IF NOT EXISTS workflows (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    definition   TEXT NOT NULL,
    input        TEXT NOT NULL,
    status       TEXT NOT NULL,
    current_step INTEGER NOT NULL,
    output       TEXT,
    error        TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workflow_steps (
    workflow_id   TEXT NOT NULL REFERENCES workflows(id),
    idx           INTEGER NOT NULL,
    name          TEXT NOT NULL,
    status        TEXT NOT NULL,
    assignment    INTEGER NOT NULL DEFAULT 0,
    agent_id      TEXT REFERENCES agents(id),
    inbox_item_id TEXT REFERENCES inbox(id),
    result        TEXT,
    error         TEXT,
    started_at    TEXT,
    finished_at   TEXT,
    PRIMARY KEY (workflow_id, idx)
  );
  CREATE INDEX IF NOT EXISTS workflow_steps_item ON workflow_steps (inbox_item_id);
  CREATE TABLE IF NOT EXISTS workflow_events (
    workflow_id TEXT NOT NULL REFERENCES workflows(id),
    at          TEXT NOT NULL,
    event       TEXT NOT NULL,
    detail      TEXT NOT NULL
  );
  `,
];

/** Apply any migrations not yet recorded in `user_version`. Returns how many ran. */
export function migrate(db: Db, migrations: readonly string[] = MIGRATIONS): number {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > migrations.length) {
    throw new Error(`database schema version ${current} is newer than this code (${migrations.length})`);
  }
  for (let v = current; v < migrations.length; v++) {
    db.transaction(() => {
      db.exec(migrations[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return migrations.length - current;
}

/** Opens (and migrates) the platform database. Pass ":memory:" in tests. */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
