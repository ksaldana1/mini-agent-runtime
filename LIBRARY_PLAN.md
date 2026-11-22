# Library-ification Plan

> **Status (2026-11-22):** plan and all design decisions (D1–D8) approved. **Phases 0–4 done (4.3 packaging, optional, not started); Phase 4 awaiting review.** Read [Handoff notes](#handoff-notes-for-a-fresh-session) first.

Turn the platform from "seven classes you wire by hand" into a small library with a typed,
awaitable API. The current classes in `src/platform/` stay as the internal **kernel**. The new
public API is a thin layer in `src/lib/` on top of them.

**Acceptance test for the whole plan:** `src/demos/newsroom.ts` (≈230 lines, with polling loops,
UUIDs, stringly-typed payloads, and glue code) is rewritten against the library in roughly a
third of the lines, with no polling, no UUIDs, no `{{...}}` templates, and no glue.

---

## Target API (sketch)

```ts
// agents/editor.ts: runs in the child process; also imported (for types) by the parent
export default defineAgent(import.meta.url, {
  tasks: {
    edit: {
      input: z.object({ path: z.string(), name: z.string() }),
      async run({ path, name }, ctx) {
        const text = await ctx.fs.read(path);
        return ctx.fs.write(`~/edited/${name}.txt`, text.toUpperCase());
      },
    },
  },
});
```

```ts
// main.ts: the platform process
import editorDef from "./agents/editor.ts";

const platform = createPlatform({ dataDir: "data" });

const editor = platform.agent("editor", editorDef, { restart: "on-crash" });
editor.grant("shared/artifacts/desk", "read");

const publish = platform.workflow("publish-article")
  .input(z.object({ path: z.string(), name: z.string() }))
  .step("edit", editor, "edit", ({ input }) => input)
  .step("review", [junior, senior], "review", ({ steps }) => ({ path: steps.edit.path }))
  .build();

platform.listen("submissions", { dir: "shared/documents/submissions" })
  .startWorkflow(publish, ({ path }) => ({ path, name: basename(path) }));

await platform.start();                       // recovery, listeners, autostart agents
const task = editor.send("edit", { path, name }); // typed against editorDef
const result = await task.result();           // no polling
await platform.close();
```

---

## Design decisions

These shape every phase. **All decisions below were approved on 2026-11-22. Treat them as settled;** don't reopen them during implementation without asking.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 ✓ | Workflow style: replay (Temporal-like `async` function re-run from the top after a restart) vs **declarative step list** | **Step list built with a typed builder.** Each step's input is computed by a function at assignment time, and the computed payload is stored in the inbox. | Nothing is replayed, so workflow code doesn't have to behave identically on every run, and there is no replay versioning problem. Covers everything the demos need. |
| D2 ✓ | How the parent knows which file to fork for an agent | **`defineAgent(import.meta.url, {...})`**: the definition records its own module URL. The parent imports the same module to get types and the URL. | Types flow automatically with no `import type` plumbing. Cost: agent modules must be side-effect free at the top level, because they're loaded in both processes. |
| D3 ✓ | Where agent behavior lives | **In code, supplied on every boot** (`platform.agent(name, def)`). The DB keeps identity and state only. | Same rule as workflows and listeners: *code defines behavior, SQLite holds state.* An agent in the DB with no definition registered this boot can't be started, and that is reported clearly. |
| D4 ✓ | Task protocol | **`TASK { taskId, task, input, attempt }`**, and the inbox payload becomes `{ task, input }`. The current toy behaviors become a regular agent module (`src/agents/toy.ts`). Existing demos and tests move to the new payload shape. | One protocol, not two. The migration is mechanical. |
| D5 ✓ | When recovery runs | **Explicitly, in `platform.start()`**, not in constructors. | Code-defined workflows and listeners must be registered *before* recovery runs, or recovery can't evaluate them. |
| D6 ✓ | Public sending path | **Only durable, inbox-based `send()`.** The direct RPC in `supervisor.sendTask` stays internal (the dispatcher uses it). | One delivery semantic to explain: at-least-once, durable. |
| D7 ✓ | Packaging and build | **Defer.** Use `package.json` `exports` pointing at TypeScript source, run through `tsx`, until the API settles. | A build step (`dist/`, forking compiled JS) is only needed for consumers outside the repo. |
| D8 ✓ | Schema changes | **Small migrations based on `PRAGMA user_version`.** | Several phases add columns. `CREATE TABLE IF NOT EXISTS` can't handle that, and wiping `data/` stops being acceptable once there's a library. |

---

## Phase 0: Kernel groundwork (no public API yet)

These are internal changes that the later phases depend on. Every existing test and demo must still pass after each step.

### ☑ 0.1 Schema migrations · S
- `database.ts`: replace the one big `CREATE … IF NOT EXISTS` block with an ordered list of migrations applied according to `PRAGMA user_version`. Move the tables that services create themselves (`fs_*`, `listeners`, `workflow_*`) into that list, so the whole schema lives in one place.
- **Done when:** a fresh DB and the existing `data/platform.db` both open cleanly, and a test confirms migrations are idempotent.

### ☑ 0.2 Task settlement events · S
- `Inbox` emits `"settled"` (item, final status) from `complete`, from `fail` when the attempts run out, and from `releaseClaims` / `releaseAllClaims` for each item they mark `failed`. Emitted after commit, like `"enqueued"`.
- Add `inbox.waitFor(itemId): Promise<InboxItem>`. It reads the DB first and resolves right away if the item has already settled; otherwise it waits for `"settled"`. This is the basis for `TaskHandle.result()`.
- `WorkflowService` subscribes to `"settled"` instead of the dispatcher's `completed`/`failed`/`released` events. This removes the `reconcileAll()`-on-every-release workaround.
- **Done when:** there are tests for settlement through each of the three paths, and for `waitFor` on an item that was already settled.

### ☑ 0.3 Permanent vs retryable errors · S
- Protocol: `ERROR` gains `retryable: boolean` (default `true`).
- `Inbox.fail(id, incarnation, error, { retryable })` marks the item `failed` immediately when `retryable` is false. The dispatcher passes the flag through.
- Runtime: input-validation failures and `EACCES` are non-retryable.
- **Done when:** in `demo:newsroom`, the junior reviewer's denials take 1 attempt instead of 3. Fixes a known limitation.

### ☑ 0.4 Explicit recovery · S
- Remove recovery from constructors and add `supervisor.recover()`, `dispatcher.recover()`, and `workflows.recover()`, each returning what it recovered.
- Update demos and tests to call them. That's temporary; Phase 2's `platform.start()` takes over.
- **Done when:** the existing restart-recovery tests pass using explicit `recover()` calls.

### ☑ 0.5 Supervisor restart policy · M
- `supervisor.setPolicy(agentId, { restart: "never" | "on-crash", maxRestarts, windowMs, backoffMs })`. Only crashes are restarted, never deliberate stops. Once the cap is hit, the runtime is left in a `given-up` state and an event is emitted.
- **Done when:** there are tests for a crash being restarted, exponential backoff, the restart cap within a time window, and stop/close not triggering a restart. The newsroom's hand-written restart code can then be deleted. Fixes a known limitation.

---

## Phase 1: `defineAgent` and the generic runtime host

### ☑ 1.1 Agent definition types · S
- `src/lib/agent.ts`: `defineAgent(moduleUrl, { tasks })`, with `TaskDef<In, Out> = { input: ZodType<In>; run(input: In, ctx: AgentContext): Promise<Out> | Out }`.
- Exported helper types: `TaskNames<D>`, `TaskInput<D, K>`, `TaskOutput<D, K>`.
- **Done when:** type-level tests (`expectTypeOf`) show that input and output types are inferred from the definition.

### ☑ 1.2 Runtime host · M
- New entry point `src/runtime/host.ts` replaces `agent.ts`. `INIT` gains `module` (a file URL). The host dynamically imports the module, checks that its default export is an agent definition, and replies `READY` (or an `ERROR` that the supervisor reports as a failed start).
- On `TASK`: look up the task by name. An unknown name is a non-retryable error. Then validate `input` with the task's Zod schema (failure is non-retryable), run the handler with `ctx`, and reply with the result.
- **Done when:** there are tests for a happy path, an unknown task, invalid input, a handler that throws, and a module with a bad default export.

### ☑ 1.3 `AgentContext` · S
- `ctx.agent` (`{ id, name, incarnation }`), `ctx.taskId` (to use as an idempotency key), `ctx.attempt`, and `ctx.log`.
- `ctx.fs`: `read`, `write`, `list`, `share(path, agentId, access)`, and `revoke`. These are typed wrappers around `FS_REQUEST`, which throw `FsDeniedError` with `retryable: false`.
- **Done when:** the filesystem-over-IPC tests are rewritten against `ctx.fs`.

### ☑ 1.4 Port the toy agent; migrate payloads · M
- `src/agents/toy.ts` reimplements `uppercase`, `transform`, and `fs` as tasks, so the supervisor no longer has a hard-coded default.
- Mechanically migrate every demo and test payload from `{ action, ... }` to `{ task, input }`, including listener templates and workflow step payloads.
- **Done when:** all 63+ tests and all six demos pass with the old `agent.ts` deleted.

---

## Phase 2: `createPlatform` and handles

### ☑ 2.1 `createPlatform` · M
- `src/lib/platform.ts`: `createPlatform({ dataDir, dbPath?, inbox: { maxAttempts }, listeners: { intervalMs, settleMs } })` wires the kernel in the right order and passes `fsHandler` to the supervisor.
- Lifecycle:
  - `createPlatform` only wires the services.
  - The user registers agents, workflows, and listeners.
  - `await platform.start()` runs recovery (D5), starts listener scanning, and starts agents marked `autostart`.
  - `await platform.close()` stops listeners, stops runtimes, and closes the DB. `Symbol.asyncDispose` lets `await using` work.
- Calling `agent()`, `workflow()`, or `listen()` after `start()` is allowed. Each new registration is reconciled right away.
- **Done when:** a test boots, registers, starts, and closes a platform, and a second `createPlatform` on the same `dataDir` recovers the first one's state.

### ☑ 2.2 `AgentHandle` · M
- `platform.agent(name, def, { restart?, autostart?, configuration? })` gets or creates the agent by **name** and returns a typed `AgentHandle<D>`: `id`, `name`, `start()`, `stop()`, `restart()`, `status()`, `history()`, `grant(path, access)`, `revoke(path)`, `inbox()`.
- Registering the same name twice in one process is an error. A DB agent with no registered definition can't be started, and the error says why (D3).
- **Done when:** a test shows that identity is stable across two platform boots in the same `dataDir`.

### ☑ 2.3 Typed `send` and `TaskHandle` · M
- `agent.send(task, input, { idempotencyKey? })` validates `input` with the task's schema on the **parent** side too, failing fast before anything is enqueued. It returns a `TaskHandle<Out>` with `id`, `status()`, and `result()`.
  - `result()` rejects with `TaskFailedError` (carrying `lastError` and `attempts`) if the task fails.
- `platform.task(id)` reattaches to a task created by an earlier process.
- **Done when:** there are tests for result after success, rejection after a non-retryable failure, `result()` across a crash and redelivery, and reattaching after a restart. Type tests cover the task name and the input and output types.

### ☑ 2.4 Unified events · S
- `platform.events`: one typed emitter (`agent.ready`, `agent.exited`, `agent.gave-up`, `task.enqueued`, `task.delivered`, `task.settled`, `listener.fired`, `workflow.transition`, `fs.denied`) that re-emits the kernel events with agent **names** included.
- **Done when:** the newsroom's timeline logger is about 10 lines long.

### ☑ 2.5 Public entry point · S
- `src/lib/index.ts` exports `createPlatform`, `defineAgent`, error classes, and public types, but no kernel classes. In `package.json`, `"exports": { ".": "./src/lib/index.ts" }`.
- **Done when:** a test imports only from the public entry point.

---

## Phase 3: Workflows and listeners defined in code

### ☑ 3.1 Workflow builder · M
- `platform.workflow(name).input(schema).step(stepName, agentOrCandidates, task, (ctx) => input).build()` returns a `WorkflowRef<In, Out>`.
  - Each `.step` adds the task's output type to `ctx.steps.<stepName>`, so later steps see typed results.
  - The last step's output becomes the workflow's output.
- Definitions live in an in-memory registry keyed by name (D1, D3).
- **Done when:** type tests show step results flow into later steps.

### ☑ 3.2 `WorkflowService` uses registered definitions · M
- The DB keeps `name`, a **fingerprint** (a hash of the step names, tasks, and candidate agent names), `input`, and step progress. It no longer stores the definition JSON.
- `assign` calls the step's input function and stores the computed payload in the inbox, as it does now.
- Recovery and reconcile:
  - A running workflow whose definition isn't registered is skipped, with a warning event.
  - If the fingerprint doesn't match, the workflow is marked `failed` with `definition changed`. That's simple and explicit; resuming across definition changes can come later.
- **Done when:** the existing workflow tests are ported, plus tests for an unregistered definition and a fingerprint mismatch.

### ☑ 3.3 `startWorkflow` and `WorkflowHandle` · S
- `platform.startWorkflow(ref, input, { idempotencyKey? })` returns a `WorkflowHandle<Out>` with `id`, `status()`, `steps()`, `events()`, and `result()`. Add a unique `workflows.idempotency_key` column (migration).
- **Done when:** there are tests for result, duplicate starts with the same key, and reattaching after a restart.

### ☑ 3.4 Named listeners with code targets · M
- `platform.listen(name, { dir, events })` returns a builder with two targets:
  - `.send(agent, task, (event) => input)`: the target agent must have read access to `dir` (the current rule).
  - `.startWorkflow(ref, (event) => input)`: a **platform-owned** listener with no permission check, which needs a migration to make `target_agent_id` nullable. The workflow's idempotency key is `listener:<name>:<event>:<path>:<mtime>`.
- Registration is an upsert by name, and the snapshot is kept. If `dir` changes, the snapshot is reset to the directory's current contents.
- **Done when:** there are tests for both target kinds, re-registration across boots not refiring, and the listener→workflow chain surviving a restart between the listener firing and the workflow starting. That last one is the failure case the newsroom glue had.

---

## Phase 4: Acceptance and docs

### ☑ 4.1 Rewrite the newsroom · M
- Move it to `examples/newsroom/` with `main.ts` and `agents/{intake,editor,reviewer}.ts`, using only the public API.
- **Done when:**
  - The same timeline and outcome as today, except junior denials are now 1 attempt each, thanks to 0.3.
  - No `until`/polling loops, no UUIDs in user code, no templates, no glue, no hand-written restart policy.
  - Roughly a third of the current line count.

### ☑ 4.2 Docs · S
- README: a "Library quickstart" section at the top, with the milestone demos described as tours of the internals.
- `ARCHITECTURE.md`: a new "Layering" section (public API ↔ kernel ↔ runtime host). Update §10: remove the items fixed here (restart policy, permanent errors, listener→workflow glue, polling) and add new ones (fingerprint mismatch fails the workflow, agent modules must be side-effect free).

### ☐ 4.3 Packaging (optional; see D7) · M
- Build to `dist/` with `tsc`. The supervisor forks `dist/runtime/host.js`, and adds `--import tsx` only when the agent module is `.ts`.
- **Done when:** a scratch project outside the repo can `npm install` the package by path and run a two-agent example.

---

## Out of scope

Each of these stays in `ARCHITECTURE.md` §10:

- Agent-to-agent messaging from inside a handler (`ctx.send`) and the "who may send to whom" check. The handle API makes this easy to add next.
- Step deadlines and timeouts.
- Replay-style workflows (see D1).
- OS-enforced isolation.
- Branching or parallel workflow steps.

## Sequencing and checkpoints

```text
Phase 0 ──▶ Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4
(0.1–0.5     (needs 0.3,  (needs 0.2,   (needs 0.1,   (needs all)
 independent  0.4)         0.4, 0.5)     2.x)
 of each other)
```

After each phase:
1. Every existing test passes, and the phase adds its own tests.
2. Every demo still runs.
3. Stop for review before starting the next phase, the same rhythm as the original milestones.

Rough size: Phase 0 ≈ 1 milestone's worth, Phases 1–3 ≈ 1–1.5 each, Phase 4 ≈ 0.5 (plus 4.3 if wanted).

---

## Handoff notes for a fresh session

Read these before touching code.

**Read first:** this file, then `ARCHITECTURE.md` (the original brief, plus §10 for known limitations), then `README.md` (how each subsystem works and why). The kernel code is in `src/platform/`. The best end-to-end example is `examples/newsroom/main.ts` (public API); `src/demos/*.ts` show the kernel wired by hand.

**Where things stand:**
- Milestones 1–5 from `ARCHITECTURE.md` are complete, and so is Phases 0–4: 147 tests passing, `tsc` clean, six demos working (`npm run demo:newsroom` plus one per milestone).
- Phase 0 notes for later phases:
  - Supervisor events added: `restart-scheduled`, `gave-up`, `restart-failed`. Phase 2.4's `agent.gave-up` maps to `gave-up`.
  - `TaskError` (in `supervisor.ts`) carries `retryable`. The runtime marks `EACCES` (the `code` field on `FS_RESPONSE`) and invalid toy payloads as permanent. Phase 1.2's host should do the same for unknown tasks and Zod input failures.
  - `dispatcher.recover()` throws if anything is already in flight, so `platform.start()` must call it before starting agents.
- Phase 1 notes for later phases:
  - The kernel learns an agent's code through `supervisor.setModule(agentId, def.moduleUrl)`. There's also a `defaultModule` option, used by kernel tests and demos. `platform.agent()` should call `setModule`.
  - `defineAgent` infers through **two** homomorphic mapped types (one for schemas, one for outputs). A single mapped type infers the outputs as `unknown`, and an assignment-based type test won't notice. Use `expectTypeOf(...).toEqualTypeOf` (which `npm run typecheck` enforces) when touching these types again. The same trick is likely needed for the workflow builder in 3.1.
  - `TaskInput` is the schema's *input* type (defaults optional), which is what `send()` should accept in 2.3. The parent can validate with the same schema before enqueueing.
  - The toy agent's `fs` task uses `share` / `revoke` with `agentId`, matching `ctx.fs`; the old `grant` / `granteeAgentId` shape is gone.
  - A listener's default payload is not a task (see ARCHITECTURE §10). Phase 3.4 removes the problem.
- Phase 2 notes for later phases:
  - `Platform` (src/lib/platform.ts) keeps the wired kernel on an `@internal` `kernel` field. Phase 3's `workflow()` / `listen()` / `startWorkflow()` belong on that class, next to `agent()`.
  - Lifecycle is `created → started → closed`. Agent `start()` / `restart()` require `started`, because recovery must run first. `send()` works in any state except `closed`.
  - Defaults chosen here: `autostart: true` and `restart: "on-crash"`.
  - `send()` stores the caller's raw input, not the schema's parsed output, because the runtime parses it again. Workflow steps in 3.2 should do the same.
  - Events added beyond the plan's list: `agent.restarting`, `agent.start-failed`, and `task.attempt-failed`.
  - The 2.4 "≈10-line timeline logger" is in the README (`events.onAny`). The newsroom itself is rewritten in 4.1.
  - Two kernel changes: a runtime that refuses to start is killed deliberately, so the restart policy doesn't loop on a broken module, and `AgentFilesystem` emits `"denied"`.
- Phase 3 notes for Phase 4:
  - Templates are gone (`src/shared/template.ts` deleted). Kernel workflows and listeners take functions: `workflows.register({ name, steps: [{ name, agents, task, input(ctx) }] })` + `start(name, input)`, and `listeners.register(name, { path, target })` with an `agent` or `platform` target. The M4/M5 demos and the current newsroom use these kernel APIs.
  - Migration 2 rebuilds `listeners` (named; nullable target). `migrate()` now turns foreign keys off around migrations, as SQLite recommends, so table rebuilds don't cascade-delete.
  - A listener → workflow start happens *inside* the scan transaction (a `platform` target). That's what makes the chain crash-safe, with the idempotency key as the second layer.
  - Public names: `platform.workflowRun(id)` reattaches to a run (`platform.workflow(name)` was taken by the builder). Events added: `workflow.settled`, `workflow.skipped`, `listener.error`, `listener.skipped`. `listener.fired` now has `listener`, plus nullable `agent` / `taskId` / `workflowId`.
  - The workflow builder needs `.input(schema)` first (it's the only method on `platform.workflow(name)`), which keeps `startWorkflow`'s input type simple.
  - For 4.1: name workflows and listeners stably (not per run) in the new example, and use `dataDir` under `examples/newsroom/data` so old demo rows in `data/` don't show up as orphans.
- Phase 4 notes:
  - The newsroom is `examples/newsroom/` (`main.ts` + `agents/{intake,editor,reviewer}.ts`), public API only. `main.ts` is 80 lines, down from 199, so about 40% rather than a third. The agent modules add 52. Intake became a workflow step, which removed the glue; the listener starts the workflow directly. It wipes `examples/newsroom/data` on each run (the data directory is gitignored).
  - The kernel's `TaskError` message is now the runtime's own message, without a `task <id> failed:` prefix.
  - 4.3 (packaging) is optional and not started.
- Work is committed on `main`; commit at the end of each phase so every phase has a clean diff.

**Environment quirks (macOS, not Linux):**
- `node` in the user's zsh is an nvm lazy-load shell function that prints nvm's help text. Use `command node`, `command npm`, and `command npx`, which resolve to Node v26 (`~/.vite-plus/bin`). Node v24 is also at `/usr/local/bin`. `.nvmrc` says 26.
- TypeScript is v7 and Vitest v5. `npm run typecheck` runs `tsc --noEmit`; `npm test` runs `vitest run`.
- `better-sqlite3` loads fine on Node 26, even though npm's install-scripts allowlist blocked its install script.
- Runtimes are forked with `--import tsx`, so there's no build step.
- `sed -i` needs `''` on macOS (BSD sed).

**Working conventions:**
- Work one phase at a time. After each phase: run the full suite **several times** (several tests race real child processes), re-run every demo, update README and `ARCHITECTURE.md` §10, then **stop for review**.
- Tick the ☐ boxes in this file as steps are completed.
- Keep dependencies minimal (currently `zod` and `better-sqlite3`). Prefer native Node APIs.
- Remember the timing gotchas found earlier:
  - File mtimes can be slightly ahead of `Date.now()`.
  - Inbox `"enqueued"` is deferred with `queueMicrotask`, so subscribers only see committed rows. Do the same for `"settled"` (0.2).
  - Dispatcher in-flight slots are compared by object identity, because a redelivered item can have the same id.
