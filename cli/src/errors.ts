// Turning failures into one readable line.
//
// SPDX-License-Identifier: Apache-2.0
//
// A contract assertion is already a sentence written for a person .. "caller is
// not the buyer" .. and the API hands it over unwrapped. Printing a stack trace
// on top of that sentence buries the one line that explains what happened. So
// the default is the sentence alone, and `--verbose` restores the stack for
// whoever is actually debugging the transport rather than using the product.

import type { Logger } from 'pino';

import { out } from './format.js';
import { isVerbose } from './verbose.js';

/** Raised when stdin goes away: Ctrl-C, Ctrl-D, or a closed pipe. */
export class PromptAborted extends Error {
  constructor(message = 'input stream closed') {
    super(message);
    this.name = 'PromptAborted';
  }
}

export const isAbort = (error: unknown): boolean =>
  error instanceof PromptAborted ||
  (error instanceof Error && (error.name === 'AbortError' || error.name === 'PromptAborted'));

/**
 * The shortest true description of a failure.
 *
 * Some errors arrive with the contract's own `quietbooks:` prefix still on them
 * (the ones thrown by the contract package before a call is ever made, rather
 * than by a circuit) so it is stripped here as well as in the API. Repeating the
 * product's name in front of its own error messages reads like a stutter.
 */
export const messageOf = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  const cleaned = raw.replace(/^quietbooks:\s*/i, '').trim();
  return cleaned.length > 0 ? cleaned : 'the operation failed without a message';
};

/** Print a failure without ending the session. */
export const reportFailure = (logger: Logger, error: unknown, context?: string): void => {
  const where = context === undefined ? '' : `${context}: `;
  out(`  ! ${where}${messageOf(error)}`);
  if (isVerbose() && error instanceof Error && error.stack !== undefined) {
    out(error.stack);
  }
  logger.error({ err: error }, context ?? 'operation failed');
};

/**
 * Run an action, printing any failure as one line and carrying on.
 *
 * Every menu entry goes through this. The alternative .. letting an assertion
 * unwind the loop .. would drop the operator back to a shell in the middle of a
 * demo, with a wallet still running and a LevelDB store still open.
 */
export const attempt = async (
  logger: Logger,
  context: string,
  action: () => Promise<void>,
): Promise<void> => {
  try {
    await action();
  } catch (error) {
    if (isAbort(error)) {
      throw error;
    }
    reportFailure(logger, error, context);
  }
};
