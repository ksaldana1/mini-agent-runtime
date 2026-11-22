import { EventEmitter } from "node:events";
import type { Inbox, InboxItem } from "./inbox.js";
import type { Supervisor } from "./supervisor.js";

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
  /** Claims left over from a previous platform process, returned to pending at startup. */
  readonly recoveredOnStartup: number;

  constructor(
    private readonly supervisor: Supervisor,
    private readonly inbox: Inbox,
  ) {
    super();
    // Constructed at platform startup, before any runtime exists: every claim is stale.
    this.recoveredOnStartup = inbox.releaseAllClaims();

    supervisor.on("runtime-ready", ({ agentId }) => this.pump(agentId));
    supervisor.on("runtime-exit", ({ agentId, incarnation }) => {
      this.inFlight.delete(agentId);
      const count = inbox.releaseClaims(agentId, incarnation);
      if (count > 0) this.emit("released", { agentId, incarnation, count });
    });
    inbox.on("enqueued", (item: InboxItem) => this.pump(item.recipientAgentId));
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

    this.supervisor
      .sendTask(agentId, item.payload, item.id)
      .then(
        (result) => {
          if (this.inbox.complete(item.id, slot.incarnation, result)) this.emit("completed", { item, result });
        },
        (err: Error) => {
          const now = this.supervisor.status(agentId);
          if (now?.state === "running" && now.incarnation === slot.incarnation) {
            // Runtime is alive and answered with an error (or timed out): count it as a failed attempt.
            this.inbox.fail(item.id, slot.incarnation, err.message);
            const willRetry = this.inbox.get(item.id)?.status === "pending";
            this.emit("failed", { item, error: err.message, willRetry });
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
