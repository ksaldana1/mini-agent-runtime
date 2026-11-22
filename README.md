# mini-agent-runtime

A toy local agent platform where agents behave like OS processes / Erlang actors.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the full brief. **Status: Milestone 1 (agent lifecycle).**

## Run

```bash
npm install
npm run demo        # create Agent A, start / task / stop / restart / crash / recover
npm test            # vitest
npm run typecheck
```

Requires Node ≥ 24 (developed on 26). Run `npm run demo` twice: the second run
reloads Agent A from `data/platform.db` and continues its incarnation count.

## How it fits together

```text
              platform process (src/index.ts)
 ┌───────────────────────────────────────────────────────┐
 │ AgentRegistry ── agents table      (persistent identity)
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
| `src/platform/database.ts` | SQLite setup: `agents` and `runtimes` tables. |
| `src/platform/identity.ts` | `AgentRegistry`: create / look up agents. Knows nothing about processes. |
| `src/platform/supervisor.ts` | Forks runtimes, does the INIT/READY handshake, correlates requests to responses, detects exits, records every incarnation. |
| `src/runtime/agent.ts` | The child process. Starts anonymous, learns who it is from `INIT`, handles `TASK` / `PING` / `SHUTDOWN`. |

### Agent vs runtime

- **Agent** = row in `agents` (UUID, name, config, `lifecycleState: active | deleted`). Survives crashes, restarts, and platform restarts.
- **Runtime** = one process incarnation (`agentId`, `incarnation`, `pid`, `state: starting | running | stopping | exited | crashed`). Disposable.

The runtime is told its identity via an `INIT` IPC message rather than argv/env, so identity
assignment is part of the validated protocol and the supervisor can verify the `READY` echo.

## Trade-offs and limitations (Milestone 1)

- **Not a sandbox.** `fork()` gives a separate process, not a security boundary. Runtimes are trusted code.
- **No automatic restart policy.** The supervisor *detects* crashes (`runtime-exit` event, `state: crashed`) but restarting is the caller's decision. An Erlang-style restart strategy is a natural next step.
- **Stale runtime rows after a platform crash.** If the platform itself dies, `runtimes` rows keep `exited_at = NULL`. Children exit on IPC disconnect, so there are no orphans, but the DB isn't reconciled on startup yet.
- **Request/response is in-memory.** Pending requests live in the supervisor and are rejected if the runtime exits. Durable delivery is Milestone 2's inbox, not this transport.
- **Runtimes run via `tsx`** (`--import tsx`) to keep dev simple; no build step.
