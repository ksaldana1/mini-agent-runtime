/**
 * QA: Decisions as an LLM judge. Grades a drafted reply against the original ticket; a draft
 * passes only if it's helpful enough and breaks no policy. Escalations pass through untouched.
 */
import { z } from "zod";
import { defineAgent } from "mini-agent-runtime";
import { byName, call, DECISIONS_MODEL, probability, score } from "../openai.js";

export default defineAgent(import.meta.url, {
  tasks: {
    check: {
      input: z.object({ ticketPath: z.string(), action: z.enum(["drafted", "escalated"]), path: z.string() }),
      async run({ ticketPath, action, path }, ctx) {
        if (action === "escalated") return { verdict: "escalated" as const, helpfulness: null, policyViolation: null };

        const [ticket, draft] = await Promise.all([ctx.fs.read(ticketPath), ctx.fs.read(path)]);
        const decision = await call((c) => c.decisions.create({
          model: DECISIONS_MODEL,
          input: [{ role: "user", content: [{ type: "input_json", data: { ticket, draft_reply: draft } }] }],
          questions: [
            {
              type: "score",
              name: "helpfulness",
              instructions: "How well does draft_reply address what the customer asked in ticket?",
              levels: [{ label: "unhelpful" }, { label: "partial" }, { label: "good" }, { label: "excellent" }],
            },
            { type: "predicate", name: "policy_violation", instructions: "draft_reply promises a refund, credit, or a specific timeline." },
          ],
        }));
        const a = byName(decision);
        const helpfulness = score(a.helpfulness);
        const policyViolation = probability(a.policy_violation);
        const ok = ["good", "excellent"].includes(helpfulness?.label ?? "") && (policyViolation ?? 1) < 0.3;
        return { verdict: ok ? ("approved" as const) : ("rejected" as const), helpfulness, policyViolation };
      },
    },
  },
});
