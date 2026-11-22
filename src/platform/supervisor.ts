import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { Db } from "./database.js";
import type { AgentRegistry } from "./identity.js";
import { AgentResponseSchema, type AgentMessage, type AgentResponse } from "../shared/protocol.js";

/** State of one runtime incarnation (a process), not of the logical agent. */
export type RuntimeState = "starting" | "running" | "stopping" | "exited" | "crashed";

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
  /** Script forked for each runtime. Defaults to src/runtime/agent.ts. */
  runtimeEntry?: string;
  requestTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Forward runtime stdout/stderr to ours (handy in the demo, noisy in tests). */
  inheritStdio?: boolean;
}

const DEFAULT_ENTRY = fileURLToPath(new URL("../runtime/agent.ts", import.meta.url));

/**
 * The authority on runtime lifecycle. Maps persistent agent IDs to the
 * (temporary) process currently embodying them. At most one live runtime per agent.
 *
 * Events: "runtime-ready" (RuntimeInfo), "runtime-exit" (RuntimeInfo),
 *         "protocol-error" ({ agentId, error }).
 */
export class Supervisor extends EventEmitter {
  private readonly runtimes = new Map<string, Runtime>();
  private readonly entry: string;
  private readonly requestTimeoutMs: number;
  private readonly stopTimeoutMs: number;
  private readonly inheritStdio: boolean;

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

    // Platform startup: runtimes from a previous platform process exited when their IPC
    // channel closed, but we never saw it. Close out their records.
    this.db
      .prepare(`UPDATE runtimes SET exited_at = ?, exit_signal = 'PLATFORM_RESTART' WHERE exited_at IS NULL`)
      .run(new Date().toISOString());
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start(agentId: string): Promise<RuntimeInfo> {
    const agent = this.registry.get(agentId);
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    if (agent.lifecycleState !== "active") throw new Error(`agent ${agentId} is ${agent.lifecycleState}`);
    if (this.isLive(agentId)) throw new Error(`agent ${agentId} already has a live runtime`);

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
    child.on("exit", (code, signal) => {
      // A clean exit we asked for is "exited"; anything else is a crash.
      runtime.state = runtime.state === "stopping" && code === 0 ? "exited" : "crashed";
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
    });

    // Handshake: hand the anonymous process its identity, wait for it to confirm.
    const ready = await this.request(runtime, "__init__", {
      type: "INIT",
      agentId,
      name: agent.name,
      incarnation,
      configuration: agent.configuration,
    });
    if (ready.type !== "READY" || ready.agentId !== agentId) {
      child.kill("SIGKILL");
      throw new Error(`runtime handshake failed: ${JSON.stringify(ready)}`);
    }
    runtime.state = "running";
    const info = this.info(runtime);
    this.emit("runtime-ready", info);
    return info;
  }

  /** Graceful stop: SHUTDOWN over IPC, then SIGKILL if it doesn't exit in time. */
  async stop(agentId: string): Promise<void> {
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
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)));
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

  async sendTask(agentId: string, payload: unknown, taskId: string = randomUUID()): Promise<unknown> {
    const res = await this.request(this.running(agentId), taskId, { type: "TASK", taskId, payload });
    if (res.type === "ERROR") throw new Error(`task ${taskId} failed: ${res.message}`);
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
