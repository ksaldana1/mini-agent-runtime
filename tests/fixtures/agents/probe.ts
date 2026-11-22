/** Test agent: exposes what the host hands to handlers, and every ctx.fs operation. */
import { z } from "zod";
import { defineAgent } from "../../../src/lib/agent.js";
import { FsDeniedError, PermanentError } from "../../../src/lib/errors.js";

export default defineAgent(import.meta.url, {
  tasks: {
    whoami: {
      input: z.object({ greeting: z.string().default("hi") }),
      run: ({ greeting }, ctx) => ({ greeting, agent: ctx.agent, taskId: ctx.taskId, attempt: ctx.attempt, pid: process.pid }),
    },
    boom: {
      input: z.object({}),
      run: () => {
        throw new Error("transient trouble");
      },
    },
    permanent: {
      input: z.object({}),
      run: () => {
        throw new PermanentError("this will never work");
      },
    },
    read: {
      input: z.object({ path: z.string() }),
      run: ({ path }, ctx) => ctx.fs.read(path),
    },
    write: {
      input: z.object({ path: z.string(), content: z.string() }),
      run: ({ path, content }, ctx) => ctx.fs.write(path, content),
    },
    list: {
      input: z.object({ path: z.string() }),
      run: ({ path }, ctx) => ctx.fs.list(path),
    },
    share: {
      input: z.object({ path: z.string(), agentId: z.string(), access: z.enum(["read", "write"]) }),
      run: ({ path, agentId, access }, ctx) => ctx.fs.share(path, agentId, access),
    },
    revoke: {
      input: z.object({ path: z.string(), agentId: z.string() }),
      run: ({ path, agentId }, ctx) => ctx.fs.revoke(path, agentId),
    },
    /** Reports how a denial surfaces inside the handler. */
    tryRead: {
      input: z.object({ path: z.string() }),
      async run({ path }, ctx) {
        try {
          return { ok: true, text: await ctx.fs.read(path) };
        } catch (err) {
          return { ok: false, denied: err instanceof FsDeniedError, retryable: (err as FsDeniedError).retryable, message: (err as Error).message };
        }
      },
    },
  },
});
