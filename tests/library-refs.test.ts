/**
 * Phase 5: TaskRef, typed workflow refs and handles, workflow output, agent config.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  AgentConfigError,
  createPlatform,
  TaskInputError,
  WorkflowMismatchError,
  type AgentContext,
  type Platform,
  type TaskHandle,
  type TaskRef,
  type WorkflowStepSnapshot,
} from "mini-agent-runtime";
import configured from "./fixtures/agents/configured.js";
import notes from "./fixtures/agents/notes.js";
import shouter from "./fixtures/agents/shouter.js";

let dataDir: string;
const open: Platform[] = [];
const boot = () => {
  const p = createPlatform({ dataDir, listeners: { intervalMs: 30, settleMs: 0 } });
  open.push(p);
  return p;
};

beforeEach(() => (dataDir = mkdtempSync(join(tmpdir(), "lib-refs-"))));
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
  rmSync(dataDir, { recursive: true, force: true });
});

type Saved = { attempt: number; incarnation: number; path: string; bytes: number };

/** save, then review: junior (notes.read) can't read the writer's files; senior (shouter.shout) can. */
function setup(p: Platform, opts: { autostart?: boolean; name?: string } = {}) {
  const writer = p.agent("writer", notes, { autostart: opts.autostart });
  const junior = p.agent("junior", notes, { autostart: opts.autostart });
  const senior = p.agent("senior", shouter, { autostart: opts.autostart });
  senior.grant(`agents/${writer.id}`, "read");
  const flow = p
    .workflow(opts.name ?? "save-and-review")
    .input(z.object({ name: z.string(), text: z.string() }))
    .step("save", writer.task("save"), ({ input }) => ({ name: input.name, text: input.text }))
    .step("review", [junior.task("read"), senior.task("shout")], ({ steps }) => ({ path: steps.save.path }))
    .build();
  return { writer, junior, senior, flow };
}

describe("TaskRef (5.1)", () => {
  it("types: agent.task(name) carries the task's input and output", () => {
    const p = boot();
    const a = p.agent("a", notes, { autostart: false });
    expectTypeOf(a.task("read")).toEqualTypeOf<TaskRef<{ path: string }, string>>();
    expectTypeOf(a.task("save").send).parameter(0).toEqualTypeOf<{ name: string; text: string; delayMs?: number | undefined }>();
    expectTypeOf(a.task("read").send({ path: "x" })).toEqualTypeOf<TaskHandle<string>>();
    // @ts-expect-error no such task
    expect(() => a.task("nope")).toThrow(TaskInputError);
  });

  it("send() validates, enqueues durably, and agent.send() is the same thing", async () => {
    const p = boot();
    const a = p.agent("a", notes);
    await p.start();
    const save = a.task("save");
    expect(save).toMatchObject({ task: "save", agent: { id: a.id, name: "a" } });
    // @ts-expect-error text is required
    expect(() => save.send({ name: "x" })).toThrow(TaskInputError);
    const { path } = await save.send({ name: "n", text: "hi" }).result();
    await expect(a.task("read").send({ path }).result()).resolves.toBe("hi");
    await expect(a.send("read", { path }).result()).resolves.toBe("hi");
  });

  it("fallback candidates may be different tasks with the same input; the step output is their union", async () => {
    const p = boot();
    const { flow } = setup(p);
    expectTypeOf(flow.start).returns.toHaveProperty("step");
    await p.start();
    const run = flow.start({ name: "memo", text: "quiet" });
    await expect(run.result()).resolves.toEqual({ loud: "QUIET" });
    expect(run.steps().map((s) => [s.name, s.agent?.name, s.assignment])).toEqual([
      ["save", "writer", 1],
      ["review", "senior", 2],
    ]);
    expectTypeOf(run.result()).resolves.toEqualTypeOf<string | { loud: string }>();
  });

  it("types: fallback candidates with different inputs are rejected", () => {
    const p = boot();
    const a = p.agent("a", notes, { autostart: false });
    p.workflow("mixed")
      .input(z.object({}))
      // @ts-expect-error read takes { path }, save takes { name, text }
      .step("s", [a.task("read"), a.task("save")], () => ({ path: "x" }));
  });
});

describe("typed workflow refs and handles (5.2)", () => {
  it("run.step(name) narrows on status; run.input() is typed", async () => {
    const p = boot();
    const { flow } = setup(p);
    await p.start();
    const run = flow.start({ name: "memo", text: "hello" });
    expectTypeOf(run.input()).toEqualTypeOf<{ name: string; text: string }>();
    expectTypeOf(run.step("save")).toEqualTypeOf<WorkflowStepSnapshot<Saved>>();
    // @ts-expect-error no such step
    expect(() => run.step("nope")).toThrow(/no step "nope"/);

    await run.result();
    expect(run.input()).toEqual({ name: "memo", text: "hello" });
    const save = run.step("save");
    expectTypeOf(save.result).toEqualTypeOf<Saved | null>();
    if (save.status !== "completed") throw new Error("expected save to be completed");
    expectTypeOf(save.result).toEqualTypeOf<Saved>();
    expect(save.result.path).toMatch(/notes\/memo\.txt$/);
    expect(save).toMatchObject({ agent: { name: "writer" }, error: null });

    const saveTask = run.task("save");
    expectTypeOf(saveTask).toEqualTypeOf<TaskHandle<Saved> | null>();
    expect(saveTask!.info()).toMatchObject({ id: save.taskId, status: "completed", task: "save", agent: { name: "writer" } });
    await expect(saveTask!.result()).resolves.toEqual(save.result);
    // @ts-expect-error no such step
    expect(() => run.task("nope")).toThrow(/no step "nope"/);
  });

  it("a step that isn't done yet has no result", () => {
    const p = boot();
    const { flow } = setup(p, { autostart: false });
    const run = flow.start({ name: "m", text: "t" });
    expect(run.step("save")).toMatchObject({ status: "assigned", result: null, error: null });
    expect(run.step("review")).toMatchObject({ status: "waiting", result: null, error: null });
    expect(run.task("save")!.info()).toMatchObject({ status: "pending", task: "save" });
    expect(run.task("review")).toBeNull();
  });

  it("ref.run(id) refuses a run of another workflow, and one started with another definition", async () => {
    const first = boot();
    const { flow, writer } = setup(first, { autostart: false });
    const other = first
      .workflow("other")
      .input(z.object({}))
      .step("s", writer.task("save"), () => ({ name: "o", text: "o" }))
      .build();
    const otherRun = other.start({});
    const run = flow.start({ name: "x", text: "y" });
    expect(flow.run(run.id).id).toBe(run.id);
    expect(() => flow.run(otherRun.id)).toThrow(WorkflowMismatchError);
    expect(() => flow.run(otherRun.id)).toThrow(/run of other/);
    await first.close();

    // Same name, different steps: the stored fingerprint no longer matches.
    const second = boot();
    const w = second.agent("writer", notes, { autostart: false });
    const changed = second
      .workflow("save-and-review")
      .input(z.object({ name: z.string(), text: z.string() }))
      .step("save", w.task("save"), ({ input }) => input)
      .build();
    expect(() => changed.run(run.id)).toThrow(/different definition/);
    expect(second.workflowRun(run.id).id).toBe(run.id); // the untyped handle still works
  });
});

describe("workflow output (5.4)", () => {
  const withOutput = (p: Platform, fn?: (text: string) => string) => {
    const { writer, senior } = setup(p, { name: "unused" });
    return p
      .workflow("summarize")
      .input(z.object({ name: z.string(), text: z.string() }))
      .step("save", writer.task("save"), ({ input }) => input)
      .step("shout", senior.task("shout"), ({ steps }) => ({ path: steps.save.path }))
      .output(({ input, steps }) => ({ name: input.name, bytes: steps.save.bytes, loud: fn ? fn(steps.shout.loud) : steps.shout.loud }))
      .build();
  };

  it("the projection is the result, typed, and survives a restart", async () => {
    const first = boot();
    const flow = withOutput(first);
    expectTypeOf(flow.start({ name: "a", text: "b" }).result()).resolves.toEqualTypeOf<{ name: string; bytes: number; loud: string }>();
    await first.start();
    const run = flow.start({ name: "memo", text: "abc" });
    await expect(run.result()).resolves.toEqual({ name: "memo", bytes: 3, loud: "ABC" });
    await first.close();

    const second = boot();
    const again = withOutput(second);
    await expect(again.run(run.id).result()).resolves.toEqual({ name: "memo", bytes: 3, loud: "ABC" });
  });

  it("a throwing projection fails the workflow, without retry", async () => {
    const p = boot();
    const flow = withOutput(p, () => {
      throw new Error("bad summary");
    });
    await p.start();
    const run = flow.start({ name: "m", text: "t" });
    await expect(run.result()).rejects.toThrow(/output: bad summary/);
    expect(run.step("shout").status).toBe("completed"); // the steps themselves succeeded
  });
});

describe("agent config (5.3)", () => {
  it("types: ctx.config is the schema's output; the option is the schema's input", () => {
    const p = boot();
    type Run = (typeof configured)["tasks"]["greet"]["run"];
    expectTypeOf<Parameters<Run>[1]>().toEqualTypeOf<AgentContext<{ greeting: string; excitement: number }>>();
    p.agent("ok", configured, { config: { greeting: "hi" }, autostart: false }); // excitement has a default
    // @ts-expect-error greeting must be a string
    expect(() => p.agent("bad", configured, { config: { greeting: 1 }, autostart: false })).toThrow(AgentConfigError);
    // @ts-expect-error notes takes no config
    p.agent("plain", notes, { config: { x: 1 }, autostart: false });
  });

  it("the runtime sees the parsed config", async () => {
    const p = boot();
    const a = p.agent("greeter", configured, { config: { greeting: "Hello", excitement: 2 } });
    await p.start();
    await expect(a.send("greet", { name: "Ada" }).result()).resolves.toBe("Hello, Ada!!");
  });

  it("is validated at registration: a bad config changes nothing", () => {
    const first = boot();
    first.agent("greeter", configured, { config: { greeting: "Hello" }, autostart: false });
    expect(() => first.agent("missing", configured, { autostart: false })).toThrow(/invalid config for agent missing/);
    expect(first.kernel.registry.getByName("missing")).toBeUndefined();
  });

  it("omitting config keeps the stored one", async () => {
    const first = boot();
    first.agent("greeter", configured, { config: { greeting: "Hey" }, autostart: false });
    await first.close();
    const second = boot();
    const a = second.agent("greeter", configured);
    await second.start();
    await expect(a.send("greet", { name: "Bo" }).result()).resolves.toBe("Hey, Bo!");
  });

  it("the host refuses to start with a config that doesn't fit the schema", async () => {
    const p = boot();
    const a = p.agent("greeter", configured, { config: { greeting: "Hi" }, autostart: false });
    p.kernel.registry.updateConfiguration(a.id, { greeting: 42 }); // e.g. stored by other code
    await p.start();
    await expect(a.start()).rejects.toThrow(/invalid config for agent greeter/);
  });

  it("a change takes effect on restart, not before", async () => {
    const p = boot();
    const a = p.agent("greeter", configured, { config: { greeting: "Hi" } });
    await p.start();
    p.kernel.registry.updateConfiguration(a.id, { greeting: "Bye" });
    await expect(a.send("greet", { name: "C" }).result()).resolves.toBe("Hi, C!");
    await a.restart();
    await expect(a.send("greet", { name: "C" }).result()).resolves.toBe("Bye, C!");
  });
});
