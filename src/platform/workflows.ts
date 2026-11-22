import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Db } from "./database.js";
import type { AgentRegistry } from "./identity.js";
import type { Inbox, InboxItem } from "./inbox.js";

// ── Definitions (code, registered every boot) ───────────────────────────────

export interface StepContext {
  /** The workflow's input, as stored at start. */
  input: unknown;
  /** Results of the steps completed so far, by step name. */
  steps: Record<string, unknown>;
  workflow: { id: string };
}

export interface WorkflowStepDefinition {
  name: string;
  /** Candidate agent ids, in order. The first is tried first; the rest are fallbacks. */
  agents: string[];
  /** Task name on the agent. */
  task: string;
  /**
   * Computes the task input when the step is assigned. The result is stored in the inbox,
   * so it runs once per assignment, not on every recovery. If it throws, the workflow fails.
   */
  input(ctx: StepContext): unknown;
}

export interface WorkflowDefinition {
  name: string;
  steps: WorkflowStepDefinition[];
}

export type WorkflowStatus = "running" | "completed" | "failed";
export type StepStatus = "waiting" | "assigned" | "completed" | "failed";

export interface Workflow {
  id: string;
  name: string;
  /** Hash of the definition the workflow was started with (step names, tasks, agents). */
  fingerprint: string | null;
  input: unknown;
  status: WorkflowStatus;
  currentStep: number;
  output: unknown;
  error: string | null;
  idempotencyKey: string | null;
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
 * Code defines workflows (register(), every boot); SQLite holds their progress. A workflow
 * row stores its definition's name and fingerprint, never the definition itself.
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
 * `reconcile` derives the next transition purely from SQLite state plus the registered
 * definition, so it is idempotent and safe to call any time. It runs:
 *   - on the inbox's "settled" event for a step's item — the fast path;
 *   - for every running workflow in recover() — the startup path, covering events lost
 *     while the platform was down.
 * A running workflow whose definition isn't registered is left alone ("skipped"). One whose
 * registered definition has a different fingerprint is failed with "definition changed".
 *
 * Events: "transition" (WorkflowEvent), "settled" (Workflow; completed or failed, after
 * commit), "skipped" ({ workflowId, name, reason }).
 */
export class WorkflowService extends EventEmitter {
  private readonly definitions = new Map<string, { def: WorkflowDefinition; fingerprint: string }>();
  private readonly waiters = new Map<string, Set<(wf: Workflow) => void>>();

  constructor(
    private readonly db: Db,
    private readonly registry: AgentRegistry,
    private readonly inbox: Inbox,
  ) {
    super();
    // Every path to a final status (complete, fail, crash release, startup release)
    // emits "settled" for that item, so this is the only trigger needed.
    inbox.on("settled", (item: InboxItem) => this.reconcileForItem(item.id));
  }

  // ── Definitions ───────────────────────────────────────────────────────────

  /** Register (or replace) the code for a workflow name. Returns its fingerprint. */
  register(def: WorkflowDefinition): string {
    if (!def.name) throw new Error("workflow needs a name");
    if (def.steps.length === 0) throw new Error(`workflow ${def.name}: needs at least one step`);
    const names = new Set<string>();
    for (const s of def.steps) {
      if (!s.name) throw new Error(`workflow ${def.name}: every step needs a name`);
      if (names.has(s.name)) throw new Error(`workflow ${def.name}: step names must be unique (${s.name})`);
      names.add(s.name);
      if (s.agents.length === 0) throw new Error(`workflow ${def.name}, step ${s.name}: needs at least one agent`);
      for (const a of s.agents) if (!this.registry.get(a)) throw new Error(`workflow ${def.name}, step ${s.name}: unknown agent ${a}`);
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(def.steps.map((s) => [s.name, s.task, s.agents.map((a) => this.registry.get(a)!.name)])))
      .digest("hex")
      .slice(0, 16);
    this.definitions.set(def.name, { def, fingerprint });
    return fingerprint;
  }

  isRegistered(name: string): boolean {
    return this.definitions.has(name);
  }

  // ── Runs ──────────────────────────────────────────────────────────────────

  /**
   * Start a run of a registered workflow. With an idempotency key, a repeat start of the
   * same workflow name returns the original run instead of creating another.
   */
  start(name: string, input: unknown = {}, opts: { idempotencyKey?: string } = {}): Workflow {
    const registered = this.definitions.get(name);
    if (!registered) throw new Error(`workflow ${name} is not registered`);
    const { def, fingerprint } = registered;

    const id = randomUUID();
    const now = new Date().toISOString();
    let created = false;
    this.db.transaction(() => {
      created =
        this.db
          .prepare(
            `INSERT INTO workflows (id, name, fingerprint, input, status, current_step, idempotency_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'running', 0, ?, ?, ?)
             ON CONFLICT (name, idempotency_key) DO NOTHING`,
          )
          .run(id, name, fingerprint, JSON.stringify(input ?? null), opts.idempotencyKey ?? null, now, now).changes > 0;
      if (!created) return;
      const insertStep = this.db.prepare(`INSERT INTO workflow_steps (workflow_id, idx, name, status) VALUES (?, ?, ?, 'waiting')`);
      def.steps.forEach((s, i) => insertStep.run(id, i, s.name));
      this.record(id, "workflow_started", `${name} (${def.steps.length} steps)`);
      this.assign(this.get(id)!, def, 0, 1);
    })();
    if (!created) {
      return fromWorkflowRow(
        this.db.prepare(`SELECT * FROM workflows WHERE name = ? AND idempotency_key = ?`).get(name, opts.idempotencyKey) as WorkflowRow,
      );
    }
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

  /** Resolves once the workflow is completed or failed (immediately if it already is). */
  waitFor(id: string): Promise<Workflow> {
    const wf = this.get(id);
    if (!wf) return Promise.reject(new Error(`unknown workflow ${id}`));
    if (wf.status !== "running") return Promise.resolve(wf);
    return new Promise((resolve) => {
      let set = this.waiters.get(id);
      if (!set) this.waiters.set(id, (set = new Set()));
      set.add(resolve);
    });
  }

  /**
   * Platform startup: catch up on steps that settled while no workflow service was
   * listening. Returns how many workflows moved. Also safe to call after registering
   * more definitions.
   */
  recover(): number {
    return this.reconcileAll();
  }

  /** Advance every running workflow as far as durable state allows. Returns how many moved. */
  reconcileAll(): number {
    let moved = 0;
    for (const wf of this.list("running")) if (this.reconcile(wf.id)) moved++;
    return moved;
  }

  /** Advance one workflow as far as durable state allows. Returns true if anything changed. */
  reconcile(workflowId: string): boolean {
    const wf = this.get(workflowId);
    if (!wf || wf.status !== "running") return false;
    const registered = this.definitions.get(wf.name);
    if (!registered) {
      this.emit("skipped", { workflowId, name: wf.name, reason: `workflow ${wf.name} is not registered in this process` });
      return false;
    }
    if (registered.fingerprint !== wf.fingerprint) {
      this.db.transaction(() => this.finish(wf.id, "failed", null, "definition changed"))();
      return true;
    }
    let changed = false;
    while (this.db.transaction(() => this.step(workflowId, registered.def))()) changed = true;
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
  private step(workflowId: string, def: WorkflowDefinition): boolean {
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
      if (next < def.steps.length) {
        this.db.prepare(`UPDATE workflows SET current_step = ?, updated_at = ? WHERE id = ?`).run(next, now(), wf.id);
        this.assign(this.get(wf.id)!, def, next, 1);
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
      this.assign(wf, def, step.index, step.assignment + 1);
      return true;
    }

    return false; // pending or claimed: nothing to do yet
  }

  /** Give step `index` to its `assignment`-th candidate agent (1-based), or fail the workflow. */
  private assign(wf: Workflow, def: WorkflowDefinition, index: number, assignment: number): void {
    const s = def.steps[index]!;
    let input: unknown;
    try {
      input = s.input({ input: wf.input, steps: this.stepResults(wf.id), workflow: { id: wf.id } });
    } catch (err) {
      const error = `step ${s.name}: computing its input failed: ${(err as Error).message}`;
      this.updateStep(wf.id, index, { status: "failed", error, finished: true });
      this.finish(wf.id, "failed", null, error);
      return;
    }

    for (let k = assignment; k <= s.agents.length; k++) {
      const agentId = s.agents[k - 1]!;
      const agent = this.registry.get(agentId);
      if (!agent || agent.lifecycleState !== "active") {
        this.record(wf.id, "assignment_skipped", `${s.name}: ${this.agentName(agentId)} is not active`);
        continue;
      }
      const item = this.inbox.send(
        agentId,
        { task: s.task, input },
        { idempotencyKey: `workflow:${wf.id}:step:${index}:assignment:${k}` },
      );
      this.updateStep(wf.id, index, { status: "assigned", assignment: k, agentId, inboxItemId: item.id, started: true });
      this.record(wf.id, "step_assigned", `${s.name} → ${agent.name}${k > 1 ? ` (fallback #${k - 1})` : ""}`);
      return;
    }
    const error = `step ${s.name}: no candidate agents left`;
    this.updateStep(wf.id, index, { status: "failed", error, finished: true });
    this.finish(wf.id, "failed", null, error);
  }

  private finish(id: string, status: "completed" | "failed", output: unknown, error: string | null): void {
    this.db
      .prepare(`UPDATE workflows SET status = ?, output = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run(status, JSON.stringify(output ?? null), error, now(), id);
    this.record(id, `workflow_${status}`, error ?? "");
    const wf = this.get(id)!;
    // After the enclosing transaction commits (same rule as the inbox's events).
    queueMicrotask(() => {
      this.emit("settled", wf);
      const waiters = this.waiters.get(id);
      this.waiters.delete(id);
      for (const resolve of waiters ?? []) resolve(wf);
    });
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
  fingerprint: string | null;
  input: string;
  status: WorkflowStatus;
  current_step: number;
  output: string | null;
  error: string | null;
  idempotency_key: string | null;
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
  fingerprint: r.fingerprint,
  input: JSON.parse(r.input),
  status: r.status,
  currentStep: r.current_step,
  output: parse(r.output),
  error: r.error,
  idempotencyKey: r.idempotency_key,
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
