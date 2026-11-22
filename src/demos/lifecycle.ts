/**
 * Milestone 1 demo: one persistent agent identity, several runtime incarnations.
 *
 *   npm run demo:lifecycle
 *
 * Run it twice: the second run finds Agent A already in the database and
 * continues its incarnation count — identity survives platform restarts too.
 */
import { openDatabase } from "../platform/database.js";
import { AgentRegistry } from "../platform/identity.js";
import { Supervisor } from "../platform/supervisor.js";
import toy from "../agents/toy.js";

const db = openDatabase("data/platform.db");
const registry = new AgentRegistry(db);
const supervisor = new Supervisor(db, registry, { defaultModule: toy.moduleUrl, inheritStdio: true });
supervisor.recover(); // close out runtime records left open by a previous run

supervisor.on("runtime-exit", (r) =>
  console.log(`[supervisor] runtime exit: incarnation #${r.incarnation} pid=${r.pid} → ${r.state}`),
);

const step = (n: number, text: string) => console.log(`\n${n}. ${text}`);

try {
  step(1, "Create (or load) Agent A");
  const agent = registry.getByName("agent-a") ?? registry.create("agent-a", { role: "uppercaser" });
  console.log(`   agent id: ${agent.id}  (persistent, created ${agent.createdAt})`);

  step(2, "Start runtime via child_process.fork()");
  const first = await supervisor.start(agent.id);
  console.log(`   runtime: incarnation #${first.incarnation}, pid ${first.pid}`);

  step(3, "Send a structured TASK message");
  const result = await supervisor.sendTask(agent.id, "uppercase", { text: "hello from the platform" });
  console.log(`   result:`, result);

  step(4, "Terminate the runtime");
  await supervisor.stop(agent.id);

  step(5, "Restart with the same identity");
  const second = await supervisor.start(agent.id);
  const pong = await supervisor.ping(agent.id);
  console.log(`   runtime: incarnation #${second.incarnation}, pid ${second.pid}`);
  console.log(`   PONG says agentId=${pong.agentId} pid=${pong.pid}`);

  step(6, "Crash it (SIGKILL) and let the supervisor notice");
  process.kill(second.pid, "SIGKILL");
  await new Promise((r) => supervisor.once("runtime-exit", r));
  const third = await supervisor.start(agent.id);
  console.log(`   recovered as incarnation #${third.incarnation}, pid ${third.pid}`);

  console.log(`\nSame agent, different processes:`);
  console.table(supervisor.history(agent.id));
  console.log(`agent id unchanged across all incarnations: ${agent.id}`);
} finally {
  await supervisor.stopAll();
  db.close();
}
