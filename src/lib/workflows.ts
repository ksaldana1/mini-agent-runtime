/**
 * Workflows and listeners defined in code (D1): a typed step list, and named listeners
 * whose targets are functions, not templates.
 *
 *   const publish = platform.workflow("publish")
 *     .input(z.object({ path: z.string() }))
 *     .step("edit", editor, "edit", ({ input }) => ({ path: input.path }))
 *     .step("review", [junior, senior], "review", ({ steps }) => ({ path: steps.edit.path }))
 *     .build();
 *
 *   platform.listen("submissions", { dir: "shared/documents/in" })
 *     .startWorkflow(publish, (file) => ({ path: file.path }));
 */
import { z } from "zod";
import type { FileEvent as KernelFileEvent, Listener, ListenerEvent } from "../platform/listeners.js";
import type { StepStatus, Workflow, WorkflowEvent, WorkflowStatus, WorkflowStep } from "../platform/workflows.js";
import type { AgentDefinition, TaskInput, TaskNames, TaskOutput } from "./agent.js";
import { TaskInputError, WorkflowFailedError, WorkflowInputError } from "./errors.js";
import type { AgentHandle, Platform } from "./platform.js";

// ── Public types ────────────────────────────────────────────────────────────

/** A registered workflow. `In` is what startWorkflow accepts; `Out` is the last step's output. */
export interface WorkflowRef<In, Out> {
  readonly name: string;
  /** Type-only: carries In and Out. Never set at runtime. */
  readonly __types?: { in: In; out: Out };
}

/** What a step's input function sees. */
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

export type { WorkflowEvent, WorkflowStatus, StepStatus };

export interface WorkflowHandle<Out = unknown> {
  readonly id: string;
  readonly workflow: string;
  status(): WorkflowInfo;
  steps(): WorkflowStepInfo[];
  /** The append-only transition log. */
  events(): WorkflowEvent[];
  /** Resolves with the last step's output, or rejects with WorkflowFailedError. No polling. */
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
   * Enqueue a task for `agent` for each file event. The agent must be allowed to read
   * `dir` (a listener reveals file names to its target).
   */
  send<D extends AgentDefinition, K extends TaskNames<D>>(
    agent: AgentHandle<D>,
    task: K,
    input: (file: FileEvent) => TaskInput<D, K>,
  ): ListenerHandle;
  /**
   * Start a run of `workflow` for each file event. Platform-owned: no agent's permission
   * is involved. The run is started in the same transaction that records the file as seen,
   * with idempotency key listener:<name>:<event>:<path>:<mtime>, so a crash can't lose or
   * duplicate it.
   */
  startWorkflow<In>(workflow: WorkflowRef<In, unknown>, input: (file: FileEvent) => In): ListenerHandle;
}

// ── Builder ─────────────────────────────────────────────────────────────────

type Simplify<T> = { [K in keyof T]: T[K] } & {};

interface StepSpec {
  name: string;
  agents: AgentHandle<AgentDefinition>[];
  task: string;
  input: (ctx: StepContext<unknown, Record<string, unknown>>) => unknown;
}

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

export class WorkflowBuilder<In, InRaw, Steps extends Record<string, unknown>, Out> {
  constructor(
    private readonly platform: Platform,
    private readonly name: string,
    private readonly schema: z.ZodType,
    private readonly specs: StepSpec[],
  ) {}

  /**
   * Add a step: run `task` on `agents` (the first, then fallbacks if it fails) with the
   * input computed from the workflow input and earlier steps' outputs.
   */
  step<N extends string, D extends AgentDefinition, K extends TaskNames<D>>(
    name: N,
    agents: AgentHandle<D> | readonly AgentHandle<D>[],
    task: K,
    input: (ctx: StepContext<In, Steps>) => TaskInput<D, K>,
  ): WorkflowBuilder<In, InRaw, Simplify<Steps & { [P in N]: TaskOutput<D, K> }>, TaskOutput<D, K>> {
    const list = (Array.isArray(agents) ? [...agents] : [agents]) as AgentHandle<AgentDefinition>[];
    const spec: StepSpec = { name, agents: list, task, input: input as StepSpec["input"] };
    return new WorkflowBuilder(this.platform, this.name, this.schema, [...this.specs, spec]);
  }

  /** Register the workflow with the platform. */
  build(): WorkflowRef<InRaw, Out> {
    this.platform.registerWorkflow(this.name, this.schema, this.specs);
    return { name: this.name };
  }
}

// ── Kernel adapters (used by Platform) ─────────────────────────────────────

/** Turns a typed step spec into the kernel's step definition (validation included). */
export function toKernelStep(workflow: string, schema: z.ZodType, spec: StepSpec) {
  for (const a of spec.agents) {
    if (!Object.hasOwn(a.definition.tasks, spec.task)) {
      throw new Error(`workflow ${workflow}, step ${spec.name}: agent ${a.name} has no task "${spec.task}"`);
    }
  }
  const taskSchema = spec.agents[0]!.definition.tasks[spec.task]!.input;
  return {
    name: spec.name,
    agents: spec.agents.map((a) => a.id),
    task: spec.task,
    input: (ctx: { input: unknown; steps: Record<string, unknown>; workflow: { id: string } }) => {
      const value = spec.input({ input: schema.parse(ctx.input), steps: ctx.steps, workflow: ctx.workflow });
      // Like send(): check in the platform process, store the raw value.
      const parsed = taskSchema.safeParse(value);
      if (!parsed.success) throw new TaskInputError(spec.task, spec.agents[0]!.name, z.prettifyError(parsed.error));
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

export class WorkflowHandleImpl<Out> implements WorkflowHandle<Out> {
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
