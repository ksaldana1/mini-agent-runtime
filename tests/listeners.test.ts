import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/platform/database.js";
import { Dispatcher } from "../src/platform/dispatcher.js";
import { AgentFilesystem } from "../src/platform/filesystem.js";
import { AgentRegistry, type Agent } from "../src/platform/identity.js";
import { Inbox } from "../src/platform/inbox.js";
import { ListenerService } from "../src/platform/listeners.js";
import { Supervisor } from "../src/platform/supervisor.js";

const DIR = "shared/documents/in";

describe("ListenerService (scan-based, no runtimes)", () => {
  let root: string;
  let db: Db;
  let registry: AgentRegistry;
  let fs: AgentFilesystem;
  let inbox: Inbox;
  let listeners: ListenerService;
  let agent: Agent;

  const write = (name: string, content = name, mtimeSec?: number) => {
    const p = join(root, DIR, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
  };
  const items = () => inbox.list(agent.id);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "listeners-"));
    db = openDatabase(":memory:");
    registry = new AgentRegistry(db);
    fs = new AgentFilesystem(db, registry, root);
    inbox = new Inbox(db, registry);
    listeners = new ListenerService(db, registry, fs, inbox, { settleMs: 0 });
    agent = registry.create("watcher");
    mkdirSync(join(root, DIR), { recursive: true });
    fs.grant(agent.id, DIR, "read");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("enqueues a task when a file is created, even though no runtime exists", () => {
    listeners.register(agent.id, DIR);
    write("a.txt");
    listeners.scanAll();
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ status: "pending", payload: { event: "created", path: `${DIR}/a.txt` } });
  });

  it("ignores files that existed before registration unless includeExisting", () => {
    write("old.txt");
    listeners.register(agent.id, DIR);
    listeners.scanAll();
    expect(items()).toHaveLength(0);

    listeners.register(agent.id, DIR, { includeExisting: true });
    listeners.scanAll();
    expect(items()).toHaveLength(1);
  });

  it("watches subdirectories and skips in-progress *.tmp files", () => {
    listeners.register(agent.id, DIR);
    write("nested/deep/x.txt");
    write("partial.txt.abc.tmp");
    listeners.scanAll();
    expect(items().map((i) => (i.payload as { path: string }).path)).toEqual([`${DIR}/nested/deep/x.txt`]);
  });

  it("repeated scans do not create duplicate tasks", () => {
    listeners.register(agent.id, DIR);
    write("a.txt");
    for (let i = 0; i < 5; i++) listeners.scanAll();
    expect(items()).toHaveLength(1);
  });

  it("the inbox idempotency key still dedupes if the snapshot is lost", () => {
    listeners.register(agent.id, DIR);
    write("a.txt");
    listeners.scanAll();
    db.exec(`DELETE FROM listener_files`);
    listeners.scanAll();
    expect(items()).toHaveLength(1);
  });

  it("emits modified only when asked to", () => {
    const createdOnly = listeners.register(agent.id, DIR);
    const both = listeners.register(agent.id, DIR, { events: ["created", "modified"] });
    write("a.txt", "v1", 1_000);
    listeners.scanAll();
    write("a.txt", "version 2", 2_000);
    listeners.scanAll();

    const byListener = (id: string) =>
      items().filter((i) => (i.payload as { listenerId: string }).listenerId === id).map((i) => (i.payload as { event: string }).event);
    expect(byListener(createdOnly.id)).toEqual(["created"]);
    expect(byListener(both.id)).toEqual(["created", "modified"]);
  });

  it("a deleted and re-created file counts as created again", () => {
    listeners.register(agent.id, DIR);
    write("a.txt", "one", 1_000);
    listeners.scanAll();
    unlinkSync(join(root, DIR, "a.txt"));
    listeners.scanAll();
    write("a.txt", "two", 2_000);
    listeners.scanAll();
    expect(items()).toHaveLength(2);
  });

  it("waits for recently modified files to settle", () => {
    const settling = new ListenerService(db, registry, fs, inbox, { settleMs: 60_000 });
    settling.register(agent.id, DIR);
    write("fresh.txt");
    settling.scanAll();
    expect(items()).toHaveLength(0);
    utimesSync(join(root, DIR, "fresh.txt"), 1_000, 1_000);
    settling.scanAll();
    expect(items()).toHaveLength(1);
  });

  it("renders the payload template", () => {
    listeners.register(agent.id, DIR, { payloadTemplate: { action: "transform", from: "{{path}}", to: "~/out/{{name}}", tags: ["{{event}}"] } });
    write("r.txt");
    listeners.scanAll();
    expect(items()[0]!.payload).toEqual({ action: "transform", from: `${DIR}/r.txt`, to: "~/out/r.txt", tags: ["created"] });
  });

  it("registrations and snapshots survive a platform restart; offline changes are caught", () => {
    listeners.register(agent.id, DIR);
    write("before.txt");
    listeners.scanAll();

    write("while-down.txt"); // no service running
    const restarted = new ListenerService(db, registry, fs, inbox, { settleMs: 0 });
    expect(restarted.list()).toHaveLength(1);
    restarted.scanAll();
    expect(items().map((i) => (i.payload as { path: string }).path)).toEqual([`${DIR}/before.txt`, `${DIR}/while-down.txt`]);
  });

  it("registration requires the target to have read access to the directory", () => {
    const other = registry.create("other");
    expect(() => listeners.register(other.id, DIR)).toThrow(/EACCES/);
    expect(() => listeners.register(other.id, `agents/${agent.id}`)).toThrow(/EACCES/);
    expect(listeners.register(other.id, "~").path).toBe(`agents/${other.id}`);
  });

  it("stops firing when the target loses access, is deleted, or the listener is paused", () => {
    const l = listeners.register(agent.id, DIR);

    listeners.setState(l.id, "paused");
    write("p.txt");
    listeners.scanAll();
    expect(items()).toHaveLength(0);
    listeners.setState(l.id, "active");
    listeners.scanAll();
    expect(items()).toHaveLength(1); // caught up after resume

    fs.revoke(agent.id, DIR);
    write("r.txt");
    listeners.scanAll();
    expect(items()).toHaveLength(1);
    expect(listeners.get(l.id)!.lastError).toMatch(/lost read access/);

    fs.grant(agent.id, DIR, "read");
    registry.markDeleted(agent.id);
    listeners.scanAll();
    expect(listeners.get(l.id)!.lastError).toMatch(/not active/);
  });
});

describe("Listener → inbox → runtime, end to end", () => {
  let root: string;
  let db: Db;
  let supervisor: Supervisor;

  afterEach(async () => {
    await supervisor.stopAll();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a file created while the agent is offline is processed once it starts", async () => {
    root = mkdtempSync(join(tmpdir(), "listeners-e2e-"));
    db = openDatabase(":memory:");
    const registry = new AgentRegistry(db);
    const fs = new AgentFilesystem(db, registry, root);
    const inbox = new Inbox(db, registry);
    supervisor = new Supervisor(db, registry, { fsHandler: (id, req) => fs.handle(id, req) });
    const dispatcher = new Dispatcher(supervisor, inbox);
    const listeners = new ListenerService(db, registry, fs, inbox, { settleMs: 0 });
    const agent = registry.create("indexer");

    mkdirSync(join(root, DIR), { recursive: true });
    fs.grant(agent.id, DIR, "read");
    listeners.register(agent.id, DIR, { payloadTemplate: { action: "transform", from: "{{path}}", to: "~/{{name}}" } });

    writeFileSync(join(root, DIR, "doc.txt"), "hello");
    listeners.scanAll();
    expect(inbox.list(agent.id, "pending")).toHaveLength(1);

    await supervisor.start(agent.id);
    const deadline = Date.now() + 5_000;
    while (!dispatcher.isDrained(agent.id) && Date.now() < deadline) await sleep(10);
    expect(fs.handle(agent.id, { op: "read", path: "~/doc.txt" })).toBe("HELLO");
  });
});
