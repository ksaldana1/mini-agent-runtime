/** Editor: edits an article into its own directory, then shares the result with a reviewer. */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { defineAgent } from "mini-agent-runtime";

export default defineAgent(import.meta.url, {
  tasks: {
    edit: {
      input: z.object({ path: z.string(), name: z.string() }),
      async run({ path, name }, ctx) {
        const text = await ctx.fs.read(path);
        await sleep(250); // editing takes a moment (long enough to crash in the middle of)
        return ctx.fs.write(`~/edited/${name}.txt`, `${text}\n[edited]`);
      },
    },
    share: {
      input: z.object({ path: z.string(), with: z.string() }),
      async run({ path, with: agentId }, ctx) {
        await ctx.fs.share(path, agentId, "read");
        return { shared: path };
      },
    },
  },
});
