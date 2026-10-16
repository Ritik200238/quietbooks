// Fund a wallet on a public Midnight network, before anything is deployed to it.
//
// SPDX-License-Identifier: Apache-2.0
//
// Everything QuietBooks has run so far ran on the standalone node in
// ../localnet, whose genesis seed holds the entire minted supply. A public
// network has no genesis seed to borrow: the wallet starts empty, NIGHT comes
// from a faucet, and nothing can be submitted until that NIGHT has been
// registered for DUST and the DUST has become spendable. This script does those
// three things and nothing else, so that a failure to get funded is reported
// here rather than two minutes into a deploy.
//
//   npm run preview:fund --workspace @quietbooks/e2e
//
// The seed is read from QB_SEED, or from the file named by QB_SEED_FILE, or
// generated. It is never written inside this repository and never printed: a
// funded seed on a public network is a key, and the addresses below are the
// only part of it that is safe to publish.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import * as Rx from 'rxjs';

import { nativeToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { FaucetClient, type EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import {
  ShieldedAddress,
  UnshieldedAddress,
} from '@midnight-ntwrk/wallet-sdk-address-format';
import { configureNetwork } from '@quietbooks/api';

import { addressesOf, buildWallet, registerForDust, waitForSync } from './wallet.js';

type NetworkName = 'preview' | 'preprod';

const NETWORKS: Record<NetworkName, EnvironmentConfiguration> = {
  preview: {
    walletNetworkId: 'preview',
    networkId: 'preview',
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preview.midnight.network',
    nodeWS: 'wss://rpc.preview.midnight.network',
    faucet: 'https://midnight-tmnight-preview.nethermind.dev/',
    proofServer: process.env.QB_PROOF_SERVER ?? 'http://127.0.0.1:6300',
  },
  preprod: {
    walletNetworkId: 'preprod',
    networkId: 'preprod',
    indexer: 'https://indexer.preprod.midnight.network/api/v4/graphql',
    indexerWS: 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    node: 'https://rpc.preprod.midnight.network',
    nodeWS: 'wss://rpc.preprod.midnight.network',
    faucet: 'https://midnight-tmnight-preprod.nethermind.dev/',
    proofServer: process.env.QB_PROOF_SERVER ?? 'http://127.0.0.1:6300',
  },
};

const logger = pino({
  level: process.env.QB_LOG_LEVEL ?? 'info',
  transport: { target: 'pino-pretty', options: { colorize: false, translateTime: 'HH:MM:ss' } },
});

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

/**
 * Read the seed, or make one.
 *
 * A seed that funds a public network is a key. Writing it under the repository
 * is how it ends up in a commit, so a path inside the working tree is refused
 * outright rather than warned about.
 */
const resolveSeed = (): { seed: string; source: string } => {
  const fromEnv = process.env.QB_SEED?.trim();
  if (fromEnv !== undefined && fromEnv !== '') {
    return { seed: fromEnv, source: 'QB_SEED' };
  }

  const file = process.env.QB_SEED_FILE?.trim();
  if (file === undefined || file === '') {
    throw new Error(
      'quietbooks: set QB_SEED to an existing seed, or QB_SEED_FILE to a path outside this ' +
        'repository where a new one may be written.',
    );
  }

  const resolved = path.resolve(file);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Error(
      `quietbooks: refusing to keep a funded seed inside the repository (${resolved}). ` +
        'Choose a path outside the working tree.',
    );
  }

  if (fs.existsSync(resolved)) {
    const seed = fs.readFileSync(resolved, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(seed)) {
      throw new Error(`quietbooks: ${resolved} does not hold a 32-byte hex seed.`);
    }
    return { seed, source: resolved };
  }

  const seed = randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${seed}\n`, { encoding: 'utf8', mode: 0o600 });
  return { seed, source: `${resolved} (new)` };
};

const main = async (): Promise<void> => {
  const network = (process.env.QB_NETWORK ?? 'preview') as NetworkName;
  const env = NETWORKS[network];
  if (env === undefined) {
    throw new Error(`quietbooks: unknown network "${network}". Use preview or preprod.`);
  }

  setNetworkId(network);
  configureNetwork(network);

  const { seed, source } = resolveSeed();
  logger.info(`network ${network}, seed from ${source}`);

  const ctx = await buildWallet(env, seed);
  const { shielded, unshielded } = await addressesOf(ctx);
  const unshieldedText = UnshieldedAddress.codec.encode(network, unshielded).toString();
  const shieldedText = ShieldedAddress.codec.encode(network, shielded).toString();

  logger.info(`unshielded address  ${unshieldedText}`);
  logger.info(`shielded address    ${shieldedText}`);

  await waitForSync(ctx, logger);

  const night = nativeToken().raw;
  const balanceNow = async (): Promise<bigint> => {
    const state = await Rx.firstValueFrom(ctx.wallet.state());
    return (
      (state.unshielded?.balances[night] ?? 0n) + (state.shielded?.balances[night] ?? 0n)
    );
  };

  let balance = await balanceNow();
  if (balance === 0n) {
    const faucet = env.faucet ?? '';
    logger.info(`asking the ${network} faucet for NIGHT`);
    try {
      await new FaucetClient(faucet, logger).requestTokens(unshieldedText);
    } catch (error) {
      // A faucet that rate-limits, requires a human, or is simply down is not a
      // bug in this script, and the address above is all an operator needs to
      // fund the wallet by hand. Say which it was and keep waiting.
      logger.warn(
        `the faucet refused the request (${error instanceof Error ? error.message : String(error)}). ` +
          `Fund the unshielded address above at ${faucet} and leave this running.`,
      );
    }

    logger.info('waiting for NIGHT to arrive (Ctrl-C to stop)');
    balance = await Rx.firstValueFrom(
      ctx.wallet.state().pipe(
        Rx.throttleTime(5_000, undefined, { leading: true, trailing: true }),
        Rx.map(
          (s) => (s.unshielded?.balances[night] ?? 0n) + (s.shielded?.balances[night] ?? 0n),
        ),
        Rx.tap((b) => logger.info(`NIGHT=${b.toString()}`)),
        Rx.filter((b) => b > 0n),
      ),
    );
  }

  logger.info(`NIGHT balance ${balance.toString()}`);

  // Fees are paid in DUST, which only registered NIGHT generates. A wallet that
  // holds NIGHT and has not registered it looks funded and cannot submit.
  await registerForDust(ctx, logger);

  const final = await Rx.firstValueFrom(ctx.wallet.state());
  logger.info(
    `ready: NIGHT unshielded=${(final.unshielded?.balances[night] ?? 0n).toString()} ` +
      `shielded=${(final.shielded?.balances[night] ?? 0n).toString()} ` +
      `dust UTXOs=${final.dust?.availableCoins.length ?? 0}`,
  );

  await ctx.wallet.stop().catch(() => undefined);
};

await main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
