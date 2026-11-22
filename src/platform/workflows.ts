import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { z } from "zod";
import type { Db } from "./database.js";
import type { Dispatcher } from "./dispatcher.js";
import type { AgentRegistry } from "./identity.js";
import type { Inbox } from "./inbox.js";
import { renderTemplate } from "../shared/template.js";

// ── Definitions ─────────────────────────────────────────────────────────────

export const WorkflowDefinitionSchema = z
  .object({
    name: z.string().min(1),
    steps: z
      .array(
        z.object({
          name: z.string().regex(/^\w+$/, "step names must be identifiers (used in templates)"),
          /** Candidate agents, in order. The first is tried first; the rest are fallbacks. */
          agents: z.array(z.string().uuid()).min(1),
          /** Inbox payload. May reference {{input.*}}, {{steps.<name>.*}}, {{workflow.id}}. */
          payload: z.unknown(),
        }),
      )
      .min(1),
  })
  .refine((d) => new Set(d.steps.map((s) => s.name)).size === d.steps.length, "step names must be unique");
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;

export type WorkflowStatus = "running" | "completed" | "failed";
export type StepStatus = "waiting" | "assigned" | "completed" | "failed";

export interface Workflow {
  id: string;
  name: string;
  definition: WorkflowDefinition;
  input: unknown;
  status: WorkflowStatus;
  currentStep: number;
  output: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStep {
  workflowId: string;
  index: number;
  name: string;
  status: StepStatus;
  /** Which assignment this is (1 = first candidate, 2 = first fallback, ...). */
  assignment: number;
  agentId: string | null;
  inboxItemId: string | null;
  result: unknown;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkflowEvent {
  at: string;
  workflowId: string;
  event: string;
  detail: string;
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * Durable sequential workflows, layered on the inbox.
 *
 * A workflow never talks to a runtime. Each step becomes an inbox item for an agent
 * (idempotency key: workflow:<id>:step:<n>:assignment:<k>), and the workflow advances
 * by observing that item's durable status:
 *
 *   step:      waiting ──assign──▶ assigned ──item completed──▶ completed ──▶ next step
 *                                     │
 *                                     └──item failed──▶ reassign to next candidate agent
 *                                                       (none left → step + workflow failed)
 *
 * Retries *within* an assignment (crashes, errors) are the inbox's job (maxAttempts).
 * Reassignment *across* agents is the workflow's job.
 *
 * `reconcile` derives the next transition purely from SQLite state, so it is idempotent
 * and safe to call any time. It runs:
 *   - on dispatcher events ("completed", "failed", "released") — the fast path;
 *   - for every running workflow at startup — the recovery path, covering events lost
 *     while the platform was down.
 *
 * Events: "transition" (WorkflowEvent).
 */
export class WorkflowService extends EventEmitter {
  /** Number of workflows that made progress during the startup recovery pass. */
  readonly recoveredOnStartup: number;

  constructor(
    private readonly db: Db,
    private readonly registry: AgentRegistry,
    private readonly inbox: Inbox,
    dispatcher: Dispatcher,
  ) {
    super();
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        definition   TEXT NOT NULL,
        input        TEXT NOT NULL,
        status       TEXT NOT NULL,
        current_step INTEGER NOT NULL,
        output       TEXT,
        error        TEXT,
        created_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflow_steps (
        workflow_id   TEXT NOT NULL REFERENCES workflows(id),
        idx           INTEGER NOT NULL,
        name          TEXT NOT NULL,
        status        TEXT NOT NULL,
        assignment    INTEGER NOT NULL DEFAULT 0,
        agent_id      TEXT REFERENCES agents(id),
        inbox_item_id TEXT REFERENCES inbox(id),
        result        TEXT,
        error         TEXT,
        started_at    TEXT,
        finished_at   TEXT,
        PRIMARY KEY (workflow_id, idx)
      );
      CREATE INDEX IF NOT EXISTS workflow_steps_item ON workflow_steps (inbox_item_id);
      CREATE TABLE IF NOT EXISTS workflow_events (
        workflow_id TEXT NOT NULL REFERENCES workflows(id),
        at          TEXT NOT NULL,
        event       TEXT NOT NULL,
        detail      TEXT NOT NULL
      );
    `);

    dispatcher.on("completed", ({ item }) => this.reconcileForItem(item.id));
    dispatcher.on("failed", ({ item }) => this.reconcileForItem(item.id));
    // A crash can push an item to "failed" via releaseClaims without a per-item event.
    dispatcher.on("released", () => this.reconcileAll());

    this.recoveredOnStartup = this.reconcileAll();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  start(definition: WorkflowDefinition, input: unknown = {}): Workflow {
    const def = WorkflowDefinitionSchema.parse(definition);
    for (const s of def.steps) {
      for (const a of s.agents) if (!this.registry.get(a)) throw new Error(`step ${s.name}: unknown agent ${a}`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO workflows (id, name, definition, input, status, current_step, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'running', 0, ?, ?)`,
        )
        .run(id, def.name, JSON.stringify(def), JSON.stringify(input ?? null), now, now);
      const insertStep = this.db.prepare(`INSERT INTO workflow_steps (workflow_id, idx, name, status) VALUES (?, ?, ?, 'waiting')`);
      def.steps.forEach((s, i) => insertStep.run(id, i, s.name));
      this.record(id, "workflow_started", `${def.name} (${def.steps.length} steps)`);
      this.assign(this.get(id)!, 0, 1);
    })();
    return this.get(id)!;
  }

  get(id: string): Workflow | undefined {
    const r = this.db.prepare(`SELECT * FROM workflows WHERE id = ?`).get(id) as WorkflowRow | undefined;
    return r && fromWorkflowRow(r);
  }

  list(status?: WorkflowStatus): Workflow[] {
    const rows = status
      ? this.db.prepare(`SELECT * FROM workflows WHERE status = ? ORDER BY rowid`).all(status)
      : this.db.prepare(`SELECT * FROM workflows ORDER BY rowid`).all();
    return (rows as WorkflowRow[]).map(fromWorkflowRow);
  }

  steps(workflowId: string): WorkflowStep[] {
    return (
      this.db.prepare(`SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY idx`).all(workflowId) as StepRow[]
    ).map(fromStepRow);
  }

  events(workflowId: string): WorkflowEvent[] {
    return this.db
      .prepare(`SELECT at, workflow_id AS workflowId, event, detail FROM workflow_events WHERE workflow_id = ? ORDER BY rowid`)
      .all(workflowId) as WorkflowEvent[];
  }

  /** Advance every running workflow as far as durable state allows. Returns how many moved. */
  reconcileAll(): number {
    let moved = 0;
    for (const wf of this.list("running")) if (this.reconcile(wf.id)) moved++;
    return moved;
  }

  /** Advance one workflow as far as durable state allows. Returns true if anything changed. */
  reconcile(workflowId: string): boolean {
    let changed = false;
    while (this.db.transaction(() => this.step(workflowId))()) changed = true;
    return changed;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private reconcileForItem(inboxItemId: string): void {
    const row = this.db.prepare(`SELECT workflow_id FROM workflow_steps WHERE inbox_item_id = ?`).get(inboxItemId) as
      | { workflow_id: string }
      | undefined;
    if (row) this.reconcile(row.workflow_id);
  }

  /** Apply at most one transition. Returns true if one was applied. */
  private step(workflowId: string): boolean {
    const wf = this.get(workflowId);
    if (!wf || wf.status !== "running") return false;
    const step = this.steps(workflowId)[wf.currentStep]!;
    if (step.status !== "assigned" || !step.inboxItemId) return false;

    const item = this.inbox.get(step.inboxItemId);
    if (!item) return false;

    if (item.status === "completed") {
      this.updateStep(wf.id, step.index, { status: "completed", result: item.result, finished: true });
      this.record(wf.id, "step_completed", `${step.name} by ${this.agentName(step.agentId)}`);

      const next = step.index + 1;
      if (next < wf.definition.steps.length) {
        this.db.prepare(`UPDATE workflows SET current_step = ?, updated_at = ? WHERE id = ?`).run(next, now(), wf.id);
        this.assign(this.get(wf.id)!, next, 1);
      } else {
        this.finish(wf.id, "completed", item.result, null);
      }
      return true;
    }

    if (item.status === "failed") {
      this.record(
        wf.id,
        "assignment_failed",
        `${step.name} on ${this.agentName(step.agentId)} after ${item.attempts} attempt(s): ${item.lastError}`,
      );
      this.assign(wf, step.index, step.assignment + 1);
      return true;
    }

    return false; // pending or claimed: nothing to do yet
  }

  /** Give step `index` to its `assignment`-th candidate agent (1-based), or fail the workflow. */
  private assign(wf: Workflow, index: number, assignment: number): void {
    const def = wf.definition.steps[index]!;
    for (let k = assignment; k <= def.agents.length; k++) {
      const agentId = def.agents[k - 1]!;
      const agent = this.registry.get(agentId);
      if (!agent || agent.lifecycleState !== "active") {
        this.record(wf.id, "assignment_skipped", `${def.name}: ${this.agentName(agentId)} is not active`);
        continue;
      }
      const payload = renderTemplate(def.payload, {
        input: wf.input,
        steps: this.stepResults(wf.id),
        workflow: { id: wf.id },
      });
      const item = this.inbox.send(agentId, payload, {
        idempotencyKey: `workflow:${wf.id}:step:${index}:assignment:${k}`,
      });
      this.updateStep(wf.id, index, { status: "assigned", assignment: k, agentId, inboxItemId: item.id, started: true });
      this.record(wf.id, "step_assigned", `${def.name} → ${agent.name}${k > 1 ? ` (fallback #${k - 1})` : ""}`);
      return;
    }
    const error = `step ${def.name}: no candidate agents left`;
    this.updateStep(wf.id, index, { status: "failed", error, finished: true });
    this.finish(wf.id, "failed", null, error);
  }

  private finish(id: string, status: "completed" | "failed", output: unknown, error: string | null): void {
    this.db
      .prepare(`UPDATE workflows SET status = ?, output = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run(status, JSON.stringify(output ?? null), error, now(), id);
    this.record(id, `workflow_${status}`, error ?? "");
  }

  private stepResults(workflowId: string): Record<string, unknown> {
    return Object.fromEntries(this.steps(workflowId).filter((s) => s.status === "completed").map((s) => [s.name, s.result]));
  }

  private updateStep(
    workflowId: string,
    index: number,
    u: {
      status: StepStatus;
      assignment?: number;
      agentId?: string;
      inboxItemId?: string;
      result?: unknown;
      error?: string;
      started?: boolean;
      finished?: boolean;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE workflow_steps SET
           status        = ?,
           assignment    = COALESCE(?, assignment),
           agent_id      = COALESCE(?, agent_id),
           inbox_item_id = COALESCE(?, inbox_item_id),
           result        = COALESCE(?, result),
           error         = COALESCE(?, error),
           started_at    = CASE WHEN ? THEN ? ELSE started_at END,
           finished_at   = CASE WHEN ? THEN ? ELSE finished_at END
         WHERE workflow_id = ? AND idx = ?`,
      )
      .run(
        u.status,
        u.assignment ?? null,
        u.agentId ?? null,
        u.inboxItemId ?? null,
        u.result === undefined ? null : JSON.stringify(u.result),
        u.error ?? null,
        u.started ? 1 : 0,
        now(),
        u.finished ? 1 : 0,
        now(),
        workflowId,
        index,
      );
  }

  private record(workflowId: string, event: string, detail: string): void {
    const e: WorkflowEvent = { at: now(), workflowId, event, detail };
    this.db.prepare(`INSERT INTO workflow_events (workflow_id, at, event, detail) VALUES (?, ?, ?, ?)`).run(workflowId, e.at, event, detail);
    this.emit("transition", e);
  }

  private agentName(id: string | null): string {
    return (id && this.registry.get(id)?.name) ?? String(id);
  }
}

// ── Row mapping ─────────────────────────────────────────────────────────────

const now = () => new Date().toISOString();
const parse = (s: string | null): unknown => (s === null ? null : JSON.parse(s));

interface WorkflowRow {
  id: string;
  name: string;
  definition: string;
  input: string;
  status: WorkflowStatus;
  current_step: number;
  output: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

interface StepRow {
  workflow_id: string;
  idx: number;
  name: string;
  status: StepStatus;
  assignment: number;
  agent_id: string | null;
  inbox_item_id: string | null;
  result: string | null;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
}

const fromWorkflowRow = (r: WorkflowRow): Workflow => ({
  id: r.id,
  name: r.name,
  definition: JSON.parse(r.definition),
  input: JSON.parse(r.input),
  status: r.status,
  currentStep: r.current_step,
  output: parse(r.output),
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const fromStepRow = (r: StepRow): WorkflowStep => ({
  workflowId: r.workflow_id,
  index: r.idx,
  name: r.name,
  status: r.status,
  assignment: r.assignment,
  agentId: r.agent_id,
  inboxItemId: r.inbox_item_id,
  result: parse(r.result),
  error: r.error,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});
