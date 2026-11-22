# Roadmap: toward a persistent agent platform

Status: proposed roadmap, November 2026. No future phase is implemented by this document.

## Goal

Move from named task workers toward persistent agents that maintain sessions, communicate,
work in controlled environments, react to events, and involve people when needed. Eventually,
agents should be able to customize their workflows, integrations, and application interfaces.

Keep the project's original constraints: TypeScript, a small understandable kernel, working
demonstrations, and local execution before distributed infrastructure. The immediate objective
is a convincing implementation of the core agent lifecycle, not full production parity with
every prediction in the inspiration posts.

This extends [ARCHITECTURE.md](ARCHITECTURE.md) and follows the implemented library work in
[LIBRARY_PLAN.md](LIBRARY_PLAN.md). Features listed as out of scope in those documents become
explicit future work here; they are not promises of current behavior. API names below are
design sketches, not committed interfaces.

## Inspiration and interpretation

The supplied **Agent platform 2027** screenshots describe:

- [Actors, execution environments, and permissioned filesystems](https://pbs.twimg.com/media/HXsjmKvaAAAMOdo?format=jpg&name=large).
- [Separate conversations and sessions, a human inbox, and programmable listeners](https://pbs.twimg.com/media/HXsjqh8bIAAUJ3-?format=jpg&name=large).
- [Code-defined workflows and customizable apps](https://pbs.twimg.com/media/HXsjuw-acAAJhec?format=jpg&name=large).
- [Agent-customized applications and multiple UI containers](https://pbs.twimg.com/media/HXsk6XWbIAAUiiO?format=png&name=large).

Treat these as architectural hypotheses to test. Actor identity and message passing do not
provide security isolation by themselves. Durable workflows and actors can coexist. A local
process, a sandbox, and an agent's logical workspace are different resources.

## Starting point

| Area | Current capability | Remaining gap |
|---|---|---|
| Identity | Named agents survive runtime incarnations | Sessions and explicit definition versions |
| Execution | Supervised child processes, crash recovery | Replaceable environments and enforced isolation |
| Delivery | Durable inbox, retry limits, idempotency keys | Agent-originated messages, authorization, durable waiting |
| Files | Private directories, shared paths, grants, audit | Isolated mounts, revisions, environment-independent workspaces |
| Events | Persistent file listeners | General sources, cursors, dynamic subscriptions |
| Workflows | Sequential steps, fallback tasks, persisted results | Waiting, cancellation, branching, version migration |
| Public API | Task references, typed workflow inspection, typed config, output projection | Types and inspection for the new persistent entities |
| Human interaction | No dedicated model | Conversations, approval requests, resumable responses |
| Apps | No application lifecycle | Versioned artifacts, hosting, scoped platform access |

The runtime currently recovers at task boundaries. A retry can repeat external effects inside
a handler. Filesystem grants are platform checks for cooperative code, not an OS security boundary.

## Core entities and invariants

Keep these distinctions explicit as the API grows:

| Entity | Meaning |
|---|---|
| Definition | Versioned code, schemas, and declared requirements for an agent |
| Agent | Persistent identity with configuration, permissions, and owned resources |
| Runtime | Disposable execution incarnation of an agent |
| Session | Persistent context for an assignment, spanning tasks and runtimes |
| Task | One durable unit of requested work, potentially delivered multiple times |
| Conversation | User-facing messages that may involve several sessions and agents |
| Human request | A durable question or approval with an explicit resolution state |
| Workspace | Persistent files and access policy, independent of a runtime |
| Environment | A computer or sandbox in which tools and code execute |

Invariants:

- The platform owns durable state; a child process disappearing must not erase obligations.
- Authenticate runtime requests from their transport identity, never a caller-supplied agent ID.
- Persist transitions before notifying observers; observers must be able to reconnect and catch up.
- Preserve at-least-once delivery semantics and document where effects can repeat.
- Waiting must release execution capacity. Do not hold a database transaction or require a live
  process while waiting for another agent, a person, or a timer.
- Pin resumable work to compatible definitions. A step-name fingerprint alone cannot detect
  changed handler code or closures.
- Keep model providers and agent-loop implementations outside the kernel.

## Phase 1: persistent sessions and definition versions

Establish durable context before adding autonomous coordination.

- [ ] Add sessions associated with an agent, with lifecycle state, timestamps, and task links.
- [ ] Provide platform-owned session state and an append-only event history. Start with a small
  JSON state API; define atomic updates or revision checks to prevent lost writes.
- [ ] Add a handler context for the current session. Let harness adapters persist their own
  transcript/checkpoint format without requiring one provider's message schema.
- [ ] Specify scheduling: initially retain one in-flight task per agent, while allowing multiple
  logical sessions. Do not imply concurrent execution merely by adding sessions.
- [ ] Record explicit definition versions on sessions and runs. Refuse incompatible resumption
  with an inspectable reason; keep migration an explicit operation.
- [ ] Define session completion, failure, retention, and reattachment through typed handles.

**Done when:** an agent processes two independent sessions, restarts, and continues each with
the correct persisted context. Tests cover state conflicts, unknown versions, and crashes
between state updates and task settlement. Document any remaining replay window.

## Phase 2: agent communication and durable waits

Allow agents to coordinate through the platform instead of relying entirely on a workflow
declared by the application author.

- [ ] Add agent discovery/reference resolution without passing process-local handles over IPC.
- [ ] Add a permission-checked handler API such as `ctx.send(target, task, input)`.
- [ ] Derive sender identity from the runtime connection and enforce who may invoke which tasks.
- [ ] Persist correlation, causation, session association, and caller-provided idempotency keys.
- [ ] Make a replayed delegation return the same child task using a stable operation key.
- [ ] Add persisted wait conditions and continuations for task completion and deadlines. Start
  with explicit continuations; do not promise arbitrary JavaScript stack resumption.
- [ ] Define cancellation and late-result handling. Distinguish stopping a waiter from canceling
  the underlying work, and define whether cancellation propagates to delegated tasks.
- [ ] Apply pending-work limits and expose queue depth and blocked-work diagnostics.

**Done when:** agent A delegates to B, both processes can stop, and A resumes after B completes.
A crash around delegation does not create duplicate child tasks. Unauthorized sends fail, and
an A-to-B-to-A exchange does not deadlock because a suspended task occupies A's execution slot.

## Phase 3: conversations and the human inbox

Make human interaction a durable part of the application, separate from internal execution logs.

- [ ] Add conversations with explicit participants and agent/session associations.
- [ ] Provide an explicit operation for posting user-facing messages; keep tool traces and
  internal session events accessible through inspection rather than automatically publishing them.
- [ ] Add human requests with a typed response schema, context/artifact references, intended
  responder, expiration policy, and pending/resolved/expired/canceled states.
- [ ] Resolve requests atomically, authenticate the responder, and resume a persisted continuation.
- [ ] Specify duplicate responses, withdrawn requests, late responses, and retries of request creation.
- [ ] Bind approvals to the exact action and artifact revision being reviewed. Changed content
  must invalidate approval or require a new request.
- [ ] Build a minimal local inbox interface for pending requests and their outcomes.

**Done when:** a person approves a draft after a full platform restart and work resumes once.
Repeated responses do not repeat the continuation; an approval for an older draft cannot authorize
publishing a newer one. Execution traces remain independently inspectable.

## First end-to-end acceptance demo

After phases 1–3, build one application that exercises the platform thesis:

1. A persistent agent watches a workspace and investigates a new document.
2. It maintains assignment context in a session and delegates review to another agent.
3. The reviewer produces an artifact and the originating agent requests human approval.
4. The entire platform shuts down while approval is pending.
5. On restart, the inbox still shows the request, the person responds, and the agent resumes.
6. The approved artifact is published and the outcome appears in the conversation.

Use a controlled local publication target initially. Inject failures around delegation, request
creation, response handling, and publication. Verify durable IDs, correlation, and artifact
revisions. For publication, use an idempotent target or reconciliation; do not claim exactly-once
external effects from inbox deduplication alone.

This demo is the decision gate for broader investment. Prefer fixing lifecycle and recovery
problems it reveals over adding unrelated API conveniences.

## Phase 4: workspaces and replaceable execution environments

Make the agent's working environment explicit and establish real boundaries before executing
agent-generated extensions.

- [ ] Introduce a workspace reference independent of the runtime process and physical data path.
- [ ] Introduce a runtime/environment adapter boundary for launch, stop, health, authenticated
  transport, and workspace attachment. Preserve the local-process backend for development.
- [ ] Implement one isolated backend with scoped filesystem mounts, credentials, network policy,
  and resource limits. State the threat model and test it against direct filesystem/process access.
- [ ] Support attaching an environment to a session and cleaning it up without losing the workspace.
- [ ] Add artifact revisions or snapshots for review, restoration, and provenance.
- [ ] Later, support an agent using multiple environments, explicit environment sharing, and cloning
  supported snapshots. Distinguish a filesystem snapshot from a full running-machine checkpoint.
- [ ] Model local-computer access as a separately granted capability with revocation and audit.

**Done when:** the acceptance demo runs through the adapter boundary, restarting an environment
preserves its agent/session identity, and the isolated backend denies access outside its grants
even when code bypasses `ctx.fs`. Lost or expired environments produce recoverable, visible states.

## Phase 5: programmable event sources and richer durable workflows

Generalize the existing file listener while preserving its durable delivery properties.

- [ ] Define an event-source adapter with stable event IDs, cursor/checkpoint storage, delivery
  acknowledgment, reconnect behavior, and a documented retention window.
- [ ] Port file watching to the source model and add one external source to validate the abstraction.
- [ ] Support named subscriptions with filtering, batching, debounce, pause/resume, and expiration.
- [ ] Expose authorized subscription creation/update from agents, with scope and resource quotas.
- [ ] Handle ingestion-to-enqueue atomically where possible; otherwise use a durable handoff and
  deduplication. Surface poison events and source gaps instead of silently dropping them.
- [ ] Extend workflows with durable timers, human/task waits, explicit branches, and bounded
  parallelism using the continuation machinery from phases 2–3.
- [ ] Pin workflow definitions to versions and provide inspection and explicit migration/failure
  behavior for old runs. Keep input/output projections deterministic and free of external effects.

**Done when:** an agent installs a time-limited subscription, the platform restarts, and matching
events still trigger work with controlled redelivery. A branching workflow survives a timer wait
and human response; slow consumers cannot grow queues without bound.

## Phase 6: controlled customization of agents and integrations

Allow agents to change behavior through versioned installation rather than mutable imports.

- [ ] Represent generated definitions, extensions, and source adapters as versioned packages with
  manifests, entry points, schemas, dependencies, and required capabilities.
- [ ] Provide draft, validate, test, activate, disable, and rollback operations.
- [ ] Run generated code in the isolated backend before activation. Validate requested permissions
  against the installing principal's authority; generated code cannot grant itself new access.
- [ ] Pin existing sessions to their installed version. Specify when new sessions adopt a new version
  and how an explicit migration works.
- [ ] Store provenance, installation decisions, test results, and activation history.
- [ ] Let an agent propose and, within delegated authority, install changes through the same API
  available to a human administrator.

**Done when:** an agent creates a small integration, tests and activates it within its permissions,
and rolls back a bad revision without breaking sessions using the previous version.

## Phase 7: customizable apps and interfaces

Build the application layer after the underlying entities have stable lifecycle semantics.

- [ ] Define an app artifact with a manifest, versioned assets, entry point, and scoped platform API.
- [ ] Supply default apps for conversations, the human inbox, workspace browsing, and execution
  inspection. Keep their data/API contracts independent of their presentation.
- [ ] Start with one supported representation, such as a web app, and one embedding surface.
  Add message embeds, panels, or canvases only when an application needs them.
- [ ] Isolate app execution, authenticate users, and enforce permissions on every backend operation.
- [ ] Allow agents to propose edits to an app, preview them, and activate or roll back a revision
  through the package lifecycle from phase 6.
- [ ] Preserve platform-enforced authorization and trusted approval details even when presentation
  code is customizable. An app edit must not silently expand an agent's authority.

**Done when:** a user requests a tailored document-review interface, an agent produces a preview,
and the installed app uses the existing approval and artifact APIs. Reverting the UI preserves
requests, conversations, and audit history.

## Cross-cutting work and build-versus-buy checkpoints

Each phase needs schema migrations, public API documentation, a runnable example, type tests
where inference matters, and failure/restart tests around its new persistence boundaries.
Track task, session, agent, conversation, and causation IDs in observability as they are introduced.
Add backup/restore, retention, and secret-redaction policies before using real sensitive workloads.

Preserve the platform's domain model while evaluating existing infrastructure underneath it:

| Decision point | Evaluation |
|---|---|
| Before sophisticated durable waits/workflows | Compare a representative flow with DBOS, Restate, or Temporal; assess recovery, versioning, operational cost, and local setup |
| Before building an isolated runtime backend | Evaluate existing sandbox/container providers against the required filesystem and credential boundaries |
| Before remote workspace storage | Evaluate established storage/versioning options rather than implementing a distributed filesystem |
| Before distributed or multi-tenant deployment | Reassess storage, scheduling, authenticated routing, tenant isolation, and operational ownership as a separate project |

These are evaluation candidates, not selected dependencies. Record decisions against actual
requirements and current capabilities. Do not introduce a generic backend abstraction until a
second implementation or a concrete boundary justifies it.

## Sequence and scope

```text
Sessions/versioning → messaging/waits → conversations/human inbox → acceptance demo
                                                                       |
                                        workspaces/isolated environments
                                                                       |
                                      event sources/richer workflows
                                                                       |
                                        controlled customization → apps
```

Event-source work can proceed independently once durable messaging is stable. Generated-code
activation depends on isolation and versioning; apps depend on stable human-interaction APIs.

Keep these outside the near-term roadmap:

- Distributed scheduling, transparent cross-machine failover, and production multi-tenancy.
- Arbitrary JavaScript continuation capture or a new general-purpose replay engine.
- Full POSIX-compatible distributed storage.
- Automatic self-modification without versioning, capability checks, and rollback.
- Supporting every UI format, model provider, or sandbox vendor.
- Claims of exactly-once external effects or security isolation from actor semantics alone.

**Next milestone:** phase 1, followed by the smallest delegation-and-approval path that can
complete the acceptance demo. Use that application to determine which later phases are worth
implementing, keeping the runtime useful as a small local library throughout.
