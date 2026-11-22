/** Reviewer: approves an edited article. Needs read access to it (FsDeniedError otherwise). */
import { z } from "zod";
import { defineAgent } from "mini-agent-runtime";

export default defineAgent(import.meta.url, {
  tasks: {
    review: {
      input: z.object({ path: z.string(), name: z.string() }),
      async run({ path, name }, ctx) {
        return ctx.fs.write(`~/approved/${name}.txt`, `${await ctx.fs.read(path)}\n[approved]`);
      },
    },
  },
});
