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
import { ListenerService, type FileEvent, type ListenerTarget, type RegisterOptions } from "../src/platform/listeners.js";
import { Supervisor } from "../src/platform/supervisor.js";
import toy from "../src/agents/toy.js";

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
  const toAgent = (id = agent.id): ListenerTarget => ({
    kind: "agent",
    agentId: id,
    payload: (e: FileEvent) => ({ event: e.event, path: e.path, listener: e.listener }),
  });
  /** Old-style registration: a listener named `name` enqueueing { event, path, listener }. */
  const watch = (name = "l", opts: Partial<RegisterOptions> = {}, svc = listeners) =>
    svc.register(name, { path: DIR, target: toAgent(), ...opts });

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
    watch();
    write("a.txt");
    listeners.scanAll();
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ status: "pending", payload: { event: "created", path: `${DIR}/a.txt` } });
  });

  it("ignores files that existed before registration unless includeExisting", () => {
    write("old.txt");
    watch();
    listeners.scanAll();
    expect(items()).toHaveLength(0);

    watch("second", { includeExisting: true });
    listeners.scanAll();
    expect(items()).toHaveLength(1);
  });

  it("watches subdirectories and skips in-progress *.tmp files", () => {
    watch();
    write("nested/deep/x.txt");
    write("partial.txt.abc.tmp");
    listeners.scanAll();
    expect(items().map((i) => (i.payload as { path: string }).path)).toEqual([`${DIR}/nested/deep/x.txt`]);
  });

  it("repeated scans do not create duplicate tasks", () => {
    watch();
    write("a.txt");
    for (let i = 0; i < 5; i++) listeners.scanAll();
    expect(items()).toHaveLength(1);
  });

  it("the inbox idempotency key still dedupes if the snapshot is lost", () => {
    watch();
    write("a.txt");
    listeners.scanAll();
    db.exec(`DELETE FROM listener_files`);
    listeners.scanAll();
    expect(items()).toHaveLength(1);
  });

  it("emits modified only when asked to", () => {
    watch("created-only");
    watch("both", { events: ["created", "modified"] });
    write("a.txt", "v1", 1_000);
    listeners.scanAll();
    write("a.txt", "version 2", 2_000);
    listeners.scanAll();

    const byListener = (name: string) =>
      items().filter((i) => (i.payload as { listener: string }).listener === name).map((i) => (i.payload as { event: string }).event);
    expect(byListener("created-only")).toEqual(["created"]);
    expect(byListener("both")).toEqual(["created", "modified"]);
  });

  it("a deleted and re-created file counts as created again", () => {
    watch();
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
    watch("l", {}, settling);
    write("fresh.txt");
    settling.scanAll();
    expect(items()).toHaveLength(0);
    utimesSync(join(root, DIR, "fresh.txt"), 1_000, 1_000);
    settling.scanAll();
    expect(items()).toHaveLength(1);
  });

  it("computes the payload with the target's function", () => {
    listeners.register("fn", {
      path: DIR,
      target: { kind: "agent", agentId: agent.id, payload: (e) => ({ task: "transform", input: { from: e.path, to: `~/out/${e.name}`, tags: [e.event] } }) },
    });
    write("r.txt");
    listeners.scanAll();
    expect(items()[0]).toMatchObject({
      payload: { task: "transform", input: { from: `${DIR}/r.txt`, to: "~/out/r.txt", tags: ["created"] } },
      idempotencyKey: expect.stringMatching(new RegExp(`^listener:fn:created:${DIR}/r.txt:`)),
    });
  });

  it("registrations and snapshots survive a platform restart; offline changes are caught", () => {
    watch();
    write("before.txt");
    listeners.scanAll();

    write("while-down.txt"); // no service running
    const restarted = new ListenerService(db, registry, fs, inbox, { settleMs: 0 });
    expect(restarted.list()).toHaveLength(1);
    watch("l", {}, restarted); // code re-registers its target on boot; the snapshot is kept
    restarted.scanAll();
    expect(items().map((i) => (i.payload as { path: string }).path)).toEqual([`${DIR}/before.txt`, `${DIR}/while-down.txt`]);
  });

  it("registration requires the target to have read access to the directory", () => {
    const other = registry.create("other");
    expect(() => watch("x", { target: toAgent(other.id) })).toThrow(/EACCES/);
    expect(() => watch("x", { path: `agents/${agent.id}`, target: toAgent(other.id) })).toThrow(/EACCES/);
    expect(watch("x", { path: "~", target: toAgent(other.id) }).path).toBe(`agents/${other.id}`);
  });

  it("stops firing when the target loses access, is deleted, or the listener is paused", () => {
    const l = watch();

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

  it("registration is an upsert by name: re-registering keeps the snapshot", () => {
    const first = watch("l");
    write("a.txt");
    listeners.scanAll();
    const again = watch("l", {}, new ListenerService(db, registry, fs, inbox, { settleMs: 0 }));
    expect(again.id).toBe(first.id);
    expect(listeners.list()).toHaveLength(1);
    listeners.scanAll();
    expect(items()).toHaveLength(1); // a.txt was already seen
  });

  it("changing the watched path resets the snapshot to that directory's contents", () => {
    const other = "shared/documents/other";
    mkdirSync(join(root, other), { recursive: true });
    writeFileSync(join(root, other, "existing.txt"), "x");
    fs.grant(agent.id, other, "read");
    watch("l");
    write("a.txt");
    listeners.scanAll();
    watch("l", { path: other });
    listeners.scanAll();
    expect(items()).toHaveLength(1); // existing.txt is part of the new baseline
    writeFileSync(join(root, other, "new.txt"), "y");
    listeners.scanAll();
    expect(items().map((i) => (i.payload as { path: string }).path)).toEqual([`${DIR}/a.txt`, `${other}/new.txt`]);
  });

  it("a stored listener with no target registered in this process is skipped, then catches up", () => {
    watch("l");
    const reborn = new ListenerService(db, registry, fs, inbox, { settleMs: 0 });
    write("a.txt");
    reborn.scanAll();
    expect(items()).toHaveLength(0);
    expect(reborn.getByName("l")!.lastError).toMatch(/no target registered/);
    watch("l", {}, reborn);
    reborn.scanAll();
    expect(items()).toHaveLength(1);
  });

  it("platform targets need no agent permission and get the idempotency key", () => {
    const fired: [FileEvent, string][] = [];
    const secret = "shared/artifacts/private";
    mkdirSync(join(root, secret), { recursive: true });
    listeners.register("platform", { path: secret, target: { kind: "platform", fire: (e, key) => fired.push([e, key]) } });
    expect(listeners.getByName("platform")!.targetAgentId).toBeNull();
    writeFileSync(join(root, secret, "x.txt"), "x");
    listeners.scanAll();
    listeners.scanAll();
    expect(fired).toHaveLength(1);
    expect(fired[0]![0]).toMatchObject({ listener: "platform", event: "created", path: `${secret}/x.txt`, name: "x.txt" });
    expect(fired[0]![1]).toMatch(new RegExp(`^listener:platform:created:${secret}/x.txt:`));
    expect(() => listeners.register("bad", { path: "~/x", target: { kind: "platform", fire: () => {} } })).toThrow(/needs an agent/);
  });

  it("a target that throws for one file doesn't block the others and isn't retried", () => {
    const errors: string[] = [];
    listeners.on("error", ({ path }) => errors.push(path));
    listeners.register("picky", {
      path: DIR,
      target: {
        kind: "agent",
        agentId: agent.id,
        payload: (e) => {
          if (e.name.startsWith("bad")) throw new Error("can't handle this one");
          return { path: e.path };
        },
      },
    });
    write("bad.txt");
    write("good.txt");
    listeners.scanAll();
    expect(listeners.getByName("picky")!.lastError).toMatch(/bad.txt: can't handle this one/);
    listeners.scanAll();
    expect(items().map((i) => (i.payload as { path: string }).path)).toEqual([`${DIR}/good.txt`]);
    expect(errors).toEqual([`${DIR}/bad.txt`]);
    expect(listeners.getByName("picky")!.lastError).toBeNull(); // describes the latest scan
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
    supervisor = new Supervisor(db, registry, { defaultModule: toy.moduleUrl, fsHandler: (id, req) => fs.handle(id, req) });
    const dispatcher = new Dispatcher(supervisor, inbox);
    const listeners = new ListenerService(db, registry, fs, inbox, { settleMs: 0 });
    const agent = registry.create("indexer");

    mkdirSync(join(root, DIR), { recursive: true });
    fs.grant(agent.id, DIR, "read");
    listeners.register("indexer", {
      path: DIR,
      target: { kind: "agent", agentId: agent.id, payload: (e) => ({ task: "transform", input: { from: e.path, to: `~/${e.name}` } }) },
    });

    writeFileSync(join(root, DIR, "doc.txt"), "hello");
    listeners.scanAll();
    expect(inbox.list(agent.id, "pending")).toHaveLength(1);

    await supervisor.start(agent.id);
    const deadline = Date.now() + 5_000;
    while (!dispatcher.isDrained(agent.id) && Date.now() < deadline) await sleep(10);
    expect(fs.handle(agent.id, { op: "read", path: "~/doc.txt" })).toBe("HELLO");
  });
});
