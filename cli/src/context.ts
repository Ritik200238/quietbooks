// What every menu action needs to do its job.
//
// SPDX-License-Identifier: Apache-2.0
//
// Passed as one object rather than five parameters so that adding, say, the
// network name later does not mean editing the signature of every action.

import type { QuietBooksAPI } from '@quietbooks/api';
import type { Logger } from 'pino';

import type { Config } from './config.js';
import type { MidnightWalletProvider } from './midnight-wallet-provider.js';
import type { Prompter } from './prompts.js';

export type AppContext = {
  readonly api: QuietBooksAPI;
  readonly ask: Prompter;
  readonly logger: Logger;
  readonly config: Config;
  readonly wallet: MidnightWalletProvider;
};
