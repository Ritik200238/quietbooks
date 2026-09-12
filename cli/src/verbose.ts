// Whether the operator asked for the unabridged truth.
//
// SPDX-License-Identifier: Apache-2.0
//
// Read from argv and the environment rather than threaded through every call
// site, because the very first thing that can fail .. building the logger ..
// happens before any context object exists to carry a flag.

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export const isVerbose = (): boolean => {
  if (process.argv.includes('--verbose') || process.argv.includes('-v')) {
    return true;
  }
  const fromEnv = process.env.QUIETBOOKS_VERBOSE ?? process.env.VERBOSE ?? '';
  return TRUTHY.has(fromEnv.trim().toLowerCase());
};
