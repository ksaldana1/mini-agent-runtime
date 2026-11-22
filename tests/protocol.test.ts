import { describe, expect, it } from "vitest";
import { AgentMessageSchema, AgentResponseSchema, TaskPayloadSchema } from "../src/shared/protocol.js";

describe("protocol validation", () => {
  it("accepts well-formed messages", () => {
    expect(AgentMessageSchema.safeParse({ type: "PING", requestId: "r1" }).success).toBe(true);
    expect(AgentMessageSchema.safeParse({ type: "TASK", taskId: "t1", task: "edit", input: { a: 1 }, attempt: 1 }).success).toBe(true);
    expect(
      AgentMessageSchema.safeParse({
        type: "INIT",
        agentId: "6f1c1a52-7d4e-4c3e-9b8a-1d2e3f405162",
        name: "a",
        incarnation: 1,
        configuration: {},
        module: "file:///agents/a.ts",
      }).success,
    ).toBe(true);
    expect(TaskPayloadSchema.safeParse({ task: "edit", input: { path: "x" } }).success).toBe(true);
  });

  it("rejects unknown types and missing fields", () => {
    expect(AgentMessageSchema.safeParse({ type: "REBOOT" }).success).toBe(false);
    expect(AgentMessageSchema.safeParse({ type: "PING" }).success).toBe(false);
    expect(AgentMessageSchema.safeParse({ type: "INIT", agentId: "not-a-uuid", name: "a", incarnation: 1, configuration: {} }).success).toBe(false);
    expect(AgentResponseSchema.safeParse({ type: "TASK_COMPLETED" }).success).toBe(false);
    // The pre-library TASK shape and payloads without a task name are gone.
    expect(AgentMessageSchema.safeParse({ type: "TASK", taskId: "t1", payload: { a: 1 } }).success).toBe(false);
    expect(TaskPayloadSchema.safeParse({ action: "transform" }).success).toBe(false);
  });
});

describe("protocol edge cases", () => {
  it("TASK_COMPLETED without a result (a handler returning undefined) is valid", () => {
    // process.send() serializes as JSON, which drops undefined properties.
    expect(AgentResponseSchema.safeParse(JSON.parse(JSON.stringify({ type: "TASK_COMPLETED", taskId: "t", result: undefined }))).success).toBe(true);
  });
});
