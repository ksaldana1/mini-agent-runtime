/**
 * Support desk on OpenAI (npm run demo:support). Needs OPENAI_API_KEY.
 * Each ticket dropped in the inbox starts a workflow:
 *   triage  (Decisions API: category / urgency / needs-human / has-secret in one call)
 *   respond (escalate risky tickets, otherwise draft a reply with the Responses API)
 *   check   (Decisions API as a judge: helpfulness score + policy-violation predicate)
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { createPlatform, type WorkflowHandle } from "mini-agent-runtime";
import qaDef from "./agents/qa.js";
import responderDef from "./agents/responder.js";
import triageDef from "./agents/triage.js";

// Load ./.env if present. Agent processes are forked from this one, so they inherit it.
try {
  process.loadEnvFile();
} catch {}
if (!process.env.OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY to run this example.");
  process.exit(1);
}

const DATA = "examples/support-desk/data";
const [INBOX, DRAFTS, ESCALATIONS] = ["shared/documents/inbox", "shared/artifacts/drafts", "shared/artifacts/escalations"];
rmSync(DATA, { recursive: true, force: true });

await using platform = createPlatform({ dataDir: DATA, listeners: { intervalMs: 150, settleMs: 50 } });
const triage = platform.agent("triage", triageDef);
const responder = platform.agent("responder", responderDef);
const qa = platform.agent("qa", qaDef);
triage.grant(INBOX, "read");
responder.grant(INBOX, "read");
responder.grant(DRAFTS, "write");
responder.grant(ESCALATIONS, "write");
qa.grant(INBOX, "read");
qa.grant(DRAFTS, "read");

const handle = platform
  .workflow("handle-ticket")
  .input(z.object({ path: z.string(), name: z.string() }))
  .step("triage", triage, "triage", ({ input }) => input)
  .step("respond", responder, "respond", ({ steps }) => ({ triage: steps.triage, draftsDir: DRAFTS, escalationsDir: ESCALATIONS }))
  .step("check", qa, "check", ({ input, steps }) => ({ ticketPath: input.path, action: steps.respond.action, path: steps.respond.path }))
  .build();
platform.listen("inbox", { dir: INBOX }).startWorkflow(handle, (file) => ({ path: file.path, name: basename(file.name, ".txt") }));

platform.events.on("task.delivered", (e) => console.log(`  ${e.agent.padEnd(10)} ${e.task} (attempt ${e.attempt})`));
platform.events.on("task.attempt-failed", (e) => console.log(`  ${e.agent.padEnd(10)} ${e.task} ✗ ${e.error}`));

const TICKETS: Record<string, string> = {
  "double-charge": "Hi, I was charged twice for my Pro plan this month (two $49 charges on the 3rd). Can you fix this?",
  "export-broken": "CSV export has been spinning forever since yesterday's update. I need this report for a board meeting in 2 hours!!",
  "dark-mode": "Would love a dark mode for the dashboard. My eyes thank you in advance.",
  "chargeback": "This is the third time your service went down. If I don't hear back today I'm filing a chargeback and talking to my lawyer.",
  "leaked-key": "My integration fails with 401. Here's my key so you can test: sk-live-9f8a7b6c5d4e3f2a1b0c. What am I doing wrong?",
};

const runs: WorkflowHandle<unknown>[] = [];
const allStarted = new Promise((done) =>
  platform.events.on("listener.fired", (e) => runs.push(platform.workflowRun(e.workflowId!)) === Object.keys(TICKETS).length && done(0)),
);

await platform.start();
mkdirSync(join(DATA, INBOX), { recursive: true });
for (const [name, text] of Object.entries(TICKETS)) writeFileSync(join(DATA, INBOX, `${name}.txt`), text);
await allStarted;
await Promise.allSettled(runs.map((run) => run.result()));

type Triage = Awaited<ReturnType<typeof triageDef.tasks.triage.run>>;
type Respond = Awaited<ReturnType<typeof responderDef.tasks.respond.run>>;
type Check = Awaited<ReturnType<typeof qaDef.tasks.check.run>>;
const outputOf = <T,>(run: WorkflowHandle<unknown>, i: number) => {
  const id = run.steps()[i]?.taskId;
  return id ? (platform.task(id).status().result as T | undefined) : undefined;
};

console.table(runs.map((run) => {
  const t = outputOf<Triage>(run, 0), r = outputOf<Respond>(run, 1), c = outputOf<Check>(run, 2);
  return {
    ticket: (run.status().input as { name: string }).name,
    status: run.status().status,
    category: t?.category ? `${t.category.value} (${t.category.confidence.toFixed(2)})` : "-",
    urgency: t?.urgency?.label ?? "-",
    "p(human)": t?.needsHuman?.toFixed(2) ?? "-",
    "p(secret)": t?.hasSecret?.toFixed(2) ?? "-",
    action: r?.action ?? "-",
    qa: c ? (c.helpfulness ? `${c.verdict} (${c.helpfulness.label})` : c.verdict) : "-",
  };
}));
console.log(`\nDrafts: ${join(DATA, DRAFTS)}\nEscalations: ${join(DATA, ESCALATIONS)}`);
