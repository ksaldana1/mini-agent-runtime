/**
 * The toy agent used by the milestone demos and kernel tests: the behaviours the old
 * hard-coded runtime had, as a regular agent module.
 *
 *   uppercase  uppercase `text`. Knobs: `delayMs` (slow work), `fail` (throw).
 *   transform  read `from`, uppercase it, append `suffix`, write it to `to`.
 *   fs         one platform filesystem operation, returning its result.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { defineAgent } from "../lib/agent.js";

const delay = { delayMs: z.number().int().nonnegative().optional() };

export default defineAgent(import.meta.url, {
  tasks: {
    uppercase: {
      input: z.object({ text: z.string().default(""), fail: z.boolean().optional(), ...delay }),
      async run({ text, fail, delayMs }, ctx) {
        if (delayMs) await sleep(delayMs);
        if (fail) throw new Error("task asked to fail");
        return { output: text.toUpperCase(), handledBy: ctx.agent.id, pid: process.pid };
      },
    },

    transform: {
      input: z.object({ from: z.string(), to: z.string(), suffix: z.string().default(""), ...delay }),
      async run({ from, to, suffix, delayMs }, ctx) {
        if (delayMs) await sleep(delayMs);
        const text = await ctx.fs.read(from);
        return ctx.fs.write(to, text.toUpperCase() + suffix);
      },
    },

    fs: {
      input: z.object({
        request: z.discriminatedUnion("op", [
          z.object({ op: z.literal("read"), path: z.string() }),
          z.object({ op: z.literal("write"), path: z.string(), content: z.string() }),
          z.object({ op: z.literal("list"), path: z.string() }),
          z.object({ op: z.literal("share"), path: z.string(), agentId: z.string(), access: z.enum(["read", "write"]) }),
          z.object({ op: z.literal("revoke"), path: z.string(), agentId: z.string() }),
        ]),
        ...delay,
      }),
      async run({ request: r, delayMs }, ctx) {
        if (delayMs) await sleep(delayMs);
        switch (r.op) {
          case "read":
            return ctx.fs.read(r.path);
          case "write":
            return ctx.fs.write(r.path, r.content);
          case "list":
            return ctx.fs.list(r.path);
          case "share":
            await ctx.fs.share(r.path, r.agentId, r.access);
            return { shared: r.path, with: r.agentId, access: r.access };
          case "revoke":
            await ctx.fs.revoke(r.path, r.agentId);
            return { revoked: r.path, from: r.agentId };
        }
      },
    },
  },
});
