import { EventEmitter } from "node:events";
import type { Inbox, InboxItem } from "./inbox.js";
import { TaskError, type Supervisor } from "./supervisor.js";
import { TaskPayloadSchema } from "../shared/protocol.js";

interface InFlight {
  itemId: string;
  incarnation: number;
}

/**
 * Push delivery: moves items from the durable inbox to running runtimes.
 *
 * This is the "message transport" side of the inbox-vs-transport split. The inbox
 * decides *what* is owed to whom; the dispatcher decides *when* to hand it over.
 *
 * Policy: one item in flight per agent (credit = 1), FIFO. Delivery is triggered by
 *   - a runtime becoming ready   (drains anything sent while the agent was offline)
 *   - a new item being enqueued  (if the recipient is running and idle)
 *   - the previous item finishing
 *
 * Delivery is at-least-once: if a runtime dies mid-task, its claim is released and
 * the item is redelivered (same taskId = inbox item id) to the next incarnation.
 *
 * Events: "delivered", "completed", "failed", "released" — for observability.
 */
export class Dispatcher extends EventEmitter {
  private readonly inFlight = new Map<string, InFlight>();

  constructor(
    private readonly supervisor: Supervisor,
    private readonly inbox: Inbox,
  ) {
    super();

    supervisor.on("runtime-ready", ({ agentId }) => this.pump(agentId));
    supervisor.on("runtime-exit", ({ agentId, incarnation }) => {
      this.inFlight.delete(agentId);
      const count = inbox.releaseClaims(agentId, incarnation);
      if (count > 0) this.emit("released", { agentId, incarnation, count });
    });
    inbox.on("enqueued", (item: InboxItem) => this.pump(item.recipientAgentId));
  }

  /**
   * Platform startup: no runtime from a previous platform process survives, so every
   * claim in the inbox is stale. Returns them to pending (or failed, if out of attempts).
   * Must run before this dispatcher delivers anything. Returns how many were released.
   */
  recover(): number {
    if (this.inFlight.size > 0) throw new Error("dispatcher.recover() must run before any delivery");
    return this.inbox.releaseAllClaims();
  }

  /** True when the agent has nothing pending or in flight. */
  isDrained(agentId: string): boolean {
    return !this.inFlight.has(agentId) && this.inbox.list(agentId, "pending").length === 0;
  }

  private pump(agentId: string): void {
    if (this.inFlight.has(agentId)) return;
    const runtime = this.supervisor.status(agentId);
    if (runtime?.state !== "running") return; // offline: items wait in the inbox

    const item = this.inbox.claimNext(agentId, runtime.incarnation);
    if (!item) return;

    const slot: InFlight = { itemId: item.id, incarnation: runtime.incarnation };
    this.inFlight.set(agentId, slot);
    this.emit("delivered", { item, incarnation: runtime.incarnation });

    // Inbox payloads are { task, input }. Anything else can never succeed: fail it for good.
    const payload = TaskPayloadSchema.safeParse(item.payload);
    const sent = payload.success
      ? this.supervisor.sendTask(agentId, payload.data.task, payload.data.input, { taskId: item.id, attempt: item.attempts })
      : Promise.reject(new TaskError(`invalid inbox payload (expected { task, input }): ${JSON.stringify(item.payload)}`, false));

    sent
      .then(
        (result) => {
          if (this.inbox.complete(item.id, slot.incarnation, result)) this.emit("completed", { item, result });
        },
        (err: Error) => {
          const now = this.supervisor.status(agentId);
          if (now?.state === "running" && now.incarnation === slot.incarnation) {
            // Runtime is alive and answered with an error (or timed out): count it as a failed attempt.
            // Timeouts and other non-TaskErrors are assumed transient.
            const retryable = !(err instanceof TaskError) || err.retryable;
            this.inbox.fail(item.id, slot.incarnation, err.message, { retryable });
            const willRetry = this.inbox.get(item.id)?.status === "pending";
            this.emit("failed", { item, error: err.message, retryable, willRetry });
          }
          // Otherwise the runtime died; the runtime-exit handler already released the claim.
        },
      )
      .finally(() => {
        // Compare by identity: after a crash the same item may already be in flight again.
        if (this.inFlight.get(agentId) === slot) {
          this.inFlight.delete(agentId);
          this.pump(agentId);
        }
      });
  }
}
