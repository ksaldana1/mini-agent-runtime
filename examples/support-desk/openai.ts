/**
 * Shared OpenAI helpers for the support-desk agents. Imported by agent modules, so no
 * top-level side effects: the client is created lazily inside the runtime process.
 */
import OpenAI from "openai";
import type { Decision } from "openai/resources/decisions";
import { PermanentError } from "mini-agent-runtime";

/** Decisions API: gpt-6-luna is the only supported model. */
export const DECISIONS_MODEL = "gpt-6-luna";
/** Model for free-form generation (Responses API). Override with OPENAI_MODEL. */
export const TEXT_MODEL = process.env.OPENAI_MODEL ?? "gpt-6-sol";

let client: OpenAI | undefined;
export function openai(): OpenAI {
  // Retrying can't conjure an API key, so fail the task on the first attempt.
  if (!process.env.OPENAI_API_KEY)
    throw new PermanentError("OPENAI_API_KEY is not set");
  return (client ??= new OpenAI());
}

type Answer = Decision["answers"][number];

/** Index answers by question name. Answers come back in question order, but names read better. */
export function byName(decision: Decision): Record<string, Answer> {
  return Object.fromEntries(
    decision.answers.map((a, i) => [a.name ?? String(i), a]),
  );
}

export function probability(a: Answer | undefined): number | null {
  return a?.type === "predicate" ? a.probability : null;
}
export function choice(
  a: Answer | undefined,
): { value: string; confidence: number } | null {
  return a?.type === "choice"
    ? { value: String(a.choice), confidence: a.confidence }
    : null;
}
export function score(
  a: Answer | undefined,
): { level: number; label: string; confidence: number } | null {
  if (a?.type !== "score") return null;
  const label =
    a.probabilities.find((p) => p.value === a.score)?.label ?? String(a.score);
  return { level: a.score, label, confidence: a.confidence };
}

/**
 * Map OpenAI errors onto the platform's retry rule: 4xx (bad key, bad request) won't get
 * better on redelivery, so make them permanent; 429/5xx/network stay retryable.
 */
export async function call<T>(fn: (client: OpenAI) => Promise<T>): Promise<T> {
  try {
    return await fn(openai());
  } catch (err) {
    if (
      err instanceof OpenAI.APIError &&
      err.status &&
      err.status >= 400 &&
      err.status < 500 &&
      err.status !== 429
    ) {
      throw new PermanentError(err.message, { cause: err });
    }
    throw err;
  }
}
