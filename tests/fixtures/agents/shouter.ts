/** Test agent: a task with the same input as notes.read but a different name and output. */
import { z } from "zod";
import { defineAgent } from "mini-agent-runtime";

export default defineAgent(import.meta.url, {
  tasks: {
    shout: {
      input: z.object({ path: z.string() }),
      run: async ({ path }, ctx) => ({ loud: (await ctx.fs.read(path)).toUpperCase() }),
    },
  },
});
