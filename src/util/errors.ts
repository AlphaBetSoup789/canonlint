/**
 * An error we expect and can explain. The CLI prints the message alone,
 * without a stack trace — stacks are for bugs, not for "run init first".
 */
export class CanonlintError extends Error {
  override readonly name = 'CanonlintError';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Raised when a run would cost more than the configured spend cap. */
export class SpendCapError extends CanonlintError {
  constructor(
    readonly estimatedUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `Estimated cost $${estimatedUsd.toFixed(2)} exceeds the spend cap of ` +
        `$${capUsd.toFixed(2)}. Raise CANONLINT_MAX_SPEND_USD or pass ` +
        `--max-spend to proceed.`,
    );
  }
}

export function isCanonlintError(err: unknown): err is CanonlintError {
  return err instanceof CanonlintError;
}
