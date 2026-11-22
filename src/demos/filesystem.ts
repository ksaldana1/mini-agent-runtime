/**
 * Milestone 3 demo: private dirs, a shared area nobody gets by default,
 * and sharing one artifact without handing over the whole directory.
 *
 *   npm run demo:fs
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../platform/database.js";
import { AgentFilesystem } from "../platform/filesystem.js";
import { AgentRegistry } from "../platform/identity.js";
import { Supervisor } from "../platform/supervisor.js";
import toy from "../agents/toy.js";
import type { TaskInput } from "../lib/agent.js";

type ToyFsRequest = TaskInput<typeof toy, "fs">["request"];

const db = openDatabase("data/platform.db");
const registry = new AgentRegistry(db);
const fs = new AgentFilesystem(db, registry, "data");
const supervisor = new Supervisor(db, registry, { defaultModule: toy.moduleUrl, fsHandler: (agentId, req) => fs.handle(agentId, req) });
supervisor.recover();

const run = Date.now();
const alice = registry.create(`alice-${run}`);
const bob = registry.create(`bob-${run}`);
const names: Record<string, string> = { [alice.id]: "alice", [bob.id]: "bob" };
const short = (p: string) => p.replaceAll(alice.id, "<alice>").replaceAll(bob.id, "<bob>");

/** Ask an agent's runtime to do something; print whether the platform allowed it. */
async function attempt(agentId: string, what: string, [task, input]: [string, unknown]): Promise<void> {
  try {
    const result = await supervisor.sendTask(agentId, task, input);
    const shown = typeof result === "string" ? JSON.stringify(result) : JSON.stringify(result, (_k, v) => (typeof v === "string" ? short(v) : v));
    console.log(`   ✓ ${names[agentId]}: ${what}\n       → ${shown}`);
  } catch (err) {
    const msg = short((err as Error).message.replace(/^\w*Error: /, ""));
    console.log(`   ✗ ${names[agentId]}: ${what}\n       → ${msg}`);
  }
}
const fsTask = (request: ToyFsRequest): [string, unknown] => ["fs", { request }];
const step = (n: number, text: string) => console.log(`\n${n}. ${text}`);

try {
  await supervisor.start(alice.id);
  await supervisor.start(bob.id);

  const brief = `shared/documents/brief-${run}.txt`;
  writeFileSync(join(fs.root, brief), "quarterly numbers look fine\n");
  const report = `agents/${alice.id}/report.txt`;

  step(1, "Private directories: each agent owns its own");
  await attempt(alice.id, "write ~/notes.txt", fsTask({ op: "write", path: "~/notes.txt", content: "alice's private notes" }));
  await attempt(bob.id, "read alice's notes", fsTask({ op: "read", path: `agents/${alice.id}/notes.txt` }));

  step(2, "The shared area is not open by default");
  await attempt(alice.id, `read ${brief}`, fsTask({ op: "read", path: brief }));

  step(3, "Platform grants alice read on shared/documents; she produces a report");
  fs.grant(alice.id, "shared/documents", "read");
  await attempt(alice.id, `transform ${brief} → ~/report.txt`, ["transform", { from: brief, to: "~/report.txt" }]);
  await attempt(alice.id, "write into shared/documents", fsTask({ op: "write", path: "shared/documents/x.txt", content: "x" }));

  step(4, "Bob can't see the report until alice shares it");
  await attempt(bob.id, "read alice's report", fsTask({ op: "read", path: report }));
  await attempt(alice.id, "grant bob read on ~/report.txt", fsTask({ op: "share", path: "~/report.txt", agentId: bob.id, access: "read" }));
  await attempt(bob.id, "read alice's report", fsTask({ op: "read", path: report }));

  step(5, "...and the grant covers exactly that file, read-only");
  await attempt(bob.id, "read alice's notes", fsTask({ op: "read", path: `agents/${alice.id}/notes.txt` }));
  await attempt(bob.id, "list alice's directory", fsTask({ op: "list", path: `agents/${alice.id}` }));
  await attempt(bob.id, "overwrite alice's report", fsTask({ op: "write", path: report, content: "bob was here" }));
  await attempt(bob.id, "re-share alice's report with himself as write", fsTask({ op: "share", path: report, agentId: bob.id, access: "write" }));

  step(6, "Path tricks are normalized or rejected");
  await attempt(bob.id, "read ~/../<alice>/notes.txt", fsTask({ op: "read", path: `~/../${alice.id}/notes.txt` }));
  await attempt(bob.id, "read ../platform.db", fsTask({ op: "read", path: "../platform.db" }));
  await attempt(bob.id, "read /etc/passwd", fsTask({ op: "read", path: "/etc/passwd" }));

  step(7, "Alice revokes; bob loses access");
  await attempt(alice.id, "revoke bob on ~/report.txt", fsTask({ op: "revoke", path: "~/report.txt", agentId: bob.id }));
  await attempt(bob.id, "read alice's report", fsTask({ op: "read", path: report }));

  step(8, "Audit log (every decision the platform made)");
  console.table(
    fs.auditLog().filter((e) => names[e.agentId]).map((e) => ({
      agent: names[e.agentId],
      op: e.op,
      path: short(e.path),
      allowed: e.allowed ? "✓" : "✗",
      reason: short(e.reason),
    })),
  );
} finally {
  await supervisor.stopAll();
  db.close();
}
