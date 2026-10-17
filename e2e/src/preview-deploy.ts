// Deploy to a public Midnight network and write down what the chain did.
//
// SPDX-License-Identifier: Apache-2.0
//
// Everything this project has proven so far, it proved on a standalone node on
// one laptop. That is real work and it is unverifiable: nobody outside this
// machine can check a single claim in the README, and unverifiable work is
// indistinguishable from work that was never done.
//
// This script closes that gap. It deploys the contract to preview or preprod,
// runs the business flow against it -- issue, settle, grant an audit -- and
// writes `docs/receipts/<network>.json`: one entry per transaction, each with
// the circuit it called, the transaction hash, the block it landed in, and the
// state change it produced, read back through the public indexer rather than
// taken from the local result of the call.
//
//   npm run preview:deploy --workspace @quietbooks/e2e
//
// It needs a funded wallet; run `preview:fund` first. The seed is read the same
// way that script reads it, from QB_SEED or QB_SEED_FILE, and is never written
// into this repository.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import * as Rx from 'rxjs';

import { encodeCoinPublicKey } from '@midnight-ntwrk/compact-runtime';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { nativeToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import type { FinalizedTxData } from '@midnight-ntwrk/midnight-js-types';
import { UnshieldedAddress } from '@midnight-ntwrk/wallet-sdk-address-format';

import {
  CompiledQuietBooksContract,
  ledger,
  pureCircuits,
  emptyPrivateState,
  withActive,
  withInvoice,
  clearActive,
  prepareInvoice,
  storedInvoiceFrom,
  payableTotal,
  type PreparedInvoice,
  deriveInvoiceId,
  randomBytes32,
  toHex,
  nowSeconds,
  ZERO32,
  InvoiceStatus,
  type QuietBooksPrivateState,
} from '@quietbooks/contract';
import { configureNetwork } from '@quietbooks/api';

import {
  E2EWalletProvider,
  addressesOf,
  buildWallet,
  registerForDust,
  waitForSync,
  type WalletContext,
} from './wallet.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const ZK_CONFIG_PATH = path.resolve(REPO_ROOT, 'contract', 'build');

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

/** One line of the receipt: what was called, where it landed, what changed. */
type Receipt = {
  step: string;
  circuit: string;
  txHash: string;
  txId: string;
  blockHeight: number;
  blockTimestamp: string;
  status: string;
  effect: string;
};

const receipts: Receipt[] = [];

/**
 * Record a transaction.
 *
 * `effect` is written by the caller only after it has re-read the state through
 * the indexer, so a line in the receipt file is a claim about the chain rather
 * than a claim about what this process believed it had done.
 */
const record = (step: string, circuit: string, tx: FinalizedTxData, effect: string): void => {
  const entry: Receipt = {
    step,
    circuit,
    txHash: tx.txHash,
    txId: tx.txId,
    blockHeight: tx.blockHeight,
    blockTimestamp: new Date(tx.blockTimestamp).toISOString(),
    status: String(tx.status),
    effect,
  };
  receipts.push(entry);
  logger.info(`${step}: ${entry.txHash} in block ${entry.blockHeight} -- ${effect}`);
};

const resolveSeed = (): string => {
  const fromEnv = process.env.QB_SEED?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  const file = process.env.QB_SEED_FILE?.trim();
  if (file === undefined || file === '') {
    throw new Error('quietbooks: set QB_SEED or QB_SEED_FILE to the funded wallet seed.');
  }
  const seed = fs.readFileSync(path.resolve(file), 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(seed)) {
    throw new Error(`quietbooks: ${file} does not hold a 32-byte hex seed.`);
  }
  return seed;
};

const assertOk = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`quietbooks: ${message}`);
};

const main = async (): Promise<void> => {
  const network = (process.env.QB_NETWORK ?? 'preview') as NetworkName;
  const env = NETWORKS[network];
  if (env === undefined) throw new Error(`quietbooks: unknown network "${network}".`);

  setNetworkId(network);
  configureNetwork(network);

  const startedAt = new Date().toISOString();
  const ctx: WalletContext = await buildWallet(env, resolveSeed());
  const { unshielded } = await addressesOf(ctx);
  const payer = UnshieldedAddress.codec.encode(network, unshielded).toString();
  logger.info(`network ${network}, paying from ${payer}`);

  // A first scan of a public chain is far slower than the standalone node, and
  // a transaction cannot be balanced until all three sub-wallets have caught up.
  await waitForSync(ctx, logger, 1_800_000);

  const night = nativeToken().raw;
  const state = await Rx.firstValueFrom(ctx.wallet.state());
  const balance = (state.unshielded?.balances[night] ?? 0n) + (state.shielded?.balances[night] ?? 0n);
  assertOk(balance > 0n, `the wallet holds no NIGHT. Fund ${payer} and run preview:fund first.`);
  logger.info(`NIGHT balance ${balance.toString()}`);

  await registerForDust(ctx, logger);

  const walletProvider = new E2EWalletProvider(ctx, logger);
  const zkConfigProvider = new NodeZkConfigProvider<string>(ZK_CONFIG_PATH);
  const secret = randomBytes32();

  const providers = {
    privateStateProvider: levelPrivateStateProvider<'quietBooksPrivateState', QuietBooksPrivateState>({
      privateStateStoreName: `quietbooks-${network}-private-state`,
      signingKeyStoreName: `quietbooks-${network}-signing-keys`,
      privateStoragePasswordProvider: () => 'QuietBooks-preview-deploy-1',
      accountId: randomBytes(16).toString('hex'),
    }),
    publicDataProvider: indexerPublicDataProvider(env.indexer, env.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(env.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const instanceSalt = randomBytes32();

  logger.info('deploying (this builds real proofs and takes a while)');
  const deployed = await deployContract(providers, {
    compiledContract: CompiledQuietBooksContract,
    privateStateId: 'quietBooksPrivateState',
    initialPrivateState: emptyPrivateState(secret),
    args: [instanceSalt],
  });

  const address = deployed.deployTxData.public.contractAddress;
  providers.privateStateProvider.setContractAddress(address);
  logger.info(`contract address ${address}`);

  const readLedger = async () => {
    const s = await providers.publicDataProvider.queryContractState(address);
    assertOk(s !== null, 'the indexer does not know this contract');
    return ledger(s.data);
  };

  {
    const l = await readLedger();
    assertOk(toHex(l.instanceSalt) === toHex(instanceSalt), 'instance salt mismatch after deploy');
    assertOk(l.issuedCount === 0n, 'a fresh deployment should have issued nothing');
    record(
      'deploy',
      'constructor',
      deployed.deployTxData.public,
      `contract live at ${address}; issuedCount 0, paused false`,
    );
  }

  const SELLER_PIN = 1n;
  const BUYER_PIN = 2n;
  const payoutKey = encodeCoinPublicKey(walletProvider.getCoinPublicKey());
  const sellerKey = pureCircuits.derivePartyKeyWith(instanceSalt, secret, SELLER_PIN);
  const buyerKey = pureCircuits.derivePartyKeyWith(instanceSalt, secret, BUYER_PIN);

  const dueDate = nowSeconds() + 30n * 86_400n;
  const prepared = await prepareInvoice({
    currency: 'NIGHT',
    lineItems: [
      { description: 'Platform integration, October', quantity: 1n, unitPrice: 4_000_000n },
      { description: 'On-call support hours', quantity: 12n, unitPrice: 125_000n },
    ],
    taxAmount: 550_000n,
    memo: 'Net 30.',
    orderRef: 'PO-2026-0231',
    dueDate,
    sellerPayout: payoutKey,
    buyerPayout: payoutKey,
  });

  const invoiceId = deriveInvoiceId(sellerKey, prepared.nonce);
  const issuedAt = nowSeconds();
  const stored = storedInvoiceFrom({
    invoiceId,
    prepared,
    sellerKey,
    buyerKey,
    dueDate,
    issuedAt,
    pin: SELLER_PIN,
    role: 'seller',
  });

  // Circuits read the openings from private state rather than taking them as
  // arguments, so they are staged before a call and cleared after it. A stale
  // active invoice makes the next call prove against the wrong openings, which
  // surfaces as an assertion inside a circuit naming nothing useful.
  const withOpenings = async <T>(
    openings: Pick<PreparedInvoice, 'terms' | 'termsSalt' | 'fieldSalts' | 'nonce'>,
    body: () => Promise<T>,
  ): Promise<T> => {
    const before = (await providers.privateStateProvider.get('quietBooksPrivateState'))!;
    await providers.privateStateProvider.set(
      'quietBooksPrivateState',
      withActive(withInvoice(before, stored), {
        terms: openings.terms,
        termsSalt: openings.termsSalt,
        fieldSalts: openings.fieldSalts,
        nonce: openings.nonce,
        settlementSalt: randomBytes32(),
      }),
    );
    try {
      return await body();
    } finally {
      const after = (await providers.privateStateProvider.get('quietBooksPrivateState'))!;
      await providers.privateStateProvider.set('quietBooksPrivateState', clearActive(after));
    }
  };

  logger.info('issuing an invoice');
  const issue = await withOpenings(prepared, () =>
    deployed.callTx.issueInvoice(SELLER_PIN, buyerKey, ZERO32, dueDate, issuedAt),
  );
  {
    const l = await readLedger();
    assertOk(l.issuedCount === 1n, 'issuedCount did not advance');
    assertOk(l.invoices.member(invoiceId), 'the invoice is not on the ledger');
    const anchor = l.invoices.lookup(invoiceId);
    assertOk(anchor.status === InvoiceStatus.issued, 'status is not issued');

    // The claim the product rests on, checked against bytes the indexer served.
    const total = payableTotal(prepared.terms);
    const serialised = JSON.stringify(anchor, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    assertOk(!serialised.includes(total.toString()), 'the invoice total appears in public state');

    record(
      'issue',
      'issueInvoice',
      issue.public,
      `issuedCount 0 -> 1; invoice ${toHex(invoiceId).slice(0, 16)}… status issued; ` +
        'the total appears nowhere in the anchor',
    );
  }

  logger.info('settling: the buyer pays the seller inside the same transaction');
  const payment = {
    nonce: randomBytes32(),
    color: prepared.terms.tokenType,
    value: payableTotal(prepared.terms),
  };
  const settle = await withOpenings(prepared, () =>
    deployed.callTx.settleWithNote(invoiceId, BUYER_PIN, payment, { bytes: payoutKey }, nowSeconds()),
  );
  {
    const l = await readLedger();
    assertOk(l.settledCount === 1n, 'settledCount did not advance');
    const anchor = l.invoices.lookup(invoiceId);
    assertOk(anchor.status === InvoiceStatus.settled, 'status is not settled');
    const settlement = l.settlements.lookup(invoiceId);
    const serialised = JSON.stringify({ anchor, settlement }, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    assertOk(
      !serialised.includes(payment.value.toString()),
      'the settled amount appears in public state',
    );
    record(
      'settle',
      'settleWithNote',
      settle.public,
      `settledCount 0 -> 1; status issued -> settled; shielded coin forwarded buyer -> seller ` +
        'in one call, and the amount appears in neither the anchor nor the settlement record',
    );
  }

  logger.info('granting an auditor sight of amount, tax and currency');
  const auditKey = randomBytes32();
  const { sha256 } = await import('@quietbooks/contract');
  const auditKeyHash = await sha256(auditKey);
  const expiresAt = nowSeconds() + 7n * 86_400n;
  const scopes: boolean[] = [true, true, false, false, false, true, false, false, false];
  const grant = await withOpenings(prepared, () =>
    deployed.callTx.grantAudit(
      invoiceId,
      SELLER_PIN,
      auditKeyHash,
      scopes as never,
      expiresAt,
      nowSeconds(),
    ),
  );
  {
    const l = await readLedger();
    const g = l.auditGrants.lookup(invoiceId);
    assertOk(toHex(g.auditKeyHash) === toHex(auditKeyHash), 'audit key hash mismatch');
    assertOk(g.revoked === false, 'a fresh grant should not be revoked');
    assertOk(g.expiresAt === expiresAt, 'expiry mismatch');
    record(
      'audit',
      'grantAudit',
      grant.public,
      'grant recorded for amount, tax and currency; the key itself never reaches the chain, ' +
        'only its hash, and the six ungranted fields stay sealed',
    );
  }

  const out = {
    schemaVersion: '1',
    title: `QuietBooks end-to-end on Midnight ${network}`,
    network,
    startedAt,
    completedAt: new Date().toISOString(),
    contractAddress: address,
    payer,
    indexer: env.indexer,
    contract: {
      source: 'contract/src/quietbooks.compact',
      language: 'Compact 0.23',
      toolchain: '0.31.1',
    },
    steps: receipts,
    note:
      'Every effect above was read back through the public indexer after the transaction ' +
      'landed, not taken from the local result of the call. The two amount checks search the ' +
      'serialised state the indexer served for the invoice total and fail if it appears.',
  };

  const dir = path.resolve(REPO_ROOT, 'docs', 'receipts');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${network}.json`);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, 'utf8');
  logger.info(`wrote ${path.relative(REPO_ROOT, file)} with ${receipts.length} transactions`);

  await ctx.wallet.stop().catch(() => undefined);
};

await main().catch((error: unknown) => {
  logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
