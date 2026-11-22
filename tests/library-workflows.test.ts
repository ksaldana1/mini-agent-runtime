/**
 * Phase 3: workflows and listeners defined in code, through the public API.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  createPlatform,
  WorkflowFailedError,
  WorkflowInputError,
  type AgentHandle,
  type Platform,
  type PlatformEvents,
  type WorkflowHandle,
  type WorkflowRef,
} from "mini-agent-runtime";
import notes from "./fixtures/agents/notes.js";

let dataDir: string;
const open: Platform[] = [];
const boot = () => {
  const p = createPlatform({ dataDir, listeners: { intervalMs: 30, settleMs: 0 } });
  open.push(p);
  return p;
};
const next = <K extends keyof PlatformEvents>(p: Platform, event: K, where: (e: PlatformEvents[K]) => boolean = () => true) =>
  new Promise<PlatformEvents[K]>((resolve) => {
    const off = p.events.on(event, (e) => {
      if (!where(e)) return;
      off();
      resolve(e);
    });
  });

beforeEach(() => (dataDir = mkdtempSync(join(tmpdir(), "lib-wf-"))));
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * writer saves a note; then a reviewer reads it back. The junior reviewer can't read
 * the writer's files, so the step falls back to the senior, who was granted access.
 */
function setup(p: Platform, opts: { autostart?: boolean; reviewers?: "both" | "senior" } = {}) {
  const writer = p.agent("writer", notes, { autostart: opts.autostart });
  const junior = p.agent("junior", notes, { autostart: opts.autostart });
  const senior = p.agent("senior", notes, { autostart: opts.autostart });
  senior.grant(`agents/${writer.id}`, "read");
  const reviewers = opts.reviewers === "senior" ? [senior] : [junior, senior];
  const flow = p
    .workflow("note-and-review")
    .input(z.object({ name: z.string(), text: z.string() }))
    .step("save", writer.task("save"), ({ input }) => ({ name: input.name, text: input.text }))
    .step("review", reviewers.map((r) => r.task("read")), ({ steps }) => ({ path: steps.save.path }))
    .build();
  return { writer, junior, senior, flow };
}

describe("workflow builder (3.1)", () => {
  it("types: step outputs flow into later steps; In and Out come from the schema and last step", () => {
    const p = boot();
    const a = p.agent("a", notes, { autostart: false });
    const flow = p
      .workflow("typed")
      .input(z.object({ name: z.string(), loud: z.boolean().default(false) }))
      .step("save", a.task("save"), (ctx) => {
        expectTypeOf(ctx.input).toEqualTypeOf<{ name: string; loud: boolean }>(); // parsed: defaults applied
        expectTypeOf(ctx.steps).toEqualTypeOf<{}>();
        return { name: ctx.input.name, text: "x" };
      })
      .step("read", a.task("read"), (ctx) => {
        expectTypeOf(ctx.steps.save).toEqualTypeOf<{ attempt: number; incarnation: number; path: string; bytes: number }>();
        // @ts-expect-error no step named "nope" yet
        void ctx.steps.nope;
        return { path: ctx.steps.save.path };
      })
      .build();
    type In = { name: string; loud?: boolean | undefined };
    type Steps = { save: { attempt: number; incarnation: number; path: string; bytes: number }; read: string };
    expectTypeOf(flow).toEqualTypeOf<WorkflowRef<In, Steps, string>>();
    expectTypeOf(p.startWorkflow(flow, { name: "n" })).toEqualTypeOf<WorkflowHandle<In, Steps, string>>();
    expectTypeOf(flow.start).parameter(0).toEqualTypeOf<In>();

    p.workflow("bad-input").input(z.object({})).step("s", a.task("save"), () =>
      // @ts-expect-error `text` is required by the task
      ({ name: "x" }),
    );
  });

  it("rejects duplicate names, empty workflows, and tasks the agent doesn't have", () => {
    const p = boot();
    const a = p.agent("a", notes, { autostart: false });
    p.workflow("w").input(z.object({})).step("s", a.task("read"), () => ({ path: "x" })).build();
    expect(() => p.workflow("w").input(z.object({})).step("s", a.task("read"), () => ({ path: "x" })).build()).toThrow(/already registered/);
    expect(() => p.workflow("empty").input(z.object({})).build()).toThrow(/at least one step/);
    expect(() => p.workflow("w2").input(z.object({})).step("s", [], () => ({}) as never)).toThrow(/at least one task/);
    expect(() => a.task("nope" as "read")).toThrow(/unknown task/);
  });
});

describe("startWorkflow and WorkflowHandle (3.3)", () => {
  it("runs to completion; falls back to the next candidate; result() is the last step's output", async () => {
    const p = boot();
    const { flow } = setup(p);
    await p.start();
    const run = p.startWorkflow(flow, { name: "memo", text: "hello" });
    await expect(run.result()).resolves.toBe("hello");
    expect(run.status()).toMatchObject({ workflow: "note-and-review", status: "completed", output: "hello" });
    expect(run.steps().map((s) => [s.name, s.status, s.agent, s.assignment])).toEqual([
      ["save", "completed", "writer", 1],
      ["review", "completed", "senior", 2],
    ]);
    expect(run.events().map((e) => e.event)).toContain("assignment_failed");
  });

  it("validates the input before starting anything", () => {
    const p = boot();
    const { flow } = setup(p, { autostart: false });
    // @ts-expect-error text is required
    expect(() => p.startWorkflow(flow, { name: "x" })).toThrow(WorkflowInputError);
  });

  it("result() rejects with WorkflowFailedError when no candidate can do a step", async () => {
    const p = boot();
    const writer = p.agent("writer", notes);
    const stranger = p.agent("stranger", notes);
    const flow = p
      .workflow("doomed")
      .input(z.object({}))
      .step("save", writer.task("save"), () => ({ name: "n", text: "t" }))
      .step("read", stranger.task("read"), ({ steps }) => ({ path: steps.save.path }))
      .build();
    await p.start();
    const err = await p.startWorkflow(flow, {}).result().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowFailedError);
    expect(err).toMatchObject({ workflow: "doomed", error: expect.stringMatching(/no candidate agents left/) });
  });

  it("duplicate starts with the same idempotency key return the same run", () => {
    const p = boot();
    const { flow } = setup(p, { autostart: false });
    const one = p.startWorkflow(flow, { name: "a", text: "1" }, { idempotencyKey: "order-1" });
    const two = p.startWorkflow(flow, { name: "a", text: "2" }, { idempotencyKey: "order-1" });
    expect(two.id).toBe(one.id);
    expect(p.startWorkflow(flow, { name: "a", text: "3" }, { idempotencyKey: "order-2" }).id).not.toBe(one.id);
  });

  it("reattaches after a restart and finishes there", async () => {
    const first = boot();
    const { flow } = setup(first, { autostart: false });
    await first.start();
    const run = first.startWorkflow(flow, { name: "later", text: "survives" });
    await first.close();

    const second = boot();
    const { flow: again } = setup(second); // code registers the same agents and workflow again
    await second.start();
    await expect(again.run(run.id).result()).resolves.toBe("survives");
  });
});

describe("registered definitions across boots (3.2)", () => {
  it("a running workflow whose definition isn't registered is skipped with a warning", async () => {
    const first = boot();
    const { flow } = setup(first, { autostart: false });
    await first.start();
    const run = first.startWorkflow(flow, { name: "x", text: "y" });
    await first.close();

    const second = boot();
    second.agent("writer", notes, { autostart: false }); // agents, but no workflow registered
    const skipped = next(second, "workflow.skipped");
    await second.start();
    expect(await skipped).toMatchObject({ workflowId: run.id, workflow: "note-and-review", reason: expect.stringMatching(/not registered/) });
    expect(second.workflowRun(run.id).status().status).toBe("running");
  });

  it("a changed definition (different steps) fails the running workflow", async () => {
    const first = boot();
    const { flow } = setup(first, { autostart: false });
    await first.start();
    const run = first.startWorkflow(flow, { name: "x", text: "y" });
    await first.close();

    const second = boot();
    setup(second, { reviewers: "senior" }); // review candidates changed
    await second.start();
    await expect(second.workflowRun(run.id).result()).rejects.toThrow(/definition changed/);
  });
});

describe("listeners defined in code (3.4)", () => {
  const inbox = "shared/documents/in";
  const drop = (name: string, text = name) => {
    mkdirSync(join(dataDir, inbox), { recursive: true });
    writeFileSync(join(dataDir, inbox, name), text);
  };

  it(".send() enqueues a typed task for an agent that can read the directory", async () => {
    const p = boot();
    const clerk = p.agent("clerk", notes);
    expect(() => p.listen("too-early", { dir: inbox }).send(clerk.task("read"), (f) => ({ path: f.path }))).toThrow(/EACCES/);
    clerk.grant(inbox, "read");
    p.listen("incoming", { dir: inbox }).send(clerk.task("read"), (f) => ({ path: f.path }));
    await p.start();

    const fired = next(p, "listener.fired");
    drop("a.txt", "alpha");
    const e = await fired;
    expect(e).toMatchObject({ listener: "incoming", agent: "clerk", event: "created", path: `${inbox}/a.txt`, workflowId: null });
    await expect(p.task(e.taskId!).result()).resolves.toBe("alpha");
  });

  it(".startWorkflow() starts a run per file, with no agent permission needed", async () => {
    const p = boot();
    const { flow } = setup(p);
    p.listen("submissions", { dir: inbox }).startWorkflow(flow, (f) => ({ name: f.name.replace(".txt", ""), text: `from ${f.path}` }));
    await p.start();

    const fired = next(p, "listener.fired");
    drop("b.txt");
    const e = await fired;
    expect(e).toMatchObject({ listener: "submissions", agent: null, taskId: null });
    await expect(p.workflowRun(e.workflowId!).result()).resolves.toBe(`from ${inbox}/b.txt`);
  });

  it("re-registering on the next boot doesn't refire for files already seen", async () => {
    const first = boot();
    const a = first.agent("clerk", notes);
    a.grant(inbox, "read");
    first.listen("incoming", { dir: inbox }).send(a.task("read"), (f) => ({ path: f.path }));
    await first.start();
    const fired = next(first, "listener.fired");
    drop("once.txt");
    await fired;
    await first.close();

    const second = boot();
    const b = second.agent("clerk", notes);
    second.listen("incoming", { dir: inbox }).send(b.task("read"), (f) => ({ path: f.path }));
    await second.start();
    await new Promise((r) => setTimeout(r, 150)); // several scans
    expect(b.inbox()).toHaveLength(1);
  });

  it("listener → workflow survives a restart between the file arriving and the workflow running", async () => {
    // Boot 1: the listener fires and starts the workflow, but no agent is running, so
    // the workflow can't progress. Then the platform goes down.
    const first = boot();
    const { flow } = setup(first, { autostart: false });
    first.listen("submissions", { dir: inbox }).startWorkflow(flow, (f) => ({ name: "doc", text: f.name }));
    await first.start();
    const fired = next(first, "listener.fired");
    drop("c.txt");
    const runId = (await fired).workflowId!;
    await first.close();

    // Boot 2: same code. The run is picked up and finishes; nothing fires twice.
    const second = boot();
    const again = setup(second);
    second.listen("submissions", { dir: inbox }).startWorkflow(again.flow, (f) => ({ name: "doc", text: f.name }));
    await second.start();
    await expect(second.workflowRun(runId).result()).resolves.toBe("c.txt");
    expect(second.kernel.workflows.list().map((w) => w.id)).toEqual([runId]);

    // Even with the listener's snapshot wiped, the idempotency key prevents a second run.
    second.kernel.db.exec(`DELETE FROM listener_files`);
    await new Promise((r) => setTimeout(r, 150));
    expect(second.kernel.workflows.list()).toHaveLength(1);
  });

  it("invalid input from a listener function is reported, not retried, and doesn't stop the listener", async () => {
    const p = boot();
    const { flow } = setup(p);
    p.listen("picky", { dir: inbox }).startWorkflow(flow, (f) => ({ name: f.name, text: f.name.startsWith("bad") ? (42 as never) : "ok" }));
    const errors: string[] = [];
    p.events.on("listener.error", (e) => errors.push(e.path));
    await p.start();
    const ok = next(p, "listener.fired");
    drop("bad.txt");
    drop("good.txt");
    await ok;
    await new Promise((r) => setTimeout(r, 100));
    expect(errors).toEqual([`${inbox}/bad.txt`]);
    expect(p.kernel.workflows.list()).toHaveLength(1);
  });

  it("pause / resume, and one registration per name per process", async () => {
    const p = boot();
    const a: AgentHandle<typeof notes> = p.agent("clerk", notes);
    a.grant(inbox, "read");
    const l = p.listen("incoming", { dir: inbox }).send(a.task("read"), (f) => ({ path: f.path }));
    expect(() => p.listen("incoming", { dir: inbox })).toThrow(/already registered/);
    await p.start();
    l.pause();
    drop("p.txt");
    await new Promise((r) => setTimeout(r, 100));
    expect(a.inbox()).toHaveLength(0);
    l.resume();
    await next(p, "listener.fired");
    expect(l.status()).toMatchObject({ state: "active", dir: inbox, lastError: null });
  });
});
