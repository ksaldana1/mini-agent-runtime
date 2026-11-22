# mini-agent-runtime

A toy local agent platform where agents behave like OS processes / Erlang actors.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the full brief. **Status: Milestone 2 (persistent inbox).**

## Run

```bash
npm install
npm run demo:lifecycle   # M1: create Agent A, start / task / stop / restart / crash / recover
npm run demo:inbox       # M2: offline delivery, dedupe, crash redelivery, retries
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
 │     │  agentId → live ChildProcess (at most one)
 └─────┼─────────────────────────────────────────────────┘
       │ fork() + IPC, Zod-validated messages
       ▼
 runtime process (src/runtime/agent.ts)   pid changes every incarnation
```

| File | Role |
|---|---|
| `src/shared/protocol.ts` | Zod schemas for `AgentMessage` (platform→runtime) and `AgentResponse` (runtime→platform). Both sides validate on receipt. |
| `src/platform/database.ts` | SQLite setup: `agents`, `runtimes`, and `inbox` tables. |
| `src/platform/identity.ts` | `AgentRegistry`: create / look up agents. Knows nothing about processes. |
| `src/platform/supervisor.ts` | Forks runtimes, does the INIT/READY handshake, correlates requests to responses, detects exits, records every incarnation. |
| `src/platform/inbox.ts` | Durable inbox: `pending → claimed → completed / failed`. Idempotency keys, claims fenced by incarnation, retry limit. Pure SQLite, no processes. |
| `src/platform/dispatcher.ts` | Push delivery. Hands the oldest pending item to a running, idle runtime; releases claims when a runtime exits. |
| `src/runtime/agent.ts` | The child process. Starts anonymous, learns who it is from `INIT`, handles `TASK` / `PING` / `SHUTDOWN`. |

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

## Trade-offs and limitations

- **Not a sandbox.** `fork()` gives a separate process, not a security boundary. Runtimes are trusted code.
- **No automatic restart policy.** The supervisor *detects* crashes (`runtime-exit` event, `state: crashed`) but restarting is the caller's decision. An Erlang-style restart strategy is a natural next step.
- **Graceful stop counts as an attempt.** `stop()` doesn't wait for the in-flight task to finish. The claim is released and the item is redelivered, using one attempt.
- **Agents can't send messages yet.** Only the platform calls `inbox.send` (optionally *on behalf of* a sender). Letting runtimes send needs a new protocol message and a send-permission check.
- **No dead-letter handling beyond `failed`.** Failed items just sit there with `lastError`.
- **FIFO per agent, no priorities.**
- **Runtimes run via `tsx`** (`--import tsx`) to keep dev simple; no build step.
