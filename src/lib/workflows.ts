/**
 * Workflows and listeners defined in code (D1): a typed step list, and named listeners
 * whose targets are functions, not templates.
 *
 *   const publish = platform.workflow("publish")
 *     .input(z.object({ path: z.string() }))
 *     .step("edit", editor.task("edit"), ({ input }) => ({ path: input.path }))
 *     .step("review", [junior.task("review"), senior.task("review")], ({ steps }) => ({ path: steps.edit.path }))
 *     .build();
 *
 *   const run = publish.start({ path });
 *   const edit = run.step("edit");
 *   if (edit.status === "completed") edit.result.path; // typed
 *
 *   platform.listen("submissions", { dir: "shared/documents/in" })
 *     .startWorkflow(publish, (file) => ({ path: file.path }));
 */
import { z } from "zod";
import type { FileEvent as KernelFileEvent, Listener, ListenerEvent } from "../platform/listeners.js";
import type { StepStatus, Workflow, WorkflowEvent, WorkflowStatus, WorkflowStep } from "../platform/workflows.js";
import { WorkflowFailedError, WorkflowInputError, WorkflowMismatchError } from "./errors.js";
import { taskRefImpl, type Platform, type TaskRef, type TaskRefImpl } from "./platform.js";

// ── Public types ────────────────────────────────────────────────────────────

type AnySteps = Record<string, unknown>;

/**
 * A registered workflow. `In` is what `start` accepts (the schema's input type), `Steps`
 * maps each step name to its output, and `Out` is the workflow's result.
 */
export interface WorkflowRef<In = unknown, Steps extends AnySteps = AnySteps, Out = unknown> {
  readonly name: string;
  /**
   * Start a run. The input is validated first (WorkflowInputError, nothing started). With
   * the same idempotencyKey, a repeat start returns the original run.
   */
  start(input: In, opts?: { idempotencyKey?: string }): WorkflowHandle<In, Steps, Out>;
  /**
   * Reattach to a run by id, e.g. one started by an earlier process. Throws
   * WorkflowMismatchError if the run belongs to another workflow, or was started with a
   * different definition (step names, tasks, candidates; not the step functions' code).
   */
  run(id: string): WorkflowHandle<In, Steps, Out>;
}

/** What a step's input function (and `.output()`) sees. */
export interface StepContext<In, Steps> {
  /** The workflow input, parsed by its schema. */
  input: In;
  /** Outputs of the steps before this one. */
  steps: Steps;
  workflow: { id: string };
}

export interface WorkflowInfo {
  id: string;
  workflow: string;
  status: WorkflowStatus;
  input: unknown;
  /** Index of the current (or last) step. */
  currentStep: number;
  output: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStepInfo {
  name: string;
  status: StepStatus;
  /** Which candidate holds the step (1 = first choice). */
  assignment: number;
  agent: string | null;
  taskId: string | null;
  result: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** One step of a run, narrowed on `status`: `result` is typed (and set) only once it's completed. */
export type WorkflowStepSnapshot<Result = unknown> = Omit<WorkflowStepInfo, "status" | "result" | "error"> &
  (
    | { status: "completed"; result: Result; error: null }
    | { status: "waiting" | "assigned"; result: null; error: null }
    | { status: "failed"; result: null; error: string }
  );

export type { WorkflowEvent, WorkflowStatus, StepStatus };

export interface WorkflowHandle<In = unknown, Steps extends AnySteps = AnySteps, Out = unknown> {
  readonly id: string;
  readonly workflow: string;
  /** The input the run was started with (as given to `start`, before parsing). */
  input(): In;
  /** One step by name. Throws for a name the workflow doesn't have. */
  step<N extends keyof Steps & string>(name: N): WorkflowStepSnapshot<Steps[N]>;
  status(): WorkflowInfo;
  steps(): WorkflowStepInfo[];
  /** The append-only transition log. */
  events(): WorkflowEvent[];
  /** Resolves with the workflow's output, or rejects with WorkflowFailedError. No polling. */
  result(): Promise<Out>;
}

/** What a listener's input function is told about a file. */
export interface FileEvent {
  /** Listener name. */
  listener: string;
  event: ListenerEvent;
  /** Logical path, e.g. "shared/documents/in/a.txt". */
  path: string;
  /** Base name, e.g. "a.txt". */
  name: string;
}

export interface ListenOptions {
  /** Logical directory to watch (recursively). */
  dir: string;
  /** Default ["created"]. */
  events?: ListenerEvent[];
  /** On first registration (or when `dir` changes), treat files already there as new. */
  includeExisting?: boolean;
}

export interface ListenerHandle {
  readonly name: string;
  readonly id: string;
  status(): { state: "active" | "paused"; dir: string; lastScanAt: string | null; lastError: string | null };
  pause(): void;
  resume(): void;
}

export interface ListenerBuilder {
  /**
   * Enqueue `task` for each file event. Its agent must be allowed to read `dir` (a
   * listener reveals file names to its target).
   */
  send<In>(task: TaskRef<In, unknown>, input: (file: FileEvent) => NoInfer<In>): ListenerHandle;
  /**
   * Start a run of `workflow` for each file event. Platform-owned: no agent's permission
   * is involved. The run is started in the same transaction that records the file as seen,
   * with idempotency key listener:<name>:<event>:<path>:<mtime>, so a crash can't lose or
   * duplicate it.
   */
  startWorkflow<In>(workflow: WorkflowRef<In, any, unknown>, input: (file: FileEvent) => NoInfer<In>): ListenerHandle;
}

// ── Builder ─────────────────────────────────────────────────────────────────

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type AnyTaskRef = TaskRef<any, any>;
type RefIn<R> = R extends TaskRef<infer I, any> ? I : never;
type RefOut<R> = R extends TaskRef<any, infer O> ? O : never;
/** Fallback candidates must take the same input (TaskRef's `In` is invariant). */
type SameInput<R> = [R] extends [TaskRef<RefIn<R>, unknown>] ? unknown : { "fallback candidates must take the same input": never };

/** @internal */
export interface StepSpec {
  name: string;
  refs: TaskRefImpl<unknown, unknown>[];
  input: (ctx: StepContext<unknown, AnySteps>) => unknown;
}

type OutputFn = (ctx: StepContext<unknown, AnySteps>) => unknown;

/** First stage of platform.workflow(name): every workflow declares its input schema. */
export class WorkflowStart {
  constructor(
    private readonly platform: Platform,
    private readonly name: string,
  ) {}

  input<S extends z.ZodType>(schema: S): WorkflowBuilder<z.output<S>, z.input<S>, {}, never> {
    return new WorkflowBuilder(this.platform, this.name, schema, []);
  }
}

export class WorkflowBuilder<In, InRaw, Steps extends AnySteps, Out> {
  constructor(
    private readonly platform: Platform,
    private readonly name: string,
    private readonly schema: z.ZodType,
    private readonly specs: StepSpec[],
  ) {}

  /**
   * Add a step: run `task` (or the first of several candidates, then the others as
   * fallbacks if it fails) with the input computed from the workflow input and earlier
   * steps' outputs. Candidates may be different tasks, as long as they take the same input;
   * the step's output is the union of theirs.
   */
  step<N extends string, R extends AnyTaskRef>(
    name: N,
    task: (R | readonly R[]) & SameInput<R>,
    input: (ctx: StepContext<In, Steps>) => NoInfer<RefIn<R>>,
  ): WorkflowBuilder<In, InRaw, Simplify<Steps & { [P in N]: RefOut<R> }>, RefOut<R>> {
    const list = (Array.isArray(task) ? [...task] : [task]) as AnyTaskRef[];
    if (list.length === 0) throw new Error(`workflow ${this.name}, step ${name}: needs at least one task`);
    const spec: StepSpec = { name, refs: list.map(taskRefImpl), input: input as StepSpec["input"] };
    return new WorkflowBuilder(this.platform, this.name, this.schema, [...this.specs, spec]);
  }

  /**
   * Declare the workflow's result, computed from its input and every step's output once the
   * last step completes (instead of the last step's output). It's part of the definition:
   * the result is stored, and a throw fails the workflow, without retry. Keep it pure and
   * return JSON-serializable data.
   */
  output<O>(fn: (ctx: StepContext<In, Steps>) => O): { build(): WorkflowRef<InRaw, Steps, O> } {
    return { build: () => this.register(fn as OutputFn) };
  }

  /** Register the workflow with the platform. */
  build(): WorkflowRef<InRaw, Steps, Out> {
    return this.register();
  }

  private register<O>(output?: OutputFn): WorkflowRef<InRaw, Steps, O> {
    this.platform.registerWorkflow(this.name, this.schema, this.specs, output);
    return new WorkflowRefImpl(this.platform, this.name);
  }
}

class WorkflowRefImpl<In, Steps extends AnySteps, Out> implements WorkflowRef<In, Steps, Out> {
  constructor(
    private readonly platform: Platform,
    readonly name: string,
  ) {}

  start(input: In, opts: { idempotencyKey?: string } = {}): WorkflowHandle<In, Steps, Out> {
    return new WorkflowHandleImpl(this.platform, this.platform.startRun(this.name, input, opts));
  }

  run(id: string): WorkflowHandle<In, Steps, Out> {
    this.platform.assertOpen();
    const wf = this.platform.kernel.workflows.get(id);
    if (!wf) throw new Error(`unknown workflow run ${id}`);
    if (wf.name !== this.name) throw new WorkflowMismatchError(id, this.name, `it is a run of ${wf.name}`);
    if (wf.fingerprint !== this.platform.kernel.workflows.fingerprint(this.name)) {
      throw new WorkflowMismatchError(id, this.name, "it was started with a different definition");
    }
    return new WorkflowHandleImpl(this.platform, id);
  }
}

// ── Kernel adapters (used by Platform) ─────────────────────────────────────

/** Turns a typed step spec into the kernel's step definition (validation included). */
export function toKernelStep(_workflow: string, schema: z.ZodType, spec: StepSpec) {
  return {
    name: spec.name,
    agents: spec.refs.map((r) => r.agent.id),
    task: spec.refs[0]!.task,
    tasks: spec.refs.map((r) => r.task),
    input: (ctx: { input: unknown; steps: AnySteps; workflow: { id: string } }) => {
      const value = spec.input({ input: schema.parse(ctx.input), steps: ctx.steps, workflow: ctx.workflow });
      // Like send(): check in the platform process, store the raw value. Every candidate
      // gets the same input, so it must fit every candidate's schema.
      for (const ref of spec.refs) ref.validate(value);
      return value;
    },
  };
}

export function validateWorkflowInput(workflow: string, schema: z.ZodType, input: unknown): void {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new WorkflowInputError(workflow, z.prettifyError(parsed.error));
}

export function toFileEvent(e: KernelFileEvent): FileEvent {
  return { listener: e.listener, event: e.event, path: e.path, name: e.name };
}

export class WorkflowHandleImpl<In = unknown, Steps extends AnySteps = AnySteps, Out = unknown> implements WorkflowHandle<In, Steps, Out> {
  readonly workflow: string;

  constructor(
    private readonly platform: Platform,
    readonly id: string,
  ) {
    const wf = platform.kernel.workflows.get(id);
    if (!wf) throw new Error(`unknown workflow run ${id}`);
    this.workflow = wf.name;
  }

  status(): WorkflowInfo {
    this.platform.assertOpen();
    return toInfo(this.platform.kernel.workflows.get(this.id)!);
  }

  input(): In {
    return this.status().input as In;
  }

  step<N extends keyof Steps & string>(name: N): WorkflowStepSnapshot<Steps[N]> {
    const s = this.steps().find((x) => x.name === name);
    if (!s) throw new Error(`workflow ${this.workflow} has no step "${name}"`);
    // Normalize so the union holds: a result only when completed, an error only when failed.
    return {
      ...s,
      result: s.status === "completed" ? s.result : null,
      error: s.status === "failed" ? (s.error ?? "failed") : null,
    } as WorkflowStepSnapshot<Steps[N]>;
  }

  steps(): WorkflowStepInfo[] {
    this.platform.assertOpen();
    return this.platform.kernel.workflows.steps(this.id).map((s: WorkflowStep) => ({
      name: s.name,
      status: s.status,
      assignment: s.assignment,
      agent: s.agentId && this.platform.nameOf(s.agentId),
      taskId: s.inboxItemId,
      result: s.result,
      error: s.error,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
    }));
  }

  events(): WorkflowEvent[] {
    this.platform.assertOpen();
    return this.platform.kernel.workflows.events(this.id);
  }

  async result(): Promise<Out> {
    this.platform.assertOpen();
    const wf = await this.platform.kernel.workflows.waitFor(this.id);
    if (wf.status === "completed") return wf.output as Out;
    throw new WorkflowFailedError(this.id, wf.name, wf.error);
  }
}

export class ListenerHandleImpl implements ListenerHandle {
  constructor(
    private readonly platform: Platform,
    readonly name: string,
    readonly id: string,
  ) {}

  private row(): Listener {
    this.platform.assertOpen();
    return this.platform.kernel.listeners.get(this.id)!;
  }

  status() {
    const l = this.row();
    return { state: l.state, dir: l.path, lastScanAt: l.lastScanAt, lastError: l.lastError };
  }

  pause(): void {
    this.row();
    this.platform.kernel.listeners.setState(this.id, "paused");
  }

  resume(): void {
    this.row();
    this.platform.kernel.listeners.setState(this.id, "active");
  }
}

const toInfo = (wf: Workflow): WorkflowInfo => ({
  id: wf.id,
  workflow: wf.name,
  status: wf.status,
  input: wf.input,
  currentStep: wf.currentStep,
  output: wf.output,
  error: wf.error,
  createdAt: wf.createdAt,
  updatedAt: wf.updatedAt,
});
