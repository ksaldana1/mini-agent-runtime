import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/platform/database.js";
import { AgentRegistry } from "../src/platform/identity.js";

describe("AgentRegistry", () => {
  let dir: string | undefined;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("assigns a UUID and stores configuration", () => {
    const registry = new AgentRegistry(openDatabase(":memory:"));
    const agent = registry.create("agent-a", { role: "x" });
    expect(agent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(registry.get(agent.id)).toEqual(agent);
    expect(agent.lifecycleState).toBe("active");
  });

  it("identity survives a platform restart (database reopen)", () => {
    dir = mkdtempSync(join(tmpdir(), "agents-"));
    const path = join(dir, "platform.db");

    const db1 = openDatabase(path);
    const created = new AgentRegistry(db1).create("agent-a");
    db1.close();

    const reloaded = new AgentRegistry(openDatabase(path)).getByName("agent-a");
    expect(reloaded).toEqual(created);
  });

  it("logical deletion is separate from existence", () => {
    const registry = new AgentRegistry(openDatabase(":memory:"));
    const agent = registry.create("agent-a");
    registry.markDeleted(agent.id);
    expect(registry.get(agent.id)?.lifecycleState).toBe("deleted");
  });
});
