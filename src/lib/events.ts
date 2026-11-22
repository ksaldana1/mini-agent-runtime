import { EventEmitter } from "node:events";
import type { RuntimeState } from "../platform/supervisor.js";

export type TaskStatus = "pending" | "claimed" | "completed" | "failed";

/** How the public API names an agent: its stable id and its registered name. */
export interface AgentRef {
  readonly id: string;
  readonly name: string;
}

/**
 * Everything observable about a platform, with agents identified by name as well as id.
 * Payloads are plain data: safe to log or serialize.
 */
export interface PlatformEvents {
  "agent.ready": { agent: AgentRef; incarnation: number; pid: number };
  "agent.exited": { agent: AgentRef; incarnation: number; pid: number; state: RuntimeState };
  "agent.restarting": { agent: AgentRef; attempt: number; delayMs: number };
  "agent.gave-up": { agent: AgentRef; crashes: number; windowMs: number };
  /** An agent registered after platform.start() couldn't be started. */
  "agent.start-failed": { agent: AgentRef; error: string };
  "task.enqueued": { taskId: string; agent: AgentRef; task: string; input: unknown };
  "task.delivered": { taskId: string; agent: AgentRef; task: string; attempt: number; incarnation: number };
  /** One attempt failed. `willRetry` says whether it goes back to the queue. */
  "task.attempt-failed": { taskId: string; agent: AgentRef; task: string; error: string; retryable: boolean; willRetry: boolean };
  "task.settled": {
    taskId: string;
    agent: AgentRef;
    task: string;
    status: "completed" | "failed";
    attempts: number;
    result: unknown;
    error: string | null;
  };
  /** A listener fired: it either enqueued a task for an agent or started a workflow run. */
  "listener.fired": { listener: string; listenerId: string; event: string; path: string } & (
    | { target: "task"; agent: AgentRef; taskId: string }
    | { target: "workflow"; workflow: string; workflowId: string }
  );
  /** A listener's target threw for one file (e.g. it computed invalid input). The file is not retried. */
  "listener.error": { listener: string; path: string; error: string };
  /** A listener was skipped this scan (no target registered, agent lost access, ...). */
  "listener.skipped": { listener: string; reason: string };
  "workflow.transition": { workflowId: string; workflow: string; event: string; detail: string };
  "workflow.settled": { workflowId: string; workflow: string; status: "completed" | "failed"; output: unknown; error: string | null };
  /** A running workflow can't progress in this process: its definition isn't registered. */
  "workflow.skipped": { workflowId: string; workflow: string; reason: string };
  "fs.denied": { agent: AgentRef; op: string; path: string; reason: string };
}

export type PlatformEventName = keyof PlatformEvents;

/** A typed event emitter. `on` / `once` / `onAny` return an unsubscribe function. */
export class PlatformEventEmitter {
  private readonly emitter = new EventEmitter();

  on<K extends PlatformEventName>(event: K, listener: (e: PlatformEvents[K]) => void): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  once<K extends PlatformEventName>(event: K, listener: (e: PlatformEvents[K]) => void): () => void {
    this.emitter.once(event, listener);
    return () => this.emitter.off(event, listener);
  }

  /** Every event, with its name. Handy for timelines and logs. */
  onAny(listener: <K extends PlatformEventName>(event: K, e: PlatformEvents[K]) => void): () => void {
    this.emitter.on("*", listener);
    return () => this.emitter.off("*", listener);
  }

  /** @internal */
  emit<K extends PlatformEventName>(event: K, e: PlatformEvents[K]): void {
    this.emitter.emit(event, e);
    this.emitter.emit("*", event, e);
  }
}
