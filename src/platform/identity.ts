import { randomUUID } from "node:crypto";
import type { Db } from "./database.js";

/**
 * Logical lifecycle of an agent identity. This is NOT runtime state:
 * an `active` agent may have zero running processes.
 */
export type AgentLifecycleState = "active" | "deleted";

export interface Agent {
  id: string;
  name: string;
  configuration: Record<string, unknown>;
  createdAt: string;
  lifecycleState: AgentLifecycleState;
}

interface AgentRow {
  id: string;
  name: string;
  configuration: string;
  created_at: string;
  lifecycle_state: AgentLifecycleState;
}

const fromRow = (r: AgentRow): Agent => ({
  id: r.id,
  name: r.name,
  configuration: JSON.parse(r.configuration),
  createdAt: r.created_at,
  lifecycleState: r.lifecycle_state,
});

/** The authority on persistent agent identity. Knows nothing about processes. */
export class AgentRegistry {
  constructor(private readonly db: Db) {}

  create(name: string, configuration: Record<string, unknown> = {}): Agent {
    const agent: Agent = {
      id: randomUUID(),
      name,
      configuration,
      createdAt: new Date().toISOString(),
      lifecycleState: "active",
    };
    this.db
      .prepare(
        `INSERT INTO agents (id, name, configuration, created_at, lifecycle_state)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(agent.id, agent.name, JSON.stringify(configuration), agent.createdAt, agent.lifecycleState);
    return agent;
  }

  get(id: string): Agent | undefined {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as AgentRow | undefined;
    return row && fromRow(row);
  }

  getByName(name: string): Agent | undefined {
    const row = this.db.prepare(`SELECT * FROM agents WHERE name = ?`).get(name) as AgentRow | undefined;
    return row && fromRow(row);
  }

  list(): Agent[] {
    return (this.db.prepare(`SELECT * FROM agents ORDER BY created_at`).all() as AgentRow[]).map(fromRow);
  }

  updateConfiguration(id: string, configuration: Record<string, unknown>): void {
    this.db.prepare(`UPDATE agents SET configuration = ? WHERE id = ?`).run(JSON.stringify(configuration), id);
  }

  /** Logical deletion (soft). Terminating the runtime is the supervisor's job, not ours. */
  markDeleted(id: string): void {
    this.db.prepare(`UPDATE agents SET lifecycle_state = 'deleted' WHERE id = ?`).run(id);
  }
}
