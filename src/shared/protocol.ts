/**
 * Wire protocol between the platform (supervisor) and an agent runtime process.
 *
 * Everything crossing the process boundary is validated with Zod on receipt.
 * TypeScript types are derived from the schemas so the two can't drift.
 */
import { z } from "zod";

// ── Platform → Runtime ─────────────────────────────────────────────────────

export const AgentMessageSchema = z.discriminatedUnion("type", [
  // First message a runtime receives: tells the process which logical agent it is.
  z.object({
    type: z.literal("INIT"),
    agentId: z.string().uuid(),
    name: z.string(),
    incarnation: z.number().int().positive(),
    configuration: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("TASK"),
    taskId: z.string(),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal("PING"),
    requestId: z.string(),
  }),
  z.object({
    type: z.literal("SHUTDOWN"),
  }),
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

// ── Runtime → Platform ─────────────────────────────────────────────────────

export const AgentResponseSchema = z.discriminatedUnion("type", [
  // Sent once INIT has been processed. Echoes identity so the supervisor can verify it.
  z.object({
    type: z.literal("READY"),
    agentId: z.string().uuid(),
    pid: z.number().int(),
  }),
  z.object({
    type: z.literal("TASK_COMPLETED"),
    taskId: z.string(),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("PONG"),
    requestId: z.string(),
    agentId: z.string().uuid(),
    pid: z.number().int(),
  }),
  z.object({
    type: z.literal("ERROR"),
    message: z.string(),
    // Correlation id (taskId / requestId) when the error relates to a specific request.
    correlationId: z.string().optional(),
  }),
]);
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
