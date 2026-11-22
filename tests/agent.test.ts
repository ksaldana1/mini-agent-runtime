/**
 * defineAgent: runtime checks plus type-level tests. The expectTypeOf assertions are
 * enforced by `npm run typecheck` (tsc covers tests/); at runtime they're no-ops.
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import toy from "../src/agents/toy.js";
import { defineAgent, isAgentDefinition, type AgentContext, type TaskInput, type TaskNames, type TaskOutput } from "../src/lib/agent.js";

const editor = defineAgent(import.meta.url, {
  tasks: {
    edit: {
      input: z.object({ path: z.string(), name: z.string(), shout: z.boolean().default(false) }),
      async run(input, ctx) {
        expectTypeOf(input).toEqualTypeOf<{ path: string; name: string; shout: boolean }>();
        expectTypeOf(ctx).toEqualTypeOf<AgentContext>();
        return { path: `~/edited/${input.name}.txt`, bytes: 3 };
      },
    },
    count: {
      input: z.object({ items: z.array(z.string()) }),
      run: ({ items }) => items.length,
    },
    nothing: {
      input: z.object({}),
      run: () => {},
    },
  },
});

describe("defineAgent types", () => {
  it("infers task names", () => {
    expectTypeOf<TaskNames<typeof editor>>().toEqualTypeOf<"edit" | "count" | "nothing">();
    expectTypeOf<TaskNames<typeof toy>>().toEqualTypeOf<"uppercase" | "transform" | "fs">();
  });

  it("infers task inputs from the schema (caller side: defaults are optional)", () => {
    expectTypeOf<TaskInput<typeof editor, "edit">>().toEqualTypeOf<{ path: string; name: string; shout?: boolean | undefined }>();
    expectTypeOf<TaskInput<typeof editor, "count">>().toEqualTypeOf<{ items: string[] }>();
    expectTypeOf<TaskInput<typeof toy, "transform">>().toMatchTypeOf<{ from: string; to: string; suffix?: string }>();
  });

  it("infers task outputs from run's return type, unwrapping promises", () => {
    expectTypeOf<TaskOutput<typeof editor, "edit">>().toEqualTypeOf<{ path: string; bytes: number }>();
    expectTypeOf<TaskOutput<typeof editor, "count">>().toEqualTypeOf<number>();
    expectTypeOf<TaskOutput<typeof editor, "nothing">>().toEqualTypeOf<void>();
    expectTypeOf<TaskOutput<typeof toy, "transform">>().toEqualTypeOf<{ path: string; bytes: number }>();
  });

  it("rejects handlers that use fields the schema doesn't have", () => {
    defineAgent(import.meta.url, {
      tasks: {
        t: {
          input: z.object({ a: z.string() }),
          run(input) {
            // @ts-expect-error `b` is not in the schema
            return input.b;
          },
        },
      },
    });
  });
});

describe("defineAgent at runtime", () => {
  it("brands the definition and records the module URL", () => {
    expect(isAgentDefinition(editor)).toBe(true);
    expect(isAgentDefinition({ tasks: {} })).toBe(false);
    expect(editor.moduleUrl).toBe(import.meta.url);
    expect(Object.keys(editor.tasks)).toEqual(["edit", "count", "nothing"]);
  });

  it("requires a file: URL", () => {
    expect(() => defineAgent("./editor.ts", { tasks: {} })).toThrow(/import\.meta\.url/);
  });

  it("requires each task to have a schema and a run function", () => {
    expect(() => defineAgent(import.meta.url, { tasks: { t: { input: undefined as never, run: () => 1 } } })).toThrow(/task "t"/);
  });
});
