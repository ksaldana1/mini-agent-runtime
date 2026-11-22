# Project Brief: Local Agent Platform

## 1. Project Goal

Build a local toy implementation of an agent platform inspired by the concept **Agent Platform 2027**.

The goal is to explore an architecture in which agents behave somewhat like operating-system processes and Erlang actors, while the platform provides persistent identity, communication, shared storage, permissions, event-driven work, and durable workflows.

Think of this as building a small operating system for agents.

This is an educational prototype, not a production-ready multi-tenant agent platform.

Prioritize:
- Architectural clarity.
- Working demonstrations.
- Observable behavior.
- Small, understandable components.
- Minimal dependencies.

Use TypeScript as the primary implementation language.

Do not introduce distributed infrastructure prematurely.

---

## 2. Architectural Principles

The implementation should follow these principles:

1. Agents are independent logical actors.
2. Agent runtimes are Linux operating-system processes.
3. Agent identity survives runtime termination and recreation.
4. Agents communicate primarily through message passing.
5. The platform owns persistent inboxes, rather than agent processes.
6. Agents can access shared filesystem resources subject to permissions.
7. Listeners operate independently of agent runtimes.
8. Workflows can outlive individual agent processes.
9. The platform manages agent lifecycle and coordinates execution.

The architecture should borrow ideas from:
- Linux process management.
- Erlang's actor model.
- Operating-system permissions and resource management.
- Durable workflow orchestration.

The intent is not to recreate an entire operating system or Erlang runtime. It is to explore these concepts through a small implementation.

---

## 3. Core Architecture

The platform should have the following logical components.

### 3.1 Agent Supervisor

The supervisor manages agent runtime processes.

Responsibilities:
- Create logical agents.
- Start agent runtime processes.
- Terminate processes.
- Restart agents.
- Track runtime state.
- Map persistent agent IDs to temporary process IDs.
- Monitor process health and termination.

An agent and its runtime are separate entities.

An agent may have multiple runtime incarnations over its lifetime.

For example:

```text
Agent A (persistent identity)
    |
    +-- Runtime 1 (PID 1234)
    |       |
    |       +-- terminated
    |
    +-- Runtime 2 (PID 5678)
            |
            +-- currently running
```

The supervisor should be the authority on runtime lifecycle.

### 3.2 Agent Identity

Each agent has a persistent identity independent of its runtime PID.

Suggested fields:

- `id`: Persistent UUID.
- `name`: Human-readable name.
- `configuration`: Agent configuration.
- `createdAt`: Creation timestamp.
- `lifecycleState`: Logical agent state.

The identity should survive:
- Runtime crashes.
- Runtime restarts.
- Platform restarts.

A runtime process receives its agent identity when it starts.

Do not use process IDs as agent identifiers.

Keep logical agent deletion separate from runtime termination.

### 3.3 Agent Runtime

Each agent runtime is an independent Linux process running Node.js.

Responsibilities:
- Receive messages.
- Execute assigned tasks.
- Read and write permitted files.
- Communicate with platform services.
- Report status.
- Respond to lifecycle events.

Initially, agents should be simple TypeScript programs rather than autonomous LLM agents.

The runtime should not own persistent platform state.

Assume that a runtime can disappear at any moment and be recreated.

### 3.4 Agent Communication

Use message passing as the primary communication mechanism.

Start with Node.js IPC using `child_process.fork()`.

Agents should communicate through structured messages rather than sharing mutable in-memory state.

Define discriminated unions for message types.

For example:

```typescript
type AgentMessage =
  | {
      type: "TASK";
      taskId: string;
      payload: unknown;
    }
  | {
      type: "PING";
      requestId: string;
    }
  | {
      type: "SHUTDOWN";
    };

type AgentResponse =
  | {
      type: "TASK_COMPLETED";
      taskId: string;
      result: unknown;
    }
  | {
      type: "PONG";
      requestId: string;
    }
  | {
      type: "ERROR";
      message: string;
    };
```

Validate messages crossing process boundaries at runtime.

Consider Zod for runtime validation.

Initially, use parent-child IPC. Explore Unix domain sockets later if communication between independently managed processes becomes necessary.

### 3.5 Inbox Service

The platform owns inbox persistence.

Each inbox is scoped to a persistent agent identity.

An inbox must survive the termination of its associated runtime.

Suggested inbox item fields:

- `id`
- `recipientAgentId`
- `senderAgentId`
- `payload`
- `status`
- `createdAt`
- `acknowledgedAt`

Possible statuses:

- `pending`
- `claimed`
- `completed`
- `failed`

Responsibilities:
- Persist incoming messages.
- Make pending messages available to agent runtimes.
- Track message acknowledgment.
- Recover pending messages after runtime termination.
- Prevent unauthorized inbox access.

Important distinction:

The platform owns and operates the inbox service, while each inbox belongs logically to a particular agent identity.

Assume at-least-once message delivery initially. Design for duplicate delivery and use idempotency where appropriate.

### 3.6 Shared Filesystem

Use a local Linux filesystem.

The objective is to allow agents to work with shared artifacts while maintaining access controls.

Explore:
- Private agent directories.
- Shared directories.
- File ownership.
- Unix users and groups.
- POSIX permissions.
- POSIX ACLs.

Suggested layout:

```text
data/
  agents/
    agent-a/
    agent-b/
  shared/
    documents/
    artifacts/
```

Do not assume every agent should have unrestricted access to the shared directory.

Start with logical permission enforcement in the platform if separate Unix users make development unnecessarily complicated.

However, document the difference between:
- Platform-level authorization.
- OS-enforced filesystem security.

Authorization and synchronization are separate concerns.

Permissions determine who may access a resource. Locks, versioning, and atomic operations determine how concurrent modifications are coordinated.

Avoid implementing an elaborate locking system until the prototype needs one.

### 3.7 Listener Service

Listeners are persistent platform-managed subscriptions.

They must have lifecycles independent of agent runtimes.

Example:

"When a file is created in directory X, enqueue a task for Agent A."

Responsibilities:
- Register listeners.
- Monitor specified events.
- Generate inbox items when matching events occur.
- Persist listener registrations.
- Continue operating while target agents are offline.
- Avoid duplicate logical tasks from repeated event delivery.

For the initial prototype, use Linux filesystem notifications through a Node.js-compatible library or a simple polling implementation.

A listener should not need to keep an agent runtime alive.

### 3.8 Workflow Service

A workflow represents work that persists independently of an agent runtime.

Initially, implement a simple durable state machine backed by SQLite.

A workflow should be able to:
- Assign work to an agent.
- Track execution progress.
- Record state transitions.
- Recover after runtime termination.
- Resume or reassign work when appropriate.

Keep workflow state separate from agent runtime state.

Do not implement a complete Temporal-like workflow engine initially.

The goal is to establish the architectural boundary between agents and durable work.

---

## 4. Technology Stack

Use the following technology foundation:

| Concern | Technology |
|---|---|
| Language | TypeScript |
| Runtime | Node.js LTS |
| Package manager | npm |
| Process management | `node:child_process` |
| Agent IPC | `child_process.fork()` |
| Persistence | SQLite |
| SQLite library | `better-sqlite3` |
| Filesystem | `node:fs` and `node:fs/promises` |
| Runtime validation | Zod |
| Testing | Vitest |
| Type checking | TypeScript |
| Development execution | `tsx` |

Prefer native Node.js APIs where practical.

Keep dependencies minimal.

Avoid initially:
- Docker.
- Kubernetes.
- Redis.
- Kafka.
- Distributed databases.
- Cloud infrastructure.
- External orchestration services.

These may become relevant later, but they are not prerequisites for demonstrating the architecture.

---

## 5. Suggested Project Structure

Start with a modular monolith.

The logical components should be separated in code, but they do not need to run as independent services.

Suggested structure:

```text
agent-platform/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── platform/
│   │   ├── supervisor.ts
│   │   ├── identity.ts
│   │   ├── inbox.ts
│   │   ├── filesystem.ts
│   │   ├── listeners.ts
│   │   ├── workflows.ts
│   │   └── database.ts
│   │
│   ├── runtime/
│   │   ├── agent.ts
│   │   ├── messaging.ts
│   │   └── protocol.ts
│   │
│   ├── agents/
│   │   ├── example-agent.ts
│   │   └── worker-agent.ts
│   │
│   ├── shared/
│   │   ├── types.ts
│   │   └── schemas.ts
│   │
│   └── index.ts
│
├── data/
│   ├── platform.db
│   ├── agents/
│   └── shared/
│
└── tests/
    ├── identity.test.ts
    ├── inbox.test.ts
    ├── runtime.test.ts
    └── listeners.test.ts
```

This is a suggested starting point, not a mandatory structure.

Avoid creating abstractions that have no immediate purpose.

---

## 6. Development Milestones

Implement incrementally.

### Milestone 1: Agent Lifecycle

Implement:
- Create agent.
- Assign persistent UUID.
- Start runtime as a separate Node.js process.
- Send a structured message to the runtime.
- Receive a response.
- Terminate runtime.
- Restart runtime using the same identity.

Demonstrate that the agent identity survives process replacement.

### Milestone 2: Persistent Inbox

Implement:
- Platform-managed inbox storage.
- Message creation.
- Message retrieval.
- Message acknowledgment.
- Recovery after runtime termination.

Demonstrate that messages sent while an agent is offline are available after restart.

### Milestone 3: Shared Filesystem

Implement:
- Private agent directories.
- Shared directory.
- Basic permission model.
- Agent-to-agent artifact sharing.

Demonstrate that an agent can be granted access to an artifact without receiving unrestricted filesystem access.

### Milestone 4: Listeners

Implement:
- Listener registration.
- Event detection.
- Inbox item creation.
- Delivery when the agent becomes available.

Demonstrate that a listener continues operating while its agent is offline.

### Milestone 5: Durable Workflows

Implement:
- Workflow creation.
- Task assignment.
- State transitions.
- Persistent progress.
- Recovery after agent process termination.

Demonstrate a workflow surviving an agent crash.

---

## 7. Important Engineering Considerations

Keep the following distinctions explicit throughout implementation.

### Agent vs Runtime

An agent is a persistent logical identity.

A runtime is a temporary executing process.

### Inbox vs Message Transport

An inbox is durable platform-managed storage.

Message transport is the mechanism used to deliver messages.

### Authorization vs Synchronization

Permissions determine who can access resources.

Locks, versioning, and atomic operations coordinate concurrent modifications.

### Listener vs Runtime

A listener has an independent lifecycle and continues operating while an agent is offline.

### Agent State vs Workflow State

Agent state describes the agent's context and configuration.

Workflow state describes progress of a particular unit of work.

### Delivery vs Execution Guarantees

Durable message storage does not automatically guarantee exactly-once execution.

Assume at-least-once delivery and use idempotency for operations that may be repeated.

### Process Isolation vs Security Isolation

Separate Node.js processes provide separate execution contexts, but not strong security boundaries.

Do not treat `child_process.fork()` as a security sandbox.

The initial prototype is trusted local software. Stronger isolation can be explored later using Unix users, namespaces, containers, or microVMs.

---

## 8. Development Instructions for the Coding Agent

Work incrementally.

Before implementing:
1. Inspect the development environment.
2. Confirm Node.js and TypeScript versions.
3. Propose a concise implementation plan.
4. Identify architectural ambiguities.
5. Avoid unnecessary dependencies.

After each milestone:
1. Run tests.
2. Explain the implementation.
3. Document important trade-offs.
4. Identify the next architectural decision.

Do not implement all milestones at once.

Prefer working code and observable behavior over elaborate abstractions.

Do not introduce LLM integration yet. The first objective is to establish the agent platform infrastructure independently of the intelligence running inside agents.

---

## 9. First Deliverable: Milestone 1 Only

Build a minimal working TypeScript application demonstrating the following:

1. The platform creates Agent A.
2. Agent A receives a persistent UUID.
3. The supervisor starts Agent A using `child_process.fork()`.
4. The runtime receives its agent identity.
5. The platform sends Agent A a structured message.
6. Agent A processes the message and responds.
7. The supervisor terminates Agent A.
8. The supervisor restarts Agent A.
9. The restarted process retains the same logical agent identity.

The demonstration should make the distinction between agent identity and runtime PID observable.

Include:
- Working TypeScript source.
- Basic tests.
- README with installation and execution instructions.
- A short explanation of the architecture.

Keep the first deliverable small enough that a developer can understand the entire system by reading the code.

**Do not proceed to Milestone 2 until Milestone 1 works and has been reviewed.**

---

## 10. Known Limitations and Next Steps

All five milestones are implemented (see README). This section records what the prototype deliberately does not do yet.

### Known Limitations

**Isolation and security**
- `child_process.fork()` is not a sandbox. Runtimes are trusted code running as the same Unix user as the platform.
- Filesystem permissions are enforced by the platform, not the OS. A runtime could bypass them by using `node:fs` directly, including reading `data/platform.db`.
- The symlink check happens before the file operation, so a symlink created in between could slip through (a time-of-check/time-of-use race).
- Sender identity is validated, but nothing restricts which agents may send to which.

**Lifecycle**
- The supervisor detects crashes but never restarts agents itself. Restarting is the caller's job.
- Stopping an agent doesn't wait for its in-flight task. The task is redelivered, and that delivery counts as an attempt.

**Inbox and delivery**
- Permanent errors (for example `EACCES`) are retried like temporary ones, using up all attempts before giving up.
- `failed` items just stay in the inbox with their last error. There is no separate dead-letter handling.
- Delivery is strictly first-in, first-out per agent, with no priorities.
- Only the platform can call `inbox.send`. Agents can't send messages over IPC.

**Filesystem**
- No locking or versioning. Writes are atomic (temp file + rename), but with concurrent writers the last write wins.
- Text files only (UTF-8 strings over IPC), with no size limits.

**Listeners**
- Only the platform can register listeners. Agents can't create their own.
- Listeners only watch files: no timers, no agent-to-agent events, and deleted files aren't reported.
- Changes are detected by modification time and size, so a rewrite that keeps both the same is missed.
- Every scan lists the whole watched tree, which gets slow for large trees.

**Workflows**
- Sequential only: no branching, parallel steps, timers, or cancellation.
- Steps have no deadline. A step assigned to an agent that never starts waits forever, because reassignment only happens after a failure.
- Step outputs have no schema. A template that refers to a missing field is left unfilled.

### Next Steps

1. **Supervisor restart policies.** Restart crashed runtimes automatically, Erlang-style (for example, one-for-one restarts with backoff and a cap on restarts within a time window).
2. **Separate permanent from temporary errors.** Let a task report an error as non-retryable so the inbox fails it right away, and a workflow can reassign it without spending all attempts.
3. **Step deadlines.** Give each workflow step a timeout that triggers reassignment to the next candidate agent, so a step held by an agent that never runs doesn't block the workflow.
4. **Agent-initiated messaging and listeners.** Add IPC messages that let runtimes send inbox messages and register listeners, with a check on who may send to whom.
5. **OS-enforced isolation.** Give each agent its own Unix user (or namespace/container), and turn platform grants into real file ownership, POSIX permissions, or ACLs, so the kernel enforces access instead of TypeScript.
