import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/platform/database.js";
import { AgentRegistry, type Agent } from "../src/platform/identity.js";
import { Inbox, type InboxItem } from "../src/platform/inbox.js";

describe("Inbox (storage, no processes)", () => {
  let registry: AgentRegistry;
  let inbox: Inbox;
  let a: Agent;
  let b: Agent;

  beforeEach(() => {
    const db = openDatabase(":memory:");
    registry = new AgentRegistry(db);
    inbox = new Inbox(db, registry, { maxAttempts: 2 });
    a = registry.create("a");
    b = registry.create("b");
  });

  it("stores messages as pending for the recipient identity", () => {
    const item = inbox.send(a.id, { x: 1 }, { senderAgentId: b.id });
    expect(item).toMatchObject({ recipientAgentId: a.id, senderAgentId: b.id, status: "pending", payload: { x: 1 } });
    expect(inbox.list(a.id, "pending")).toHaveLength(1);
    expect(inbox.list(b.id)).toHaveLength(0);
  });

  it("rejects unknown or deleted recipients and unknown senders", () => {
    expect(() => inbox.send("00000000-0000-0000-0000-000000000000", {})).toThrow();
    expect(() => inbox.send(a.id, {}, { senderAgentId: "nope" })).toThrow(/unknown sender/);
    registry.markDeleted(a.id);
    expect(() => inbox.send(a.id, {})).toThrow(/no active agent/);
  });

  it("dedupes by idempotency key per recipient", () => {
    const first = inbox.send(a.id, { n: 1 }, { idempotencyKey: "k" });
    const dup = inbox.send(a.id, { n: 2 }, { idempotencyKey: "k" });
    const other = inbox.send(b.id, { n: 3 }, { idempotencyKey: "k" });
    expect(dup.id).toBe(first.id);
    expect(other.id).not.toBe(first.id);
    expect(inbox.list(a.id)).toHaveLength(1);
  });

  it("claims FIFO and records the claiming incarnation", () => {
    const one = inbox.send(a.id, 1);
    const two = inbox.send(a.id, 2);
    expect(inbox.claimNext(a.id, 7)).toMatchObject({ id: one.id, status: "claimed", attempts: 1, claimedByIncarnation: 7 });
    expect(inbox.claimNext(a.id, 7)?.id).toBe(two.id);
    expect(inbox.claimNext(a.id, 7)).toBeUndefined();
  });

  it("only the incarnation holding the claim can complete it (fencing)", () => {
    const item = inbox.send(a.id, {});
    inbox.claimNext(a.id, 1);
    inbox.releaseClaims(a.id, 1); // incarnation 1 died
    inbox.claimNext(a.id, 2);
    expect(inbox.complete(item.id, 1, "late answer")).toBe(false);
    expect(inbox.complete(item.id, 2, "ok")).toBe(true);
    expect(inbox.get(item.id)).toMatchObject({ status: "completed", result: "ok" });
    expect(inbox.get(item.id)!.acknowledgedAt).not.toBeNull();
  });

  it("fail retries until attempts are exhausted", () => {
    const item = inbox.send(a.id, {});
    inbox.claimNext(a.id, 1);
    inbox.fail(item.id, 1, "boom");
    expect(inbox.get(item.id)).toMatchObject({ status: "pending", lastError: "boom" });
    inbox.claimNext(a.id, 1);
    inbox.fail(item.id, 1, "boom");
    expect(inbox.get(item.id)).toMatchObject({ status: "failed", attempts: 2 });
  });

  it("releasing a dead incarnation's claims only touches that incarnation", () => {
    inbox.send(a.id, 1);
    inbox.send(a.id, 2);
    const held = inbox.claimNext(a.id, 1)!;
    const other = inbox.claimNext(a.id, 2)!;
    expect(inbox.releaseClaims(a.id, 1)).toBe(1);
    expect(inbox.get(held.id)!.status).toBe("pending");
    expect(inbox.get(other.id)!.status).toBe("claimed");
  });

  it("a message that keeps killing its runtime ends up failed, not redelivered forever", () => {
    const item = inbox.send(a.id, {});
    for (let inc = 1; inc <= 2; inc++) {
      inbox.claimNext(a.id, inc);
      inbox.releaseClaims(a.id, inc);
    }
    expect(inbox.get(item.id)!.status).toBe("failed");
  });
});

describe("Inbox durability", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "inbox-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("pending and claimed messages survive a platform restart; stale claims can be released", () => {
    const path = join(dir, "platform.db");
    const db1 = openDatabase(path);
    const reg1 = new AgentRegistry(db1);
    const agent = reg1.create("a");
    const inbox1 = new Inbox(db1, reg1);
    inbox1.send(agent.id, "waiting");
    const claimed = inbox1.send(agent.id, "in flight");
    inbox1.claimNext(agent.id, 1); // claims "waiting"
    inbox1.claimNext(agent.id, 1); // claims "in flight"
    db1.close();

    const db2 = openDatabase(path);
    const inbox2 = new Inbox(db2, new AgentRegistry(db2));
    expect(inbox2.list(agent.id, "claimed")).toHaveLength(2);
    expect(inbox2.releaseAllClaims()).toBe(2);
    expect(inbox2.get(claimed.id)!.status).toBe("pending");
    db2.close();
  });
});

describe("Inbox settlement", () => {
  let db: Db;
  let registry: AgentRegistry;
  let inbox: Inbox;
  let a: Agent;
  let settled: InboxItem[];

  beforeEach(() => {
    db = openDatabase(":memory:");
    registry = new AgentRegistry(db);
    inbox = new Inbox(db, registry, { maxAttempts: 2 });
    a = registry.create("a");
    settled = [];
    inbox.on("settled", (item: InboxItem) => settled.push(item));
  });

  const tick = () => new Promise<void>((r) => setImmediate(r));

  it("complete emits settled (after the call returns, not synchronously)", async () => {
    const item = inbox.send(a.id, {});
    inbox.claimNext(a.id, 1);
    inbox.complete(item.id, 1, { ok: true });
    expect(settled).toHaveLength(0);
    await tick();
    expect(settled).toMatchObject([{ id: item.id, status: "completed", result: { ok: true } }]);
  });

  it("fail emits settled only when attempts run out", async () => {
    const item = inbox.send(a.id, {});
    inbox.claimNext(a.id, 1);
    inbox.fail(item.id, 1, "boom");
    await tick();
    expect(settled).toHaveLength(0); // back to pending: not final
    inbox.claimNext(a.id, 1);
    inbox.fail(item.id, 1, "boom again");
    await tick();
    expect(settled).toMatchObject([{ id: item.id, status: "failed", attempts: 2, lastError: "boom again" }]);
  });

  it("releaseClaims emits settled for each item it marks failed", async () => {
    const item = inbox.send(a.id, {});
    inbox.claimNext(a.id, 1);
    inbox.releaseClaims(a.id, 1); // attempt 1 of 2: back to pending
    await tick();
    expect(settled).toHaveLength(0);
    inbox.claimNext(a.id, 2);
    inbox.releaseClaims(a.id, 2);
    await tick();
    expect(settled).toMatchObject([{ id: item.id, status: "failed", lastError: "runtime exited while processing" }]);
  });

  it("releaseAllClaims emits settled for each item it marks failed", async () => {
    const exhausted = inbox.send(a.id, "x");
    const fresh = inbox.send(a.id, "y");
    inbox.claimNext(a.id, 1);
    inbox.fail(exhausted.id, 1, "boom");
    inbox.claimNext(a.id, 1); // FIFO: "x" again, its last attempt (2 of 2)
    inbox.claimNext(a.id, 1); // "y", attempt 1 of 2
    expect(inbox.releaseAllClaims()).toBe(2);
    await tick();
    expect(settled.map((i) => [i.id, i.status])).toEqual([[exhausted.id, "failed"]]);
    expect(inbox.get(fresh.id)!.status).toBe("pending");
  });

  it("a non-retryable failure marks the item failed on the first attempt", async () => {
    const item = inbox.send(a.id, {});
    inbox.claimNext(a.id, 1);
    expect(inbox.fail(item.id, 1, "EACCES: nope", { retryable: false })).toBe(true);
    expect(inbox.get(item.id)).toMatchObject({ status: "failed", attempts: 1, lastError: "EACCES: nope" });
    await tick();
    expect(settled).toMatchObject([{ id: item.id, status: "failed" }]);
  });

  it("waitFor resolves right away for an already-settled item", async () => {
    const item = inbox.send(a.id, {});
    inbox.claimNext(a.id, 1);
    inbox.complete(item.id, 1, 42);
    // Fresh Inbox instance (like a new platform process): no event will ever fire.
    const other = new Inbox(db, registry);
    await expect(other.waitFor(item.id)).resolves.toMatchObject({ status: "completed", result: 42 });
  });

  it("waitFor waits for settlement, ignoring non-final transitions", async () => {
    const item = inbox.send(a.id, {});
    let done: InboxItem | undefined;
    void inbox.waitFor(item.id).then((i) => (done = i));
    inbox.claimNext(a.id, 1);
    inbox.fail(item.id, 1, "transient");
    await tick();
    expect(done).toBeUndefined();
    inbox.claimNext(a.id, 1);
    inbox.complete(item.id, 1, "ok");
    await tick();
    expect(done).toMatchObject({ status: "completed", result: "ok" });
  });

  it("waitFor rejects for an unknown item", async () => {
    await expect(inbox.waitFor("nope")).rejects.toThrow(/unknown inbox item/);
  });
});
