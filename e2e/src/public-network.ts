// The public network a script runs against, read once from the environment.
//
// SPDX-License-Identifier: Apache-2.0
//
// Endpoints come from `@quietbooks/api`, which owns the one copy of the table.
// Mainnet is left out on purpose. Its NIGHT arrives from Cardano and registers
// for DUST through the cNgD DApp rather than in-wallet
// (`docs/guides/networks-and-environments.mdx`, "Funding and transaction
// cost"), and this script's funding path has only been written for the two
// test networks.

import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { publicEndpoints } from '@quietbooks/api';

export type TestNetwork = 'preview' | 'preprod';

export const selectedNetwork = (): TestNetwork => {
  const name = process.env.QB_NETWORK ?? 'preview';
  if (name !== 'preview' && name !== 'preprod') {
    throw new Error(`quietbooks: QB_NETWORK must be preview or preprod, not "${name}".`);
  }
  return name;
};

export const environmentFor = (network: TestNetwork): EnvironmentConfiguration => {
  const e = publicEndpoints(network, process.env.BLOCKFROST_PROJECT_ID);
  return {
    walletNetworkId: network,
    networkId: network,
    indexer: e.indexer,
    indexerWS: e.indexerWS,
    node: e.node,
    nodeWS: e.nodeWS,
    faucet: e.faucet,
    proofServer: process.env.QB_PROOF_SERVER ?? 'http://127.0.0.1:6300',
  };
};
