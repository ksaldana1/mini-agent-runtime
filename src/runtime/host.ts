/**
 * Generic agent runtime host. Runs as its own OS process, forked by the supervisor.
 *
 * The process starts anonymous. INIT tells it which agent it is *and* which module
 * holds that agent's code; the host imports the module, checks that its default export
 * is an agent definition, and only then replies READY. Every TASK names one of the
 * definition's tasks; the host validates the input with that task's schema and runs it.
 *
 * It holds no persistent state: assume it can be killed at any moment and replaced by
 * a new incarnation of the same agent.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isAgentDefinition, type AgentContext, type AgentDefinition } from "../lib/agent.js";
import { FsDeniedError, isRetryable } from "../lib/errors.js";
import { AgentMessageSchema, type AgentMessage, type AgentResponse, type FsRequest } from "../shared/protocol.js";

if (!process.send) {
  console.error("agent runtime host must be started by the supervisor via child_process.fork()");
  process.exit(1);
}

interface Identity {
  agentId: string;
  name: string;
  incarnation: number;
}

let identity: Identity | undefined;
let definition: AgentDefinition | undefined;
/** Parsed by the definition's config schema at INIT (undefined without a schema). */
let config: unknown;

function reply(msg: AgentResponse): void {
  process.send!(msg);
}

function log(text: string): void {
  const who = identity ? `${identity.name}#${identity.incarnation}` : "uninitialised";
  console.log(`  [runtime ${who} pid=${process.pid}] ${text}`);
}

// ── Platform filesystem client ──────────────────────────────────────────────
// The runtime never touches node:fs for platform data; it asks the platform.

const fsPending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function platformFs(request: FsRequest): Promise<unknown> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    fsPending.set(requestId, { resolve, reject });
    reply({ type: "FS_REQUEST", requestId, request });
  });
}

const fsClient: AgentContext["fs"] = {
  read: async (path) => (await platformFs({ op: "read", path })) as string,
  write: async (path, content) => (await platformFs({ op: "write", path, content })) as { path: string; bytes: number },
  list: async (path) => (await platformFs({ op: "list", path })) as string[],
  share: async (path, agentId, access) => void (await platformFs({ op: "grant", path, granteeAgentId: agentId, access })),
  revoke: async (path, agentId) => void (await platformFs({ op: "revoke", path, granteeAgentId: agentId })),
};

// ── Lifecycle ───────────────────────────────────────────────────────────────

async function init(msg: Extract<AgentMessage, { type: "INIT" }>): Promise<void> {
  try {
    const mod = (await import(msg.module)) as { default?: unknown };
    if (!isAgentDefinition(mod.default)) {
      throw new Error(`${msg.module}: default export is not an agent definition (export default defineAgent(...))`);
    }
    definition = mod.default;
    if (definition.config) {
      // Validated in the platform process too; this catches a config stored by another
      // version of the code. Like a bad module: the start is refused, not retried.
      const parsed = definition.config.safeParse(msg.configuration);
      if (!parsed.success) throw new Error(`invalid config for agent ${msg.name}: ${z.prettifyError(parsed.error)}`);
      config = parsed.data;
    }
  } catch (err) {
    reply({ type: "ERROR", message: (err as Error).message ?? String(err), correlationId: "__init__", retryable: false });
    return;
  }
  identity = { agentId: msg.agentId, name: msg.name, incarnation: msg.incarnation };
  log(`received identity ${msg.agentId}, loaded ${Object.keys(definition.tasks).length} task(s)`);
  reply({ type: "READY", agentId: msg.agentId, pid: process.pid });
}

async function runTask(msg: Extract<AgentMessage, { type: "TASK" }>): Promise<unknown> {
  const tasks = definition!.tasks;
  const task = Object.hasOwn(tasks, msg.task) ? tasks[msg.task] : undefined;
  if (!task) {
    throw Object.assign(new Error(`unknown task "${msg.task}" (this agent has: ${Object.keys(tasks).join(", ")})`), {
      retryable: false,
    });
  }
  const input = task.input.safeParse(msg.input);
  if (!input.success) {
    throw Object.assign(new Error(`invalid input for task "${msg.task}": ${z.prettifyError(input.error)}`), { retryable: false });
  }
  const ctx: AgentContext<unknown> = {
    config,
    agent: { id: identity!.agentId, name: identity!.name, incarnation: identity!.incarnation },
    taskId: msg.taskId,
    attempt: msg.attempt,
    log,
    fs: fsClient,
  };
  return task.run(input.data as never, ctx as AgentContext<never>);
}

function handle(msg: AgentMessage): void {
  if (msg.type === "FS_RESPONSE") {
    const pending = fsPending.get(msg.requestId);
    fsPending.delete(msg.requestId);
    if (msg.ok) pending?.resolve(msg.result);
    // A permission denial won't change on retry (grants are managed out of band).
    else pending?.reject(msg.code === "EACCES" ? new FsDeniedError(msg.error ?? "EACCES") : new Error(msg.error));
    return;
  }

  if (msg.type === "INIT") {
    void init(msg);
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
      log(`executing ${msg.task} (task ${msg.taskId}, attempt ${msg.attempt})`);
      runTask(msg).then(
        (result) => reply({ type: "TASK_COMPLETED", taskId: msg.taskId, result }),
        (err) => reply({ type: "ERROR", message: String(err), correlationId: msg.taskId, retryable: isRetryable(err) }),
      );
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
