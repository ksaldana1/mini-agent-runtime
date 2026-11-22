import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/platform/database.js";
import { AgentRegistry, type Agent } from "../src/platform/identity.js";
import { Supervisor, type RuntimeInfo } from "../src/platform/supervisor.js";

describe("Supervisor + runtime processes", () => {
  let db: Db;
  let registry: AgentRegistry;
  let supervisor: Supervisor;
  let agent: Agent;

  beforeEach(() => {
    db = openDatabase(":memory:");
    registry = new AgentRegistry(db);
    supervisor = new Supervisor(db, registry);
    agent = registry.create("agent-a");
  });

  afterEach(async () => {
    await supervisor.stopAll();
    db.close();
  });

  it("starts a separate OS process that knows its agent identity", async () => {
    const rt = await supervisor.start(agent.id);
    expect(rt.pid).not.toBe(process.pid);
    expect(rt.state).toBe("running");

    const pong = await supervisor.ping(agent.id);
    expect(pong).toMatchObject({ agentId: agent.id, pid: rt.pid });
  });

  it("round-trips a TASK", async () => {
    await supervisor.start(agent.id);
    const result = await supervisor.sendTask(agent.id, { text: "hi" });
    expect(result).toMatchObject({ output: "HI", handledBy: agent.id });
  });

  it("restart keeps the agent id but changes the pid and incarnation", async () => {
    const first = await supervisor.start(agent.id);
    const second = await supervisor.restart(agent.id);

    expect(second.agentId).toBe(first.agentId);
    expect(second.pid).not.toBe(first.pid);
    expect(second.incarnation).toBe(first.incarnation + 1);
    expect((await supervisor.ping(agent.id)).agentId).toBe(agent.id);

    const history = supervisor.history(agent.id);
    expect(history.map((h) => h.pid)).toEqual([first.pid, second.pid]);
    expect(history[0]).toMatchObject({ exitCode: 0 });
  });

  it("detects a crashed runtime and can start a new incarnation", async () => {
    const first = await supervisor.start(agent.id);
    const exited = new Promise<RuntimeInfo>((r) => supervisor.once("runtime-exit", r));
    process.kill(first.pid, "SIGKILL");

    expect(await exited).toMatchObject({ pid: first.pid, state: "crashed" });
    expect(supervisor.history(agent.id)[0]).toMatchObject({ exitSignal: "SIGKILL" });

    const second = await supervisor.start(agent.id);
    expect(second.incarnation).toBe(2);
  });

  it("rejects in-flight requests when the runtime dies", async () => {
    const rt = await supervisor.start(agent.id);
    const pending = supervisor.ping(agent.id);
    process.kill(rt.pid, "SIGKILL");
    // Either the PONG wins the race or the request is rejected — it must never hang.
    await pending.catch((e: Error) => expect(e.message).toMatch(/exited/));
  });

  it("refuses a second live runtime for the same agent", async () => {
    await supervisor.start(agent.id);
    await expect(supervisor.start(agent.id)).rejects.toThrow(/already has a live runtime/);
  });

  it("refuses to start a deleted agent", async () => {
    registry.markDeleted(agent.id);
    await expect(supervisor.start(agent.id)).rejects.toThrow(/deleted/);
  });
});
