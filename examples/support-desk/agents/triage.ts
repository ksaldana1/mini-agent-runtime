/**
 * Triage: one Decisions API call answers four questions about a ticket at once
 * (a choice, a score and two predicates). No text generation: just typed answers.
 */
import { z } from "zod";
import { defineAgent } from "mini-agent-runtime";
import { byName, call, choice, DECISIONS_MODEL, probability, score } from "../openai.js";

export const CATEGORIES = ["billing", "bug", "account_access", "feature_request", "other"] as const;

export default defineAgent(import.meta.url, {
  tasks: {
    triage: {
      input: z.object({ path: z.string(), name: z.string() }),
      async run({ path, name }, ctx) {
        const ticket = await ctx.fs.read(path);
        const decision = await call((c) => c.decisions.create({
          model: DECISIONS_MODEL,
          input: [
            { role: "developer", content: "You triage inbound customer support tickets for a SaaS product." },
            { role: "user", content: ticket },
          ],
          questions: [
            {
              type: "choice",
              name: "category",
              instructions: "Which queue should this ticket go to?",
              choices: [
                { value: "billing", description: "Charges, invoices, refunds, plan changes" },
                { value: "bug", description: "Something in the product is broken or behaving wrongly" },
                { value: "account_access", description: "Login, password, 2FA, locked accounts" },
                { value: "feature_request", description: "Asking for something the product does not do" },
                { value: "other", description: "Anything else" },
              ],
            },
            {
              type: "score",
              name: "urgency",
              instructions: "How urgently does this need a response?",
              levels: [
                { label: "low", description: "Nice to have, no impact" },
                { label: "normal", description: "Inconvenient, has a workaround" },
                { label: "high", description: "Blocking the customer's work" },
                { label: "critical", description: "Outage, data loss, security issue or money at risk" },
              ],
            },
            { type: "predicate", name: "needs_human", instructions: "The ticket mentions legal action, a chargeback, a security incident, or a customer threatening to cancel." },
            { type: "predicate", name: "has_secret", instructions: "The ticket contains a password, API key, or full payment card number." },
          ],
          prompt_cache_key: "support-desk-triage", // same developer message + questions every time
        }));

        const a = byName(decision);
        const result = {
          name,
          path,
          category: choice(a.category),
          urgency: score(a.urgency),
          needsHuman: probability(a.needs_human),
          hasSecret: probability(a.has_secret),
          refused: decision.answers.filter((x) => x.type === "refusal").map((x) => x.name),
          tokens: decision.usage.input_tokens,
        };
        ctx.log(`${name}: ${result.category?.value} / ${result.urgency?.label} / human=${result.needsHuman?.toFixed(2)}`);
        await ctx.fs.write(`~/triage/${name}.json`, JSON.stringify(result, null, 2));
        return result;
      },
    },
  },
});
