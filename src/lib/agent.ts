/**
 * Agent definitions. An agent module is loaded twice:
 *   - in the platform process, for its types and its module URL (D2);
 *   - in each runtime process, by the host, to run its tasks.
 * So agent modules must be side-effect free at the top level.
 *
 *   export default defineAgent(import.meta.url, {
 *     tasks: {
 *       edit: {
 *         input: z.object({ path: z.string() }),
 *         async run({ path }, ctx) { ... },
 *       },
 *     },
 *   });
 */
import type { z } from "zod";

// ── Context handed to every task handler ────────────────────────────────────

export type Access = "read" | "write";

export interface AgentContext<Config = undefined> {
  /**
   * The agent's config, parsed by the definition's `config` schema (undefined without one).
   * Delivered when the runtime starts: a change takes effect on the next start or restart.
   */
  config: Config;
  /** Which logical agent (and which process incarnation of it) is running this task. */
  agent: { id: string; name: string; incarnation: number };
  /** Stable across redeliveries of the same task: use it as an idempotency key for side effects. */
  taskId: string;
  /** 1 on first delivery, 2 on the first redelivery, ... */
  attempt: number;
  log(message: string): void;
  /**
   * Platform filesystem, checked against this agent's grants. Paths are logical:
   * "~/x" (own private dir), "agents/<id>/x", "shared/...". Denials throw FsDeniedError.
   */
  fs: {
    read(path: string): Promise<string>;
    write(path: string, content: string): Promise<{ path: string; bytes: number }>;
    list(path: string): Promise<string[]>;
    /** Grant another agent access to a path this agent owns. */
    share(path: string, agentId: string, access: Access): Promise<void>;
    revoke(path: string, agentId: string): Promise<void>;
  };
}

// ── Definitions ─────────────────────────────────────────────────────────────

export interface TaskDef<S extends z.ZodType = z.ZodType, Out = unknown, Config = undefined> {
  input: S;
  run(input: z.output<S>, ctx: AgentContext<Config>): Out | Promise<Out>;
}

/** A task as the host sees it: types erased. */
type AnyTaskDef = { input: z.ZodType; run(input: never, ctx: AgentContext<never>): unknown };

/** Parsed config type for a config schema (undefined when there's none). */
type ConfigOf<C> = C extends z.ZodType ? z.output<C> : undefined;

const BRAND = Symbol.for("mini-agent-runtime.agent-definition");

export interface AgentDefinition<
  Tasks extends Record<string, AnyTaskDef> = Record<string, AnyTaskDef>,
  C extends z.ZodType | undefined = z.ZodType | undefined,
> {
  readonly [BRAND]: true;
  /** file: URL of the module that defines this agent; the runtime host imports it. */
  readonly moduleUrl: string;
  readonly tasks: Tasks;
  /** Schema for the agent's config (`platform.agent(name, def, { config })`), if it takes any. */
  readonly config: C;
}

/**
 * Define an agent. Pass `import.meta.url` as `moduleUrl` and make this the module's
 * default export. Each task's `run` input type is inferred from its `input` schema.
 */
export function defineAgent<S extends Record<string, z.ZodType>, R, C extends z.ZodType | undefined = undefined>(
  moduleUrl: string,
  // Two homomorphic mapped types so TypeScript can reverse-infer both type parameters
  // from the same object: S from each `input`, then (with `run`'s parameter now
  // contextually typed by S) R from each `run`'s return type. A single mapped type
  // over S can't infer R. C comes from `config`, which isn't context-sensitive.
  def: {
    config?: C;
    tasks: { [K in keyof S]: { input: S[K] } } & {
      [K in keyof R]: { run(input: z.output<S[K & keyof S]>, ctx: AgentContext<ConfigOf<C>>): R[K] | Promise<R[K]> };
    };
  },
): AgentDefinition<{ [K in keyof S]: TaskDef<S[K], R[K & keyof R], ConfigOf<C>> }, C> {
  if (!moduleUrl.startsWith("file:")) throw new Error(`defineAgent: moduleUrl must be a file: URL (pass import.meta.url), got ${moduleUrl}`);
  for (const [name, task] of Object.entries(def.tasks as Record<string, Partial<TaskDef>>)) {
    if (typeof task?.run !== "function" || typeof task.input?.safeParse !== "function") {
      throw new Error(`defineAgent: task "${name}" needs an \`input\` Zod schema and a \`run\` function`);
    }
  }
  if (def.config !== undefined && typeof (def.config as Partial<z.ZodType>).safeParse !== "function") {
    throw new Error("defineAgent: `config` must be a Zod schema");
  }
  return Object.freeze({ [BRAND]: true as const, moduleUrl, tasks: def.tasks as never, config: def.config as C });
}

export function isAgentDefinition(value: unknown): value is AgentDefinition {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
}

// ── Helper types ────────────────────────────────────────────────────────────

/** Names of the tasks an agent definition offers. */
export type TaskNames<D extends AgentDefinition> = keyof D["tasks"] & string;

/** What callers pass to a task (the schema's input type: before defaults/transforms). */
export type TaskInput<D extends AgentDefinition, K extends TaskNames<D>> = z.input<D["tasks"][K]["input"]>;

/** What `platform.agent(name, def, { config })` accepts (the schema's input type). */
export type AgentConfigInput<D extends AgentDefinition> = D["config"] extends z.ZodType ? z.input<D["config"]> : undefined;

/** What a task resolves to. */
export type TaskOutput<D extends AgentDefinition, K extends TaskNames<D>> = Awaited<ReturnType<D["tasks"][K]["run"]>>;
