/**
 * Agent runtime entrypoint. Runs as its own OS process, forked by the supervisor.
 *
 * The process starts anonymous: it does not know which agent it is until the
 * platform sends INIT. It holds no persistent state — assume it can be killed
 * at any moment and replaced by a new incarnation of the same agent.
 */
import { AgentMessageSchema, type AgentMessage, type AgentResponse } from "../shared/protocol.js";

if (!process.send) {
  console.error("agent runtime must be started by the supervisor via child_process.fork()");
  process.exit(1);
}

interface Identity {
  agentId: string;
  name: string;
  incarnation: number;
}

let identity: Identity | undefined;

function reply(msg: AgentResponse): void {
  process.send!(msg);
}

function log(text: string): void {
  const who = identity ? `${identity.name}#${identity.incarnation}` : "uninitialised";
  console.log(`  [runtime ${who} pid=${process.pid}] ${text}`);
}

/** The "intelligence" of this toy agent. Swap this out later; the platform doesn't care. */
function executeTask(payload: unknown): unknown {
  const text = typeof payload === "object" && payload !== null && "text" in payload ? String(payload.text) : "";
  return { output: text.toUpperCase(), handledBy: identity!.agentId, pid: process.pid };
}

function handle(msg: AgentMessage): void {
  if (msg.type === "INIT") {
    identity = { agentId: msg.agentId, name: msg.name, incarnation: msg.incarnation };
    log(`received identity ${msg.agentId}`);
    reply({ type: "READY", agentId: msg.agentId, pid: process.pid });
    return;
  }

  if (!identity) {
    reply({ type: "ERROR", message: `received ${msg.type} before INIT` });
    return;
  }

  switch (msg.type) {
    case "PING":
      reply({ type: "PONG", requestId: msg.requestId, agentId: identity.agentId, pid: process.pid });
      return;
    case "TASK":
      log(`executing task ${msg.taskId}`);
      try {
        reply({ type: "TASK_COMPLETED", taskId: msg.taskId, result: executeTask(msg.payload) });
      } catch (err) {
        reply({ type: "ERROR", message: String(err), correlationId: msg.taskId });
      }
      return;
    case "SHUTDOWN":
      log("shutting down");
      process.exit(0);
  }
}

process.on("message", (raw) => {
  const parsed = AgentMessageSchema.safeParse(raw);
  if (!parsed.success) {
    reply({ type: "ERROR", message: `invalid message: ${parsed.error.message}` });
    return;
  }
  handle(parsed.data);
});

// If the supervisor goes away, don't linger as an orphan.
process.on("disconnect", () => process.exit(0));
