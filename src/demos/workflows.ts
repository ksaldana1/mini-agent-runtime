/**
 * Milestone 5 demo: a workflow survives an agent crash, a platform restart, and an
 * agent that can't do its step (reassigned to a fallback).
 *
 *   npm run demo:workflows
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { openDatabase } from "../platform/database.js";
import { Dispatcher } from "../platform/dispatcher.js";
import { AgentFilesystem } from "../platform/filesystem.js";
import { AgentRegistry } from "../platform/identity.js";
import { Inbox } from "../platform/inbox.js";
import { Supervisor } from "../platform/supervisor.js";
import { WorkflowService } from "../platform/workflows.js";

const DB_PATH = "data/platform.db";
const DATA = "data";

/** Everything a platform process holds. Booting twice = a platform restart. */
function boot() {
  const db = openDatabase(DB_PATH);
  const registry = new AgentRegistry(db);
  const fs = new AgentFilesystem(db, registry, DATA);
  const inbox = new Inbox(db, registry);
  const supervisor = new Supervisor(db, registry, { fsHandler: (id, req) => fs.handle(id, req) });
  const dispatcher = new Dispatcher(supervisor, inbox);
  const workflows = new WorkflowService(db, registry, inbox);
  workflows.on("transition", (e) => console.log(`   [workflow] ${e.event.padEnd(18)} ${e.detail}`));
  supervisor.on("runtime-exit", (r) => console.log(`   [supervisor] ${registry.get(r.agentId)?.name}#${r.incarnation} → ${r.state}`));
  // Startup recovery, explicitly: close stale runtime records, release stale claims,
  // then let workflows catch up on anything that settled while nobody was listening.
  supervisor.recover();
  dispatcher.recover();
  workflows.recover();
  return { db, registry, fs, inbox, supervisor, dispatcher, workflows };
}

async function until(cond: () => boolean, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(20);
  }
}
const step = (n: number, text: string) => console.log(`\n${n}. ${text}`);

const run = Date.now();
const docs = `shared/documents/wf-${run}`;
const artifacts = `shared/artifacts/wf-${run}`;

let p = boot();
const extractor = p.registry.create(`extractor-${run}`);
const reviewer = p.registry.create(`reviewer-${run}`);
const backup = p.registry.create(`backup-reviewer-${run}`);

mkdirSync(join(DATA, docs), { recursive: true });
writeFileSync(join(DATA, docs, "source.txt"), "draft: the numbers are in\n");
p.fs.grant(extractor.id, docs, "read");
p.fs.grant(extractor.id, artifacts, "write");
p.fs.grant(backup.id, artifacts, "read");
// Deliberately NOT granting `reviewer` access to artifacts: its step will fail.

let workflowId = "";
try {
  step(1, "Start a two-step workflow. Only the extractor is running.");
  await p.supervisor.start(extractor.id);
  const wf = p.workflows.start(
    {
      name: "review-document",
      steps: [
        {
          name: "extract",
          agents: [extractor.id],
          payload: { action: "transform", from: "{{input.source}}", to: `${artifacts}/extracted.txt`, delayMs: 600 },
        },
        {
          name: "review",
          agents: [reviewer.id, backup.id],
          payload: { action: "transform", from: "{{steps.extract.path}}", to: "~/reviewed.txt", suffix: "-- approved\n" },
        },
      ],
    },
    { source: `${docs}/source.txt` },
  );
  workflowId = wf.id;

  step(2, "Crash the extractor mid-step, then bring it back");
  await until(() => p.inbox.list(extractor.id, "claimed").length === 1);
  process.kill(p.supervisor.status(extractor.id)!.pid, "SIGKILL");
  await until(() => p.supervisor.status(extractor.id)?.state === "crashed");
  console.log(`   workflow still: ${p.workflows.get(wf.id)!.status}, step "extract" ${p.workflows.steps(wf.id)[0]!.status}`);
  await p.supervisor.start(extractor.id);
  await until(() => p.workflows.get(wf.id)!.currentStep === 1);

  step(3, "Platform restart while the review step waits for an offline agent");
  await p.supervisor.stopAll();
  p.db.close();
  console.log("   (platform stopped: every service object discarded)");
  p = boot();
  const resumed = p.workflows.get(wf.id)!;
  const reviewStep = p.workflows.steps(wf.id)[1]!;
  console.log(
    `   reloaded: ${resumed.status}, step ${resumed.currentStep} "${reviewStep.name}" ${reviewStep.status} → ${p.registry.get(reviewStep.agentId!)!.name}`,
  );

  step(4, "Reviewers come online. The primary lacks access, so the step is reassigned.");
  await p.supervisor.start(reviewer.id);
  await p.supervisor.start(backup.id);
  await until(() => p.workflows.get(wf.id)!.status !== "running");

  const done = p.workflows.get(wf.id)!;
  console.log(`\n   workflow ${done.status}; output: ${JSON.stringify(done.output).replaceAll(backup.id, "<backup>")}`);
  console.log(`   reviewed.txt: ${JSON.stringify(p.fs.handle(backup.id, { op: "read", path: "~/reviewed.txt" }))}`);

  step(5, "Durable history");
  console.table(
    p.workflows.steps(wf.id).map((s) => ({
      step: s.name,
      status: s.status,
      agent: p.registry.get(s.agentId!)?.name,
      assignment: s.assignment,
      attempts: p.inbox.get(s.inboxItemId!)?.attempts,
    })),
  );
} finally {
  await p.supervisor.stopAll();
  p.db.close();
}
