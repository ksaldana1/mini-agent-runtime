import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { dirname, join, posix } from "node:path";
import type { Db } from "./database.js";
import type { AgentRegistry } from "./identity.js";
import type { FsRequest } from "../shared/protocol.js";

export type Access = "read" | "write";

export class FsDeniedError extends Error {
  readonly code = "EACCES";
  /** True once the denial has been written to fs_audit (avoids double-logging). */
  constructor(message: string, readonly audited = false) {
    super(`EACCES: ${message}`);
  }
}

export interface Grant {
  agentId: string;
  path: string;
  access: Access;
  grantedBy: string | null; // null = platform
  createdAt: string;
}

export interface FileStat {
  path: string; // logical
  mtimeMs: number;
  size: number;
}

export interface AuditEntry {
  at: string;
  agentId: string;
  op: string;
  path: string;
  allowed: boolean;
  reason: string;
}

/**
 * Platform-checked shared filesystem.
 *
 *   <root>/agents/<agentId>/...   private; the owning agent has implicit read/write
 *   <root>/shared/documents/...   shared; nobody has access until granted
 *   <root>/shared/artifacts/...
 *
 * Every agent file operation goes through `handle()`, which:
 *   1. resolves the logical path (rejecting escapes and symlinks),
 *   2. checks ownership or an explicit grant,
 *   3. records the decision in fs_audit,
 *   4. performs the operation with the *platform's* OS privileges.
 *
 * This is platform-level authorization, NOT OS-enforced security: runtimes run as
 * the same Unix user and could bypass this by calling node:fs directly. See README.
 *
 * Events: "denied" (AuditEntry), for every audited denial.
 */
export class AgentFilesystem extends EventEmitter {
  private readonly realRoot: string;

  constructor(
    private readonly db: Db,
    private readonly registry: AgentRegistry,
    readonly root: string,
  ) {
    super();
    for (const dir of ["agents", "shared/documents", "shared/artifacts"]) {
      mkdirSync(join(root, dir), { recursive: true });
    }
    this.realRoot = realpathSync(root);
  }

  // ── Agent-facing entry point (called with the identity of the IPC channel) ──

  handle(agentId: string, req: FsRequest): unknown {
    let path = req.path;
    try {
      path = this.normalize(agentId, req.path);
      switch (req.op) {
        case "read": {
          this.authorize(agentId, req.op, path, "read");
          return readFileSync(this.physical(path), "utf8");
        }
        case "write": {
          this.authorize(agentId, req.op, path, "write");
          const target = this.physical(path);
          mkdirSync(dirname(target), { recursive: true });
          // Atomic replace: readers see the old file or the new one, never half of each.
          const tmp = `${target}.${randomUUID()}.tmp`;
          writeFileSync(tmp, req.content);
          renameSync(tmp, target);
          return { path, bytes: Buffer.byteLength(req.content) };
        }
        case "list": {
          this.authorize(agentId, req.op, path, "read");
          try {
            return readdirSync(this.physical(path)).filter((n) => !n.endsWith(".tmp"));
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw e;
          }
        }
        case "grant": {
          this.authorizeGrant(agentId, req.op, path);
          this.grant(req.granteeAgentId, path, req.access, agentId);
          return { granted: req.access, path, to: req.granteeAgentId };
        }
        case "revoke": {
          this.authorizeGrant(agentId, req.op, path);
          this.revoke(req.granteeAgentId, path);
          return { revoked: path, from: req.granteeAgentId };
        }
      }
    } catch (err) {
      if (err instanceof FsDeniedError && !err.audited) {
        this.audit(agentId, req.op, path, false, err.message);
      }
      throw err;
    }
  }

  // ── Platform/admin API ────────────────────────────────────────────────────

  /** grantedBy = null means the platform itself granted it. */
  grant(agentId: string, path: string, access: Access, grantedBy: string | null = null): void {
    if (!this.registry.get(agentId)) throw new Error(`unknown grantee ${agentId}`);
    const logical = this.normalize(grantedBy ?? agentId, path);
    this.db
      .prepare(
        `INSERT INTO fs_grants (agent_id, path, access, granted_by, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (agent_id, path) DO UPDATE SET access = excluded.access, granted_by = excluded.granted_by`,
      )
      .run(agentId, logical, access, grantedBy, new Date().toISOString());
  }

  revoke(agentId: string, path: string): void {
    this.db.prepare(`DELETE FROM fs_grants WHERE agent_id = ? AND path = ?`).run(agentId, path);
  }

  grants(agentId: string): Grant[] {
    return this.db
      .prepare(
        `SELECT agent_id AS agentId, path, access, granted_by AS grantedBy, created_at AS createdAt
         FROM fs_grants WHERE agent_id = ? ORDER BY path`,
      )
      .all(agentId) as Grant[];
  }

  auditLog(agentId?: string): AuditEntry[] {
    const sql = `SELECT at, agent_id AS agentId, op, path, allowed, reason FROM fs_audit
                 ${agentId ? "WHERE agent_id = ?" : ""} ORDER BY rowid`;
    const rows = (agentId ? this.db.prepare(sql).all(agentId) : this.db.prepare(sql).all()) as (Omit<AuditEntry, "allowed"> & { allowed: number })[];
    return rows.map((r) => ({ ...r, allowed: r.allowed === 1 }));
  }

  /** Logical home directory of an agent. */
  home(agentId: string): string {
    return `agents/${agentId}`;
  }

  /**
   * Would `agentId` be allowed `need` access to `rawPath`? Pure check: no audit entry,
   * no file operation. Used by services that act on an agent's behalf (listeners).
   */
  check(agentId: string, rawPath: string, need: Access): { allowed: boolean; reason: string; path: string } {
    try {
      const path = this.normalize(agentId, rawPath);
      return { ...this.decide(agentId, path, need), path };
    } catch (err) {
      return { allowed: false, reason: (err as Error).message, path: rawPath };
    }
  }

  /**
   * Platform-privileged recursive listing of regular files under a logical directory.
   * No authorization: callers must check access themselves. Skips in-progress atomic
   * writes (*.tmp) and anything that isn't a regular file (including symlinks).
   */
  scan(logicalDir: string): FileStat[] {
    const dir = this.normalize("", logicalDir);
    const base = this.physical(dir);
    let entries;
    try {
      entries = readdirSync(base, { recursive: true, withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const out: FileStat[] = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.endsWith(".tmp")) continue;
      const abs = join(e.parentPath, e.name);
      const rel = abs.slice(base.length + 1).split(/[\\/]/).join("/");
      try {
        const st = statSync(abs);
        out.push({ path: `${dir}/${rel}`, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Deleted between readdir and stat: it just doesn't exist for this scan.
      }
    }
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  // ── Authorization ─────────────────────────────────────────────────────────

  /** Owner of a logical path: the agent whose private dir contains it, or null (platform). */
  private owner(path: string): string | null {
    const m = /^agents\/([^/]+)(\/|$)/.exec(path);
    return m ? m[1]! : null;
  }

  /** The permission decision itself, on an already-normalized path. */
  private decide(agentId: string, path: string, need: Access): { allowed: boolean; reason: string } {
    if (this.owner(path) === agentId) return { allowed: true, reason: "owner" };
    // Most specific grant covering this path (exact match or an ancestor directory).
    const grant = this.db
      .prepare(
        `SELECT path, access FROM fs_grants
          WHERE agent_id = ? AND (path = ? OR substr(?, 1, length(path) + 1) = path || '/')
          ORDER BY length(path) DESC LIMIT 1`,
      )
      .get(agentId, path, path) as { path: string; access: Access } | undefined;

    if (grant && (need === "read" || grant.access === "write")) {
      return { allowed: true, reason: `grant ${grant.access} on ${grant.path}` };
    }
    return { allowed: false, reason: grant ? `grant on ${grant.path} is ${grant.access}-only` : "no grant" };
  }

  private authorize(agentId: string, op: string, path: string, need: Access): void {
    const { allowed, reason } = this.decide(agentId, path, need);
    this.audit(agentId, op, path, allowed, reason);
    if (!allowed) throw new FsDeniedError(`${op} ${path}: ${reason}`, true);
  }

  /** Agents may only share what they own. Shared areas are granted by the platform. */
  private authorizeGrant(agentId: string, op: string, path: string): void {
    if (this.owner(path) !== agentId) {
      this.audit(agentId, op, path, false, "only the owner can share");
      throw new FsDeniedError(`${op} ${path}: only the owner can share`, true);
    }
    this.audit(agentId, op, path, true, "owner");
  }

  private audit(agentId: string, op: string, path: string, allowed: boolean, reason: string): void {
    const entry: AuditEntry = { at: new Date().toISOString(), agentId, op, path, allowed, reason };
    this.db
      .prepare(`INSERT INTO fs_audit (at, agent_id, op, path, allowed, reason) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(entry.at, agentId, op, path, allowed ? 1 : 0, reason);
    if (!allowed) this.emit("denied", entry);
  }

  // ── Path handling ─────────────────────────────────────────────────────────

  /** "~/x" → "agents/<self>/x"; normalizes ".."; rejects anything escaping the root. */
  private normalize(agentId: string, raw: string): string {
    if (raw.includes("\0")) throw new FsDeniedError("invalid path");
    const expanded = raw === "~" ? this.home(agentId) : raw.startsWith("~/") ? `${this.home(agentId)}/${raw.slice(2)}` : raw;
    if (posix.isAbsolute(expanded)) throw new FsDeniedError(`absolute paths not allowed: ${raw}`);
    const norm = posix.normalize(expanded).replace(/\/+$/, "");
    if (norm === ".." || norm.startsWith("../")) throw new FsDeniedError(`path escapes the data root: ${raw}`);
    if (norm === "." || norm === "") throw new FsDeniedError("the data root itself is not accessible");
    return norm;
  }

  /**
   * Physical path for a logical one. Refuses to follow symlinks anywhere along the
   * path: the permission check was done on the logical path, so a link like
   * agents/me/x → agents/other/secret would otherwise bypass it.
   */
  private physical(logical: string): string {
    const target = join(this.realRoot, logical);
    let probe = target;
    for (;;) {
      try {
        const real = realpathSync(probe);
        if (real !== probe) throw new FsDeniedError(`symlinks are not allowed: ${logical}`);
        return target;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        probe = dirname(probe); // check the deepest existing ancestor instead
      }
    }
  }
}
