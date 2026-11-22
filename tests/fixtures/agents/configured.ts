/** Test agent with a config schema (5.3). */
import { z } from "zod";
import { defineAgent } from "mini-agent-runtime";

export default defineAgent(import.meta.url, {
  config: z.object({ greeting: z.string(), excitement: z.number().int().default(1) }),
  tasks: {
    greet: {
      input: z.object({ name: z.string() }),
      run: ({ name }, ctx) => `${ctx.config.greeting}, ${name}${"!".repeat(ctx.config.excitement)}`,
    },
  },
});
