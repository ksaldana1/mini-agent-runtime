import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/platform/database.js";
import { AgentRegistry, type Agent } from "../src/platform/identity.js";
import { Supervisor, TaskError } from "../src/platform/supervisor.js";
import probe from "./fixtures/agents/probe.js";

const fixture = (name: string) => pathToFileURL(new URL(`./fixtures/agents/${name}`, import.meta.url).pathname).href;

/** The generic runtime host: loads an agent module named in INIT and runs its tasks. */
describe("runtime host", () => {
  let db: Db;
  let registry: AgentRegistry;
  let supervisor: Supervisor;
  let agent: Agent;

  beforeEach(() => {
    db = openDatabase(":memory:");
    registry = new AgentRegistry(db);
    supervisor = new Supervisor(db, registry);
    agent = registry.create("probe");
    supervisor.setModule(agent.id, probe.moduleUrl);
  });

  afterEach(async () => {
    await supervisor.close();
    db.close();
  });

  const failure = async (p: Promise<unknown>): Promise<TaskError> => {
    const err = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TaskError);
    return err as TaskError;
  };

  it("runs a task with validated input and a context", async () => {
    const rt = await supervisor.start(agent.id);
    const result = await supervisor.sendTask(agent.id, "whoami", {}, { taskId: "task-1", attempt: 2 });
    expect(result).toEqual({
      greeting: "hi", // schema default applied in the runtime
      agent: { id: agent.id, name: "probe", incarnation: 1 },
      taskId: "task-1",
      attempt: 2,
      pid: rt.pid,
    });
  });

  it("an unknown task name is a non-retryable error", async () => {
    await supervisor.start(agent.id);
    const err = await failure(supervisor.sendTask(agent.id, "nope", {}));
    expect(err).toMatchObject({ retryable: false, message: expect.stringMatching(/unknown task "nope" \(this agent has: whoami, boom/) });
  });

  it("invalid input is a non-retryable error and never reaches the handler", async () => {
    await supervisor.start(agent.id);
    const err = await failure(supervisor.sendTask(agent.id, "read", { path: 42 }));
    expect(err).toMatchObject({ retryable: false, message: expect.stringMatching(/invalid input for task "read"[\s\S]*path/) });
  });

  it("a throwing handler is retryable; a PermanentError is not", async () => {
    await supervisor.start(agent.id);
    expect(await failure(supervisor.sendTask(agent.id, "boom", {}))).toMatchObject({
      retryable: true,
      message: expect.stringMatching(/transient trouble/),
    });
    expect(await failure(supervisor.sendTask(agent.id, "permanent", {}))).toMatchObject({
      retryable: false,
      message: expect.stringMatching(/PermanentError: this will never work/),
    });
    // The runtime survives handler errors.
    expect(supervisor.status(agent.id)!.state).toBe("running");
  });

  it("refuses to start a module whose default export isn't an agent definition", async () => {
    supervisor.setModule(agent.id, fixture("bad-export.ts"));
    await expect(supervisor.start(agent.id)).rejects.toThrow(/failed to start: .*default export is not an agent definition/);
  });

  it("refuses to start a module that throws while loading", async () => {
    supervisor.setModule(agent.id, fixture("throws-on-import.ts"));
    await expect(supervisor.start(agent.id)).rejects.toThrow(/failed to start: module exploded at import time/);
  });

  it("refuses to start an agent with no module registered, without forking", async () => {
    const other = registry.create("orphan");
    await expect(supervisor.start(other.id)).rejects.toThrow(/orphan .* has no agent definition registered/);
    expect(supervisor.history(other.id)).toHaveLength(0);
  });
});
