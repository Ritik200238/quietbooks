/*
 * Wallet synchronisation and funding helpers.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted closely from `bboard-cli/src/wallet-utils.ts` in
 * midnightntwrk/example-bboard (Copyright (C) Midnight Foundation, Apache-2.0).
 * The sync predicate, the throttled state stream and the faucet call are the
 * example's. The QuietBooks change is `onProgress`: the operator is told what
 * the wallet is waiting for while it waits, instead of watching an idle terminal
 * for the minute or two a first sync takes.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * You may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { UnshieldedTokenType } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { FaucetClient, type EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';
import { type FacadeState, type WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import { type ShieldedWalletAPI, type ShieldedWalletState } from '@midnight-ntwrk/wallet-sdk-shielded';
import {
  type UnshieldedWalletAPI,
  type UnshieldedWalletState,
} from '@midnight-ntwrk/wallet-sdk-unshielded-wallet';
import type { Logger } from 'pino';
import * as Rx from 'rxjs';

export const getInitialShieldedState = async (
  logger: Logger,
  wallet: ShieldedWalletAPI,
): Promise<ShieldedWalletState> => {
  logger.debug('reading the initial shielded wallet state');
  return Rx.firstValueFrom(wallet.state);
};

export const getInitialUnshieldedState = async (
  logger: Logger,
  wallet: UnshieldedWalletAPI,
): Promise<UnshieldedWalletState> => {
  logger.debug('reading the initial unshielded wallet state');
  return Rx.firstValueFrom(wallet.state);
};

const isProgressStrictlyComplete = (progress: unknown): boolean => {
  if (progress === null || typeof progress !== 'object') {
    return false;
  }
  const candidate = progress as { isStrictlyComplete?: unknown };
  if (typeof candidate.isStrictlyComplete !== 'function') {
    return false;
  }
  return (candidate.isStrictlyComplete as () => boolean)();
};

/** All three sub-wallets have to be caught up before a transaction can balance. */
const isFacadeStateSynced = (state: FacadeState): boolean =>
  isProgressStrictlyComplete(state.shielded.state.progress) &&
  isProgressStrictlyComplete(state.dust.state.progress) &&
  isProgressStrictlyComplete(state.unshielded.progress);

const describe = (state: FacadeState): string => {
  const part = (name: string, done: boolean): string => `${name}=${done ? 'synced' : 'syncing'}`;
  return [
    part('shielded', isProgressStrictlyComplete(state.shielded.state.progress)),
    part('unshielded', isProgressStrictlyComplete(state.unshielded.progress)),
    part('dust', isProgressStrictlyComplete(state.dust.state.progress)),
  ].join(', ');
};

export const syncWallet = (
  logger: Logger,
  wallet: WalletFacade,
  onProgress?: (status: string) => void,
  throttleTime = 2_000,
): Promise<FacadeState> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(throttleTime),
      Rx.tap((state: FacadeState) => {
        logger.debug(`wallet sync: ${describe(state)}`);
        onProgress?.(describe(state));
      }),
      Rx.filter((state: FacadeState) => isFacadeStateSynced(state)),
    ),
  );

/**
 * Block until the wallet holds NIGHT, optionally asking a faucet for some.
 *
 * Nothing can be deployed or called without fees, so this is the one place the
 * CLI is willing to wait indefinitely: an operator who has just been shown an
 * address needs time to fund it, and a timeout here would throw away a session
 * that was about to work.
 */
export const waitForUnshieldedFunds = async (
  logger: Logger,
  wallet: WalletFacade,
  env: EnvironmentConfiguration,
  tokenType: UnshieldedTokenType,
  options: {
    fundFromFaucet?: boolean;
    onAddress?: (address: string) => void;
    onProgress?: (status: string) => void;
    throttleTime?: number;
  } = {},
): Promise<UnshieldedWalletState> => {
  const throttleTime = options.throttleTime ?? 2_000;
  const initialState = await getInitialUnshieldedState(logger, wallet.unshielded);
  const unshieldedAddress = UnshieldedAddress.codec
    .encode(getNetworkId(), initialState.address)
    .toString();
  options.onAddress?.(unshieldedAddress);
  logger.info({ unshieldedAddress }, 'waiting for unshielded funds');

  if (options.fundFromFaucet === true && env.faucet !== undefined) {
    await new FaucetClient(env.faucet, logger).requestTokens(unshieldedAddress);
  }

  const initialBalance = initialState.balances[tokenType.raw];
  if (initialBalance !== undefined && initialBalance > 0n) {
    return initialState;
  }

  return Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(throttleTime),
      Rx.tap((state: FacadeState) => {
        const balance = state.unshielded.balances[tokenType.raw] ?? 0n;
        const status = `${describe(state)}, NIGHT=${balance.toString()}`;
        logger.debug(`waiting for funds: ${status}`);
        options.onProgress?.(status);
      }),
      Rx.filter(
        (state: FacadeState) =>
          isFacadeStateSynced(state) && (state.unshielded.balances[tokenType.raw] ?? 0n) > 0n,
      ),
      Rx.map((state: FacadeState) => state.unshielded),
    ),
  );
};
