// Where each public Midnight network lives, and where a stranger can check it.
//
// SPDX-License-Identifier: Apache-2.0
//
// This table used to be written out three times -- once in the CLI, once in the
// faucet script, once in the deploy script -- and all three copies went stale on
// the same day. Midnight shut down its own Preprod indexer and RPC at 22:00 UTC on
// 9 October 2026 and moved them to Blockfrost, behind a per-project token; the
// old hostname now answers every query with ENDPOINT_DECOMMISSIONED. Preview
// stayed Midnight-hosted and tokenless. Source for both, and for every URL below:
// `docs/guides/networks-and-environments.mdx` at midnight-docs 61f6009
// (2026-10-15), the "Environment reference" section.
//
// The explorer links are the part a judge, an auditor or a counterparty uses.
// The docs name the three explorers per network but not their URL shapes, so
// those were checked by hand on 2026-10-19 against a real Preview transaction
// (`3f7a3e6e…f942`, block 1,354,587): Midnight Explorer serves
// `/transactions/<hash>` and answers `/tx/<hash>` with a 404; Subscan serves
// `/tx/<hash>`; 1am routes `/tx/:txHash` and `/contract/:contractAddr`, read
// from its client bundle. A contract page is only listed where the shape was
// seen, which today means 1am alone.

export type PublicNetwork = 'preview' | 'preprod' | 'mainnet';

export const PUBLIC_NETWORKS: readonly PublicNetwork[] = ['preview', 'preprod', 'mainnet'];

export const isPublicNetwork = (value: string): value is PublicNetwork =>
  (PUBLIC_NETWORKS as readonly string[]).includes(value);

/** The endpoints a wallet and a DApp need, in the shape testkit-js consumes. */
export type PublicEndpoints = {
  networkId: PublicNetwork;
  indexer: string;
  indexerWS: string;
  node: string;
  nodeWS: string;
  /** Absent on mainnet, which has no faucet. */
  faucet?: string;
};

export type ExplorerLink = { explorer: string; url: string };

export class EndpointError extends Error {
  constructor(message: string) {
    super(`quietbooks: ${message}`);
    this.name = 'EndpointError';
  }
}

// A Blockfrost project id names its network in its prefix -- `nightpreprod` or
// `nightmainnet` -- and Blockfrost rejects a token used on the other network.
// Checking here turns a 403 from a remote server into a sentence about the
// mistake that caused it.
const BLOCKFROST_PREFIX: Record<Exclude<PublicNetwork, 'preview'>, string> = {
  preprod: 'nightpreprod',
  mainnet: 'nightmainnet',
};

const withToken = (url: string, token: string): string =>
  `${url}?project_id=${encodeURIComponent(token)}`;

/**
 * The endpoints for one public network.
 *
 * @param blockfrostProjectId Required for `preprod` and `mainnet`, ignored for
 *   `preview`. Read it from `BLOCKFROST_PROJECT_ID`; it is a credential, so it
 *   never belongs in this repository.
 */
export const publicEndpoints = (
  network: PublicNetwork,
  blockfrostProjectId?: string,
): PublicEndpoints => {
  if (network === 'preview') {
    return {
      networkId: 'preview',
      indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
      indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
      node: 'https://rpc.preview.midnight.network',
      nodeWS: 'wss://rpc.preview.midnight.network',
      faucet: 'https://midnight-tmnight-preview.nethermind.dev/',
    };
  }

  const token = blockfrostProjectId?.trim() ?? '';
  if (token === '') {
    throw new EndpointError(
      `${network} is served by Blockfrost and needs a project token. Create a ` +
        `"Midnight ${network === 'preprod' ? 'Preprod' : 'Mainnet'}" project at ` +
        'https://blockfrost.io and set BLOCKFROST_PROJECT_ID.',
    );
  }
  const prefix = BLOCKFROST_PREFIX[network];
  if (!token.startsWith(prefix)) {
    throw new EndpointError(
      `that Blockfrost token is not a ${network} token: ${network} project ids start ` +
        `with "${prefix}", and Blockfrost refuses a token issued for another network.`,
    );
  }

  const host = `midnight-${network}.blockfrost.io`;
  return {
    networkId: network,
    indexer: withToken(`https://${host}/api/v0`, token),
    indexerWS: withToken(`wss://${host}/api/v0/ws`, token),
    node: withToken(`https://rpc.${host}`, token),
    nodeWS: withToken(`wss://rpc.${host}`, token),
    ...(network === 'preprod' ? { faucet: 'https://midnight-tmnight-preprod.nethermind.dev/' } : {}),
  };
};

/**
 * Remove the Blockfrost token from a URL before it is logged or written down.
 *
 * Receipts are committed to the repository and logs get pasted into issues, so
 * nothing that leaves this process should carry a credential.
 */
export const redactToken = (url: string): string =>
  url.replace(/([?&]project_id=)[^&]*/g, '$1<redacted>');

const subdomain = (network: PublicNetwork): string => (network === 'mainnet' ? '' : `${network}.`);
const subscanHost = (network: PublicNetwork): string =>
  network === 'mainnet' ? 'midnight.subscan.io' : `midnight-${network}.subscan.io`;
const oneAmQuery = (network: PublicNetwork): string =>
  network === 'mainnet' ? '' : `?network=${network}`;

const HEX = /^[0-9a-f]+$/i;

/** Every page where a third party can look this transaction up. */
export const transactionLinks = (network: PublicNetwork, txHash: string): ExplorerLink[] => {
  if (!HEX.test(txHash)) throw new EndpointError(`"${txHash}" is not a hex transaction hash.`);
  const hash = txHash.toLowerCase();
  return [
    {
      explorer: 'Midnight Explorer',
      url: `https://${subdomain(network)}midnightexplorer.com/transactions/${hash}`,
    },
    { explorer: 'Subscan', url: `https://${subscanHost(network)}/tx/${hash}` },
    { explorer: '1am', url: `https://explorer.1am.xyz/tx/${hash}${oneAmQuery(network)}` },
  ];
};

/** Every page where a third party can look this contract up. */
export const contractLinks = (network: PublicNetwork, address: string): ExplorerLink[] => {
  if (!HEX.test(address)) throw new EndpointError(`"${address}" is not a hex contract address.`);
  return [
    {
      explorer: '1am',
      url: `https://explorer.1am.xyz/contract/${address.toLowerCase()}${oneAmQuery(network)}`,
    },
  ];
};
