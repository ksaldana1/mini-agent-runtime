/**
 * The public face of the platform: wires the kernel (src/platform/*) together and hands
 * out typed handles. Code defines behaviour (agent modules, policies); SQLite holds state.
 *
 *   const platform = createPlatform({ dataDir: "data" });
 *   const editor = platform.agent("editor", editorDef, { restart: "on-crash" });
 *   await platform.start();                          // recovery, listeners, autostart agents
 *   const edit = editor.task("edit");                // a TaskRef: the operation
 *   const out = await edit.send({ path }).result();  // a TaskHandle: one execution
 *   await platform.close();
 */
import { join } from "node:path";
import { z } from "zod";
import { openDatabase, type Db } from "../platform/database.js";
import { Dispatcher } from "../platform/dispatcher.js";
import { AgentFilesystem, type AuditEntry } from "../platform/filesystem.js";
import { AgentRegistry } from "../platform/identity.js";
import { Inbox, type InboxItem } from "../platform/inbox.js";
import { ListenerService } from "../platform/listeners.js";
import { Supervisor, type RestartPolicy, type RuntimeInfo, type RuntimeRecord, type RuntimeState } from "../platform/supervisor.js";
import { WorkflowService, type Workflow, type WorkflowEvent } from "../platform/workflows.js";
import type { Listener } from "../platform/listeners.js";
import {
  isAgentDefinition,
  type Access,
  type AgentConfigInput,
  type AgentDefinition,
  type TaskInput,
  type TaskNames,
  type TaskOutput,
} from "./agent.js";
import { AgentConfigError, TaskFailedError, TaskInputError } from "./errors.js";
import { PlatformEventEmitter, type TaskStatus } from "./events.js";
import {
  ListenerHandleImpl,
  toFileEvent,
  toKernelStep,
  validateWorkflowInput,
  WorkflowHandleImpl,
  WorkflowStart,
  type ListenerBuilder,
  type ListenerHandle,
  type ListenOptions,
  type StepSpec,
  type WorkflowHandle,
  type WorkflowRef,
} from "./workflows.js";

// ── Public types ────────────────────────────────────────────────────────────

export interface PlatformOptions {
  /** Root of everything on disk: the database (by default) and the agent filesystem. */
  dataDir: string;
  /** Defaults to `<dataDir>/platform.db`. ":memory:" works for tests. */
  dbPath?: string;
  inbox?: { maxAttempts?: number };
  listeners?: { intervalMs?: number; settleMs?: number };
  runtime?: { requestTimeoutMs?: number; stopTimeoutMs?: number; inheritStdio?: boolean };
}

export type { RestartPolicy, RuntimeRecord, RuntimeState };

export interface AgentOptions<D extends AgentDefinition = AgentDefinition> {
  /** Default "on-crash" (with the kernel's default backoff and cap). */
  restart?: "never" | "on-crash" | RestartPolicy;
  /** Start a runtime in platform.start() (or right away, if already started). Default true. */
  autostart?: boolean;
  /**
   * The agent's config, validated against the definition's `config` schema (AgentConfigError
   * otherwise). Stored with the agent's identity; omit it to keep the stored config. Runtimes
   * receive it when they start, so a change takes effect on the next start or restart.
   * Config doesn't grant anything: a directory named here still needs `grant()`.
   */
  config?: AgentConfigInput<D>;
}

export interface RuntimeStatus {
  state: RuntimeState;
  incarnation: number;
  pid: number;
}

export interface TaskInfo {
  id: string;
  agent: string;
  agentId: string;
  /** null if the inbox item isn't a { task, input } payload. */
  task: string | null;
  input: unknown;
  status: TaskStatus;
  attempts: number;
  result: unknown;
  lastError: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface TaskHandle<Out = unknown> {
  readonly id: string;
  readonly agent: string;
  readonly task: string | null;
  /** Current durable state of the task. */
  status(): TaskInfo;
  /**
   * Resolves with the task's result once it completes, however many deliveries that
   * takes. Rejects with TaskFailedError if it ends up failed. No polling: it waits on
   * the inbox's settlement event, or resolves at once if the task already settled.
   */
  result(): Promise<Out>;
}

/**
 * One task of one agent: the operation, not an execution. Pass it to workflow steps and
 * listeners, or `send()` it. Get one with `agent.task(name)`.
 */
export interface TaskRef<In = unknown, Out = unknown> {
  readonly agent: { readonly id: string; readonly name: string };
  readonly task: string;
  /**
   * Durably enqueue this task. The input is validated against the task's schema first;
   * invalid input throws TaskInputError and nothing is enqueued. With the same
   * idempotencyKey, a repeat send returns a handle to the original task.
   */
  send(input: In, opts?: { idempotencyKey?: string }): TaskHandle<Out>;
  /** Type-only, never set. `In` is invariant, so fallback candidates must agree on their input. */
  readonly __types?: { in: (input: In) => In; out: Out };
}

export interface AgentHandle<D extends AgentDefinition = AgentDefinition> {
  readonly id: string;
  readonly name: string;
  readonly definition: D;
  start(): Promise<RuntimeStatus>;
  stop(): Promise<void>;
  restart(): Promise<RuntimeStatus>;
  /** The current (or last) runtime of this agent in this process, if any. */
  status(): RuntimeStatus | undefined;
  /** Every runtime incarnation this agent has had, oldest first. */
  history(): RuntimeRecord[];
  /** Platform grant: let this agent read or write a path (and everything under it). */
  grant(path: string, access: Access): void;
  revoke(path: string): void;
  /** Tasks addressed to this agent, oldest first. */
  inbox(status?: TaskStatus): TaskInfo[];
  /** A reference to one of this agent's tasks. Throws TaskInputError for an unknown task. */
  task<K extends TaskNames<D>>(task: K): TaskRef<TaskInput<D, K>, TaskOutput<D, K>>;
  /** Shorthand for `agent.task(task).send(input, opts)`. */
  send<K extends TaskNames<D>>(task: K, input: TaskInput<D, K>, opts?: { idempotencyKey?: string }): TaskHandle<TaskOutput<D, K>>;
}

// ── Implementation ──────────────────────────────────────────────────────────

/** @internal The wired kernel services. Not part of the public API. */
export interface Kernel {
  db: Db;
  registry: AgentRegistry;
  fs: AgentFilesystem;
  inbox: Inbox;
  supervisor: Supervisor;
  dispatcher: Dispatcher;
  workflows: WorkflowService;
  listeners: ListenerService;
}

type Lifecycle = "created" | "started" | "closed";

export class Platform implements AsyncDisposable {
  readonly events = new PlatformEventEmitter();
  /** @internal */
  readonly kernel: Kernel;
  private lifecycle: Lifecycle = "created";
  private readonly handles = new Map<string, AgentHandleImpl<AgentDefinition>>();
  private readonly autostart = new Set<string>();
  private readonly workflowSchemas = new Map<string, z.ZodType>();
  private readonly listenerNames = new Set<string>();

  constructor(opts: PlatformOptions) {
    const db = openDatabase(opts.dbPath ?? join(opts.dataDir, "platform.db"));
    const registry = new AgentRegistry(db);
    const fs = new AgentFilesystem(db, registry, opts.dataDir);
    const inbox = new Inbox(db, registry, { maxAttempts: opts.inbox?.maxAttempts });
    const supervisor = new Supervisor(db, registry, { ...opts.runtime, fsHandler: (id, req) => fs.handle(id, req) });
    const dispatcher = new Dispatcher(supervisor, inbox);
    const workflows = new WorkflowService(db, registry, inbox);
    const listeners = new ListenerService(db, registry, fs, inbox, opts.listeners);
    this.kernel = { db, registry, fs, inbox, supervisor, dispatcher, workflows, listeners };
    this.bridgeEvents();
  }

  /**
   * Register an agent's code under a name, creating the agent the first time. The name is
   * the identity: the same name on a later boot gets the same agent (same id, inbox, files).
   */
  agent<D extends AgentDefinition>(name: string, definition: D, opts: AgentOptions<D> = {}): AgentHandle<D> {
    this.assertOpen();
    if (this.handles.has(name)) throw new Error(`agent "${name}" is already registered in this process`);
    if (!isAgentDefinition(definition)) throw new Error(`agent "${name}": not an agent definition (use defineAgent)`);
    const { registry, supervisor } = this.kernel;

    let agent = registry.getByName(name);
    if (agent && agent.lifecycleState !== "active") throw new Error(`agent "${name}" is ${agent.lifecycleState}`);
    // Validate before touching the registry, so a bad config changes nothing. Without a
    // new config, the stored one must still fit the (possibly changed) schema.
    const config = (opts.config ?? agent?.configuration ?? {}) as Record<string, unknown>;
    if (definition.config) {
      const parsed = definition.config.safeParse(config);
      if (!parsed.success) throw new AgentConfigError(name, z.prettifyError(parsed.error));
    }
    if (!agent) agent = registry.create(name, config);
    else if (JSON.stringify(config) !== JSON.stringify(agent.configuration)) registry.updateConfiguration(agent.id, config);

    supervisor.setModule(agent.id, definition.moduleUrl);
    const restart = opts.restart ?? "on-crash";
    supervisor.setPolicy(agent.id, typeof restart === "string" ? { restart } : restart);

    const handle = new AgentHandleImpl(this, agent.id, name, definition);
    this.handles.set(name, handle as AgentHandleImpl<AgentDefinition>);
    if (opts.autostart ?? true) {
      this.autostart.add(name);
      // Registered after start(): reconcile right away.
      if (this.lifecycle === "started") {
        handle.start().catch((err: Error) => this.events.emit("agent.start-failed", { agent: name, agentId: agent.id, error: err.message }));
      }
    }
    return handle;
  }

  // ── Workflows ─────────────────────────────────────────────────────────────

  /**
   * Define a workflow: `.input(schema)`, then `.step(...)` for each step, then `.build()`.
   * Like agents, workflows are registered by name on every boot; running workflows pick up
   * the registered definition (and fail with "definition changed" if its steps changed).
   */
  workflow(name: string): WorkflowStart {
    this.assertOpen();
    return new WorkflowStart(this, name);
  }

  /**
   * Start a run of a workflow. The input is validated first (WorkflowInputError, nothing
   * started). With the same idempotencyKey, a repeat start returns the original run.
   */
  startWorkflow<In, Steps extends Record<string, unknown>, Out>(
    workflow: WorkflowRef<In, Steps, Out>,
    input: NoInfer<In>,
    opts: { idempotencyKey?: string } = {},
  ): WorkflowHandle<In, Steps, Out> {
    return workflow.start(input, opts);
  }

  /** @internal Shared by WorkflowRef.start() and listeners. Returns the run id. */
  startRun(name: string, input: unknown, opts: { idempotencyKey?: string } = {}): string {
    this.assertOpen();
    const schema = this.workflowSchemas.get(name);
    if (!schema) throw new Error(`workflow ${name} is not registered in this platform`);
    validateWorkflowInput(name, schema, input);
    return this.kernel.workflows.start(name, input, opts).id;
  }

  /**
   * Reattach to any workflow run by id, untyped (for timelines and tooling). To get a typed
   * handle, use the workflow's ref: `ref.run(id)` also checks the run belongs to it.
   */
  workflowRun(id: string): WorkflowHandle {
    this.assertOpen();
    return new WorkflowHandleImpl(this, id);
  }

  /** @internal Called by WorkflowBuilder.build(). */
  registerWorkflow(name: string, schema: z.ZodType, specs: StepSpec[], output?: (ctx: { input: unknown; steps: Record<string, unknown>; workflow: { id: string } }) => unknown): void {
    this.assertOpen();
    if (this.workflowSchemas.has(name)) throw new Error(`workflow "${name}" is already registered in this process`);
    if (specs.length === 0) throw new Error(`workflow "${name}" needs at least one step`);
    this.kernel.workflows.register({
      name,
      steps: specs.map((s) => toKernelStep(name, schema, s)),
      output: output && ((ctx) => output({ ...ctx, input: schema.parse(ctx.input) })),
    });
    this.workflowSchemas.set(name, schema);
    // Registered after start(): let runs of this workflow catch up right away.
    if (this.lifecycle === "started") this.kernel.workflows.recover();
  }

  // ── Listeners ─────────────────────────────────────────────────────────────

  /**
   * Watch a directory. Pick a target with `.send(agent.task(name), fn)` or
   * `.startWorkflow(workflow, fn)`. Registration is by name and survives restarts: files
   * already seen don't fire again. Changing `dir` resets what has been seen.
   */
  listen(name: string, opts: ListenOptions): ListenerBuilder {
    this.assertOpen();
    if (this.listenerNames.has(name)) throw new Error(`listener "${name}" is already registered in this process`);
    const register = (target: Parameters<ListenerService["register"]>[1]["target"]): ListenerHandle => {
      if (this.listenerNames.has(name)) throw new Error(`listener "${name}" is already registered in this process`);
      const l: Listener = this.kernel.listeners.register(name, { path: opts.dir, events: opts.events, includeExisting: opts.includeExisting, target });
      this.listenerNames.add(name);
      return new ListenerHandleImpl(this, name, l.id);
    };
    return {
      send: (task, input) => {
        const ref = taskRefImpl(task);
        return register({
          kind: "agent",
          agentId: ref.agent.id,
          payload: (e) => {
            const value = input(toFileEvent(e));
            ref.validate(value);
            return { task: ref.task, input: value };
          },
        });
      },
      startWorkflow: (workflow, input) => {
        if (!this.workflowSchemas.has(workflow.name)) throw new Error(`listener ${name}: workflow ${workflow.name} is not registered in this platform`);
        return register({
          kind: "platform",
          fire: (e: Parameters<typeof toFileEvent>[0], idempotencyKey: string) => this.startRun(workflow.name, input(toFileEvent(e)), { idempotencyKey }),
        });
      },
    };
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────

  /** Reattach to a task by id, e.g. one created by an earlier process. */
  task<Out = unknown>(id: string): TaskHandle<Out> {
    this.assertOpen();
    if (!this.kernel.inbox.get(id)) throw new Error(`unknown task ${id}`);
    return new TaskHandleImpl<Out>(this, id);
  }

  /**
   * Recover state left by a previous process (stale runtime records and claims, workflow
   * progress), start listener scanning, then start every autostart agent. Rejects if any
   * autostart agent fails to start; the others are left running.
   */
  async start(): Promise<void> {
    if (this.lifecycle !== "created") throw new Error(`platform already ${this.lifecycle}`);
    const { supervisor, dispatcher, workflows, listeners } = this.kernel;
    supervisor.recover();
    dispatcher.recover();
    workflows.recover();
    listeners.start();
    this.lifecycle = "started";

    const names = [...this.autostart];
    const results = await Promise.allSettled(names.map((n) => this.handles.get(n)!.start()));
    const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${names[i]}: ${(r.reason as Error).message}`] : []));
    if (failed.length > 0) throw new Error(`failed to start ${failed.length} agent(s): ${failed.join("; ")}`);
  }

  /** Stop listeners and runtimes, then close the database. Safe to call twice. */
  async close(): Promise<void> {
    if (this.lifecycle === "closed") return;
    this.lifecycle = "closed";
    this.kernel.listeners.stop();
    await this.kernel.supervisor.close();
    // Let settlement events queued by the final runtime exits run against an open DB.
    await new Promise<void>((r) => setImmediate(r));
    this.kernel.db.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  // ── Internals shared with handles ─────────────────────────────────────────

  /** @internal */
  assertOpen(): void {
    if (this.lifecycle === "closed") throw new Error("platform is closed");
  }

  /** @internal */
  assertStarted(): void {
    this.assertOpen();
    // Runtimes started before recovery would race it (stale claims, stale runtime rows).
    if (this.lifecycle !== "started") throw new Error("call platform.start() before starting agents");
  }

  /** @internal */
  nameOf(agentId: string): string {
    return this.kernel.registry.get(agentId)?.name ?? agentId;
  }

  /** @internal */
  taskInfo(item: InboxItem): TaskInfo {
    const payload = item.payload as { task?: unknown; input?: unknown } | null;
    const isTask = typeof payload === "object" && payload !== null && typeof payload.task === "string";
    return {
      id: item.id,
      agent: this.nameOf(item.recipientAgentId),
      agentId: item.recipientAgentId,
      task: isTask ? (payload.task as string) : null,
      input: isTask ? payload.input : item.payload,
      status: item.status,
      attempts: item.attempts,
      result: item.result,
      lastError: item.lastError,
      createdAt: item.createdAt,
      settledAt: item.status === "completed" || item.status === "failed" ? item.acknowledgedAt : null,
    };
  }

  /** Re-emit kernel events as public, name-carrying events. */
  private bridgeEvents(): void {
    const { supervisor, inbox, dispatcher, listeners, workflows, fs } = this.kernel;
    const e = this.events;
    const taskName = (item: InboxItem) => {
      const p = item.payload as { task?: unknown } | null;
      return typeof p?.task === "string" ? p.task : null;
    };

    supervisor.on("runtime-ready", (r: RuntimeInfo) =>
      e.emit("agent.ready", { agent: this.nameOf(r.agentId), agentId: r.agentId, incarnation: r.incarnation, pid: r.pid }),
    );
    supervisor.on("runtime-exit", (r: RuntimeInfo) =>
      e.emit("agent.exited", { agent: this.nameOf(r.agentId), agentId: r.agentId, incarnation: r.incarnation, pid: r.pid, state: r.state }),
    );
    supervisor.on("restart-scheduled", (r: { agentId: string; attempt: number; delayMs: number }) =>
      e.emit("agent.restarting", { agent: this.nameOf(r.agentId), ...r }),
    );
    supervisor.on("gave-up", (r: { agentId: string; crashes: number; windowMs: number }) =>
      e.emit("agent.gave-up", { agent: this.nameOf(r.agentId), ...r }),
    );
    inbox.on("enqueued", (item: InboxItem) =>
      e.emit("task.enqueued", { taskId: item.id, agent: this.nameOf(item.recipientAgentId), agentId: item.recipientAgentId, task: taskName(item), input: this.taskInfo(item).input }),
    );
    dispatcher.on("delivered", ({ item, incarnation }: { item: InboxItem; incarnation: number }) =>
      e.emit("task.delivered", {
        taskId: item.id,
        agent: this.nameOf(item.recipientAgentId),
        agentId: item.recipientAgentId,
        task: taskName(item),
        attempt: item.attempts,
        incarnation,
      }),
    );
    dispatcher.on("failed", ({ item, error, retryable, willRetry }: { item: InboxItem; error: string; retryable: boolean; willRetry: boolean }) =>
      e.emit("task.attempt-failed", {
        taskId: item.id,
        agent: this.nameOf(item.recipientAgentId),
        agentId: item.recipientAgentId,
        task: taskName(item),
        error,
        retryable,
        willRetry,
      }),
    );
    inbox.on("settled", (item: InboxItem) =>
      e.emit("task.settled", {
        taskId: item.id,
        agent: this.nameOf(item.recipientAgentId),
        agentId: item.recipientAgentId,
        task: taskName(item),
        status: item.status as "completed" | "failed",
        attempts: item.attempts,
        result: item.result,
        error: item.status === "failed" ? item.lastError : null,
      }),
    );
    listeners.on("fired", ({ listener, event, path, item, result }: { listener: Listener; event: string; path: string; item?: InboxItem; result?: unknown }) =>
      e.emit("listener.fired", {
        listener: listener.name,
        listenerId: listener.id,
        event,
        path,
        agent: listener.targetAgentId && this.nameOf(listener.targetAgentId),
        agentId: listener.targetAgentId,
        taskId: item?.id ?? null,
        workflowId: typeof result === "string" ? result : null,
      }),
    );
    listeners.on("error", ({ listener, path, error }: { listener: Listener; path: string; error: Error }) =>
      e.emit("listener.error", { listener: listener.name, path, error: error.message }),
    );
    listeners.on("skipped", ({ listener, reason }: { listener: Listener; reason: string }) =>
      e.emit("listener.skipped", { listener: listener.name, reason }),
    );
    workflows.on("transition", (w: WorkflowEvent) =>
      e.emit("workflow.transition", { workflowId: w.workflowId, workflow: workflows.get(w.workflowId)?.name ?? "?", event: w.event, detail: w.detail }),
    );
    workflows.on("settled", (w: Workflow) =>
      e.emit("workflow.settled", { workflowId: w.id, workflow: w.name, status: w.status as "completed" | "failed", output: w.output, error: w.error }),
    );
    workflows.on("skipped", (w: { workflowId: string; name: string; reason: string }) =>
      e.emit("workflow.skipped", { workflowId: w.workflowId, workflow: w.name, reason: w.reason }),
    );
    fs.on("denied", (a: AuditEntry) => e.emit("fs.denied", { agent: this.nameOf(a.agentId), agentId: a.agentId, op: a.op, path: a.path, reason: a.reason }));
  }
}

class AgentHandleImpl<D extends AgentDefinition> implements AgentHandle<D> {
  constructor(
    private readonly platform: Platform,
    readonly id: string,
    readonly name: string,
    readonly definition: D,
  ) {}

  async start(): Promise<RuntimeStatus> {
    this.platform.assertStarted();
    return toStatus(await this.platform.kernel.supervisor.start(this.id));
  }

  async stop(): Promise<void> {
    this.platform.assertOpen();
    await this.platform.kernel.supervisor.stop(this.id);
  }

  async restart(): Promise<RuntimeStatus> {
    this.platform.assertStarted();
    return toStatus(await this.platform.kernel.supervisor.restart(this.id));
  }

  status(): RuntimeStatus | undefined {
    const info = this.platform.kernel.supervisor.status(this.id);
    return info && toStatus(info);
  }

  history(): RuntimeRecord[] {
    return this.platform.kernel.supervisor.history(this.id);
  }

  grant(path: string, access: Access): void {
    this.platform.assertOpen();
    this.platform.kernel.fs.grant(this.id, path, access);
  }

  revoke(path: string): void {
    this.platform.assertOpen();
    this.platform.kernel.fs.revoke(this.id, path);
  }

  inbox(status?: TaskStatus): TaskInfo[] {
    return this.platform.kernel.inbox.list(this.id, status).map((i) => this.platform.taskInfo(i));
  }

  task<K extends TaskNames<D>>(task: K): TaskRef<TaskInput<D, K>, TaskOutput<D, K>> {
    const tasks = this.definition.tasks;
    const def = Object.hasOwn(tasks, task) ? tasks[task] : undefined;
    if (!def) throw new TaskInputError(task, this.name, `unknown task (this agent has: ${Object.keys(tasks).join(", ")})`);
    return new TaskRefImpl(this.platform, { id: this.id, name: this.name }, task, def.input);
  }

  send<K extends TaskNames<D>>(task: K, input: TaskInput<D, K>, opts: { idempotencyKey?: string } = {}): TaskHandle<TaskOutput<D, K>> {
    return this.task(task).send(input, opts);
  }
}

/** @internal The one place a task's input is checked before it's stored (send, steps, listeners). */
export class TaskRefImpl<In, Out> implements TaskRef<In, Out> {
  constructor(
    private readonly platform: Platform,
    readonly agent: { readonly id: string; readonly name: string },
    readonly task: string,
    private readonly schema: z.ZodType,
  ) {}

  /** Throws TaskInputError. The runtime validates again on delivery. */
  validate(input: unknown): void {
    const parsed = this.schema.safeParse(input);
    if (!parsed.success) throw new TaskInputError(this.task, this.agent.name, z.prettifyError(parsed.error));
  }

  send(input: In, opts: { idempotencyKey?: string } = {}): TaskHandle<Out> {
    this.platform.assertOpen();
    this.validate(input);
    // Store the caller's input, not the parsed output: the runtime parses it with the
    // same schema, and parsing an already-transformed value isn't guaranteed to work.
    const item = this.platform.kernel.inbox.send(this.agent.id, { task: this.task, input }, { idempotencyKey: opts.idempotencyKey });
    return new TaskHandleImpl(this.platform, item.id);
  }
}

/** @internal */
export function taskRefImpl(ref: TaskRef<any, any>): TaskRefImpl<unknown, unknown> {
  if (!(ref instanceof TaskRefImpl)) throw new Error("expected a TaskRef from agent.task(name)");
  return ref as TaskRefImpl<unknown, unknown>;
}

class TaskHandleImpl<Out> implements TaskHandle<Out> {
  readonly agent: string;
  readonly task: string | null;

  constructor(
    private readonly platform: Platform,
    readonly id: string,
  ) {
    const info = this.status();
    this.agent = info.agent;
    this.task = info.task;
  }

  status(): TaskInfo {
    this.platform.assertOpen();
    return this.platform.taskInfo(this.platform.kernel.inbox.get(this.id)!);
  }

  async result(): Promise<Out> {
    this.platform.assertOpen();
    const item = await this.platform.kernel.inbox.waitFor(this.id);
    if (item.status === "completed") return item.result as Out;
    throw new TaskFailedError(this.id, this.task ?? "?", this.agent, item.lastError, item.attempts);
  }
}

const toStatus = (r: RuntimeInfo): RuntimeStatus => ({ state: r.state, incarnation: r.incarnation, pid: r.pid });

/** Wire up a platform. Nothing runs until `await platform.start()`. */
export function createPlatform(opts: PlatformOptions): Platform {
  return new Platform(opts);
}
