/**
 * The library API, imported only from the public entry point (package.json "exports").
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import {
  createPlatform,
  TaskFailedError,
  TaskInputError,
  type AgentHandle,
  type Platform,
  type PlatformEventName,
  type TaskHandle,
} from "mini-agent-runtime";
import notes from "./fixtures/agents/notes.js";

let dataDir: string;
const open: Platform[] = [];
const boot = (opts: { maxAttempts?: number } = {}) => {
  const p = createPlatform({ dataDir, inbox: { maxAttempts: opts.maxAttempts } });
  open.push(p);
  return p;
};

beforeEach(() => (dataDir = mkdtempSync(join(tmpdir(), "platform-"))));
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("createPlatform lifecycle", () => {
  it("boots, registers, starts, runs a task, and closes", async () => {
    const platform = boot();
    const agent = platform.agent("notes", notes);
    expect(agent.status()).toBeUndefined(); // nothing runs before start()

    await platform.start();
    expect(agent.status()).toMatchObject({ state: "running", incarnation: 1 });

    const out = await agent.send("save", { name: "a", text: "hello" }).result();
    expect(out).toMatchObject({ path: `agents/${agent.id}/notes/a.txt`, bytes: 5, attempt: 1, incarnation: 1 });
    expect(readFileSync(join(dataDir, out.path), "utf8")).toBe("hello");

    await platform.close();
    await platform.close(); // idempotent
    expect(() => agent.send("save", { name: "b", text: "" })).toThrow(/closed/);
  });

  it("supports `await using`", async () => {
    let pid: number | undefined;
    {
      await using platform = createPlatform({ dataDir });
      const agent = platform.agent("notes", notes);
      await platform.start();
      pid = agent.status()!.pid;
    }
    expect(() => process.kill(pid!, 0)).toThrow(); // runtime is gone
  });

  it("a second platform on the same dataDir recovers the first one's state", async () => {
    const first = boot();
    const a1 = first.agent("notes", notes, { autostart: false });
    await first.start();
    const pending = a1.send("save", { name: "later", text: "queued while offline" });
    await first.close();

    const second = boot();
    const a2 = second.agent("notes", notes);
    expect(a2.id).toBe(a1.id);
    const reattached = second.task<{ path: string }>(pending.id);
    expect(reattached.status()).toMatchObject({ status: "pending", task: "save", agent: "notes" });

    await second.start();
    await expect(reattached.result()).resolves.toMatchObject({ path: `agents/${a1.id}/notes/later.txt` });
  });

  it("refuses to start agents before platform.start(), and to start twice", async () => {
    const platform = boot();
    const agent = platform.agent("notes", notes, { autostart: false });
    await expect(agent.start()).rejects.toThrow(/platform.start\(\)/);
    await platform.start();
    await expect(platform.start()).rejects.toThrow(/already started/);
    await agent.start();
    expect(agent.status()!.state).toBe("running");
  });

  it("an agent registered after start() is started right away", async () => {
    const platform = boot();
    await platform.start();
    const agent = platform.agent("late", notes);
    await expect(agent.send("save", { name: "x", text: "y" }).result()).resolves.toMatchObject({ bytes: 1 });
  });
});

describe("AgentHandle", () => {
  it("identity is stable across boots; incarnations continue", async () => {
    const first = boot();
    const a1 = first.agent("notes", notes);
    await first.start();
    await first.close();

    const second = boot();
    const a2 = second.agent("notes", notes);
    await second.start();
    expect(a2.id).toBe(a1.id);
    expect(a2.status()!.incarnation).toBe(2);
    expect(a2.history().map((r) => r.incarnation)).toEqual([1, 2]);
    expect(a2.history()[0]!.exitedAt).not.toBeNull();
  });

  it("registering the same name twice in one process is an error", () => {
    const platform = boot();
    platform.agent("notes", notes);
    expect(() => platform.agent("notes", notes)).toThrow(/already registered/);
  });

  it("grant / revoke control what the agent's tasks can touch", async () => {
    const platform = boot();
    const writer = platform.agent("writer", notes);
    const reader = platform.agent("reader", notes);
    await platform.start();
    const { path } = await writer.send("save", { name: "memo", text: "secret" }).result();

    await expect(reader.send("read", { path }).result()).rejects.toThrow(TaskFailedError);
    reader.grant(`agents/${writer.id}/notes`, "read");
    await expect(reader.send("read", { path }).result()).resolves.toBe("secret");
    reader.revoke(`agents/${writer.id}/notes`);
    await expect(reader.send("read", { path }).result()).rejects.toThrow(/EACCES/);
  });

  it("stop / restart / inbox", async () => {
    const platform = boot();
    const agent = platform.agent("notes", notes);
    await platform.start();
    await agent.stop();
    expect(agent.status()!.state).toBe("exited");
    const t = agent.send("save", { name: "n", text: "t" });
    expect(agent.inbox("pending").map((i) => i.id)).toEqual([t.id]);
    expect((await agent.restart()).incarnation).toBe(2);
    await t.result();
    expect(agent.inbox()).toMatchObject([{ id: t.id, status: "completed", task: "save", input: { name: "n", text: "t" } }]);
  });
});

describe("send and TaskHandle", () => {
  let platform: Platform;
  let agent: AgentHandle<typeof notes>;
  beforeEach(async () => {
    platform = boot();
    agent = platform.agent("notes", notes, { restart: { restart: "on-crash", backoffMs: 10 } });
    await platform.start();
  });

  it("validates input in the caller's process; nothing is enqueued", () => {
    // @ts-expect-error text is required
    expect(() => agent.send("save", { name: "x" })).toThrow(TaskInputError);
    // @ts-expect-error no such task
    expect(() => agent.send("delete", {})).toThrow(/unknown task/);
    expect(agent.inbox()).toHaveLength(0);
  });

  it("result() rejects with TaskFailedError after a non-retryable failure", async () => {
    const err = await agent.send("reject", { reason: "nope" }).result().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskFailedError);
    expect(err).toMatchObject({ task: "reject", agent: "notes", attempts: 1, lastError: expect.stringMatching(/nope/) });
  });

  it("result() survives a runtime crash and redelivery", async () => {
    const handle = agent.send("save", { name: "slow", text: "x", delayMs: 300 });
    platform.events.once("task.delivered", () => setTimeout(() => process.kill(agent.status()!.pid, "SIGKILL"), 50));
    const out = await handle.result();
    expect(out).toMatchObject({ attempt: 2, incarnation: 2 });
    expect(handle.status()).toMatchObject({ status: "completed", attempts: 2 });
  });

  it("an idempotency key returns the original task", () => {
    const a = agent.send("save", { name: "k", text: "1" }, { idempotencyKey: "k1" });
    const b = agent.send("save", { name: "k", text: "2" }, { idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
  });

  it("platform.task() rejects unknown ids", () => {
    expect(() => platform.task("nope")).toThrow(/unknown task/);
  });

  it("types: task names, inputs, and outputs come from the definition", () => {
    expectTypeOf(agent.send).parameter(0).toEqualTypeOf<"save" | "read" | "reject">();
    expectTypeOf(agent.send<"save">).parameter(1).toEqualTypeOf<{ name: string; text: string; delayMs?: number | undefined }>();
    expectTypeOf(agent.send("read", { path: "x" })).toEqualTypeOf<TaskHandle<string>>();
    expectTypeOf(agent.send("save", { name: "a", text: "b" }).result()).resolves.toEqualTypeOf<{
      attempt: number;
      incarnation: number;
      path: string;
      bytes: number;
    }>();
    expectTypeOf(agent.send("reject", { reason: "r" })).toEqualTypeOf<TaskHandle<never>>();
  });
});

describe("platform.events", () => {
  it("re-emits kernel events with agent names", async () => {
    const platform = boot();
    const seen: string[] = [];
    platform.events.onAny((name: PlatformEventName, e) => seen.push(`${name}:${"agent" in e ? e.agent : ""}`));
    const denied: unknown[] = [];
    platform.events.on("fs.denied", (e) => denied.push(e));

    const writer = platform.agent("writer", notes, { restart: { restart: "on-crash", backoffMs: 10 } });
    const reader = platform.agent("reader", notes);
    await platform.start();
    const { path } = await writer.send("save", { name: "m", text: "t" }).result();
    await reader.send("read", { path }).result().catch(() => {});

    process.kill(writer.status()!.pid, "SIGKILL");
    await new Promise<void>((r) => platform.events.once("agent.ready", () => r()));

    expect(seen).toEqual(
      expect.arrayContaining([
        "agent.ready:writer",
        "agent.ready:reader",
        "task.enqueued:writer",
        "task.delivered:writer",
        "task.settled:writer",
        "task.attempt-failed:reader",
        "task.settled:reader",
        "fs.denied:reader",
        "agent.exited:writer",
        "agent.restarting:writer",
      ]),
    );
    expect(denied).toEqual([{ agent: "reader", agentId: reader.id, op: "read", path, reason: "no grant" }]);
  });
});
