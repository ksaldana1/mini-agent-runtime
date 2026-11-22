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
  TaskRef,
} from "./platform.js";

export { defineAgent } from "./agent.js";
export type { Access, AgentConfigInput, AgentContext, AgentDefinition, TaskDef, TaskInput, TaskNames, TaskOutput } from "./agent.js";

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
  WorkflowStepSnapshot,
} from "./workflows.js";

export {
  AgentConfigError,
  FsDeniedError,
  PermanentError,
  TaskFailedError,
  TaskInputError,
  WorkflowFailedError,
  WorkflowInputError,
  WorkflowMismatchError,
} from "./errors.js";

export type { PlatformEventName, PlatformEvents, TaskStatus } from "./events.js";
