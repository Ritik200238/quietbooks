// What the interfaces are allowed to show a person verbatim.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Anything that can go wrong that the interface should show verbatim.
 *
 * Circuit assertion messages are written for humans .. "caller is not the
 * buyer", not "assert failed at 0x4c" .. so they are surfaced unchanged rather
 * than wrapped in a generic failure. `cause` keeps the original for logs.
 */
export class QuietBooksError extends Error {
  constructor(
    message: string,
    readonly operation: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'QuietBooksError';
  }
}

/**
 * Re-throw an SDK or circuit failure as one of ours.
 *
 * Circuit failures arrive with the assert text already in the message. The
 * contract's own prefix is stripped so an interface is not repeating
 * "quietbooks:" in front of a sentence it is already labelling.
 */
export const failed = (operation: string, error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  const cleaned = message.replace(/^quietbooks:\s*/i, '').trim();
  throw new QuietBooksError(cleaned.length > 0 ? cleaned : `${operation} failed`, operation, error);
};
