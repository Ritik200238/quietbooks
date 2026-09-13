// Control experiment: deploy the simplest possible contract.
//
// SPDX-License-Identifier: Apache-2.0
//
// When the QuietBooks deploy fails at submission, there are two possible
// explanations and no way to choose between them from that failure alone:
// something about our contract, or something about this node and environment.
//
// This deploys Midnight's own `example-counter` .. one circuit, no witnesses, no
// tokens .. through the identical wallet, providers and submission path. If it
// succeeds, the fault is ours. If it fails the same way, the fault is not in the
// contract and no amount of changing the contract will fix it.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pino from 'pino';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';

import { buildWallet, waitForSync, waitForFunds, registerForDust, E2EWalletProvider } from './wallet.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COUNTER_BUILD = process.env.QB_COUNTER_BUILD ?? path.resolve(HERE, '..', 'counter-build');

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
const logger = pino({ level: 'info', transport: { target: 'pino-pretty', options: { colorize: false, translateTime: 'HH:MM:ss' } } });

const main = async (): Promise<void> => {
  setNetworkId(NETWORK_ID);
  logger.info(`control experiment: deploying example-counter from ${COUNTER_BUILD}`);

  // An absolute Windows path is not a valid ESM specifier; it has to go through
  // a file:// URL.
  const counter = (await import(
    /* @vite-ignore */ pathToFileURL(path.join(COUNTER_BUILD, 'contract', 'index.js')).href
  )) as { Contract: new (w: unknown) => unknown };

  const walletCtx = await buildWallet(ENV, GENESIS_SEED);
  try {
    await waitForSync(walletCtx, logger);
    await waitForFunds(walletCtx, logger);
    await registerForDust(walletCtx, logger);
    logger.info('wallet ready');

    const walletProvider = new E2EWalletProvider(walletCtx, logger);
    const zkConfigProvider = new NodeZkConfigProvider<string>(COUNTER_BUILD);

    const providers = {
      privateStateProvider: levelPrivateStateProvider({
        privateStateStoreName: 'quietbooks-control-private-state',
        signingKeyStoreName: 'quietbooks-control-signing-keys',
        // The store enforces a password policy: at least three of uppercase,
        // lowercase, digits and special characters. A local-only literal is
        // fine here, but it still has to satisfy the policy.
        privateStoragePasswordProvider: () => 'QuietBooks-control-1',
        accountId: GENESIS_SEED,
      }),
      publicDataProvider: indexerPublicDataProvider(ENV.indexer, ENV.indexerWS),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(ENV.proofServer, zkConfigProvider),
      walletProvider,
      midnightProvider: walletProvider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // The counter declares no witnesses at all, which is what `withVacantWitnesses`
    // is for.
    const compiled = CompiledContract.make('Counter', counter.Contract as never).pipe(
      CompiledContract.withVacantWitnesses,
      CompiledContract.withCompiledFileAssets('.'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any;

    logger.info('submitting the counter deployment');
    const deployed = await deployContract(providers, { compiledContract: compiled, args: [] });

    logger.info(`PASS  control deployed at ${deployed.deployTxData.public.contractAddress}`);
    process.stdout.write('\nCONTROL RESULT: the simplest contract DID deploy.\n');
    process.stdout.write('The submission failure is specific to the QuietBooks contract.\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`FAIL  control deploy: ${message}`);
    process.stdout.write('\nCONTROL RESULT: the simplest contract did NOT deploy either.\n');
    process.stdout.write('The submission failure is in the node or the environment, not the contract.\n');
    process.exitCode = 1;
  } finally {
    await walletCtx.wallet.stop().catch(() => undefined);
  }
};

void main();
