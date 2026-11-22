import { describe, expect, it } from "vitest";
import { AgentMessageSchema, AgentResponseSchema } from "../src/shared/protocol.js";

describe("protocol validation", () => {
  it("accepts well-formed messages", () => {
    expect(AgentMessageSchema.safeParse({ type: "PING", requestId: "r1" }).success).toBe(true);
    expect(AgentMessageSchema.safeParse({ type: "TASK", taskId: "t1", payload: { a: 1 } }).success).toBe(true);
  });

  it("rejects unknown types and missing fields", () => {
    expect(AgentMessageSchema.safeParse({ type: "REBOOT" }).success).toBe(false);
    expect(AgentMessageSchema.safeParse({ type: "PING" }).success).toBe(false);
    expect(AgentMessageSchema.safeParse({ type: "INIT", agentId: "not-a-uuid", name: "a", incarnation: 1, configuration: {} }).success).toBe(false);
    expect(AgentResponseSchema.safeParse({ type: "TASK_COMPLETED" }).success).toBe(false);
  });
});
