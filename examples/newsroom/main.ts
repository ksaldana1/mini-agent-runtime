/**
 * A tiny newsroom on the public API (npm run demo:newsroom). Each submission starts a workflow:
 * intake → edit (the editor crashes once; restarted by policy) → share → review (junior denied → senior).
 * Agents come online late on purpose: the listener and the inboxes hold the work meanwhile.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { createPlatform } from "mini-agent-runtime";
import editorDef from "./agents/editor.js";
import intakeDef from "./agents/intake.js";
import reviewerDef from "./agents/reviewer.js";

const [DATA, SUBMISSIONS, DESK] = ["examples/newsroom/data", "shared/documents/submissions", "shared/artifacts/desk"];
rmSync(DATA, { recursive: true, force: true }); // a fresh newsroom every run

await using platform = createPlatform({ dataDir: DATA, listeners: { intervalMs: 150, settleMs: 50 } });
const intake = platform.agent("intake", intakeDef, { autostart: false });
const editor = platform.agent("editor", editorDef, { autostart: false });
const junior = platform.agent("junior-reviewer", reviewerDef, { autostart: false });
const senior = platform.agent("senior-reviewer", reviewerDef, { autostart: false });
const staff = [intake, editor, junior, senior];
intake.grant(SUBMISSIONS, "read");
intake.grant(DESK, "write");
editor.grant(DESK, "read"); // nobody grants the reviewers anything: the editor shares per article

const publish = platform
  .workflow("publish-article")
  .input(z.object({ path: z.string(), name: z.string() }))
  .step("intake", intake.task("file"), ({ input }) => ({ from: input.path, to: `${DESK}/${input.name}.txt` }))
  .step("edit", editor.task("edit"), ({ input, steps }) => ({ path: steps.intake.path, name: input.name }))
  .step("share", editor.task("share"), ({ steps }) => ({ path: steps.edit.path, with: senior.id }))
  .step("review", [junior.task("review"), senior.task("review")], ({ input, steps }) => ({ path: steps.edit.path, name: input.name }))
  .build();
const submissions = platform.listen("submissions", { dir: SUBMISSIONS }).startWorkflow(publish, (file) => ({ path: file.path, name: basename(file.name, ".txt") }));

// Timeline. Agent directories are shown as ~name instead of agents/<id>.
const t0 = Date.now();
platform.events.onAny((name, e) => {
  if (!/^(agent\.|listener\.fired|task\.attempt|workflow\.transition)/.test(name) || ("event" in e && e.event === "workflow_started")) return;
  const who = "workflowId" in e && e.workflowId ? `[${publish.run(e.workflowId).input().name}]` : "agent" in e ? e.agent.name : "";
  const what = "detail" in e ? `${e.event}: ${e.detail}` : "error" in e ? (e.error ?? "") : "pid" in e ? `#${e.incarnation} pid ${e.pid} ${"state" in e ? e.state : ""}` : "delayMs" in e ? `in ${e.delayMs}ms` : "path" in e ? e.path : "";
  console.log(`+${((Date.now() - t0) / 1000).toFixed(2)}s  ${name.padEnd(20)} ${who.padEnd(16)} ${staff.reduce((s, a) => s.replaceAll(`agents/${a.id}`, `~${a.name}`), what)}`);
});
const denials: Record<string, number> = {};
platform.events.on("fs.denied", (e) => (denials[e.agent.name] = (denials[e.agent.name] ?? 0) + 1));

// Chaos: kill the editor in the middle of its first edit.
const stopChaos = platform.events.on("task.delivered", (e) => e.task === "edit" && (stopChaos(), setTimeout(() => process.kill(editor.runtime()!.pid, "SIGKILL"), 100)));

const filed = submissions.take(3); // before any file arrives

await platform.start(); // every agent is offline; the listener is already watching
mkdirSync(join(DATA, SUBMISSIONS), { recursive: true });
const ARTICLES = { "budget-vote": "council passes budget", "river-cleanup": "volunteers clear the river", "new-library": "library opens downtown" };
for (const [name, text] of Object.entries(ARTICLES)) writeFileSync(join(DATA, SUBMISSIONS, `${name}.txt`), text);
await sleep(400);
await Promise.all([intake.start(), editor.start()]);
await sleep(1_500);
await Promise.all([junior.start(), senior.start()]);
const runs = await filed;
const approved = await Promise.all(runs.map((run) => run.result()));

console.table(runs.map((run, i) => ({
  article: run.input().name,
  status: run.info().status,
  "edit attempts": run.task("edit")?.info().attempts,
  "reviewed by": run.step("review").agent?.name,
  approved: readFileSync(join(DATA, approved[i]!.path), "utf8").replaceAll("\n", " / "),
})));
console.table(staff.map((a) => ({
  agent: a.name,
  incarnations: a.history().length,
  "tasks done": a.inbox("completed").length,
  "tasks failed": a.inbox("failed").length,
  "fs denials": denials[a.name] ?? 0,
})));
