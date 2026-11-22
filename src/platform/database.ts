import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database.Database;

/**
 * Opens (and migrates) the platform database. Pass ":memory:" in tests.
 *
 * Two tables, deliberately separate:
 *   agents   — persistent logical identities (survive everything)
 *   runtimes — each process incarnation of an agent (ephemeral facts, kept as history)
 */
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL UNIQUE,
      configuration   TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL
    );

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
  `);
  return db;
}
