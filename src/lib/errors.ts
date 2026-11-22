/**
 * Errors an agent's task handler can throw (or receive from `ctx`), and how the
 * platform treats them. Anything with `retryable === false` fails the task on the
 * current attempt instead of being redelivered.
 */

/** Throw from a handler when retrying can't help (bad data, a business rule, ...). */
export class PermanentError extends Error {
  readonly retryable = false;
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PermanentError";
  }
}

/** The platform refused a filesystem operation. Grants don't change on retry, so it's permanent. */
export class FsDeniedError extends PermanentError {
  readonly code = "EACCES";
  constructor(message: string) {
    super(message);
    this.name = "FsDeniedError";
  }
}

/** Platform rule: an error is retried unless it says otherwise. */
export function isRetryable(err: unknown): boolean {
  return !(typeof err === "object" && err !== null && (err as { retryable?: unknown }).retryable === false);
}

/** `TaskHandle.result()` rejects with this when the task ended up failed. */
export class TaskFailedError extends Error {
  constructor(
    readonly taskId: string,
    readonly task: string,
    readonly agent: string,
    /** The error from the last attempt. */
    readonly lastError: string | null,
    readonly attempts: number,
  ) {
    super(`task ${task} (${taskId}) on ${agent} failed after ${attempts} attempt(s): ${lastError ?? "unknown error"}`);
    this.name = "TaskFailedError";
  }
}

/** `send()` refused the input: it doesn't match the task's schema. Nothing was enqueued. */
export class TaskInputError extends Error {
  constructor(
    readonly task: string,
    readonly agent: string,
    message: string,
  ) {
    super(`invalid input for task ${task} on ${agent}: ${message}`);
    this.name = "TaskInputError";
  }
}
