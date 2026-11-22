import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { Db } from "./database.js";
import type { AgentRegistry } from "./identity.js";
import { AgentResponseSchema, type AgentMessage, type AgentResponse, type FsRequest } from "../shared/protocol.js";

/**
 * State of one runtime incarnation (a process), not of the logical agent.
 * "given-up" = crashed, and the restart policy hit its cap, so nothing will restart it.
 */
export type RuntimeState = "starting" | "running" | "stopping" | "exited" | "crashed" | "given-up";

/**
 * Erlang-style supervision for one agent. Only crashes are restarted, never deliberate
 * stops. Restarts back off exponentially (backoffMs, 2×, 4×, … capped at maxBackoffMs);
 * more than `maxRestarts` crashes within `windowMs` and the supervisor gives up.
 */
export interface RestartPolicy {
  restart: "never" | "on-crash";
  /** Restarts allowed within `windowMs` before giving up. Default 5. */
  maxRestarts?: number;
  /** Sliding window for counting crashes. Default 60s. */
  windowMs?: number;
  /** Delay before the first restart in a window; doubles per further crash. Default 100ms. */
  backoffMs?: number;
  /** Upper bound on the delay. Default 10s. */
  maxBackoffMs?: number;
}

interface Supervision {
  policy: Required<RestartPolicy>;
  /** Timestamps of recent crashes (pruned to the window). */
  crashes: number[];
  timer?: NodeJS.Timeout;
}

export interface RuntimeInfo {
  agentId: string;
  incarnation: number;
  pid: number;
  state: RuntimeState;
}

export interface RuntimeRecord {
  agentId: string;
  incarnation: number;
  pid: number;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
  exitSignal: string | null;
}

interface Pending {
  resolve: (r: AgentResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Runtime extends RuntimeInfo {
  child: ChildProcess;
  pending: Map<string, Pending>;
  exited: Promise<void>;
}

export interface SupervisorOptions {
  /** Script forked for each runtime. Defaults to the generic host, src/runtime/host.ts. */
  runtimeEntry?: string;
  /**
   * Agent module (file: URL) for agents with none set via setModule(). Handy for kernel
   * tests and demos where every agent runs the same code; the library sets one per agent.
   */
  defaultModule?: string;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Forward runtime stdout/stderr to ours (handy in the demo, noisy in tests). */
  inheritStdio?: boolean;
  /**
   * Serves runtime-initiated filesystem requests. `agentId` comes from the IPC
   * channel the request arrived on, never from the request itself.
   */
  fsHandler?: (agentId: string, request: FsRequest) => unknown;
}

/** A task the runtime reported as failed. `retryable: false` means retrying can't help. */
export class TaskError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const DEFAULT_ENTRY = fileURLToPath(new URL("../runtime/host.ts", import.meta.url));

/**
 * The authority on runtime lifecycle. Maps persistent agent IDs to the
 * (temporary) process currently embodying them. At most one live runtime per agent.
 *
 * Events: "runtime-ready" (RuntimeInfo), "runtime-exit" (RuntimeInfo),
 *         "restart-scheduled" ({ agentId, attempt, delayMs }),
 *         "gave-up" ({ agentId, crashes, windowMs }),
 *         "restart-failed" ({ agentId, error }),
 *         "protocol-error" ({ agentId, error }).
 */
export class Supervisor extends EventEmitter {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly entry: string;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly inheritStdio: boolean;
  private readonly fsHandler: SupervisorOptions["fsHandler"];
  private readonly supervision = new Map<string, Supervision>();
  private readonly modules = new Map<string, string>();
  private readonly defaultModule: string | undefined;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly registry: AgentRegistry,
    opts: SupervisorOptions = {},
  ) {
    super();
    this.entry = opts.runtimeEntry ?? DEFAULT_ENTRY;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 2_000;
    this.inheritStdio = opts.inheritStdio ?? false;
    this.fsHandler = opts.fsHandler;
    this.defaultModule = opts.defaultModule;
  }

  /**
   * Platform startup: runtimes from a previous platform process exited when their IPC
   * channel closed, but nobody recorded it. Close out their records. Runtimes started
   * by this supervisor are left alone. Returns how many records were closed.
   */
  recover(): number {
    const live = new Set([...this.runtimes.values()].filter((r) => this.isLive(r.agentId)).map((r) => `${r.agentId}#${r.incarnation}`));
    const open = this.db.prepare(`SELECT agent_id, incarnation FROM runtimes WHERE exited_at IS NULL`).all() as {
      agent_id: string;
      incarnation: number;
    }[];
    const close = this.db.prepare(
      `UPDATE runtimes SET exited_at = ?, exit_signal = 'PLATFORM_RESTART' WHERE agent_id = ? AND incarnation = ?`,
    );
    let closed = 0;
    this.db.transaction(() => {
      for (const r of open) {
        if (live.has(`${r.agent_id}#${r.incarnation}`)) continue;
        close.run(new Date().toISOString(), r.agent_id, r.incarnation);
        closed++;
      }
    })();
    return closed;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Which agent module this agent's runtimes load (a file: URL). Behaviour lives in code
   * and is supplied on every boot; the database only knows the agent's identity (D3).
   */
  setModule(agentId: string, moduleUrl: string): void {
    this.modules.set(agentId, moduleUrl);
  }

  /** Set (or replace) the restart policy for an agent. In memory: code supplies it every boot. */
  setPolicy(agentId: string, policy: RestartPolicy): void {
    const existing = this.supervision.get(agentId);
    if (existing?.timer) clearTimeout(existing.timer);
    this.supervision.set(agentId, {
      policy: { maxRestarts: 5, windowMs: 60_000, backoffMs: 100, maxBackoffMs: 10_000, ...policy },
      crashes: existing?.crashes ?? [],
    });
  }

  /** Starting by hand cancels a pending automatic restart and clears a "given-up" state. */
  async start(agentId: string): Promise<RuntimeInfo> {
    const sup = this.supervision.get(agentId);
    if (sup?.timer) {
      clearTimeout(sup.timer);
      sup.timer = undefined;
    }
    return this.spawn(agentId);
  }

  private async spawn(agentId: string): Promise<RuntimeInfo> {
    if (this.closed) throw new Error("supervisor is closed");
    const agent = this.registry.get(agentId);
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    if (agent.lifecycleState !== "active") throw new Error(`agent ${agentId} is ${agent.lifecycleState}`);
    if (this.isLive(agentId)) throw new Error(`agent ${agentId} already has a live runtime`);
    const module = this.modules.get(agentId) ?? this.defaultModule;
    if (!module) throw new Error(`agent ${agent.name} (${agentId}) has no agent definition registered in this process`);

    const incarnation = this.nextIncarnation(agentId);
    const child = fork(this.entry, [], {
      execArgv: ["--import", "tsx"],
      stdio: this.inheritStdio ? ["ignore", "inherit", "inherit", "ipc"] : ["ignore", "ignore", "inherit", "ipc"],
    });
    if (child.pid === undefined) throw new Error("fork failed: no pid");

    this.db
      .prepare(`INSERT INTO runtimes (agent_id, incarnation, pid, started_at) VALUES (?, ?, ?, ?)`)
      .run(agentId, incarnation, child.pid, new Date().toISOString());

    let markExited!: () => void;
    const runtime: Runtime = {
      agentId,
      incarnation,
      pid: child.pid,
      state: "starting",
      child,
      pending: new Map(),
      exited: new Promise((r) => (markExited = r)),
    };
    this.runtimes.set(agentId, runtime);

    child.on("message", (raw) => this.onMessage(runtime, raw));
    // e.g. EPIPE when sending to a process that is already dying. Unhandled, it would
    // crash the platform; the "exit" handler below deals with the process itself.
    child.on("error", (error) => this.emit("protocol-error", { agentId, error }));
    child.on("exit", (code, signal) => {
      // A clean exit we asked for is "exited"; anything else is a crash.
      const deliberate = runtime.state === "stopping";
      runtime.state = deliberate && code === 0 ? "exited" : "crashed";
      this.db
        .prepare(
          `UPDATE runtimes SET exited_at = ?, exit_code = ?, exit_signal = ? WHERE agent_id = ? AND incarnation = ?`,
        )
        .run(new Date().toISOString(), code, signal, agentId, incarnation);
      for (const [, p] of runtime.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`runtime ${agentId}#${incarnation} exited before responding`));
      }
      runtime.pending.clear();
      markExited();
      this.emit("runtime-exit", this.info(runtime));
      // Even a stop that ended in SIGKILL was asked for: never restart it.
      if (!deliberate) this.onCrash(runtime);
    });

    // Handshake: hand the anonymous process its identity, wait for it to confirm.
    const ready = await this.request(runtime, "__init__", {
      type: "INIT",
      agentId,
      name: agent.name,
      incarnation,
      configuration: agent.configuration,
      module,
    });
    if (ready.type === "ERROR") {
      child.kill("SIGKILL");
      throw new Error(`agent ${agent.name} failed to start: ${ready.message}`);
    }
    if (ready.type !== "READY" || ready.agentId !== agentId) {
      child.kill("SIGKILL");
      throw new Error(`runtime handshake failed: ${JSON.stringify(ready)}`);
    }
    runtime.state = "running";
    const info = this.info(runtime);
    this.emit("runtime-ready", info);
    return info;
  }

  /**
   * Graceful stop: SHUTDOWN over IPC, then SIGKILL if it doesn't exit in time.
   * Also cancels a pending automatic restart.
   */
  async stop(agentId: string): Promise<void> {
    const sup = this.supervision.get(agentId);
    if (sup?.timer) {
      clearTimeout(sup.timer);
      sup.timer = undefined;
    }
    const runtime = this.runtimes.get(agentId);
    if (!runtime || !this.isLive(agentId)) return;
    runtime.state = "stopping";
    this.send(runtime, { type: "SHUTDOWN" });
    const timer = setTimeout(() => runtime.child.kill("SIGKILL"), this.stopTimeoutMs);
    await runtime.exited;
    clearTimeout(timer);
  }

  async restart(agentId: string): Promise<RuntimeInfo> {
    await this.stop(agentId);
    return this.start(agentId);
  }

  async stopAll(): Promise<void> {
    for (const sup of this.supervision.values()) {
      clearTimeout(sup.timer);
      sup.timer = undefined;
    }
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
  }

  /** Stop everything and refuse further starts, including automatic restarts. */
  async close(): Promise<void> {
    this.closed = true;
    await this.stopAll();
  }

  // ── Supervision ──────────────────────────────────────────────────────────

  private onCrash(runtime: Runtime): void {
    const sup = this.supervision.get(runtime.agentId);
    if (!sup || sup.policy.restart !== "on-crash" || this.closed) return;
    const { maxRestarts, windowMs, backoffMs, maxBackoffMs } = sup.policy;

    const now = Date.now();
    sup.crashes = [...sup.crashes.filter((t) => now - t < windowMs), now];
    if (sup.crashes.length > maxRestarts) {
      runtime.state = "given-up";
      this.emit("gave-up", { agentId: runtime.agentId, crashes: sup.crashes.length, windowMs });
      return;
    }

    const attempt = sup.crashes.length;
    const delayMs = Math.min(backoffMs * 2 ** (attempt - 1), maxBackoffMs);
    this.emit("restart-scheduled", { agentId: runtime.agentId, attempt, delayMs });
    sup.timer = setTimeout(() => {
      sup.timer = undefined;
      this.spawn(runtime.agentId).catch((error: Error) => {
        // If the new process died, its exit already went through onCrash (and maybe
        // scheduled the next attempt). Otherwise it never got that far (e.g. the agent
        // was deleted): retrying won't help.
        this.emit("restart-failed", { agentId: runtime.agentId, error });
        const latest = this.runtimes.get(runtime.agentId);
        if (!sup.timer && latest && !this.isLive(runtime.agentId) && latest.state !== "given-up") {
          latest.state = "given-up";
          this.emit("gave-up", { agentId: runtime.agentId, crashes: sup.crashes.length, windowMs });
        }
      });
    }, delayMs);
  }

  // ── Observation ──────────────────────────────────────────────────────────

  status(agentId: string): RuntimeInfo | undefined {
    const r = this.runtimes.get(agentId);
    return r && this.info(r);
  }

  /** All incarnations this agent has ever had, oldest first (persisted). */
  history(agentId: string): RuntimeRecord[] {
    return this.db
      .prepare(
        `SELECT agent_id AS agentId, incarnation, pid, started_at AS startedAt, exited_at AS exitedAt,
                exit_code AS exitCode, exit_signal AS exitSignal
         FROM runtimes WHERE agent_id = ? ORDER BY incarnation`,
      )
      .all(agentId) as RuntimeRecord[];
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  async ping(agentId: string): Promise<Extract<AgentResponse, { type: "PONG" }>> {
    const requestId = randomUUID();
    const res = await this.request(this.running(agentId), requestId, { type: "PING", requestId });
    if (res.type !== "PONG") throw new Error(`expected PONG, got ${res.type}`);
    return res;
  }

  /**
   * Direct RPC: run one task on the live runtime, no inbox. Internal (the dispatcher's
   * transport); the public sending path is the durable inbox (D6).
   */
  async sendTask(
    agentId: string,
    task: string,
    input: unknown,
    opts: { taskId?: string; attempt?: number } = {},
  ): Promise<unknown> {
    const taskId = opts.taskId ?? randomUUID();
    const res = await this.request(this.running(agentId), taskId, { type: "TASK", taskId, task, input, attempt: opts.attempt ?? 1 });
    if (res.type === "ERROR") throw new TaskError(`task ${taskId} failed: ${res.message}`, res.retryable ?? true);
    if (res.type !== "TASK_COMPLETED") throw new Error(`expected TASK_COMPLETED, got ${res.type}`);
    return res.result;
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private request(runtime: Runtime, correlationId: string, msg: AgentMessage): Promise<AgentResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.pending.delete(correlationId);
        reject(new Error(`timed out waiting for ${msg.type} response from ${runtime.agentId}`));
      }, this.requestTimeoutMs);
      runtime.pending.set(correlationId, { resolve, reject, timer });
      this.send(runtime, msg);
    });
  }

  private send(runtime: Runtime, msg: AgentMessage): void {
    if (!runtime.child.connected) throw new Error(`runtime ${runtime.agentId}#${runtime.incarnation} not connected`);
    runtime.child.send(msg);
  }

  private onMessage(runtime: Runtime, raw: unknown): void {
    const parsed = AgentResponseSchema.safeParse(raw);
    if (!parsed.success) {
      this.emit("protocol-error", { agentId: runtime.agentId, error: parsed.error });
      return;
    }
    const msg = parsed.data;
    if (msg.type === "FS_REQUEST") {
      this.serveFs(runtime, msg.requestId, msg.request);
      return;
    }
    const id =
      msg.type === "READY" ? "__init__"
      : msg.type === "TASK_COMPLETED" ? msg.taskId
      : msg.type === "PONG" ? msg.requestId
      : msg.correlationId;
    const pending = id !== undefined ? runtime.pending.get(id) : undefined;
    if (!pending) {
      this.emit("protocol-error", { agentId: runtime.agentId, error: new Error(`uncorrelated ${msg.type}`) });
      return;
    }
    clearTimeout(pending.timer);
    runtime.pending.delete(id!);
    pending.resolve(msg);
  }

  private serveFs(runtime: Runtime, requestId: string, request: FsRequest): void {
    let reply: AgentMessage;
    try {
      if (!this.fsHandler) throw new Error("filesystem service not available");
      if (runtime.state !== "running") throw new Error("runtime is not running");
      reply = { type: "FS_RESPONSE", requestId, ok: true, result: this.fsHandler(runtime.agentId, request) };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      reply = { type: "FS_RESPONSE", requestId, ok: false, error: (err as Error).message, ...(typeof code === "string" && { code }) };
    }
    if (runtime.child.connected) this.send(runtime, reply);
  }

  private running(agentId: string): Runtime {
    const r = this.runtimes.get(agentId);
    if (!r || r.state !== "running") throw new Error(`agent ${agentId} has no running runtime`);
    return r;
  }

  private isLive(agentId: string): boolean {
    const s = this.runtimes.get(agentId)?.state;
    return s === "starting" || s === "running" || s === "stopping";
  }

  private nextIncarnation(agentId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(incarnation), 0) AS n FROM runtimes WHERE agent_id = ?`)
      .get(agentId) as { n: number };
    return row.n + 1;
  }

  private info(r: Runtime): RuntimeInfo {
    return { agentId: r.agentId, incarnation: r.incarnation, pid: r.pid, state: r.state };
  }
}
