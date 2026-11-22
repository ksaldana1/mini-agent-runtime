# mini-agent-runtime

A toy local agent platform where agents behave like OS processes / Erlang actors.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the full brief. **Status: Milestone 3 (shared filesystem).**

## Run

```bash
npm install
npm run demo:lifecycle   # M1: create Agent A, start / task / stop / restart / crash / recover
npm run demo:inbox       # M2: offline delivery, dedupe, crash redelivery, retries
npm run demo:fs          # M3: private dirs, closed shared area, sharing one file, audit log
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
 │     │  agentId → live ChildProcess (at most one)
 └─────┼─────────────────────────────────────────────────┘
       │ fork() + IPC, Zod-validated messages (both directions)
       ▼
 runtime process (src/runtime/agent.ts)   pid changes every incarnation
```

| File | Role |
|---|---|
| `src/shared/protocol.ts` | Zod schemas for `AgentMessage` (platform→runtime) and `AgentResponse` (runtime→platform). Both sides validate on receipt. |
| `src/platform/database.ts` | SQLite setup: `agents`, `runtimes`, and `inbox` tables (`fs_grants` / `fs_audit` are created by the filesystem service). |
| `src/platform/identity.ts` | `AgentRegistry`: create / look up agents. Knows nothing about processes. |
| `src/platform/supervisor.ts` | Forks runtimes, does the INIT/READY handshake, correlates requests to responses, detects exits, records every incarnation. |
| `src/platform/inbox.ts` | Durable inbox: `pending → claimed → completed / failed`. Idempotency keys, claims fenced by incarnation, retry limit. Pure SQLite, no processes. |
| `src/platform/dispatcher.ts` | Push delivery. Hands the oldest pending item to a running, idle runtime; releases claims when a runtime exits. |
| `src/platform/filesystem.ts` | Platform-checked file access: path normalization, ownership + grants, audit log, atomic writes. |
| `src/runtime/agent.ts` | The child process. Starts anonymous, learns who it is from `INIT`, handles `TASK` / `PING` / `SHUTDOWN`, and sends `FS_REQUEST` to the platform for any file access. |

### Agent vs runtime

- **Agent** = row in `agents` (UUID, name, config, `lifecycleState: active | deleted`). Survives crashes, restarts, and platform restarts.
- **Runtime** = one process incarnation (`agentId`, `incarnation`, `pid`, `state: starting | running | stopping | exited | crashed`). Disposable.

The runtime is told its identity via an `INIT` IPC message rather than argv/env, so identity
assignment is part of the validated protocol and the supervisor can verify the `READY` echo.

### Inbox vs transport

The **inbox** (`inbox.ts`) is durable storage that answers "what does this agent owe / is owed?".
The **dispatcher** (`dispatcher.ts`) is transport: it decides *when* to hand an item to a process.
Runtimes never touch the inbox. They only see `TASK` messages, with `taskId` set to the inbox item id.

Delivery is **at-least-once**:

- Each claim records the incarnation holding it. When that incarnation exits, its claims go back to `pending` and are redelivered to the next one (same `taskId`).
- `complete` / `fail` only apply if the caller's incarnation still holds the claim, so a late reply from a dead process can't overwrite a redelivery (a fencing token).
- `attempts` counts deliveries. After `maxAttempts` (default 3), an item that keeps erroring **or keeps crashing its runtime** is marked `failed` instead of looping forever.
- On platform startup, every `claimed` item is released (no runtime from the old platform process survives) and open `runtimes` rows are closed with `PLATFORM_RESTART`.
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

## Trade-offs and limitations

- **Not a sandbox.** `fork()` gives a separate process, not a security boundary. Runtimes are trusted code.
- **No automatic restart policy.** The supervisor *detects* crashes (`runtime-exit` event, `state: crashed`) but restarting is the caller's decision. An Erlang-style restart strategy is a natural next step.
- **Graceful stop counts as an attempt.** `stop()` doesn't wait for the in-flight task to finish. The claim is released and the item is redelivered, using one attempt.
- **Agents can't send messages yet.** Only the platform calls `inbox.send` (optionally *on behalf of* a sender). Letting runtimes send needs a new protocol message and a send-permission check.
- **No dead-letter handling beyond `failed`.** Failed items just sit there with `lastError`.
- **FIFO per agent, no priorities.**
- **Permanent errors are retried.** A task that fails with `EACCES` is retried like any other error. There's no distinction yet between retryable and permanent failures.
- **No file locking or versioning.** Atomic rename only; concurrent writers overwrite each other.
- **Text files only** (UTF-8 strings over IPC), with no size limits.
- **Runtimes run via `tsx`** (`--import tsx`) to keep dev simple; no build step.
