/** Intake: files a submission on the editors' desk (normalized to upper case). */
import { z } from "zod";
import { defineAgent } from "mini-agent-runtime";

export default defineAgent(import.meta.url, {
  tasks: {
    file: {
      input: z.object({ from: z.string(), to: z.string() }),
      async run({ from, to }, ctx) {
        return ctx.fs.write(to, (await ctx.fs.read(from)).toUpperCase());
      },
    },
  },
});
