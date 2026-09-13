// Measure how large a contract a single deploy transaction can carry.
//
// SPDX-License-Identifier: Apache-2.0
//
// The node rejects an oversized deploy with Substrate's generic
// "Transaction would exhaust the block limits", which names neither the limit
// nor the margin. This deploys a generated contract of a given size and reports
// the transaction's cost against every block limit alongside the outcome, so
// the ceiling can be bisected instead of guessed.
//
//   node dist/probe.js <path-to-compiled-contract-dir> <label>

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import pino from 'pino';
import * as Cause from 'effect/Cause';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';

import { buildWallet, waitForSync, waitForFunds, registerForDust, E2EWalletProvider } from './wallet.js';

const BUILD_DIR = path.resolve(process.argv[2] ?? '');
const LABEL = process.argv[3] ?? path.basename(BUILD_DIR);

const NETWORK_ID = 'undeployed';
const ENV: EnvironmentConfiguration = {
  walletNetworkId: NETWORK_ID,
  networkId: NETWORK_ID,
  indexer: 'http://127.0.0.1:8088/api/v4/graphql',
  indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
  node: 'http://127.0.0.1:9944',
  nodeWS: 'ws://127.0.0.1:9944',
  proofServer: 'http://127.0.0.1:6300',
  faucet: '',
};

const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
const logger = pino({
  level: 'info',
  transport: { target: 'pino-pretty', options: { colorize: false, translateTime: 'HH:MM:ss' } },
});

const reason = (error: unknown): string => {
  let current: unknown = error;
  const seen = new Set<unknown>();
  let last = String(error);
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    last = `${current.name}: ${current.message}`;
    let next: unknown = (current as { cause?: unknown }).cause;
    for (const symbol of Object.getOwnPropertySymbols(current)) {
      const value = (current as unknown as Record<symbol, unknown>)[symbol];
      if (Cause.isCause(value)) next = Cause.squash(value as Cause.Cause<unknown>);
    }
    if (next === current) break;
    current = next;
  }
  return last;
};

const main = async (): Promise<void> => {
  setNetworkId(NETWORK_ID);

  const contractModule = (await import(
    /* @vite-ignore */ pathToFileURL(path.join(BUILD_DIR, 'contract', 'index.js')).href
  )) as { Contract: new (w: unknown) => unknown };

  const walletCtx = await buildWallet(ENV, GENESIS_SEED);
  try {
    await waitForSync(walletCtx, logger);
    await waitForFunds(walletCtx, logger);
    await registerForDust(walletCtx, logger);

    const walletProvider = new E2EWalletProvider(walletCtx, logger);
    const zkConfigProvider = new NodeZkConfigProvider<string>(BUILD_DIR);

    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: `quietbooks-probe-${LABEL}-private-state`,
        signingKeyStoreName: `quietbooks-probe-${LABEL}-signing-keys`,
        privateStoragePasswordProvider: () => 'QuietBooks-probe-local-1',
        accountId: GENESIS_SEED,
      }),
      publicDataProvider: indexerPublicDataProvider(ENV.indexer, ENV.indexerWS),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(ENV.proofServer, zkConfigProvider),
      walletProvider,
      midnightProvider: walletProvider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const compiled = CompiledContract.make(LABEL, contractModule.Contract as never).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets('.'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;

    await deployContract(providers, { compiledContract: compiled, args: [] });
    process.stdout.write(`PROBE ${LABEL} DEPLOYED\n`);
  } catch (error) {
    process.stdout.write(`PROBE ${LABEL} REJECTED ${reason(error)}\n`);
    process.exitCode = 1;
  } finally {
    await walletCtx.wallet.stop().catch(() => undefined);
  }
};

void main();
