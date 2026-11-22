import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { posix } from "node:path";
import type { Db } from "./database.js";
import type { AgentFilesystem } from "./filesystem.js";
import type { AgentRegistry } from "./identity.js";
import type { Inbox, InboxItem } from "./inbox.js";

export type ListenerEvent = "created" | "modified";
export type ListenerState = "active" | "paused";

/** What a listener's target is told about a file change. */
export interface FileEvent {
  /** Listener name. */
  listener: string;
  event: ListenerEvent;
  /** Logical path of the file. */
  path: string;
  /** Base name of the file. */
  name: string;
  mtimeMs: number;
}

/**
 * Where a listener's events go. Code, supplied on every boot (like agent modules and
 * workflow definitions); the database keeps only the registration and the snapshot.
 *   - "agent": enqueue `payload(event)` in the agent's inbox. The agent must be able to
 *     read the watched directory, since the payload reveals file names.
 *   - "platform": call `fire(event, idempotencyKey)` (e.g. to start a workflow). Platform-
 *     owned: no permission check. `fire` runs inside the scan's transaction, so whatever it
 *     writes commits atomically with the snapshot update. Its return value is reported.
 */
export type ListenerTarget =
  | { kind: "agent"; agentId: string; payload: (e: FileEvent) => unknown }
  | { kind: "platform"; fire: (e: FileEvent, idempotencyKey: string) => unknown };

export interface Listener {
  id: string;
  name: string;
  /** null for platform-owned listeners. */
  targetAgentId: string | null;
  /** Logical directory to watch (recursive). */
  path: string;
  events: ListenerEvent[];
  state: ListenerState;
  createdAt: string;
  lastScanAt: string | null;
  lastError: string | null;
}

interface Row {
  id: string;
  name: string;
  target_agent_id: string | null;
  path: string;
  events: string;
  state: ListenerState;
  created_at: string;
  last_scan_at: string | null;
  last_error: string | null;
}

const fromRow = (r: Row): Listener => ({
  id: r.id,
  name: r.name,
  targetAgentId: r.target_agent_id,
  path: r.path,
  events: JSON.parse(r.events),
  state: r.state,
  createdAt: r.created_at,
  lastScanAt: r.last_scan_at,
  lastError: r.last_error,
});

export interface RegisterOptions {
  path: string;
  target: ListenerTarget;
  events?: ListenerEvent[];
  /**
   * On first registration (or when the path changes), treat files already present as new.
   * Default false: only react to future changes.
   */
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
 * Persistent, platform-managed subscriptions: "when a file appears under X, do Y".
 * Implemented as a periodic scan against a persisted snapshot.
 *
 * Listeners are registered by name on every boot. Registration is an upsert: the row and
 * its snapshot survive restarts, so re-registering doesn't refire for files already seen.
 * If the watched path changes, the snapshot is reset to the directory's current contents.
 * A stored listener with no target registered in this process is skipped (its snapshot
 * doesn't advance, so it catches up once its target is registered again).
 *
 * Independent of runtimes by construction: a scan only touches the filesystem, the
 * snapshot table, and the inbox (or whatever a platform target writes).
 *
 * Duplicate protection, two layers:
 *   1. Snapshot (listener_files): a file version already seen produces no event.
 *      Firing + snapshot update happen in one SQLite transaction.
 *   2. Idempotency key = listener:<name>:<event>:<path>:<mtime>, used for the inbox item
 *      (or passed to a platform target), so even a lost snapshot can't fire twice.
 *
 * Events: "fired" ({ listener, event, path, item?, result? }), "skipped" ({ listener, reason }),
 *         "error" ({ listener, path, error }) when a target throws for one file.
 */
export class ListenerService extends EventEmitter {
  private timer: NodeJS.Timeout | undefined;
  private readonly intervalMs: number;
  private readonly settleMs: number;
  private readonly targets = new Map<string, ListenerTarget>();
  /** Listeners already reported as having no target, so a stale one isn't reported every scan. */
  private readonly reportedOrphans = new Set<string>();

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

  register(name: string, opts: RegisterOptions): Listener {
    const { target } = opts;
    let path: string;
    if (target.kind === "agent") {
      const agent = this.registry.get(target.agentId);
      if (!agent || agent.lifecycleState !== "active") throw new Error(`no active agent ${target.agentId}`);
      // A listener reveals file names and contents to its target, so the target must
      // already be allowed to read the watched directory.
      const access = this.fs.check(target.agentId, opts.path, "read");
      if (!access.allowed) throw new Error(`EACCES: agent cannot read ${access.path}: ${access.reason}`);
      path = access.path;
    } else {
      path = this.fs.normalizePlatformPath(opts.path);
    }
    const events = opts.events ?? ["created"];
    const targetAgentId = target.kind === "agent" ? target.agentId : null;

    this.db.transaction(() => {
      const existing = this.getByName(name);
      if (!existing) {
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO listeners (id, name, target_agent_id, path, events, state, created_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?)`,
          )
          .run(id, name, targetAgentId, path, JSON.stringify(events), new Date().toISOString());
        if (!opts.includeExisting) this.baseline(id, path);
        return;
      }
      this.db
        .prepare(`UPDATE listeners SET target_agent_id = ?, path = ?, events = ? WHERE id = ?`)
        .run(targetAgentId, path, JSON.stringify(events), existing.id);
      if (existing.path !== path) {
        this.db.prepare(`DELETE FROM listener_files WHERE listener_id = ?`).run(existing.id);
        if (!opts.includeExisting) this.baseline(existing.id, path);
      }
    })();
    this.targets.set(name, target);
    this.reportedOrphans.delete(name);
    return this.getByName(name)!;
  }

  get(id: string): Listener | undefined {
    const row = this.db.prepare(`SELECT * FROM listeners WHERE id = ?`).get(id) as Row | undefined;
    return row && fromRow(row);
  }

  getByName(name: string): Listener | undefined {
    const row = this.db.prepare(`SELECT * FROM listeners WHERE name = ?`).get(name) as Row | undefined;
    return row && fromRow(row);
  }

  list(): Listener[] {
    return (this.db.prepare(`SELECT * FROM listeners ORDER BY created_at`).all() as Row[]).map(fromRow);
  }

  setState(id: string, state: ListenerState): void {
    this.db.prepare(`UPDATE listeners SET state = ? WHERE id = ?`).run(state, id);
  }

  remove(id: string): void {
    const l = this.get(id);
    this.db.prepare(`DELETE FROM listeners WHERE id = ?`).run(id);
    if (l) this.targets.delete(l.name);
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

    const target = this.targets.get(listener.name);
    if (!target) {
      // Expected for listeners whose code is gone (or not registered yet): say so once.
      if (this.reportedOrphans.has(listener.name)) return [];
      this.reportedOrphans.add(listener.name);
      return skip("no target registered in this process");
    }
    if (target.kind === "agent") {
      // Re-check every scan: the agent may have been deleted or lost its grant since registration.
      const agent = this.registry.get(target.agentId);
      if (!agent || agent.lifecycleState !== "active") return skip("target agent is not active");
      const access = this.fs.check(target.agentId, listener.path, "read");
      if (!access.allowed) return skip(`target lost read access: ${access.reason}`);
    }

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
    let lastError: string | null = null;
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

        const e: FileEvent = { listener: listener.name, event, path: f.path, name: posix.basename(f.path), mtimeMs: f.mtimeMs };
        const key = `listener:${listener.name}:${event}:${f.path}:${f.mtimeMs}`;
        try {
          if (target.kind === "agent") {
            const item = this.inbox.send(target.agentId, target.payload(e), { idempotencyKey: key });
            created.push(item);
            this.emit("fired", { listener, event, path: f.path, item });
          } else {
            const result = target.fire(e, key);
            this.emit("fired", { listener, event, path: f.path, result });
          }
        } catch (err) {
          // One bad file doesn't block the others. Its version is recorded as seen, so it
          // isn't retried every scan; a later modification fires again.
          lastError = `${f.path}: ${(err as Error).message}`;
          this.emit("error", { listener, path: f.path, error: err as Error });
        }
      }
      // Files that disappeared: forget them, so re-creating one counts as "created" again.
      // (Files still settling are left alone.)
      const del = this.db.prepare(`DELETE FROM listener_files WHERE listener_id = ? AND path = ?`);
      const present = new Set(files.map((f) => f.path));
      for (const path of seen.keys()) if (!present.has(path)) del.run(listener.id, path);

      this.db.prepare(`UPDATE listeners SET last_scan_at = ?, last_error = ? WHERE id = ?`).run(now, lastError, listener.id);
    })();
    return created;
  }

  /** Remember what's in `path` now, so it doesn't count as "created". */
  private baseline(listenerId: string, path: string): void {
    const insert = this.db.prepare(`INSERT INTO listener_files (listener_id, path, mtime_ms, size) VALUES (?, ?, ?, ?)`);
    for (const f of this.fs.scan(path)) insert.run(listenerId, f.path, f.mtimeMs, f.size);
  }
}
