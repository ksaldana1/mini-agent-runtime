import { EventEmitter } from "node:events";
import type { RuntimeState } from "../platform/supervisor.js";

export type TaskStatus = "pending" | "claimed" | "completed" | "failed";

/**
 * Everything observable about a platform, with agents identified by name as well as id.
 * Payloads are plain data: safe to log or serialize.
 */
export interface PlatformEvents {
  "agent.ready": { agent: string; agentId: string; incarnation: number; pid: number };
  "agent.exited": { agent: string; agentId: string; incarnation: number; pid: number; state: RuntimeState };
  "agent.restarting": { agent: string; agentId: string; attempt: number; delayMs: number };
  "agent.gave-up": { agent: string; agentId: string; crashes: number; windowMs: number };
  /** An agent registered after platform.start() couldn't be started. */
  "agent.start-failed": { agent: string; agentId: string; error: string };
  "task.enqueued": { taskId: string; agent: string; agentId: string; task: string | null; input: unknown };
  "task.delivered": { taskId: string; agent: string; agentId: string; task: string | null; attempt: number; incarnation: number };
  /** One attempt failed. `willRetry` says whether it goes back to the queue. */
  "task.attempt-failed": { taskId: string; agent: string; agentId: string; task: string | null; error: string; retryable: boolean; willRetry: boolean };
  "task.settled": {
    taskId: string;
    agent: string;
    agentId: string;
    task: string | null;
    status: "completed" | "failed";
    attempts: number;
    result: unknown;
    error: string | null;
  };
  "listener.fired": { listenerId: string; agent: string; agentId: string; event: string; path: string; taskId: string };
  "workflow.transition": { workflowId: string; workflow: string; event: string; detail: string };
  "fs.denied": { agent: string; agentId: string; op: string; path: string; reason: string };
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
