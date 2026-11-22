/**
 * Milestone 4 demo: a listener keeps working while its agent is offline, and even
 * while the platform itself is down.
 *
 *   npm run demo:listeners
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openDatabase } from "../platform/database.js";
import { Dispatcher } from "../platform/dispatcher.js";
import { AgentFilesystem } from "../platform/filesystem.js";
import { AgentRegistry } from "../platform/identity.js";
import { Inbox } from "../platform/inbox.js";
import { ListenerService } from "../platform/listeners.js";
import { Supervisor } from "../platform/supervisor.js";

const db = openDatabase("data/platform.db");
const registry = new AgentRegistry(db);
const fs = new AgentFilesystem(db, registry, "data");
const inbox = new Inbox(db, registry);
const supervisor = new Supervisor(db, registry, { fsHandler: (id, req) => fs.handle(id, req) });
const dispatcher = new Dispatcher(supervisor, inbox);

const LISTENER_OPTS = { intervalMs: 200, settleMs: 50 };
const makeListeners = () => {
  const svc = new ListenerService(db, registry, fs, inbox, LISTENER_OPTS);
  svc.on("fired", ({ event, path, item }) => console.log(`   [listener] ${event} ${tail(path)} → inbox item ${item.id.slice(0, 8)}`));
  svc.on("skipped", ({ reason }) => console.log(`   [listener] skipped: ${reason}`));
  return svc;
};

const run = Date.now();
const watched = `shared/documents/incoming-${run}`;
const tail = (p: string) => p.split("/").slice(-2).join("/");
const drop = (name: string, text: string) => {
  writeFileSync(join(fs.root, watched, name), text);
  console.log(`   (external) wrote ${name}`);
};
const step = (n: number, text: string) => console.log(`\n${n}. ${text}`);
async function until(cond: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}

const agent = registry.create(`indexer-${run}`);
const counts = () => {
  const all = inbox.list(agent.id);
  return `pending=${all.filter((i) => i.status === "pending").length} completed=${all.filter((i) => i.status === "completed").length}`;
};
let listeners = makeListeners();

try {
  mkdirSync(join(fs.root, watched), { recursive: true });
  drop("old.txt", "already here before the listener existed");

  step(1, `Grant the agent read on ${watched} and register a listener`);
  fs.grant(agent.id, watched, "read");
  const listener = listeners.register(agent.id, watched, {
    payloadTemplate: { action: "transform", from: "{{path}}", to: "~/processed/{{name}}" },
  });
  listeners.start();
  console.log(`   listener ${listener.id.slice(0, 8)}; agent runtime: ${supervisor.status(agent.id)?.state ?? "none"}`);

  step(2, "Files arrive while the agent is offline");
  drop("a.txt", "alpha");
  drop("b.txt", "bravo");
  await until(() => inbox.list(agent.id).length === 2);
  console.log(`   inbox: ${counts()}   (old.txt ignored: it predates the listener)`);

  step(3, "Platform goes down; a file arrives; platform comes back");
  listeners.stop();
  console.log("   (listener service stopped)");
  drop("c.txt", "charlie");
  await sleep(300);
  listeners = makeListeners(); // fresh instance: all state comes from SQLite
  listeners.start();
  await until(() => inbox.list(agent.id).length === 3);
  console.log(`   inbox: ${counts()}`);

  step(4, "Repeated scans don't create duplicate tasks");
  for (let i = 0; i < 5; i++) listeners.scanAll();
  console.log(`   after 5 extra scans: ${inbox.list(agent.id).length} items`);

  step(5, "Agent starts and works through everything it missed");
  await supervisor.start(agent.id);
  await until(() => dispatcher.isDrained(agent.id));
  console.log(`   inbox: ${counts()}`);
  console.log(`   ~/processed: ${JSON.stringify(fs.handle(agent.id, { op: "list", path: "~/processed" }))}`);
  console.log(`   ~/processed/c.txt: ${JSON.stringify(fs.handle(agent.id, { op: "read", path: "~/processed/c.txt" }))}`);

  step(6, "While the agent is running, new files are handled right away");
  drop("d.txt", "delta");
  await until(() => inbox.list(agent.id, "completed").length === 4);
  console.log(`   inbox: ${counts()}`);

  step(7, "Revoke the agent's read grant: the listener stops firing");
  fs.revoke(agent.id, watched);
  drop("e.txt", "echo");
  await sleep(400);
  console.log(`   inbox: ${counts()}   listener lastError: ${listeners.get(listener.id)!.lastError}`);
} finally {
  listeners.stop();
  await supervisor.stopAll();
  db.close();
}
