/*
 * Wallet provider for the QuietBooks CLI.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted closely from `bboard-cli/src/midnight-wallet-provider.ts` in
 * midnightntwrk/example-bboard (Copyright (C) Midnight Foundation, Apache-2.0).
 * The class, the FluentWalletBuilder usage, the dust options and the
 * balance/sign/finalize sequence are the example's; the QuietBooks changes are
 * that the seed and address are returned to the caller instead of being logged,
 * so the interface can present them where the operator is looking, and that the
 * coin public key is exposed as hex for the escrow payout prompts.
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

import {
  type CoinPublicKey,
  DustSecretKey,
  type EncPublicKey,
  type FinalizedTransaction,
  LedgerParameters,
  ZswapSecretKeys,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import {
  type MidnightProvider,
  type UnboundTransaction,
  type WalletProvider,
} from '@midnight-ntwrk/midnight-js-types';
import { ttlOneHour } from '@midnight-ntwrk/midnight-js-utils';
import {
  type DustWalletOptions,
  type EnvironmentConfiguration,
  FluentWalletBuilder,
} from '@midnight-ntwrk/testkit-js';
import { type WalletFacade } from '@midnight-ntwrk/wallet-sdk-facade';
import type { Logger } from 'pino';

import { getInitialShieldedState } from './wallet-utils.js';

type UnshieldedKeystore = {
  getPublicKey(): unknown;
  signData(payload: Uint8Array): string;
};

export class MidnightWalletProvider implements MidnightProvider, WalletProvider {
  private constructor(
    readonly logger: Logger,
    readonly env: EnvironmentConfiguration,
    readonly wallet: WalletFacade,
    readonly zswapSecretKeys: ZswapSecretKeys,
    readonly dustSecretKey: DustSecretKey,
    readonly unshieldedKeystore: UnshieldedKeystore,
    /** The seed this wallet was built from. Shown once, so it can be reused. */
    readonly seed: string,
    /** The shielded address, for funding this wallet from a faucet. */
    readonly shieldedAddress: string,
  ) {}

  getCoinPublicKey(): CoinPublicKey {
    return this.zswapSecretKeys.coinPublicKey;
  }

  getEncryptionPublicKey(): EncPublicKey {
    return this.zswapSecretKeys.encryptionPublicKey;
  }

  async balanceTx(tx: UnboundTransaction, ttl: Date = ttlOneHour()): Promise<FinalizedTransaction> {
    const recipe = await this.wallet.balanceUnboundTransaction(
      tx,
      { shieldedSecretKeys: this.zswapSecretKeys, dustSecretKey: this.dustSecretKey },
      { ttl },
    );
    const signed = await this.wallet.signRecipe(recipe, (payload) =>
      this.unshieldedKeystore.signData(payload),
    );
    return this.wallet.finalizeRecipe(signed);
  }

  submitTx(tx: FinalizedTransaction): Promise<string> {
    return this.wallet.submitTransaction(tx);
  }

  async start(): Promise<void> {
    await this.wallet.start(this.zswapSecretKeys, this.dustSecretKey);
  }

  async stop(): Promise<void> {
    return this.wallet.stop();
  }

  static async build(
    logger: Logger,
    env: EnvironmentConfiguration,
    seed?: string,
  ): Promise<MidnightWalletProvider> {
    const dustOptions: DustWalletOptions = {
      ledgerParams: LedgerParameters.initialParameters(),
      // The local node's fee model differs enough from the public networks that
      // one overhead figure cannot serve both; this is the example's split.
      additionalFeeOverhead: env.walletNetworkId === 'undeployed' ? 500_000_000_000_000_000n : 1_000n,
      feeBlocksMargin: 5,
    };

    const builder = FluentWalletBuilder.forEnvironment(env).withDustOptions(dustOptions);
    const built =
      seed !== undefined && seed.length > 0
        ? await builder.withSeed(seed).buildWithoutStarting()
        : await builder.withRandomSeed().buildWithoutStarting();

    const { wallet, seeds, keystore } = built as unknown as {
      wallet: WalletFacade;
      seeds: { masterSeed: string; shielded: Uint8Array; dust: Uint8Array };
      keystore: UnshieldedKeystore;
    };

    const initialState = await getInitialShieldedState(logger, wallet.shielded);

    return new MidnightWalletProvider(
      logger,
      env,
      wallet,
      ZswapSecretKeys.fromSeed(seeds.shielded),
      DustSecretKey.fromSeed(seeds.dust),
      keystore,
      seeds.masterSeed,
      initialState.address.coinPublicKeyString(),
    );
  }
}
