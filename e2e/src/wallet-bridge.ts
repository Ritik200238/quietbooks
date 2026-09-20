// Drive the real web interface with a real wallet, without a browser extension.
//
// SPDX-License-Identifier: Apache-2.0
//
// The web interface talks to a wallet through the DApp connector API: it looks
// for a connector on `window.midnight`, calls `connect`, and from then on asks it
// for addresses and configuration and hands it transactions to balance and
// submit. In production that connector is the Lace extension.
//
// This serves the same six calls from a headless wallet running here, against
// the local node, so the interface can be exercised end to end -- deploy, issue,
// settle, audit -- by automation that cannot install an extension. Nothing about
// the interface changes and nothing is simulated: the page builds real proofs on
// the real proof server, the wallet really balances and signs, the node really
// includes the transactions. What differs from Lace is only whose code holds the
// keys.
//
// It is also the only way this repository has to test the interface's wallet
// path at all, which matters: the worst bug the interface shipped was in that
// path, and nothing could reach it.
//
//   npm run wallet-bridge --workspace @quietbooks/e2e
//
// then, in the page, before connecting:
//
//   await import('http://127.0.0.1:7788/connector.js')
//
// Local network only. It holds the genesis seed and signs whatever the page
// asks it to, so it listens on loopback and nowhere else.

import http from 'node:http';
import pino from 'pino';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { Transaction } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import {
  ShieldedAddress,
  ShieldedCoinPublicKey,
  ShieldedEncryptionPublicKey,
} from '@midnight-ntwrk/wallet-sdk-address-format';

import {
  buildWallet,
  E2EWalletProvider,
  registerForDust,
  waitForFunds,
  waitForSync,
} from './wallet.js';

const PORT = Number(process.env.QB_BRIDGE_PORT ?? 7788);
const NETWORK_ID = 'undeployed';
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

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

const logger = pino(
  { level: 'info' },
  pino.transport({ target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }),
);

/**
 * The page-side half: a connector object shaped like the one Lace injects.
 *
 * Served as a module so the page can import it by URL, which keeps this file
 * the single description of what the bridge offers.
 */
const connectorModule = (origin: string): string => `
const call = async (path, body) => {
  const response = await fetch('${origin}' + path, body === undefined
    ? {}
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? ('wallet bridge ' + path + ' failed'));
  return payload;
};

window.midnight = window.midnight ?? {};
window.midnight.quietbooksHeadless = {
  name: 'QuietBooks headless wallet (local node)',
  icon: '',
  apiVersion: '4.0.1',
  rdns: 'dev.quietbooks.headless',
  connect: async (networkId) => {
    const config = await call('/config');
    if (networkId !== config.networkId) {
      throw new Error('this wallet is on ' + config.networkId + ', not ' + networkId);
    }
    return {
      getConnectionStatus: async () => ({ status: 'connected', networkId: config.networkId }),
      getConfiguration: async () => config,
      getShieldedAddresses: async () => call('/addresses'),
      balanceUnsealedTransaction: async (tx) => call('/balance', { tx }),
      submitTransaction: async (tx) => { await call('/submit', { tx }); },
      hintUsage: async () => undefined,
    };
  },
};
export {};
`;

const readBody = (request: http.IncomingMessage): Promise<{ tx?: string }> =>
  new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
    });
    request.on('end', () => {
      try {
        resolve(data.length === 0 ? {} : (JSON.parse(data) as { tx?: string }));
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });

const hexToBytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const bytesToHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

const main = async (): Promise<void> => {
  setNetworkId(NETWORK_ID);

  logger.info('building the wallet from the genesis seed');
  const ctx = await buildWallet(ENV, GENESIS_SEED);
  await waitForSync(ctx, logger);
  await waitForFunds(ctx, logger);
  await registerForDust(ctx, logger);
  const provider = new E2EWalletProvider(ctx, logger);

  // The interface decodes both spellings of a coin public key, and a browser
  // wallet hands out Bech32m. Serving that form is what exercises the code path
  // that was broken, rather than the hex path that always worked.
  const cpk = ShieldedCoinPublicKey.fromHexString(ctx.shieldedSecretKeys.coinPublicKey);
  const epk = ShieldedEncryptionPublicKey.fromHexString(ctx.shieldedSecretKeys.encryptionPublicKey);
  const addresses = {
    shieldedAddress: ShieldedAddress.codec.encode(NETWORK_ID, new ShieldedAddress(cpk, epk)).toString(),
    shieldedCoinPublicKey: ShieldedCoinPublicKey.codec.encode(NETWORK_ID, cpk).toString(),
    shieldedEncryptionPublicKey: ShieldedEncryptionPublicKey.codec.encode(NETWORK_ID, epk).toString(),
  };

  const config = {
    indexerUri: ENV.indexer,
    indexerWsUri: ENV.indexerWS,
    proverServerUri: ENV.proofServer,
    substrateNodeUri: ENV.nodeWS,
    networkId: NETWORK_ID,
  };

  const server = http.createServer((request, response) => {
    const send = (status: number, body: unknown, type = 'application/json'): void => {
      response.writeHead(status, {
        'content-type': type,
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (request.method === 'OPTIONS') {
      send(204, '');
      return;
    }

    const route = `${request.method} ${request.url}`;
    void (async () => {
      try {
        switch (route) {
          case 'GET /connector.js':
            send(200, connectorModule(`http://127.0.0.1:${PORT}`), 'text/javascript');
            return;
          case 'GET /config':
            send(200, config);
            return;
          case 'GET /addresses':
            send(200, addresses);
            return;
          case 'POST /balance': {
            const { tx } = await readBody(request);
            if (tx === undefined) throw new Error('no transaction to balance');
            const unbound = Transaction.deserialize('signature', 'proof', 'pre-binding', hexToBytes(tx));
            logger.info('balancing a transaction for the page');
            const finalized = await provider.balanceTx(unbound as never);
            send(200, { tx: bytesToHex(finalized.serialize()) });
            return;
          }
          case 'POST /submit': {
            const { tx } = await readBody(request);
            if (tx === undefined) throw new Error('no transaction to submit');
            const finalized = Transaction.deserialize('signature', 'proof', 'binding', hexToBytes(tx));
            const id = await provider.submitTx(finalized as never);
            send(200, { id });
            return;
          }
          default:
            send(404, { error: `no route ${route}` });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`${route}: ${message}`);
        send(500, { error: message });
      }
    })();
  });

  server.listen(PORT, '127.0.0.1', () => {
    logger.info(`wallet bridge ready on http://127.0.0.1:${PORT}`);
    logger.info(`shielded coin public key ${addresses.shieldedCoinPublicKey}`);
  });
};

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
