/**
 * Showcase: a tiny newsroom that exercises every part of the platform at once.
 *
 *   npm run demo:newsroom
 *
 *   submissions/ ──listener──▶ intake ──(glue)──▶ workflow per article:
 *                                                  edit    (editor; crashes once, restarted by policy)
 *                                                  share   (editor grants senior reviewer read)
 *                                                  review  (junior first: denied → reassigned to senior)
 *
 * Agents come online late on purpose: the listener and inbox hold the work meanwhile.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openDatabase } from "../platform/database.js";
import { Dispatcher } from "../platform/dispatcher.js";
import { AgentFilesystem } from "../platform/filesystem.js";
import { AgentRegistry, type Agent } from "../platform/identity.js";
import { Inbox } from "../platform/inbox.js";
import { ListenerService } from "../platform/listeners.js";
import { Supervisor } from "../platform/supervisor.js";
import { WorkflowService, type WorkflowDefinition } from "../platform/workflows.js";
import toy from "../agents/toy.js";

// ── Platform ────────────────────────────────────────────────────────────────

const db = openDatabase("data/platform.db");
const registry = new AgentRegistry(db);
const fs = new AgentFilesystem(db, registry, "data");
const inbox = new Inbox(db, registry);
const supervisor = new Supervisor(db, registry, { defaultModule: toy.moduleUrl, fsHandler: (id, req) => fs.handle(id, req) });
const dispatcher = new Dispatcher(supervisor, inbox);
const workflows = new WorkflowService(db, registry, inbox);
const listeners = new ListenerService(db, registry, fs, inbox, { intervalMs: 150, settleMs: 50 });
supervisor.recover();
dispatcher.recover();
workflows.recover();

// ── Logging ─────────────────────────────────────────────────────────────────

const t0 = Date.now();
const run = t0;
const nameOf = (id: string) => registry.get(id)?.name.replace(`-${run}`, "") ?? id.slice(0, 8);
const article = (p: string) => posix.basename(p, ".txt");
const log = (who: string, msg: string) => console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s  ${who.padEnd(10)} ${msg}`);

supervisor.on("runtime-ready", (r) => log("supervisor", `${nameOf(r.agentId)} up (incarnation #${r.incarnation}, pid ${r.pid})`));
supervisor.on("runtime-exit", (r) => log("supervisor", `${nameOf(r.agentId)} #${r.incarnation} ${r.state}`));
supervisor.on("restart-scheduled", (e) => log("supervisor", `restarting ${nameOf(e.agentId)} in ${e.delayMs}ms (policy)`));
listeners.on("fired", ({ path }) => log("listener", `new submission ${posix.basename(path)} → intake inbox`));
dispatcher.on("released", ({ agentId, count }) => log("inbox", `${count} claim(s) from dead ${nameOf(agentId)} back to pending`));
workflows.on("transition", (e) => {
  if (e.event === "workflow_started") return;
  const doc = workflows.get(e.workflowId)!.input as { name: string };
  const detail = e.detail
    .replaceAll(`-${run}`, "")
    .replace(/task \S+ failed: \w*Error: /, "")
    .replace(/agents\/[0-9a-f-]{36}\//g, "~editor/");
  log("workflow", `[${doc.name}] ${e.event}${detail ? `: ${detail}` : ""}`);
});

// ── Cast ────────────────────────────────────────────────────────────────────

const agent = (role: string): Agent => registry.create(`${role}-${run}`);
const intake = agent("intake");
const editor = agent("editor");
const junior = agent("junior-reviewer");
const senior = agent("senior-reviewer");
// Erlang-style supervision: crashed runtimes come back on their own.
for (const a of [intake, editor, junior, senior]) supervisor.setPolicy(a.id, { restart: "on-crash", backoffMs: 300 });

const submissions = `shared/documents/submissions-${run}`;
const desk = `shared/artifacts/desk-${run}`;
mkdirSync(join(fs.root, submissions), { recursive: true });

fs.grant(intake.id, submissions, "read");
fs.grant(intake.id, desk, "write");
fs.grant(editor.id, desk, "read");
// Nobody grants the reviewers anything up front: the editor shares per article.

// ── Wiring ──────────────────────────────────────────────────────────────────

listeners.register(intake.id, submissions, {
  payloadTemplate: { task: "transform", input: { from: "{{path}}", to: `${desk}/{{name}}` } },
});

const pipeline: WorkflowDefinition = {
  name: "publish-article",
  steps: [
    {
      name: "edit",
      agents: [editor.id],
      payload: { task: "transform", input: { from: "{{input.path}}", to: "~/edited/{{input.name}}.txt", suffix: "\n[edited]", delayMs: 250 } },
    },
    {
      name: "share",
      agents: [editor.id],
      payload: { task: "fs", input: { request: { op: "share", path: "{{steps.edit.path}}", agentId: senior.id, access: "read" } } },
    },
    {
      name: "review",
      agents: [junior.id, senior.id],
      payload: { task: "transform", input: { from: "{{steps.edit.path}}", to: "~/approved/{{input.name}}.txt", suffix: "\n[approved]" } },
    },
  ],
};

// Glue (demo-level, not a platform feature): finished intake → start the article's workflow.
dispatcher.on("completed", ({ item, result }) => {
  if (item.recipientAgentId !== intake.id) return;
  const path = (result as { path: string }).path;
  log("glue", `intake finished ${article(path)} → starting workflow`);
  workflows.start(pipeline, { path, name: article(path) });
});

// Chaos: kill the editor in the middle of its first edit.
let crashed = false;
dispatcher.on("delivered", ({ item }) => {
  if (crashed || item.recipientAgentId !== editor.id || (item.payload as { task?: string }).task !== "transform") return;
  crashed = true;
  setTimeout(() => {
    const pid = supervisor.status(editor.id)?.pid;
    if (pid) {
      log("chaos", `SIGKILL editor (pid ${pid}) mid-edit`);
      process.kill(pid, "SIGKILL");
    }
  }, 100);
});

// ── Run ─────────────────────────────────────────────────────────────────────

const ARTICLES = { "budget-vote": "council passes budget", "river-cleanup": "volunteers clear the river", "new-library": "library opens downtown" };

try {
  listeners.start();
  log("platform", "listener on submissions/; every agent is offline");

  for (const [name, text] of Object.entries(ARTICLES)) writeFileSync(join(fs.root, submissions, `${name}.txt`), text);
  await sleep(400);

  log("platform", "starting intake and editor");
  await supervisor.start(intake.id);
  await supervisor.start(editor.id);
  await sleep(1_500);

  log("platform", "starting reviewers");
  await supervisor.start(junior.id);
  await supervisor.start(senior.id);

  const deadline = Date.now() + 20_000;
  const mine = () => workflows.list().filter((w) => w.definition.steps[0]!.agents[0] === editor.id);
  while (!(mine().length === 3 && mine().every((w) => w.status !== "running"))) {
    if (Date.now() > deadline) throw new Error("timed out waiting for workflows");
    await sleep(50);
  }

  // ── Report ────────────────────────────────────────────────────────────────

  console.log("\nArticles");
  console.table(
    mine().map((w) => {
      const steps = workflows.steps(w.id);
      return {
        article: (w.input as { name: string }).name,
        status: w.status,
        "edit attempts": inbox.get(steps[0]!.inboxItemId!)!.attempts,
        "reviewed by": nameOf(steps[2]!.agentId!),
        approved: (fs.handle(senior.id, { op: "read", path: (w.output as { path: string }).path }) as string).replaceAll("\n", " / "),
      };
    }),
  );

  console.log("Agents");
  console.table(
    [intake, editor, junior, senior].map((a) => {
      const items = inbox.list(a.id);
      const denials = fs.auditLog(a.id).filter((e) => !e.allowed).length;
      return {
        agent: nameOf(a.id),
        incarnations: supervisor.history(a.id).length,
        "tasks done": items.filter((i) => i.status === "completed").length,
        "tasks failed": items.filter((i) => i.status === "failed").length,
        "fs denials": denials,
      };
    }),
  );
} finally {
  listeners.stop();
  await supervisor.close();
  db.close();
}
