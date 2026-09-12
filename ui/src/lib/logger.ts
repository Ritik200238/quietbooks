// Console logging.
//
// SPDX-License-Identifier: Apache-2.0
//
// The API takes an optional pino logger and uses it to record what it did with a
// transaction. That trail is worth having in the browser console when a proof
// takes ninety seconds and the user wants to know whether anything is happening.
// Nothing private is logged: the API logs invoice ids and contract addresses,
// both of which are already on chain.

import pino from 'pino';

export const logger = pino({
  level: import.meta.env.VITE_LOG_LEVEL ?? 'info',
  browser: { asObject: true },
});
