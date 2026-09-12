// Assembling the providers the QuietBooks API runs on.
//
// SPDX-License-Identifier: Apache-2.0
//
// Same shape as the official example-bboard interface, with two deliberate
// differences:
//
//  * private state is written to browser storage rather than held in memory,
//    because in QuietBooks it is the only thing that can ever open an invoice;
//  * every endpoint can be overridden from the environment, falling back to what
//    the wallet reports. The proof server in particular sees the witness values
//    for every call, so anyone who is not running their own should at least be
//    able to see which one they are using.

import type { ConnectedAPI } from '@midnight-ntwrk/dapp-connector-api';
import { FetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import {
  Binding,
  FinalizedTransaction,
  Proof,
  SignatureEnabled,
  Transaction,
  type TransactionId,
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { fromHex, toHex } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import type { UnboundTransaction } from '@midnight-ntwrk/midnight-js-types';
import type {
  QuietBooksCircuitKeys,
  QuietBooksProviders,
} from '@quietbooks/api';
import type { QuietBooksPrivateState } from '@quietbooks/contract';

import { logger } from './logger';
import { createBrowserPrivateStateProvider } from './private-state-provider';

/** Where the interface is talking to, as the header shows it. */
export type Endpoints = {
  readonly networkId: string;
  readonly indexerUri: string;
  readonly indexerWsUri: string;
  readonly proofServerUri: string;
  readonly zkConfigUri: string;
};

export const networkId = (): string => import.meta.env.VITE_NETWORK_ID ?? 'testnet';

const setting = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

export type BuiltProviders = {
  readonly providers: QuietBooksProviders;
  readonly endpoints: Endpoints;
  readonly shieldedCoinPublicKey: string;
};

/**
 * Build every provider the API needs from one connected wallet.
 *
 * The wallet's own configuration is the fallback rather than the source of
 * truth, so that pointing this interface at a local node is a matter of setting
 * two variables and not of reconfiguring the extension.
 */
export const buildProviders = async (connected: ConnectedAPI): Promise<BuiltProviders> => {
  const walletConfig = await connected.getConfiguration();
  const shieldedAddresses = await connected.getShieldedAddresses();

  const endpoints: Endpoints = {
    networkId: networkId(),
    indexerUri: setting(import.meta.env.VITE_INDEXER_URI) ?? walletConfig.indexerUri,
    indexerWsUri: setting(import.meta.env.VITE_INDEXER_WS_URI) ?? walletConfig.indexerWsUri,
    proofServerUri:
      setting(import.meta.env.VITE_PROOF_SERVER_URI) ?? walletConfig.proverServerUri ?? '',
    // The proving keys are served from this application's own origin: both the
    // dev server and the production build place `keys/` and `zkir/` there.
    zkConfigUri: setting(import.meta.env.VITE_ZK_CONFIG_URI) ?? window.location.origin,
  };

  if (endpoints.proofServerUri.length === 0) {
    throw new Error(
      'No proof server. Every write in QuietBooks is a zero-knowledge proof and it is ' +
        'built there, so set VITE_PROOF_SERVER_URI or configure one in the wallet.',
    );
  }

  const zkConfigProvider = new FetchZkConfigProvider<QuietBooksCircuitKeys>(
    endpoints.zkConfigUri,
    fetch.bind(window),
  );

  const providers: QuietBooksProviders = {
    privateStateProvider: createBrowserPrivateStateProvider<
      'quietBooksPrivateState',
      QuietBooksPrivateState
    >(),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(endpoints.proofServerUri, zkConfigProvider),
    publicDataProvider: indexerPublicDataProvider(endpoints.indexerUri, endpoints.indexerWsUri),
    walletProvider: {
      getCoinPublicKey: () => shieldedAddresses.shieldedCoinPublicKey,
      getEncryptionPublicKey: () => shieldedAddresses.shieldedEncryptionPublicKey,
      balanceTx: async (tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> => {
        logger.info({ ttl }, 'asking the wallet to balance a transaction');
        const balanced = await connected.balanceUnsealedTransaction(toHex(tx.serialize()));
        return Transaction.deserialize<SignatureEnabled, Proof, Binding>(
          'signature',
          'proof',
          'binding',
          fromHex(balanced.tx),
        );
      },
    },
    midnightProvider: {
      submitTx: async (tx: FinalizedTransaction): Promise<TransactionId> => {
        await connected.submitTransaction(toHex(tx.serialize()));
        const identifiers = tx.identifiers();
        logger.info({ identifiers }, 'transaction submitted');
        return identifiers[0];
      },
    },
  };

  return { providers, endpoints, shieldedCoinPublicKey: shieldedAddresses.shieldedCoinPublicKey };
};
