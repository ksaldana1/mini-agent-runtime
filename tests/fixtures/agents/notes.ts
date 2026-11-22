/** Test agent written against the public entry point only. */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { defineAgent, PermanentError } from "mini-agent-runtime";

export default defineAgent(import.meta.url, {
  tasks: {
    save: {
      input: z.object({ name: z.string(), text: z.string(), delayMs: z.number().default(0) }),
      async run({ name, text, delayMs }, ctx) {
        if (delayMs) await sleep(delayMs);
        const written = await ctx.fs.write(`~/notes/${name}.txt`, text);
        return { ...written, attempt: ctx.attempt, incarnation: ctx.agent.incarnation };
      },
    },
    read: {
      input: z.object({ path: z.string() }),
      run: ({ path }, ctx) => ctx.fs.read(path),
    },
    reject: {
      input: z.object({ reason: z.string() }),
      run: ({ reason }): never => {
        throw new PermanentError(reason);
      },
    },
  },
});
