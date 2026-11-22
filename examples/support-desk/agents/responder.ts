/**
 * Responder: routes on the triage result. Risky tickets (a human is needed, a secret was
 * pasted, or the model refused a question) are escalated without an LLM call; the rest get
 * a reply drafted with the Responses API.
 */
import { z } from "zod";
import { defineAgent } from "mini-agent-runtime";
import { call, TEXT_MODEL } from "../openai.js";

const Triage = z.object({
  name: z.string(),
  path: z.string(),
  category: z.object({ value: z.string(), confidence: z.number() }).nullable(),
  urgency: z.object({ level: z.number(), label: z.string(), confidence: z.number() }).nullable(),
  needsHuman: z.number().nullable(),
  hasSecret: z.number().nullable(),
  refused: z.array(z.string().nullable()),
});

export default defineAgent(import.meta.url, {
  tasks: {
    respond: {
      input: z.object({ triage: Triage, draftsDir: z.string(), escalationsDir: z.string() }),
      async run({ triage, draftsDir, escalationsDir }, ctx) {
        const ticket = await ctx.fs.read(triage.path);
        const reasons = [
          (triage.needsHuman ?? 0) > 0.5 && "needs a human",
          (triage.hasSecret ?? 0) > 0.5 && "contains a secret",
          triage.refused.length > 0 && `model refused: ${triage.refused.join(", ")}`,
          !triage.category && "no category",
        ].filter(Boolean);

        if (reasons.length) {
          const { path } = await ctx.fs.write(`${escalationsDir}/${triage.name}.txt`, `ESCALATED (${reasons.join("; ")})\n\n${ticket}`);
          return { action: "escalated" as const, path, reasons };
        }

        const response = await call((c) => c.responses.create({
          model: TEXT_MODEL,
          instructions:
            "You are a friendly, concise support agent. Draft a reply to the customer in under 120 words. " +
            "Never promise refunds, credits, or timelines. Sign off as 'The Support Team'.",
          input: `Queue: ${triage.category!.value}. Urgency: ${triage.urgency?.label ?? "unknown"}.\n\nTicket:\n${ticket}`,
        }));
        const { path } = await ctx.fs.write(`${draftsDir}/${triage.name}.txt`, response.output_text);
        return { action: "drafted" as const, path, reasons };
      },
    },
  },
});
