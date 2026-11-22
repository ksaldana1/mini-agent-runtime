/**
 * Public API. Everything a platform author or agent author needs, and nothing from the
 * kernel (src/platform/*): those classes are implementation details.
 */
export { createPlatform } from "./platform.js";
export type {
  AgentHandle,
  AgentOptions,
  Platform,
  PlatformOptions,
  RestartPolicy,
  RuntimeRecord,
  RuntimeState,
  RuntimeStatus,
  TaskHandle,
  TaskInfo,
} from "./platform.js";

export { defineAgent } from "./agent.js";
export type { Access, AgentContext, AgentDefinition, TaskDef, TaskInput, TaskNames, TaskOutput } from "./agent.js";

export type {
  FileEvent,
  ListenerBuilder,
  ListenerHandle,
  ListenOptions,
  StepContext,
  StepStatus,
  WorkflowEvent,
  WorkflowHandle,
  WorkflowInfo,
  WorkflowRef,
  WorkflowStatus,
  WorkflowStepInfo,
} from "./workflows.js";

export { FsDeniedError, PermanentError, TaskFailedError, TaskInputError, WorkflowFailedError, WorkflowInputError } from "./errors.js";

export type { PlatformEventName, PlatformEvents, TaskStatus } from "./events.js";
