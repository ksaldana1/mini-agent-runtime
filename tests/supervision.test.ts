import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/platform/database.js";
import { AgentRegistry, type Agent } from "../src/platform/identity.js";
import { Supervisor } from "../src/platform/supervisor.js";
import toy from "../src/agents/toy.js";

async function until(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(10);
  }
}

describe("Supervisor restart policy", () => {
  let db: Db;
  let registry: AgentRegistry;
  let supervisor: Supervisor;
  let agent: Agent;
  let dir: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    registry = new AgentRegistry(db);
    supervisor = new Supervisor(db, registry, { defaultModule: toy.moduleUrl });
    agent = registry.create("agent-a");
    dir = mkdtempSync(join(tmpdir(), "supervision-"));
  });

  afterEach(async () => {
    await supervisor.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const kill = () => process.kill(supervisor.status(agent.id)!.pid, "SIGKILL");
  const running = (incarnation: number) => () => {
    const s = supervisor.status(agent.id);
    return s?.state === "running" && s.incarnation === incarnation;
  };

  it("restarts a crashed runtime under on-crash", async () => {
    supervisor.setPolicy(agent.id, { restart: "on-crash", backoffMs: 10 });
    await supervisor.start(agent.id);
    kill();
    await until(running(2));
    expect(supervisor.history(agent.id)).toHaveLength(2);
  });

  it("does not restart without a policy, or with restart: never", async () => {
    await supervisor.start(agent.id);
    kill();
    await until(() => supervisor.status(agent.id)?.state === "crashed");

    supervisor.setPolicy(agent.id, { restart: "never", backoffMs: 1 });
    await supervisor.start(agent.id);
    kill();
    await until(() => supervisor.status(agent.id)?.state === "crashed");
    await sleep(100);
    expect(supervisor.status(agent.id)).toMatchObject({ state: "crashed", incarnation: 2 });
  });

  it("backs off exponentially and gives up past the cap", async () => {
    // A runtime that dies before the handshake: every start crashes.
    const entry = join(dir, "crash.mjs");
    writeFileSync(entry, "process.exit(1);\n");
    const crashy = new Supervisor(db, registry, { defaultModule: toy.moduleUrl, runtimeEntry: entry });
    crashy.setPolicy(agent.id, { restart: "on-crash", maxRestarts: 3, backoffMs: 20 });

    const delays: number[] = [];
    let gaveUp: { crashes: number } | undefined;
    crashy.on("restart-scheduled", (e) => delays.push(e.delayMs));
    crashy.on("gave-up", (e) => (gaveUp = e));

    await expect(crashy.start(agent.id)).rejects.toThrow(/exited before responding/);
    await until(() => gaveUp !== undefined);

    expect(delays).toEqual([20, 40, 80]);
    expect(gaveUp).toMatchObject({ crashes: 4 });
    expect(crashy.status(agent.id)!.state).toBe("given-up");
    expect(crashy.history(agent.id)).toHaveLength(4); // first start + 3 restarts
    await sleep(200);
    expect(crashy.history(agent.id)).toHaveLength(4); // really gave up
    await crashy.close();
  });

  it("only counts crashes within the window", async () => {
    supervisor.setPolicy(agent.id, { restart: "on-crash", maxRestarts: 1, windowMs: 300, backoffMs: 10 });
    const delays: number[] = [];
    let gaveUp = false;
    supervisor.on("restart-scheduled", (e) => delays.push(e.delayMs));
    supervisor.on("gave-up", () => (gaveUp = true));

    await supervisor.start(agent.id);
    kill();
    await until(running(2));

    await sleep(350); // the first crash falls out of the window
    kill();
    await until(running(3));
    expect(delays).toEqual([10, 10]); // backoff restarted from the base, too
    expect(gaveUp).toBe(false);

    kill(); // second crash within the window: over the cap of 1
    await until(() => gaveUp);
    expect(supervisor.status(agent.id)!.state).toBe("given-up");
  });

  it("never restarts after a deliberate stop", async () => {
    supervisor.setPolicy(agent.id, { restart: "on-crash", backoffMs: 1 });
    await supervisor.start(agent.id);
    await supervisor.stop(agent.id);
    await sleep(100);
    expect(supervisor.status(agent.id)).toMatchObject({ state: "exited", incarnation: 1 });
  });

  it("stop() and close() cancel a pending restart", async () => {
    supervisor.setPolicy(agent.id, { restart: "on-crash", backoffMs: 150 });
    await supervisor.start(agent.id);
    kill();
    await until(() => supervisor.status(agent.id)?.state === "crashed");
    await supervisor.stop(agent.id);
    await sleep(250);
    expect(supervisor.history(agent.id)).toHaveLength(1);

    await supervisor.start(agent.id);
    kill();
    await until(() => supervisor.status(agent.id)?.state === "crashed");
    await supervisor.close();
    await sleep(250);
    expect(supervisor.history(agent.id)).toHaveLength(2);
    await expect(supervisor.start(agent.id)).rejects.toThrow(/closed/);
  });

  it("a manual start clears given-up", async () => {
    supervisor.setPolicy(agent.id, { restart: "on-crash", maxRestarts: 0, backoffMs: 1 });
    await supervisor.start(agent.id);
    kill();
    await until(() => supervisor.status(agent.id)?.state === "given-up");
    await supervisor.start(agent.id);
    expect(supervisor.status(agent.id)).toMatchObject({ state: "running", incarnation: 2 });
  });
});
