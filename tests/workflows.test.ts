import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { WorkflowService, type WorkflowDefinition } from "../src/platform/workflows.js";
import { renderTemplate } from "../src/shared/template.js";
import toy from "../src/agents/toy.js";

describe("renderTemplate", () => {
  it("fills dotted placeholders, keeping raw values for whole-string placeholders", () => {
    const vars = { input: { n: 3, s: "x" }, steps: { a: { path: "p/q" } } };
    expect(renderTemplate({ n: "{{input.n}}", msg: "n={{input.n}} s={{input.s}}", p: ["{{steps.a.path}}"], k: "{{nope}}" }, vars)).toEqual({
      n: 3,
      msg: "n=3 s=x",
      p: ["p/q"],
      k: "{{nope}}",
    });
  });
});

/**
 * No runtimes here: the tests play the agent's part by claiming/completing inbox
 * items directly, then call reconcile() — exactly what the inbox "settled" event triggers.
 */
describe("WorkflowService (state machine over the inbox)", () => {
  let db: Db;
  let registry: AgentRegistry;
  let inbox: Inbox;
  let supervisor: Supervisor;
  let dispatcher: Dispatcher;
  let workflows: WorkflowService;
  let a: Agent;
  let b: Agent;
  let c: Agent;

  const def = (): WorkflowDefinition => ({
    name: "two-step",
    steps: [
      { name: "first", agents: [a.id], payload: { task: "uppercase", input: { text: "{{input.text}}" } } },
      { name: "second", agents: [b.id, c.id], payload: { task: "transform", input: { from: "{{steps.first.out}}", wf: "{{workflow.id}}" } } },
    ],
  });

  /** Simulate an agent finishing (or failing) whatever is assigned to it. */
  const finish = (agent: Agent, result: unknown) => {
    const item = inbox.claimNext(agent.id, 1)!;
    inbox.complete(item.id, 1, result);
    return item;
  };
  const failHard = (agent: Agent) => {
    const id = inbox.list(agent.id, "pending")[0]!.id;
    for (let i = 0; i < 3; i++) {
      inbox.claimNext(agent.id, 1);
      inbox.fail(id, 1, "nope");
    }
  };

  beforeEach(() => {
    db = openDatabase(":memory:");
    registry = new AgentRegistry(db);
    inbox = new Inbox(db, registry);
    supervisor = new Supervisor(db, registry, { defaultModule: toy.moduleUrl });
    dispatcher = new Dispatcher(supervisor, inbox);
    workflows = new WorkflowService(db, registry, inbox);
    a = registry.create("a");
    b = registry.create("b");
    c = registry.create("c");
  });

  it("validates definitions", () => {
    expect(() => workflows.start({ name: "x", steps: [] })).toThrow();
    expect(() =>
      workflows.start({ name: "x", steps: [{ name: "s", agents: [a.id], payload: 1 }, { name: "s", agents: [a.id], payload: 2 }] }),
    ).toThrow(/unique/);
    expect(() => workflows.start({ name: "x", steps: [{ name: "s", agents: ["00000000-0000-0000-0000-000000000000"], payload: 1 }] })).toThrow(
      /unknown agent/,
    );
  });

  it("assigns the first step as an inbox item with a rendered payload", () => {
    const wf = workflows.start(def(), { text: "hi" });
    expect(wf).toMatchObject({ status: "running", currentStep: 0 });
    const [item] = inbox.list(a.id);
    expect(item).toMatchObject({ payload: { task: "uppercase", input: { text: "hi" } }, idempotencyKey: `workflow:${wf.id}:step:0:assignment:1` });
    expect(workflows.steps(wf.id)[0]).toMatchObject({ status: "assigned", agentId: a.id, inboxItemId: item!.id });
  });

  it("advances step by step, passing results forward, and completes", () => {
    const wf = workflows.start(def(), { text: "hi" });
    finish(a, { out: "a/out.txt" });
    workflows.reconcile(wf.id);

    expect(workflows.get(wf.id)!.currentStep).toBe(1);
    expect(inbox.list(b.id)[0]!.payload).toEqual({ task: "transform", input: { from: "a/out.txt", wf: wf.id } });

    finish(b, { done: true });
    workflows.reconcile(wf.id);
    expect(workflows.get(wf.id)).toMatchObject({ status: "completed", output: { done: true } });
    expect(workflows.events(wf.id).map((e) => e.event)).toEqual([
      "workflow_started",
      "step_assigned",
      "step_completed",
      "step_assigned",
      "step_completed",
      "workflow_completed",
    ]);
  });

  it("does nothing while the step's item is pending or claimed", () => {
    const wf = workflows.start(def(), {});
    expect(workflows.reconcile(wf.id)).toBe(false);
    inbox.claimNext(a.id, 1);
    expect(workflows.reconcile(wf.id)).toBe(false);
    expect(workflows.steps(wf.id)[0]!.status).toBe("assigned");
  });

  it("reconcile is idempotent", () => {
    const wf = workflows.start(def(), {});
    finish(a, { out: "x" });
    for (let i = 0; i < 5; i++) workflows.reconcile(wf.id);
    workflows.reconcileAll();
    expect(inbox.list(b.id)).toHaveLength(1);
    expect(workflows.events(wf.id).filter((e) => e.event === "step_assigned")).toHaveLength(2);
  });

  it("reassigns a failed step to the next candidate agent", () => {
    const wf = workflows.start(def(), {});
    finish(a, { out: "x" });
    workflows.reconcile(wf.id);

    failHard(b);
    workflows.reconcile(wf.id);
    expect(workflows.steps(wf.id)[1]).toMatchObject({ status: "assigned", agentId: c.id, assignment: 2 });
    expect(inbox.list(c.id)[0]!.idempotencyKey).toBe(`workflow:${wf.id}:step:1:assignment:2`);

    finish(c, "ok");
    workflows.reconcile(wf.id);
    expect(workflows.get(wf.id)!.status).toBe("completed");
  });

  it("advances on its own when the inbox settles a step's item, including via crash release", async () => {
    const tick = () => new Promise<void>((r) => setImmediate(r));
    const wf = workflows.start(def(), {});
    finish(a, { out: "x" }); // no reconcile() call: the "settled" event drives it
    await tick();
    expect(workflows.steps(wf.id)[1]).toMatchObject({ status: "assigned", agentId: b.id });

    // b's runtime crashes on every attempt; the last release marks the item failed.
    for (let inc = 1; inc <= 3; inc++) {
      inbox.claimNext(b.id, inc);
      inbox.releaseClaims(b.id, inc);
    }
    await tick();
    expect(workflows.steps(wf.id)[1]).toMatchObject({ status: "assigned", agentId: c.id, assignment: 2 });
  });

  it("fails the workflow when no candidates are left", () => {
    const wf = workflows.start(def(), {});
    failHard(a);
    workflows.reconcile(wf.id);
    expect(workflows.get(wf.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/no candidate/) });
    expect(workflows.steps(wf.id)[0]!.status).toBe("failed");
    expect(workflows.steps(wf.id)[1]!.status).toBe("waiting");
  });

  it("skips candidates that have been deleted", () => {
    registry.markDeleted(b.id);
    const wf = workflows.start(def(), {});
    finish(a, { out: "x" });
    workflows.reconcile(wf.id);
    expect(workflows.steps(wf.id)[1]).toMatchObject({ agentId: c.id, assignment: 2 });
    expect(workflows.events(wf.id).some((e) => e.event === "assignment_skipped")).toBe(true);
  });

  it("recovers on startup: progress made while no workflow service was listening is picked up", () => {
    const wf = workflows.start(def(), {});
    // The step finishes, but the "completed" event is never observed (platform died).
    finish(a, { out: "x" });
    expect(workflows.get(wf.id)!.currentStep).toBe(0);

    const restarted = new WorkflowService(db, registry, inbox);
    expect(restarted.get(wf.id)!.currentStep).toBe(0); // constructing doesn't recover
    expect(restarted.recover()).toBe(1);
    expect(restarted.get(wf.id)!.currentStep).toBe(1);
    expect(restarted.recover()).toBe(0);
  });
});

describe("Workflows end to end (real runtimes)", () => {
  let root: string;
  let db: Db;
  let supervisor: Supervisor;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "workflows-"));
    db = openDatabase(":memory:");
  });
  afterEach(async () => {
    await supervisor.stopAll();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a workflow survives its agent crashing mid-step", async () => {
    const registry = new AgentRegistry(db);
    const fs = new AgentFilesystem(db, registry, root);
    const inbox = new Inbox(db, registry);
    supervisor = new Supervisor(db, registry, { defaultModule: toy.moduleUrl, fsHandler: (id, req) => fs.handle(id, req) });
    new Dispatcher(supervisor, inbox);
    const workflows = new WorkflowService(db, registry, inbox);
    const worker = registry.create("worker");

    mkdirSync(join(root, "shared/documents"), { recursive: true });
    writeFileSync(join(root, "shared/documents/in.txt"), "abc");
    fs.grant(worker.id, "shared/documents", "read");

    const first = await supervisor.start(worker.id);
    const wf = workflows.start({
      name: "e2e",
      steps: [
        { name: "copy", agents: [worker.id], payload: { task: "transform", input: { from: "{{input.src}}", to: "~/a.txt", delayMs: 200 } } },
        { name: "again", agents: [worker.id], payload: { task: "transform", input: { from: "{{steps.copy.path}}", to: "~/b.txt", suffix: "!" } } },
      ],
    }, { src: "shared/documents/in.txt" });

    const deadline = () => Date.now() + 5_000;
    let d = deadline();
    while (inbox.list(worker.id, "claimed").length === 0 && Date.now() < d) await sleep(10);
    process.kill(first.pid, "SIGKILL");
    d = deadline();
    while (supervisor.status(worker.id)?.state !== "crashed" && Date.now() < d) await sleep(10);
    expect(workflows.get(wf.id)!.status).toBe("running");

    await supervisor.start(worker.id);
    d = deadline();
    while (workflows.get(wf.id)!.status === "running" && Date.now() < d) await sleep(10);

    expect(workflows.get(wf.id)!.status).toBe("completed");
    expect(fs.handle(worker.id, { op: "read", path: "~/b.txt" })).toBe("ABC!");
    expect(inbox.get(workflows.steps(wf.id)[0]!.inboxItemId!)!.attempts).toBe(2);
  });
});
