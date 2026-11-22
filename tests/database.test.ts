import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, openDatabase } from "../src/platform/database.js";

const tables = (db: Database.Database) =>
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as { name: string }[]).map((r) => r.name);

describe("schema migrations", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "db-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("a fresh database gets the whole schema and the latest user_version", () => {
    const db = openDatabase(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(tables(db)).toEqual(
      expect.arrayContaining(["agents", "runtimes", "inbox", "fs_grants", "fs_audit", "listeners", "listener_files", "workflows", "workflow_steps", "workflow_events"]),
    );
    db.close();
  });

  it("is idempotent: reopening applies nothing and keeps data", () => {
    const path = join(dir, "p.db");
    const db1 = openDatabase(path);
    db1.prepare(`INSERT INTO agents VALUES ('a', 'a', '{}', 'now', 'active')`).run();
    expect(migrate(db1)).toBe(0);
    db1.close();

    const db2 = openDatabase(path);
    expect(migrate(db2)).toBe(0);
    expect(db2.prepare(`SELECT COUNT(*) AS n FROM agents`).get()).toEqual({ n: 1 });
    db2.close();
  });

  it("adopts a pre-migration database (tables present, user_version 0)", () => {
    const path = join(dir, "legacy.db");
    const legacy = new Database(path);
    legacy.exec(`CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, configuration TEXT NOT NULL,
                                      created_at TEXT NOT NULL, lifecycle_state TEXT NOT NULL);
                 INSERT INTO agents VALUES ('a', 'a', '{}', 'now', 'active');`);
    legacy.close();

    const db = openDatabase(path);
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(db.prepare(`SELECT name FROM agents`).all()).toEqual([{ name: "a" }]);
    db.close();
  });

  it("applies only the migrations that are missing, in order", () => {
    const db = new Database(":memory:");
    const steps = [`CREATE TABLE t (a INTEGER)`, `ALTER TABLE t ADD COLUMN b INTEGER`];
    expect(migrate(db, steps.slice(0, 1))).toBe(1);
    expect(migrate(db, steps)).toBe(1);
    expect(migrate(db, steps)).toBe(0);
    expect(db.prepare(`SELECT name FROM pragma_table_info('t')`).all()).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("refuses a database from newer code", () => {
    const db = new Database(":memory:");
    db.pragma(`user_version = ${MIGRATIONS.length + 1}`);
    expect(() => migrate(db)).toThrow(/newer than this code/);
  });

  it("a failing migration rolls back and leaves user_version unchanged", () => {
    const db = new Database(":memory:");
    expect(() => migrate(db, [`CREATE TABLE ok (a INTEGER); CREATE TABLE ok (a INTEGER)`])).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(tables(db)).toEqual([]);
  });
});
