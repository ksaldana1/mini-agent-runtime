/**
 * Wire protocol between the platform (supervisor) and an agent runtime process.
 *
 * Everything crossing the process boundary is validated with Zod on receipt.
 * TypeScript types are derived from the schemas so the two can't drift.
 */
import { z } from "zod";

// ── Filesystem service requests (runtime asks, platform decides) ───────────
//
// Paths are logical, relative to the platform data root, POSIX style:
//   "~/notes.txt"            → the calling agent's private directory
//   "agents/<id>/notes.txt"  → some agent's private directory
//   "shared/documents/x.md"  → shared area
// Requests never say *who* is asking: the platform knows that from the IPC channel.

export const FsRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("read"), path: z.string() }),
  z.object({ op: z.literal("write"), path: z.string(), content: z.string() }),
  z.object({ op: z.literal("list"), path: z.string() }),
  z.object({
    op: z.literal("grant"),
    path: z.string(),
    granteeAgentId: z.string().uuid(),
    access: z.enum(["read", "write"]),
  }),
  z.object({ op: z.literal("revoke"), path: z.string(), granteeAgentId: z.string().uuid() }),
]);
export type FsRequest = z.infer<typeof FsRequestSchema>;

// ── Inbox payloads ─────────────────────────────────────────────────────────
// What gets stored in the inbox and turned into a TASK on delivery.

export const TaskPayloadSchema = z.object({ task: z.string().min(1), input: z.unknown() });
export type TaskPayload = z.infer<typeof TaskPayloadSchema>;

// ── Platform → Runtime ─────────────────────────────────────────────────────

export const AgentMessageSchema = z.discriminatedUnion("type", [
  // Reply to a runtime's FS_REQUEST.
  z.object({
    type: z.literal("FS_RESPONSE"),
    requestId: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
    /** Machine-readable error code, e.g. "EACCES" for a permission denial. */
    code: z.string().optional(),
  }),
  // First message a runtime receives: tells the process which logical agent it is.
  z.object({
    type: z.literal("INIT"),
    agentId: z.string().uuid(),
    name: z.string(),
    incarnation: z.number().int().positive(),
    configuration: z.record(z.string(), z.unknown()),
    /** file: URL of the agent module; its default export is the agent definition. */
    module: z.string(),
  }),
  z.object({
    type: z.literal("TASK"),
    /** Inbox item id: stable across redeliveries. */
    taskId: z.string(),
    /** Name of the task in the agent definition. */
    task: z.string(),
    input: z.unknown(),
    /** Delivery attempt, starting at 1. */
    attempt: z.number().int().positive(),
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
// Mostly responses to platform messages, plus runtime-initiated service requests.

export const AgentResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("FS_REQUEST"),
    requestId: z.string(),
    request: FsRequestSchema,
  }),
  // Sent once INIT has been processed. Echoes identity so the supervisor can verify it.
  z.object({
    type: z.literal("READY"),
    agentId: z.string().uuid(),
    pid: z.number().int(),
  }),
  z.object({
    type: z.literal("TASK_COMPLETED"),
    taskId: z.string(),
    result: z.unknown().optional(), // absent when the handler returned undefined (IPC drops it)
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
    // false = retrying can't help (bad input, permission denied): fail the task now.
    retryable: z.boolean().optional(), // absent = true
  }),
]);
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
