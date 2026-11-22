/**
 * Milestone 2 demo: the inbox belongs to the agent identity, not to any process.
 *
 *   npm run demo:inbox
 */
import { setTimeout as sleep } from "node:timers/promises";
import { openDatabase } from "../platform/database.js";
import { Dispatcher } from "../platform/dispatcher.js";
import { AgentRegistry } from "../platform/identity.js";
import { Inbox, type InboxItem } from "../platform/inbox.js";
import { Supervisor } from "../platform/supervisor.js";

const db = openDatabase("data/platform.db");
const registry = new AgentRegistry(db);
const supervisor = new Supervisor(db, registry);
const inbox = new Inbox(db, registry, { maxAttempts: 3 });
const dispatcher = new Dispatcher(supervisor, inbox);

const short = (id: string) => id.slice(0, 8);
const label = (item: InboxItem) => `${short(item.id)} ${JSON.stringify(item.payload)}`;

supervisor.on("runtime-exit", (r) => console.log(`   [supervisor] #${r.incarnation} pid=${r.pid} → ${r.state}`));
dispatcher.on("delivered", ({ item, incarnation }) =>
  console.log(`   [dispatch] → #${incarnation}  ${label(item)}  (attempt ${item.attempts})`),
);
dispatcher.on("completed", ({ item }) => console.log(`   [dispatch] ✓ ${short(item.id)} completed`));
dispatcher.on("failed", ({ item, error, willRetry }) =>
  console.log(`   [dispatch] ✗ ${short(item.id)} ${error} — ${willRetry ? "will retry" : "giving up"}`),
);
dispatcher.on("released", ({ incarnation, count }) =>
  console.log(`   [dispatch] ↺ released ${count} claim(s) held by dead incarnation #${incarnation}`),
);

async function until(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}

const step = (n: number, text: string) => console.log(`\n${n}. ${text}`);
const counts = (agentId: string) => {
  const all = inbox.list(agentId);
  const by = (s: string) => all.filter((i) => i.status === s).length;
  return `pending=${by("pending")} claimed=${by("claimed")} completed=${by("completed")} failed=${by("failed")}`;
};

try {
  if (dispatcher.recoveredOnStartup) console.log(`(recovered ${dispatcher.recoveredOnStartup} stale claim(s) from a previous run)`);

  // Fresh agent each run so the numbers are easy to follow.
  const agent = registry.create(`inbox-demo-${Date.now()}`);
  const sender = registry.getByName("agent-a") ?? registry.create("agent-a");

  step(1, `Agent ${short(agent.id)} is offline. Send it three messages.`);
  for (const text of ["one", "two", "three"]) inbox.send(agent.id, { text }, { senderAgentId: sender.id });
  console.log(`   inbox: ${counts(agent.id)}   (runtime: ${supervisor.status(agent.id)?.state ?? "none"})`);

  step(2, "Send a duplicate using the same idempotency key");
  const a = inbox.send(agent.id, { text: "four" }, { idempotencyKey: "order-42" });
  const b = inbox.send(agent.id, { text: "four (again)" }, { idempotencyKey: "order-42" });
  console.log(`   both sends returned item ${short(a.id)} / ${short(b.id)} → ${counts(agent.id)}`);

  step(3, "Start the agent: everything sent while offline gets delivered");
  await supervisor.start(agent.id);
  await until(() => dispatcher.isDrained(agent.id));
  console.log(`   inbox: ${counts(agent.id)}`);

  step(4, "Crash the runtime mid-task: the claim is released and redelivered to the next incarnation");
  const slow = inbox.send(agent.id, { text: "slow", delayMs: 500 });
  await until(() => inbox.get(slow.id)?.status === "claimed");
  process.kill(supervisor.status(agent.id)!.pid, "SIGKILL");
  await until(() => supervisor.status(agent.id)?.state === "crashed");
  console.log(`   while offline: ${short(slow.id)} is ${inbox.get(slow.id)!.status}`);
  await supervisor.start(agent.id);
  await until(() => inbox.get(slow.id)?.status === "completed");
  console.log(`   ${short(slow.id)} completed after ${inbox.get(slow.id)!.attempts} attempts`);

  step(5, "A message that always errors is retried, then marked failed");
  const poison = inbox.send(agent.id, { fail: true });
  await until(() => inbox.get(poison.id)?.status === "failed");
  console.log(`   ${short(poison.id)}: status=failed attempts=${inbox.get(poison.id)!.attempts}`);

  step(6, "Final inbox state");
  console.table(
    inbox.list(agent.id).map((i) => ({
      id: short(i.id),
      payload: JSON.stringify(i.payload),
      status: i.status,
      attempts: i.attempts,
      from: i.senderAgentId ? "agent-a" : "platform",
      result: (i.result as { output?: string } | null)?.output ?? "",
    })),
  );
} finally {
  await supervisor.stopAll();
  db.close();
}
