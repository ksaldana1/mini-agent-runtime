import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Db } from "./database.js";
import type { AgentRegistry } from "./identity.js";

export type InboxStatus = "pending" | "claimed" | "completed" | "failed";

export interface InboxItem {
  id: string;
  recipientAgentId: string;
  senderAgentId: string | null;
  payload: unknown;
  idempotencyKey: string | null;
  status: InboxStatus;
  /** Number of times this item has been claimed (i.e. delivered). */
  attempts: number;
  createdAt: string;
  claimedAt: string | null;
  claimedByIncarnation: number | null;
  acknowledgedAt: string | null;
  result: unknown;
  lastError: string | null;
}

interface Row {
  id: string;
  recipient_agent_id: string;
  sender_agent_id: string | null;
  payload: string;
  idempotency_key: string | null;
  status: InboxStatus;
  attempts: number;
  created_at: string;
  claimed_at: string | null;
  claimed_by_incarnation: number | null;
  acknowledged_at: string | null;
  result: string | null;
  last_error: string | null;
}

const fromRow = (r: Row): InboxItem => ({
  id: r.id,
  recipientAgentId: r.recipient_agent_id,
  senderAgentId: r.sender_agent_id,
  payload: JSON.parse(r.payload),
  idempotencyKey: r.idempotency_key,
  status: r.status,
  attempts: r.attempts,
  createdAt: r.created_at,
  claimedAt: r.claimed_at,
  claimedByIncarnation: r.claimed_by_incarnation,
  acknowledgedAt: r.acknowledged_at,
  result: r.result === null ? null : JSON.parse(r.result),
  lastError: r.last_error,
});

export interface SendOptions {
  senderAgentId?: string;
  /** Same key + same recipient → the existing item is returned, nothing new is enqueued. */
  idempotencyKey?: string;
}

/**
 * Durable, platform-owned inbox storage. Pure state machine over SQLite:
 *
 *   pending ──claim──▶ claimed ──complete──▶ completed
 *      ▲                  │
 *      └──release/fail────┤   (attempts < maxAttempts)
 *                         └──────────────▶ failed  (attempts exhausted)
 *
 * Every claim records the runtime incarnation that holds it. complete/fail/release
 * only apply if that incarnation still holds the claim, so a late answer from a
 * dead process can't clobber a redelivery (a simple fencing token).
 *
 * Emits "enqueued" (InboxItem) after a new item is stored (asynchronously, next microtask).
 */
export class Inbox extends EventEmitter {
  private readonly maxAttempts: number;

  constructor(
    private readonly db: Db,
    private readonly registry: AgentRegistry,
    opts: { maxAttempts?: number } = {},
  ) {
    super();
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  send(recipientAgentId: string, payload: unknown, opts: SendOptions = {}): InboxItem {
    const recipient = this.registry.get(recipientAgentId);
    if (!recipient || recipient.lifecycleState !== "active") {
      throw new Error(`cannot send to ${recipientAgentId}: no active agent`);
    }
    if (opts.senderAgentId && !this.registry.get(opts.senderAgentId)) {
      throw new Error(`unknown sender ${opts.senderAgentId}`);
    }

    const id = randomUUID();
    const inserted = this.db
      .prepare(
        `INSERT INTO inbox (id, recipient_agent_id, sender_agent_id, payload, idempotency_key, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT (recipient_agent_id, idempotency_key) DO NOTHING`,
      )
      .run(
        id,
        recipientAgentId,
        opts.senderAgentId ?? null,
        JSON.stringify(payload ?? null),
        opts.idempotencyKey ?? null,
        new Date().toISOString(),
      );

    if (inserted.changes === 0) {
      // Duplicate send: hand back the original item.
      return fromRow(
        this.db
          .prepare(`SELECT * FROM inbox WHERE recipient_agent_id = ? AND idempotency_key = ?`)
          .get(recipientAgentId, opts.idempotencyKey) as Row,
      );
    }
    const item = this.get(id)!;
    // Deferred so a caller's enclosing transaction commits before anyone reacts
    // (e.g. the dispatcher pushing the item to a runtime over IPC).
    queueMicrotask(() => this.emit("enqueued", item));
    return item;
  }

  get(id: string): InboxItem | undefined {
    const row = this.db.prepare(`SELECT * FROM inbox WHERE id = ?`).get(id) as Row | undefined;
    return row && fromRow(row);
  }

  list(recipientAgentId: string, status?: InboxStatus): InboxItem[] {
    const rows = status
      ? this.db.prepare(`SELECT * FROM inbox WHERE recipient_agent_id = ? AND status = ? ORDER BY rowid`).all(recipientAgentId, status)
      : this.db.prepare(`SELECT * FROM inbox WHERE recipient_agent_id = ? ORDER BY rowid`).all(recipientAgentId);
    return (rows as Row[]).map(fromRow);
  }

  /** Atomically claim the oldest pending item for this agent on behalf of one incarnation. */
  claimNext(recipientAgentId: string, incarnation: number): InboxItem | undefined {
    const row = this.db
      .prepare(
        `UPDATE inbox
            SET status = 'claimed', attempts = attempts + 1,
                claimed_at = ?, claimed_by_incarnation = ?
          WHERE id = (SELECT id FROM inbox
                       WHERE recipient_agent_id = ? AND status = 'pending'
                       ORDER BY rowid LIMIT 1)
          RETURNING *`,
      )
      .get(new Date().toISOString(), incarnation, recipientAgentId) as Row | undefined;
    return row && fromRow(row);
  }

  /** Acknowledge successful processing. Returns false if this incarnation no longer holds the claim. */
  complete(id: string, incarnation: number, result: unknown): boolean {
    return (
      this.db
        .prepare(
          `UPDATE inbox SET status = 'completed', acknowledged_at = ?, result = ?
            WHERE id = ? AND status = 'claimed' AND claimed_by_incarnation = ?`,
        )
        .run(new Date().toISOString(), JSON.stringify(result ?? null), id, incarnation).changes > 0
    );
  }

  /** The agent reported an error: retry if attempts remain, else mark failed. */
  fail(id: string, incarnation: number, error: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE inbox
              SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
                  last_error = ?, claimed_at = NULL, claimed_by_incarnation = NULL
            WHERE id = ? AND status = 'claimed' AND claimed_by_incarnation = ?`,
        )
        .run(this.maxAttempts, error, id, incarnation).changes > 0
    );
  }

  /**
   * Return everything a (dead) incarnation was holding to the queue. An item that
   * has already used up its attempts is marked failed instead — otherwise a message
   * that reliably crashes its agent would be redelivered forever.
   */
  releaseClaims(recipientAgentId: string, incarnation: number): number {
    return this.db
      .prepare(
        `UPDATE inbox
            SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
                last_error = 'runtime exited while processing',
                claimed_at = NULL, claimed_by_incarnation = NULL
          WHERE recipient_agent_id = ? AND status = 'claimed' AND claimed_by_incarnation = ?`,
      )
      .run(this.maxAttempts, recipientAgentId, incarnation).changes;
  }

  /** Platform startup: no runtime from a previous platform process is alive, so every claim is stale. */
  releaseAllClaims(): number {
    return this.db
      .prepare(
        `UPDATE inbox
            SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
                last_error = 'platform restarted while processing',
                claimed_at = NULL, claimed_by_incarnation = NULL
          WHERE status = 'claimed'`,
      )
      .run(this.maxAttempts).changes;
  }
}
