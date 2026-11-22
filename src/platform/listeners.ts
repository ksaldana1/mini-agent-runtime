import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { posix } from "node:path";
import type { Db } from "./database.js";
import type { AgentFilesystem } from "./filesystem.js";
import type { AgentRegistry } from "./identity.js";
import type { Inbox, InboxItem } from "./inbox.js";
import { renderTemplate } from "../shared/template.js";

export type ListenerEvent = "created" | "modified";
export type ListenerState = "active" | "paused";

export interface Listener {
  id: string;
  targetAgentId: string;
  /** Logical directory to watch (recursive). */
  path: string;
  events: ListenerEvent[];
  /**
   * Inbox payload to enqueue. String values may use {{path}}, {{name}}, {{event}},
   * {{listenerId}}. Default: { event, path, listenerId }.
   */
  payloadTemplate: unknown;
  state: ListenerState;
  createdAt: string;
  lastScanAt: string | null;
  lastError: string | null;
}

interface Row {
  id: string;
  target_agent_id: string;
  path: string;
  events: string;
  payload_template: string | null;
  state: ListenerState;
  created_at: string;
  last_scan_at: string | null;
  last_error: string | null;
}

const fromRow = (r: Row): Listener => ({
  id: r.id,
  targetAgentId: r.target_agent_id,
  path: r.path,
  events: JSON.parse(r.events),
  payloadTemplate: r.payload_template === null ? null : JSON.parse(r.payload_template),
  state: r.state,
  createdAt: r.created_at,
  lastScanAt: r.last_scan_at,
  lastError: r.last_error,
});

export interface RegisterOptions {
  events?: ListenerEvent[];
  payloadTemplate?: unknown;
  /** Treat files already present as new (default false: only react to future changes). */
  includeExisting?: boolean;
}

export interface ListenerServiceOptions {
  intervalMs?: number;
  /**
   * Ignore files modified more recently than this. Gives external writers time to
   * finish so we don't enqueue a half-written file. The next scan picks them up.
   */
  settleMs?: number;
}

/**
 * Persistent, platform-managed subscriptions: "when a file appears under X, enqueue a
 * task for agent A". Implemented as a periodic scan against a persisted snapshot.
 *
 * Independent of runtimes by construction: a scan only touches the filesystem, the
 * snapshot table, and the inbox. Whether the target agent is running is irrelevant;
 * the dispatcher delivers later.
 *
 * Duplicate protection, two layers:
 *   1. Snapshot (listener_files): a file version already seen produces no event.
 *      Enqueue + snapshot update happen in one SQLite transaction.
 *   2. Inbox idempotency key = listener + event + path + mtime, so even a lost or
 *      reset snapshot can't create a second task for the same file version.
 *
 * Events: "fired" ({ listener, event, path, item }), "skipped" ({ listener, reason }).
 */
export class ListenerService extends EventEmitter {
  private timer: NodeJS.Timeout | undefined;
  private readonly intervalMs: number;
  private readonly settleMs: number;

  constructor(
    private readonly db: Db,
    private readonly registry: AgentRegistry,
    private readonly fs: AgentFilesystem,
    private readonly inbox: Inbox,
    opts: ListenerServiceOptions = {},
  ) {
    super();
    this.intervalMs = opts.intervalMs ?? 1_000;
    this.settleMs = opts.settleMs ?? 100;
  }

  // ── Registration ─────────────────────────────────────────────────────────

  register(targetAgentId: string, path: string, opts: RegisterOptions = {}): Listener {
    const agent = this.registry.get(targetAgentId);
    if (!agent || agent.lifecycleState !== "active") throw new Error(`no active agent ${targetAgentId}`);

    // A listener reveals file names and contents to its target, so the target must
    // already be allowed to read the watched directory.
    const access = this.fs.check(targetAgentId, path, "read");
    if (!access.allowed) throw new Error(`EACCES: agent cannot read ${access.path}: ${access.reason}`);

    const listener: Listener = {
      id: randomUUID(),
      targetAgentId,
      path: access.path,
      events: opts.events ?? ["created"],
      payloadTemplate: opts.payloadTemplate ?? null,
      state: "active",
      createdAt: new Date().toISOString(),
      lastScanAt: null,
      lastError: null,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO listeners (id, target_agent_id, path, events, payload_template, state, created_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`,
        )
        .run(
          listener.id,
          targetAgentId,
          listener.path,
          JSON.stringify(listener.events),
          opts.payloadTemplate === undefined ? null : JSON.stringify(opts.payloadTemplate),
          listener.createdAt,
        );
      // Baseline: remember what's already there so it doesn't count as "created".
      if (!opts.includeExisting) {
        const insert = this.db.prepare(`INSERT INTO listener_files (listener_id, path, mtime_ms, size) VALUES (?, ?, ?, ?)`);
        for (const f of this.fs.scan(listener.path)) insert.run(listener.id, f.path, f.mtimeMs, f.size);
      }
    })();
    return listener;
  }

  get(id: string): Listener | undefined {
    const row = this.db.prepare(`SELECT * FROM listeners WHERE id = ?`).get(id) as Row | undefined;
    return row && fromRow(row);
  }

  list(): Listener[] {
    return (this.db.prepare(`SELECT * FROM listeners ORDER BY created_at`).all() as Row[]).map(fromRow);
  }

  setState(id: string, state: ListenerState): void {
    this.db.prepare(`UPDATE listeners SET state = ? WHERE id = ?`).run(state, id);
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM listeners WHERE id = ?`).run(id);
  }

  // ── Scanning ─────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return;
    this.scanAll();
    this.timer = setInterval(() => this.scanAll(), this.intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over every active listener. Returns the inbox items created. */
  scanAll(): InboxItem[] {
    const created: InboxItem[] = [];
    for (const l of this.list()) if (l.state === "active") created.push(...this.scan(l));
    return created;
  }

  private scan(listener: Listener): InboxItem[] {
    const now = new Date().toISOString();
    const skip = (reason: string): InboxItem[] => {
      this.db.prepare(`UPDATE listeners SET last_scan_at = ?, last_error = ? WHERE id = ?`).run(now, reason, listener.id);
      this.emit("skipped", { listener, reason });
      return [];
    };

    // Re-check every scan: the agent may have been deleted or lost its grant since registration.
    const agent = this.registry.get(listener.targetAgentId);
    if (!agent || agent.lifecycleState !== "active") return skip("target agent is not active");
    const access = this.fs.check(listener.targetAgentId, listener.path, "read");
    if (!access.allowed) return skip(`target lost read access: ${access.reason}`);

    const files = this.fs.scan(listener.path);
    const cutoff = Date.now() - this.settleMs;
    const seen = new Map(
      (
        this.db.prepare(`SELECT path, mtime_ms, size FROM listener_files WHERE listener_id = ?`).all(listener.id) as {
          path: string;
          mtime_ms: number;
          size: number;
        }[]
      ).map((r) => [r.path, r]),
    );

    const created: InboxItem[] = [];
    this.db.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO listener_files (listener_id, path, mtime_ms, size) VALUES (?, ?, ?, ?)
         ON CONFLICT (listener_id, path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size`,
      );
      for (const f of files) {
        // Still settling; next scan. (File mtimes can be a hair ahead of Date.now(),
        // so settleMs = 0 must mean "no check", not "mtime <= now".)
        if (this.settleMs > 0 && f.mtimeMs > cutoff) continue;
        const prev = seen.get(f.path);
        seen.delete(f.path);
        const event: ListenerEvent | undefined = !prev
          ? "created"
          : prev.mtime_ms !== f.mtimeMs || prev.size !== f.size
            ? "modified"
            : undefined;
        if (!event) continue;

        upsert.run(listener.id, f.path, f.mtimeMs, f.size);
        if (!listener.events.includes(event)) continue;

        const item = this.inbox.send(listener.targetAgentId, this.render(listener, event, f.path), {
          idempotencyKey: `listener:${listener.id}:${event}:${f.path}:${f.mtimeMs}`,
        });
        created.push(item);
        this.emit("fired", { listener, event, path: f.path, item });
      }
      // Files that disappeared: forget them, so re-creating one counts as "created" again.
      // (Files still settling are left alone.)
      const del = this.db.prepare(`DELETE FROM listener_files WHERE listener_id = ? AND path = ?`);
      const present = new Set(files.map((f) => f.path));
      for (const path of seen.keys()) if (!present.has(path)) del.run(listener.id, path);

      this.db.prepare(`UPDATE listeners SET last_scan_at = ?, last_error = NULL WHERE id = ?`).run(now, listener.id);
    })();
    return created;
  }

  private render(listener: Listener, event: ListenerEvent, path: string): unknown {
    if (listener.payloadTemplate === null) return { event, path, listenerId: listener.id };
    return renderTemplate(listener.payloadTemplate, { path, name: posix.basename(path), event, listenerId: listener.id });
  }
}
