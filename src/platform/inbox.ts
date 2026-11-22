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
 * Events (both emitted on a later microtask, so listeners only ever see committed rows):
 *   "enqueued" (InboxItem) — a new item was stored.
 *   "settled"  (InboxItem) — an item reached a final status (completed or failed), via
 *              complete, fail, releaseClaims, or releaseAllClaims.
 */
export class Inbox extends EventEmitter {
  private readonly maxAttempts: number;
  private readonly waiters = new Map<string, Set<(item: InboxItem) => void>>();

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
    const row = this.db
      .prepare(
        `UPDATE inbox SET status = 'completed', acknowledged_at = ?, result = ?
          WHERE id = ? AND status = 'claimed' AND claimed_by_incarnation = ?
          RETURNING *`,
      )
      .get(new Date().toISOString(), JSON.stringify(result ?? null), id, incarnation) as Row | undefined;
    this.settle(row ? [row] : []);
    return row !== undefined;
  }

  /**
   * The agent reported an error. A retryable error goes back to pending while attempts
   * remain; a non-retryable one (or the last attempt) marks the item failed.
   * Returns false if this incarnation no longer holds the claim.
   */
  fail(id: string, incarnation: number, error: string, opts: { retryable?: boolean } = {}): boolean {
    const retryable = opts.retryable ?? true;
    const row = this.db
      .prepare(
        `UPDATE inbox
            SET status = CASE WHEN ? = 0 OR attempts >= ? THEN 'failed' ELSE 'pending' END,
                last_error = ?, claimed_at = NULL, claimed_by_incarnation = NULL
          WHERE id = ? AND status = 'claimed' AND claimed_by_incarnation = ?
          RETURNING *`,
      )
      .get(retryable ? 1 : 0, this.maxAttempts, error, id, incarnation) as Row | undefined;
    this.settle(row ? [row] : []);
    return row !== undefined;
  }

  /**
   * Return everything a (dead) incarnation was holding to the queue. An item that
   * has already used up its attempts is marked failed instead — otherwise a message
   * that reliably crashes its agent would be redelivered forever.
   */
  releaseClaims(recipientAgentId: string, incarnation: number): number {
    const rows = this.db
      .prepare(
        `UPDATE inbox
            SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
                last_error = 'runtime exited while processing',
                claimed_at = NULL, claimed_by_incarnation = NULL
          WHERE recipient_agent_id = ? AND status = 'claimed' AND claimed_by_incarnation = ?
          RETURNING *`,
      )
      .all(this.maxAttempts, recipientAgentId, incarnation) as Row[];
    this.settle(rows);
    return rows.length;
  }

  /** Platform startup: no runtime from a previous platform process is alive, so every claim is stale. */
  releaseAllClaims(): number {
    const rows = this.db
      .prepare(
        `UPDATE inbox
            SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
                last_error = 'platform restarted while processing',
                claimed_at = NULL, claimed_by_incarnation = NULL
          WHERE status = 'claimed'
          RETURNING *`,
      )
      .all(this.maxAttempts) as Row[];
    this.settle(rows);
    return rows.length;
  }

  /**
   * Resolves once the item is completed or failed. Resolves immediately if it already
   * is. Rejects if no such item exists.
   */
  waitFor(id: string): Promise<InboxItem> {
    const item = this.get(id);
    if (!item) return Promise.reject(new Error(`unknown inbox item ${id}`));
    if (isSettled(item)) return Promise.resolve(item);
    // No await between the read above and registering here, and "settled" is emitted on a
    // later microtask, so a settlement can't slip in between.
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));
      set.add(resolve);
    });
  }

  /** Emit "settled" for rows that reached a final status, once the caller's transaction has committed. */
  private settle(rows: Row[]): void {
    const settled = rows.map(fromRow).filter(isSettled);
    if (settled.length === 0) return;
    queueMicrotask(() => {
      for (const item of settled) {
        this.emit("settled", item);
        const waiters = this.waiters.get(item.id);
        this.waiters.delete(item.id);
        for (const resolve of waiters ?? []) resolve(item);
      }
    });
  }
}

const isSettled = (item: InboxItem): boolean => item.status === "completed" || item.status === "failed";
