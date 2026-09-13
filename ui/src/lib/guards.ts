// Why an action cannot run, in the words the person reads.
//
// SPDX-License-Identifier: Apache-2.0
//
// Three screens stop the same calls for the same reasons, and the reason has to
// read identically in all of them: a pause explained one way on the invoice
// screen and another way on the audit screen looks like two separate faults.

/**
 * The first reason an action cannot run, or nothing.
 *
 * A disabled button with no explanation is a dead end, so every action states
 * the first thing standing in its way rather than only the last.
 */
export const blockedBy = (checks: readonly (readonly [boolean, string])[]): string | undefined =>
  checks.find(([blocked]) => blocked)?.[1];

/** Every state-advancing circuit opens with `assertNotPaused()`. */
export const PAUSED_REASON = 'The deployment is paused, so the contract refuses this call.';
