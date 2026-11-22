import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/platform/database.js";
import { Dispatcher } from "../src/platform/dispatcher.js";
import { AgentFilesystem } from "../src/platform/filesystem.js";
import { AgentRegistry, type Agent } from "../src/platform/identity.js";
import { Inbox } from "../src/platform/inbox.js";
import { Supervisor } from "../src/platform/supervisor.js";

async function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

describe("Dispatcher: push delivery from inbox to runtimes", () => {
  let db: Db;
  let supervisor: Supervisor;
  let inbox: Inbox;
  let dispatcher: Dispatcher;
  let agent: Agent;

  beforeEach(() => {
    db = openDatabase(":memory:");
    const registry = new AgentRegistry(db);
    supervisor = new Supervisor(db, registry);
    inbox = new Inbox(db, registry);
    dispatcher = new Dispatcher(supervisor, inbox);
    agent = registry.create("agent-a");
  });

  afterEach(async () => {
    await supervisor.stopAll();
    db.close();
  });

  it("messages sent while the agent is offline are delivered after it starts", async () => {
    inbox.send(agent.id, { text: "a" });
    inbox.send(agent.id, { text: "b" });
    await sleep(50);
    expect(inbox.list(agent.id, "pending")).toHaveLength(2); // nobody to deliver to

    await supervisor.start(agent.id);
    await until(() => inbox.list(agent.id, "completed").length === 2);
    expect(inbox.list(agent.id).map((i) => (i.result as { output: string }).output)).toEqual(["A", "B"]);
  });

  it("delivers immediately when the agent is already running", async () => {
    await supervisor.start(agent.id);
    const item = inbox.send(agent.id, { text: "now" });
    await until(() => inbox.get(item.id)?.status === "completed");
  });

  it("keeps at most one item in flight per agent", async () => {
    await supervisor.start(agent.id);
    for (let i = 0; i < 4; i++) inbox.send(agent.id, { delayMs: 30 });
    let maxClaimed = 0;
    await until(() => {
      maxClaimed = Math.max(maxClaimed, inbox.list(agent.id, "claimed").length);
      return dispatcher.isDrained(agent.id);
    });
    expect(maxClaimed).toBe(1);
  });

  it("redelivers to the next incarnation when the runtime crashes mid-task", async () => {
    const first = await supervisor.start(agent.id);
    const item = inbox.send(agent.id, { text: "slow", delayMs: 300 });
    await until(() => inbox.get(item.id)?.status === "claimed");

    process.kill(first.pid, "SIGKILL");
    await until(() => supervisor.status(agent.id)?.state === "crashed");
    expect(inbox.get(item.id)!.status).toBe("pending");

    const second = await supervisor.start(agent.id);
    await until(() => inbox.get(item.id)?.status === "completed");
    expect(inbox.get(item.id)).toMatchObject({ attempts: 2, result: { pid: second.pid } });
  });

  it("retries an erroring task, then marks it failed", async () => {
    await supervisor.start(agent.id);
    const item = inbox.send(agent.id, { fail: true });
    await until(() => inbox.get(item.id)?.status === "failed");
    expect(inbox.get(item.id)).toMatchObject({ attempts: 3, lastError: expect.stringMatching(/asked to fail/) });
  });

  it("fails a task with an invalid payload after one attempt (non-retryable)", async () => {
    await supervisor.start(agent.id);
    const events: { retryable: boolean; willRetry: boolean }[] = [];
    dispatcher.on("failed", (e) => events.push(e));
    const item = inbox.send(agent.id, { action: "transform", from: 42 });
    await until(() => inbox.get(item.id)?.status === "failed");
    expect(inbox.get(item.id)).toMatchObject({ attempts: 1, lastError: expect.stringMatching(/invalid task payload/) });
    expect(events).toMatchObject([{ retryable: false, willRetry: false }]);
  });
});

describe("Dispatcher: permission denials are permanent", () => {
  let root: string;
  let db: Db;
  let supervisor: Supervisor;

  beforeEach(() => (root = mkdtempSync(join(tmpdir(), "dispatch-fs-"))));
  afterEach(async () => {
    await supervisor.stopAll();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("an EACCES from the filesystem fails the task after one attempt", async () => {
    db = openDatabase(":memory:");
    const registry = new AgentRegistry(db);
    const fs = new AgentFilesystem(db, registry, root);
    const inbox = new Inbox(db, registry);
    supervisor = new Supervisor(db, registry, { fsHandler: (id, req) => fs.handle(id, req) });
    new Dispatcher(supervisor, inbox);
    const agent = registry.create("snoop");

    await supervisor.start(agent.id);
    const item = inbox.send(agent.id, { action: "fs", request: { op: "read", path: "shared/documents/secret.txt" } });
    await until(() => inbox.get(item.id)?.status === "failed");
    expect(inbox.get(item.id)).toMatchObject({ attempts: 1, lastError: expect.stringMatching(/EACCES/) });
    expect(fs.auditLog(agent.id).filter((e) => !e.allowed)).toHaveLength(1);
  });
});

describe("Platform restart recovery", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "dispatch-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("releases stale claims and closes out stale runtime records on startup", async () => {
    const path = join(dir, "platform.db");

    // Simulate a platform that died with a runtime holding a claim.
    const db1 = openDatabase(path);
    const reg1 = new AgentRegistry(db1);
    const agent = reg1.create("agent-a");
    db1.prepare(`INSERT INTO runtimes (agent_id, incarnation, pid, started_at) VALUES (?, 1, 99999, ?)`).run(
      agent.id,
      new Date().toISOString(),
    );
    const inbox1 = new Inbox(db1, reg1);
    const item = inbox1.send(agent.id, { text: "orphaned" });
    inbox1.claimNext(agent.id, 1);
    db1.close();

    // New platform process.
    const db2 = openDatabase(path);
    const reg2 = new AgentRegistry(db2);
    const supervisor = new Supervisor(db2, reg2);
    const inbox2 = new Inbox(db2, reg2);
    const dispatcher = new Dispatcher(supervisor, inbox2);

    // Constructors don't recover anything; recovery is explicit.
    expect(supervisor.history(agent.id)[0]).toMatchObject({ exitSignal: null, exitedAt: null });
    expect(inbox2.get(item.id)!.status).toBe("claimed");

    expect(supervisor.recover()).toBe(1);
    expect(dispatcher.recover()).toBe(1);
    expect(supervisor.recover()).toBe(0); // idempotent
    expect(dispatcher.recover()).toBe(0);
    expect(supervisor.history(agent.id)[0]).toMatchObject({ exitSignal: "PLATFORM_RESTART" });

    const rt = await supervisor.start(agent.id);
    expect(rt.incarnation).toBe(2);
    await until(() => inbox2.get(item.id)?.status === "completed");
    // A live runtime of this process is not "recovered".
    expect(supervisor.recover()).toBe(0);
    expect(supervisor.history(agent.id)[1]).toMatchObject({ exitedAt: null });

    await supervisor.stopAll();
    db2.close();
  });
});
