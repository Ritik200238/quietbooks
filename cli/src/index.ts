// The QuietBooks CLI: wallet, providers, deploy-or-join, and the menu loop.
//
// SPDX-License-Identifier: Apache-2.0
//
// The provider assembly and the run/finally shape are adapted from
// `bboard-cli/src/index.ts` in midnightntwrk/example-bboard (Copyright (C)
// Midnight Foundation, Apache-2.0), which is the reference for how a Node client
// wires a Midnight contract together.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createInterface, type Interface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { unshieldedToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { assertIsContractAddress } from '@midnight-ntwrk/midnight-js-utils';
import type { TestEnvironment } from '@midnight-ntwrk/testkit-js';
import type { Logger } from 'pino';

import {
  assertStorePassword,
  DEFAULT_STORE_PASSWORD,
  QuietBooksAPI,
  quietBooksPrivateStateKey,
  type PrivateStateId,
  type QuietBooksCircuitKeys,
  type QuietBooksProviders,
} from '@quietbooks/api';
import { randomBytes32, sha256, toHex, type QuietBooksPrivateState } from '@quietbooks/contract';

import { type Config, StandaloneConfig } from './config.js';
import type { AppContext } from './context.js';
import { attempt, isAbort, reportFailure } from './errors.js';
import { heading, out, renderFields } from './format.js';
import { MidnightWalletProvider } from './midnight-wallet-provider.js';
import { Prompter } from './prompts.js';
import { identityLabel } from './session.js';
import { auditMenu } from './menu/audit.js';
import { disputeMenu } from './menu/dispute.js';
import { escrowMenu } from './menu/escrow.js';
import { identity } from './menu/identity.js';
import {
  exportInvoice,
  importInvoice,
  issueInvoice,
  listInvoices,
  showInvoice,
} from './menu/invoices.js';
import { reliability } from './menu/reliability.js';
import { cancelInvoice, settleAttested, settleWithNote } from './menu/settlement.js';
import { generateDust } from './generate-dust.js';
import { syncWallet, waitForUnshieldedFunds } from './wallet-utils.js';

// Apollo's subscription transport expects a browser-shaped WebSocket global.
// @ts-expect-error: assigning the Node implementation onto the global
globalThis.WebSocket = (await import('ws')).WebSocket;

/**
 * Tokens minted in the genesis block of a local development node.
 *
 * Only ever used for standalone, where there is no faucet and no real value at
 * stake. Every other network builds or restores a wallet from a seed the
 * operator controls.
 */
const GENESIS_MINT_WALLET_SEED =
  '0000000000000000000000000000000000000000000000000000000000000001';

/**
 * The QuietBooks root secret, derived from the wallet seed.
 *
 * Domain-separated so it is not the wallet's spending key, and derived rather
 * than generated so that restoring the wallet from its seed also restores this
 * deployment's party key .. and with it the ability to open the invoices this
 * wallet already holds. A freshly generated secret would silently orphan them.
 *
 * The identity label is folded in when present, which is what lets one funded
 * wallet act as two separate QuietBooks parties.
 */
const rootSecretFor = (seed: string): Promise<Uint8Array> => {
  const label = identityLabel();
  return sha256(`quietbooks/root-secret/v1/${seed}${label === undefined ? '' : `/${label}`}`);
};

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

const WALLET_MENU = `
  Wallet
    1. Build a fresh wallet
    2. Restore a wallet from a seed
    0. Exit`;

const chooseSeed = async (config: Config, ask: Prompter): Promise<string | undefined> => {
  if (config instanceof StandaloneConfig) {
    out('  Standalone network: using the local genesis wallet, which already holds funds.');
    return GENESIS_MINT_WALLET_SEED;
  }

  for (;;) {
    const choice = await ask.menu(WALLET_MENU, ['1', '2', '0']);
    if (choice === '0') {
      return undefined;
    }
    if (choice === '1') {
      return toHex(randomBytes32());
    }
    const seed = (await ask.line('  Wallet seed (64 hex)')).trim().replace(/^0x/i, '');
    if (/^[0-9a-fA-F]{64}$/.test(seed)) {
      return seed;
    }
    out('  That is not a 64-character hex seed.');
  }
};

// ---------------------------------------------------------------------------
// Deploy or join
// ---------------------------------------------------------------------------

const DEPLOY_MENU = `
  QuietBooks contract
    1. Deploy a new QuietBooks instance (you become its administrator)
    2. Join an instance somebody already deployed
    0. Exit`;

const deployOrJoin = async (
  providers: QuietBooksProviders,
  ask: Prompter,
  logger: Logger,
  secret: Uint8Array,
): Promise<QuietBooksAPI | undefined> => {
  for (;;) {
    const choice = await ask.menu(DEPLOY_MENU, ['1', '2', '0']);
    if (choice === '0') {
      return undefined;
    }

    try {
      if (choice === '1') {
        out('  Deploying. The first proof of a session is the slow one.');
        const api = await QuietBooksAPI.deploy(providers, secret, logger);
        out(`  Deployed at ${api.deployedContractAddress}`);
        out('  Give that address to the other side so they can join the same instance.');
        return api;
      }

      const address = (await ask.line('  Contract address')).trim();
      assertIsContractAddress(address);
      const api = await QuietBooksAPI.join(providers, address, secret, logger);
      out(`  Joined ${api.deployedContractAddress}`);
      return api;
    } catch (error) {
      if (isAbort(error)) {
        throw error;
      }
      reportFailure(logger, error, choice === '1' ? 'deploy' : 'join');
      out('  Try again, or choose 0 to leave.');
    }
  }
};

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

const MAIN_MENU = `
  QuietBooks
    1.  List invoices
    2.  Issue an invoice
    3.  Show an invoice
    4.  Export an invoice record
    5.  Import an invoice record
    6.  Settle an invoice (shielded note)
    7.  Attest settlement (seller)
    8.  Cancel an invoice
    9.  Escrow: fund, release, refund
    10. Dispute: open, resolve
    11. Audit: grant, revoke
    12. Reliability
    13. My identity
    0.  Exit`;

const CHOICES = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '0'];

const ACTIONS: Readonly<Record<string, { label: string; run: (c: AppContext) => Promise<void> }>> = {
  '1': { label: 'list invoices', run: listInvoices },
  '2': { label: 'issue an invoice', run: issueInvoice },
  '3': { label: 'show an invoice', run: showInvoice },
  '4': { label: 'export an invoice record', run: exportInvoice },
  '5': { label: 'import an invoice record', run: importInvoice },
  '6': { label: 'settle an invoice', run: settleWithNote },
  '7': { label: 'attest a settlement', run: settleAttested },
  '8': { label: 'cancel an invoice', run: cancelInvoice },
  '9': { label: 'escrow', run: escrowMenu },
  '10': { label: 'dispute', run: disputeMenu },
  '11': { label: 'audit', run: auditMenu },
  '12': { label: 'reliability', run: reliability },
  '13': { label: 'identity', run: identity },
};

const mainLoop = async (context: AppContext): Promise<void> => {
  for (;;) {
    const choice = await context.ask.menu(MAIN_MENU, CHOICES);
    if (choice === '0') {
      out('  Leaving. Stopping the wallet and releasing the private state store.');
      return;
    }
    const action = ACTIONS[choice];
    if (action === undefined) {
      continue;
    }
    // Every action is wrapped: a contract assertion should cost the operator one
    // line of explanation and return them to this menu, not end the session.
    await attempt(context.logger, action.label, () => action.run(context));
  }
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Close the private state store, if this build of the provider can be closed.
 *
 * `levelPrivateStateProvider` 4.1.1 opens and closes its LevelDB around each
 * operation and exposes no `close()`, so there is usually nothing left holding
 * the directory lock by the time the CLI exits. The probe is here because that
 * is an implementation detail of one version: a build that does hold the store
 * open would otherwise leave a lock behind that stops the next run from reading
 * the invoice openings this one just wrote, and the failure would look like lost
 * data rather than a lock.
 */
const closeStore = async (providers: QuietBooksProviders, logger: Logger): Promise<void> => {
  const candidate = providers.privateStateProvider as unknown as { close?: () => Promise<void> };
  if (typeof candidate.close !== 'function') {
    logger.debug('the private state provider exposes no close(); relying on process exit');
    return;
  }
  await candidate.close();
};

export const run = async (config: Config, testEnv: TestEnvironment, logger: Logger): Promise<void> => {
  const rli: Interface = createInterface({ input, output, terminal: true });
  const ask = new Prompter(rli);

  // Ctrl-C closes the interface, which aborts whatever prompt is pending and
  // unwinds into the `finally` below. Letting the default handler kill the
  // process would leave a running wallet and a locked LevelDB directory behind.
  rli.on('SIGINT', () => {
    out('\n  Interrupted.');
    rli.close();
  });

  const started: MidnightWalletProvider[] = [];
  let providers: QuietBooksProviders | undefined;

  try {
    out(heading('QuietBooks'));
    out('  Private B2B invoicing on Midnight: commitments on chain, terms in your wallet.');
    out(`  Network:  ${config.networkName}`);
    out(`  Identity: ${identityLabel() ?? 'default'}  (store ${config.privateStateStoreName})`);
    out('');
    out('  Starting the network environment. On a standalone run this pulls and starts');
    out('  Docker containers, which can take a few minutes the first time.');

    const environment = await testEnv.start();
    logger.info({ environment }, 'environment started');
    out('  Environment ready.');

    const seed = await chooseSeed(config, ask);
    if (seed === undefined) {
      return;
    }

    out('  Building the wallet.');
    const wallet = await MidnightWalletProvider.build(logger, environment, seed);
    started.push(wallet);
    await wallet.start();

    out('');
    out(
      renderFields([
        ['Wallet seed', wallet.seed],
        ['Shielded address', wallet.shieldedAddress],
      ]),
    );
    out('  Keep the seed: it is the only way back to this wallet, and with it to the');
    out('  QuietBooks identity derived from it.');
    out('');

    out('  Waiting for the wallet to sync and hold NIGHT.');
    const unshielded = await waitForUnshieldedFunds(logger, wallet.wallet, environment, unshieldedToken(), {
      fundFromFaucet: config.fundFromFaucet,
      onAddress: (address) => out(`  Unshielded address: ${address}`),
      onProgress: (status) => out(`    ${status}`),
    });

    const nightBalance = unshielded.balances[unshieldedToken().raw];
    if (nightBalance === undefined || nightBalance === 0n) {
      out('  The wallet holds no NIGHT, so nothing can be submitted. Leaving.');
      return;
    }
    out(`  NIGHT balance: ${nightBalance.toString()}`);

    if (config.generateDust) {
      out('  Registering NIGHT for dust generation so transactions can pay their fees.');
      const txId = await generateDust(logger, seed, unshielded, wallet.wallet);
      if (txId !== undefined) {
        out(`  Registered (${txId}).`);
        await syncWallet(logger, wallet.wallet, (status) => out(`    ${status}`));
      }
    }

    const supplied = process.env.QUIETBOOKS_STORE_PASSWORD;
    const storePassword =
      supplied === undefined
        ? DEFAULT_STORE_PASSWORD
        : assertStorePassword(supplied, 'QUIETBOOKS_STORE_PASSWORD');

    const zkConfigProvider = new NodeZkConfigProvider<QuietBooksCircuitKeys>(config.zkConfigPath);
    providers = {
      privateStateProvider: levelPrivateStateProvider<PrivateStateId, QuietBooksPrivateState>({
        privateStateStoreName: config.privateStateStoreName,
        signingKeyStoreName: `${config.privateStateStoreName}-signing-keys`,
        // Not a secret: it encrypts a store that already sits on the operator's
        // own disk, under their own account. It is configurable so that a
        // deployment which does want a passphrase can supply one, and checked
        // here because the store itself only checks on its first write -- which
        // for a deploy is after the contract is already on chain.
        privateStoragePasswordProvider: () => storePassword,
        accountId: seed,
      }),
      publicDataProvider: indexerPublicDataProvider(environment.indexer, environment.indexerWS),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(environment.proofServer, zkConfigProvider),
      walletProvider: wallet,
      midnightProvider: wallet,
    };
    out(`  Proof server: ${environment.proofServer}`);
    out(`  Indexer: ${environment.indexer}`);

    const secret = await rootSecretFor(seed);
    const api = await deployOrJoin(providers, ask, logger, secret);
    if (api === undefined) {
      return;
    }

    const context: AppContext = { api, ask, logger, config, wallet };
    out('');
    out(`  Private state store: ${config.privateStateStoreName} (key ${quietBooksPrivateStateKey})`);
    await mainLoop(context);
  } catch (error) {
    if (isAbort(error)) {
      out('  Input closed. Shutting down.');
    } else {
      reportFailure(logger, error, 'session');
    }
  } finally {
    // Ordered deliberately: stop reading input, release the store, stop the
    // wallet, then tear down the containers. Each step is independently guarded
    // so that one failure cannot skip the rest.
    try {
      rli.close();
      rli.removeAllListeners();
    } catch (error) {
      reportFailure(logger, error, 'closing the prompt');
    }

    if (providers !== undefined) {
      try {
        await closeStore(providers, logger);
      } catch (error) {
        reportFailure(logger, error, 'closing the private state store');
      }
    }

    for (const wallet of started) {
      try {
        await wallet.stop();
      } catch (error) {
        reportFailure(logger, error, 'stopping the wallet');
      }
    }

    try {
      await testEnv.shutdown();
    } catch (error) {
      reportFailure(logger, error, 'stopping the environment');
    }

    out('  Stopped.');
  }
};
