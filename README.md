# mini-agent-runtime

A toy local agent platform where agents behave like OS processes / Erlang actors.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the full brief. **Status: Milestone 5 (durable workflows). All five milestones from the brief are implemented.**

## Run

```bash
npm install
npm run demo:newsroom    # showcase: every feature at once (start here)
npm run demo:lifecycle   # M1: create Agent A, start / task / stop / restart / crash / recover
npm run demo:inbox       # M2: offline delivery, dedupe, crash redelivery, retries
npm run demo:fs          # M3: private dirs, closed shared area, sharing one file, audit log
npm run demo:listeners   # M4: files trigger tasks while the agent (or platform) is offline
npm run demo:workflows   # M5: a workflow survives a crash, a platform restart, and a failing agent
npm test                 # vitest
npm run typecheck
```

Requires Node ≥ 24 (developed on 26). Run `npm run demo:lifecycle` twice: the second run
reloads Agent A from `data/platform.db` and continues its incarnation count.

## How it fits together

```text
              platform process (src/demos/*.ts)
 ┌───────────────────────────────────────────────────────┐
 │ AgentRegistry ── agents table      (persistent identity)
 │ Inbox ────────── inbox table       (durable, per agent identity)
 │ Dispatcher ───── inbox → runtime   (push, 1 in flight per agent)
 │ Supervisor ───── runtimes table    (incarnation history)
 │ AgentFilesystem ─ fs_grants, fs_audit (checks every file op)
 │ ListenerService ─ listeners, listener_files (periodic scan → inbox)
 │ WorkflowService ─ workflows, workflow_steps, workflow_events (steps → inbox)
 │     │  agentId → live ChildProcess (at most one)
 └─────┼─────────────────────────────────────────────────┘
       │ fork() + IPC, Zod-validated messages (both directions)
       ▼
 runtime process (src/runtime/agent.ts)   pid changes every incarnation
```

| File | Role |
|---|---|
| `src/shared/protocol.ts` | Zod schemas for `AgentMessage` (platform→runtime) and `AgentResponse` (runtime→platform). Both sides validate on receipt. |
| `src/platform/database.ts` | SQLite setup and the whole schema, as ordered migrations tracked by `PRAGMA user_version`. |
| `src/platform/identity.ts` | `AgentRegistry`: create / look up agents. Knows nothing about processes. |
| `src/platform/supervisor.ts` | Forks runtimes, does the INIT/READY handshake, correlates requests to responses, detects exits, records every incarnation, and restarts crashed runtimes according to a per-agent policy. |
| `src/platform/inbox.ts` | Durable inbox: `pending → claimed → completed / failed`. Idempotency keys, claims fenced by incarnation, retry limit, `"settled"` events and `waitFor`. Pure SQLite, no processes. |
| `src/platform/dispatcher.ts` | Push delivery. Hands the oldest pending item to a running, idle runtime; releases claims when a runtime exits. |
| `src/platform/filesystem.ts` | Platform-checked file access: path normalization, ownership + grants, audit log, atomic writes. |
| `src/platform/listeners.ts` | Persistent subscriptions. Periodically scans watched directories against a saved snapshot and enqueues inbox items for new or changed files. |
| `src/platform/workflows.ts` | Durable sequential workflows. Each step is an inbox item; progress comes from the item's stored status. Reassigns failed steps to fallback agents. |
| `src/shared/template.ts` | `{{dotted.path}}` filling for listener and workflow payloads. |
| `src/runtime/agent.ts` | The child process. Starts anonymous, learns who it is from `INIT`, handles `TASK` / `PING` / `SHUTDOWN`, and sends `FS_REQUEST` to the platform for any file access. |

### Agent vs runtime

- **Agent** = row in `agents` (UUID, name, config, `lifecycleState: active | deleted`). Survives crashes, restarts, and platform restarts.
- **Runtime** = one process incarnation (`agentId`, `incarnation`, `pid`, `state: starting | running | stopping | exited | crashed`). Disposable.

The runtime is told its identity via an `INIT` IPC message rather than argv/env, so identity
assignment is part of the validated protocol and the supervisor can verify the `READY` echo.

### Supervision

`supervisor.setPolicy(agentId, { restart: "on-crash", maxRestarts, windowMs, backoffMs, maxBackoffMs })`
gives an agent Erlang-style one-for-one supervision. Policies are in memory: code supplies them on every boot.

- **Only crashes are restarted.** A runtime that exits because of `stop()` or `close()` is never restarted, even if it had to be `SIGKILL`ed.
- **Exponential backoff.** The first restart within a window waits `backoffMs`, the next one twice as long, and so on, up to `maxBackoffMs`.
- **Restart cap.** More than `maxRestarts` crashes within `windowMs` leaves the runtime in the `given-up` state and emits `"gave-up"`. A manual `start()` clears it.
- `stop()` cancels a pending restart. `close()` cancels all of them and refuses further starts.

### Inbox vs transport

The **inbox** (`inbox.ts`) is durable storage that answers "what does this agent owe / is owed?".
The **dispatcher** (`dispatcher.ts`) is transport: it decides *when* to hand an item to a process.
Runtimes never touch the inbox. They only see `TASK` messages, with `taskId` set to the inbox item id.

Delivery is **at-least-once**:

- Each claim records the incarnation holding it. When that incarnation exits, its claims go back to `pending` and are redelivered to the next one (same `taskId`).
- `complete` / `fail` only apply if the caller's incarnation still holds the claim, so a late reply from a dead process can't overwrite a redelivery (a fencing token).
- `attempts` counts deliveries. After `maxAttempts` (default 3), an item that keeps erroring **or keeps crashing its runtime** is marked `failed` instead of looping forever.
- **Permanent errors skip the retries.** A runtime's `ERROR` carries `retryable` (default `true`). Invalid task payloads and permission denials (`EACCES`) are sent as `retryable: false`, and the inbox marks the item `failed` on that attempt. Timeouts and crashes are always treated as retryable.
- **Settlement.** Whenever an item reaches `completed` or `failed`, by any path (`complete`, `fail`, or a crash/startup release), the inbox emits `"settled"` after the write commits. `inbox.waitFor(id)` resolves once the item has settled, immediately if it already has. This replaces polling.
- **Recovery is explicit** (`supervisor.recover()`, `dispatcher.recover()`, `workflows.recover()`), not done in constructors, so code can register things before recovery runs. On startup, every `claimed` item is released (no runtime from the old platform process survives) and open `runtimes` rows are closed with `PLATFORM_RESTART`.
- Senders can pass an `idempotencyKey`; a repeat send to the same recipient returns the original item.

Because delivery can repeat, agents should treat `taskId` as an idempotency key for side effects.

**Authorization:** with push delivery, a runtime can only ever receive items addressed to its own
agent ID. There is no API for a runtime to read an inbox at all yet. Sender identity is validated
against the registry, but nothing restricts *who may send to whom* yet.

### Shared filesystem

```text
data/
  agents/<agentId>/        private: the owning agent has implicit read/write
  shared/documents/        closed by default; the platform grants access
  shared/artifacts/
```

Runtimes ask the platform for every file operation (`FS_REQUEST` over IPC) using logical
paths such as `~/report.txt`, `agents/<id>/x`, or `shared/documents/y`. The supervisor attaches
the agent ID **from the IPC channel the request arrived on**. The request has no field for "who
am I", so a runtime can't claim to be another agent.

- **Ownership** comes from the path: `agents/<id>/**` belongs to `<id>`. Everything else belongs to the platform.
- **Grants** (`fs_grants`) give an agent `read` or `write` on a file or a directory subtree. The most specific matching grant wins.
- **Sharing:** an agent can grant or revoke access to paths it owns. Only the platform can grant access to `shared/`. Grants can't be re-shared.
- **Paths** are normalized before the check (`~/../<other>/x` is checked as `agents/<other>/x`). Absolute paths, paths that escape the root, and symlinks anywhere in the path are rejected.
- **Audit:** every allow and deny is written to `fs_audit` with its reason.
- **Writes are atomic** (write to a temp file, then rename). This is synchronization, not authorization: readers never see a half-written file, but there is no locking, so with concurrent writers the last write wins.

### Platform-level authorization vs OS-enforced security

This milestone uses **platform-level authorization**. The platform decides, and then performs
the operation with its own Unix privileges. That is only as strong as the guarantee that runtimes
go through the platform, and they don't have to: every runtime runs as the same Unix user as the
platform, so a runtime could `import "node:fs"` and read `data/agents/<anyone>/` or
`data/platform.db` directly. The checks here are a policy model, not a security boundary.

**OS-enforced security** would give each agent its own Unix user (or a container or namespace),
set ownership and POSIX permissions or ACLs on its directory, and let the kernel refuse access no
matter what code the runtime runs. Then the platform's grants would be *translated into* OS
permissions instead of checked in TypeScript. Costs: root or user-management setup, ACL
differences between macOS and Linux, and grant changes that have to update the filesystem.

Related caveat: the symlink check happens before the operation, so a symlink created in between
(a time-of-check/time-of-use race) could still slip through. That's fine for trusted runtimes,
and another reason real isolation belongs in the OS.

### Listeners

A listener is a stored rule: *when a file is created (or modified) under directory X, enqueue a task
for agent A.* It is owned by the platform and never talks to a runtime:

```text
filesystem ──scan──▶ ListenerService ──inbox.send──▶ Inbox ──Dispatcher──▶ runtime (whenever it's up)
                        │
                        └─ listener_files snapshot (SQLite)
```

- **Periodic scan, not `fs.watch`.** Each pass lists the directory recursively and compares path, mtime, and size against the stored snapshot. Because the snapshot persists, files created while the platform was down are noticed on the next scan after it restarts. The cost is latency (up to `intervalMs`) and a full listing per scan.
- **Two layers against duplicates:**
  1. The snapshot. A file version that was already seen produces no event, and enqueueing plus updating the snapshot happen in one transaction.
  2. The inbox idempotency key (`listener:<id>:<event>:<path>:<mtime>`). Even if the snapshot is lost, the same file version can't create a second task.
- **New files only, by default.** Files present at registration are recorded as already seen. Pass `includeExisting` to process them anyway.
- **Settling.** Files modified within the last `settleMs` are skipped until a later scan, so a half-written file from an outside writer isn't processed. Files ending in `*.tmp` (the platform's own in-progress writes) are always ignored.
- **Permissions.** A listener reveals file names and contents to its target, so registering one requires the target agent to have read access to the directory. Access is checked again on every scan: if the grant is revoked, or the agent is deleted or the listener paused, it stops firing and records `lastError`. A paused listener catches up on resume, because the snapshot wasn't advanced while it was paused.
- **Payload templates.** `{{path}}`, `{{name}}`, `{{event}}`, and `{{listenerId}}` in string values are filled in, so a listener can enqueue a ready-to-run task (for example, `{ action: "transform", from: "{{path}}", to: "~/processed/{{name}}" }`).

### Workflows

A workflow is a named list of steps. Each step names candidate agents (the first one, then
fallbacks) and a payload template that can use `{{input.*}}`, `{{steps.<name>.*}}` (an earlier
step's result), and `{{workflow.id}}`.

```text
WorkflowService ──inbox.send──▶ Inbox ──Dispatcher──▶ runtime
      ▲                           │
      └──── "settled" events ─────┘
      └──── recover() at startup (reconcileAll)
```

- **Workflows sit on top of the inbox.** A workflow never talks to a runtime. Assigning a step means `inbox.send` with the idempotency key `workflow:<id>:step:<n>:assignment:<k>`. Delivery, crash redelivery, and retry limits all come from the inbox and dispatcher.
- **Progress comes from stored state.** `reconcile()` looks at the current step's inbox item. If it's `completed`, the result is saved and the next step is assigned (or the workflow completes). If it's `failed`, the step goes to the next candidate agent (or the workflow fails). If it's pending or claimed, nothing happens. Because it only reads the database, calling it repeatedly is safe, and each transition runs in one transaction.
- **Events for speed, a startup pass for recovery.** The inbox's `"settled"` event triggers `reconcile` immediately, including when a crash release is what failed the item. On startup, `recover()` catches anything that finished while no service was listening.
- **Two levels of retry:** retrying *the same agent* (crash or error, up to `maxAttempts`) is the inbox's job. Moving work *to a different agent* is the workflow's job.
- **Workflow state stays separate from agent state.** Agents don't know they are part of a workflow; they just get tasks. All progress lives in `workflows`, `workflow_steps`, and `workflow_events` (an append-only list of transitions).

## Limitations and next steps

See [ARCHITECTURE.md §10](ARCHITECTURE.md#10-known-limitations-and-next-steps) for the full list of known limitations and planned next steps.
