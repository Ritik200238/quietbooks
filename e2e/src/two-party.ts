// Two wallets, two people, one invoice.
//
// SPDX-License-Identifier: Apache-2.0
//
// The main end-to-end run drives the whole product against a real node, and
// makes the seller, the buyer and the arbiter three PINs of one wallet. That is
// an honest test of the authorisation rules -- the contract checks a party key
// derived from a secret, and three PINs give three genuinely different keys --
// and it is a poor test of payment. Paying the wrong party is invisible when
// every party is you. So is a shielded output the recipient cannot decrypt:
// midnight-js already knows the connected wallet's encryption key, so a
// settlement that quietly addressed itself would still have looked like a
// success.
//
// Both of those were real bugs in this project. The seller payout was
// unbound, so a buyer could settle by paying themselves and have the invoice
// recorded as settled in full. And the shared invoice record carried no seller
// encryption key at all, so a payment to anyone but yourself could not be built.
// Neither was visible to a one-wallet harness, and both are what this run is
// for.
//
// What it proves that the other run cannot: the seller's shielded balance goes
// up by the invoiced total, and the buyer's goes down, across two wallets that
// share no keys.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import * as Rx from 'rxjs';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { nativeToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';

import {
  CompiledQuietBooksContract,
  emptyPrivateState,
  payableTotal,
  prepareInvoice,
  pureCircuits,
  randomBytes32,
  type QuietBooksPrivateState,
} from '@quietbooks/contract';
import { configureNetwork, QuietBooksAPI } from '@quietbooks/api';

import {
  buildWallet,
  E2EWalletProvider,
  fundWallet,
  registerForDust,
  waitForFunds,
  waitForSync,
  type WalletContext,
} from './wallet.js';

const NETWORK_ID = 'undeployed';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZK_CONFIG_PATH = path.resolve(HERE, '..', '..', 'contract', 'build');

/** The seed that owns the genesis-minted supply on this preset. */
const SELLER_SEED = '0000000000000000000000000000000000000000000000000000000000000001';
/** Any other seed. It starts with nothing, which is the point. */
const BUYER_SEED = '00000000000000000000000000000000000000000000000000000000000000b2';

const ENV: EnvironmentConfiguration = {
  walletNetworkId: NETWORK_ID,
  networkId: NETWORK_ID,
  indexer: process.env.QB_INDEXER ?? 'http://127.0.0.1:8088/api/v4/graphql',
  indexerWS: process.env.QB_INDEXER_WS ?? 'ws://127.0.0.1:8088/api/v4/graphql/ws',
  node: process.env.QB_NODE ?? 'http://127.0.0.1:9944',
  nodeWS: process.env.QB_NODE_WS ?? 'ws://127.0.0.1:9944',
  proofServer: process.env.QB_PROOF_SERVER ?? 'http://127.0.0.1:6300',
  faucet: '',
};

const logger = pino(
  { level: process.env.QB_LOG_LEVEL ?? 'info' },
  pino.transport({ target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }),
);

type StepResult = { readonly name: string; readonly ok: boolean; readonly detail: string };
const results: StepResult[] = [];

const step = async <T>(name: string, body: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  try {
    const value = await body();
    results.push({ name, ok: true, detail: '' });
    logger.info(`PASS  ${name}  (${Date.now() - started}ms)`);
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ name, ok: false, detail });
    logger.error(`FAIL  ${name}\n      ${detail}`);
    throw error;
  }
};

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

/** The wallet's shielded NIGHT, which is what a settlement moves. */
const shieldedNight = async (ctx: WalletContext): Promise<bigint> => {
  const state = await Rx.firstValueFrom(
    ctx.wallet.state().pipe(Rx.filter((s) => s.shielded !== undefined)),
  );
  return state.shielded?.balances[nativeToken().raw] ?? 0n;
};

/** One party's providers, with a private state store of its own. */
const providersFor = (ctx: WalletContext, storeSuffix: string) => {
  const walletProvider = new E2EWalletProvider(ctx, logger);
  const zkConfigProvider = new NodeZkConfigProvider<string>(ZK_CONFIG_PATH);
  return {
    privateStateProvider: levelPrivateStateProvider<'quietBooksPrivateState', QuietBooksPrivateState>({
      // Separate stores, because these are two people. Sharing one would let the
      // buyer open the seller's invoices for reasons that have nothing to do
      // with the contract, and would make this run prove less than it appears to.
      privateStateStoreName: `quietbooks-two-party-${storeSuffix}`,
      signingKeyStoreName: `quietbooks-two-party-keys-${storeSuffix}`,
      privateStoragePasswordProvider: () => 'QuietBooks-e2e-local-1',
      accountId: storeSuffix,
    }),
    publicDataProvider: indexerPublicDataProvider(ENV.indexer, ENV.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(ENV.proofServer, zkConfigProvider),
    walletProvider,
    midnightProvider: walletProvider,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
};

const main = async (): Promise<void> => {
  setNetworkId(NETWORK_ID);
  configureNetwork(NETWORK_ID);
  logger.info(`network=${NETWORK_ID} indexer=${ENV.indexer} proofServer=${ENV.proofServer}`);

  const seller = await step('build the seller wallet from the genesis seed', () =>
    buildWallet(ENV, SELLER_SEED),
  );
  const buyer = await step('build a second wallet that owns nothing', () =>
    buildWallet(ENV, BUYER_SEED),
  );

  try {
    await step('both wallets sync', async () => {
      await waitForSync(seller, logger);
      await waitForSync(buyer, logger);
    });

    await step('the seller holds NIGHT and can pay fees', async () => {
      await waitForFunds(seller, logger);
      await registerForDust(seller, logger);
    });

    await step('the two wallets share no keys', async () => {
      // The property this whole run rests on. Not "the buyer starts empty" --
      // the local chain is persistent, so a second run finds the buyer already
      // funded and that assertion fails for a reason that says nothing about
      // the product.
      assert(
        seller.shieldedSecretKeys.coinPublicKey !== buyer.shieldedSecretKeys.coinPublicKey,
        'the two wallets have the same coin public key',
      );
      assert(
        seller.shieldedSecretKeys.encryptionPublicKey !==
          buyer.shieldedSecretKeys.encryptionPublicKey,
        'the two wallets have the same encryption key',
      );
      logger.info(`seller pays to ${seller.shieldedSecretKeys.coinPublicKey.slice(0, 16)}..`);
      logger.info(`buyer  pays from ${buyer.shieldedSecretKeys.coinPublicKey.slice(0, 16)}..`);
    });

    await step('the seller funds the buyer, who is a stranger to it', async () => {
      const before = await shieldedNight(buyer);
      const balance = await fundWallet(seller, buyer, logger, {
        shielded: 40_000_000_000_000n,
        unshielded: 40_000_000_000_000n,
      });
      assert(balance > before, `the buyer gained nothing, still holds ${balance}`);
    });

    // -----------------------------------------------------------------------
    // Two parties, two private states, one contract.
    // -----------------------------------------------------------------------

    const sellerProviders = providersFor(seller, 'seller');
    const buyerProviders = providersFor(buyer, 'buyer');

    const sellerSecret = randomBytes32();
    const buyerSecret = randomBytes32();
    const instanceSalt = randomBytes32();

    const deployed = await step('the seller deploys the contract', () =>
      deployContract(sellerProviders, {
        compiledContract: CompiledQuietBooksContract,
        privateStateId: 'quietBooksPrivateState',
        initialPrivateState: emptyPrivateState(sellerSecret),
        args: [instanceSalt],
      }),
    );
    const address = deployed.deployTxData.public.contractAddress;
    sellerProviders.privateStateProvider.setContractAddress(address);
    logger.info(`contract ${address}`);

    const sellerApi = await step('the seller opens it through the API', () =>
      QuietBooksAPI.join(sellerProviders, address, sellerSecret, logger),
    );
    const buyerApi = await step('the buyer opens the same contract', () =>
      QuietBooksAPI.join(buyerProviders, address, buyerSecret, logger),
    );

    const buyerPartyKey = pureCircuits.derivePartyKeyWith(instanceSalt, buyerSecret, 1n);
    const sellerPayout = seller.shieldedSecretKeys.coinPublicKey;

    // ---------------------------------------------------------------------
    // The invoice. The seller is paid at their own coin public key, which is a
    // key the buyer's wallet has never held.
    // ---------------------------------------------------------------------

    const { invoiceId, total } = await step('the seller issues an invoice to the buyer', async () => {
      const draft = {
        currency: 'USDM',
        lineItems: [{ description: 'Integration retainer, March', quantity: 1n, unitPrice: 3_000_000n }],
        taxAmount: 250_000n,
        memo: 'Net 30.',
        orderRef: 'PO-2026-0301',
        dueDate: BigInt(Math.floor(Date.now() / 1000)) + 30n * 86_400n,
        sellerPayout: (await import('@quietbooks/api')).coinPublicKeyBytes(sellerPayout),
      };
      const prepared = await prepareInvoice(draft);
      const result = await sellerApi.issueInvoice(draft, buyerPartyKey);
      return { invoiceId: result.invoiceId, total: payableTotal(prepared.terms) };
    });

    const shared = await step('the seller exports the record and the buyer imports it', async () => {
      const json = await sellerApi.exportInvoice(invoiceId);
      const parsed = JSON.parse(json) as { sellerEncryptionKey?: string };
      // The key that made third-party settlement possible at all. Without it in
      // the record there is nothing to build the recipient's ciphertext from,
      // and the payment cannot be constructed.
      assert(
        typeof parsed.sellerEncryptionKey === 'string' && parsed.sellerEncryptionKey.length > 0,
        'the exported record carries no seller encryption key',
      );
      const stored = await buyerApi.importInvoice(json, 'buyer');
      assert(stored.invoiceId === invoiceId, 'the buyer imported a different invoice');
      return stored;
    });

    const before = await step('measure both balances before the payment', async () => {
      const sellerBalance = await shieldedNight(seller);
      const buyerBalance = await shieldedNight(buyer);
      logger.info(`seller ${sellerBalance}, buyer ${buyerBalance}, invoice ${total}`);
      return { seller: sellerBalance, buyer: buyerBalance };
    });

    await step('the buyer pays the seller, who is a different wallet', () =>
      buyerApi.settleWithNote(
        invoiceId,
        { nonce: randomBytes32(), color: shared.terms.tokenType, value: total },
        shared.terms.sellerPayout,
        shared.sellerEncryptionKey,
      ),
    );

    // ---------------------------------------------------------------------
    // The assertion a one-wallet run cannot make.
    // ---------------------------------------------------------------------

    await step('the money arrived in the seller’s wallet, not the buyer’s', async () => {
      const settled = await Rx.firstValueFrom(
        Rx.interval(3_000).pipe(
          Rx.switchMap(async () => ({
            seller: await shieldedNight(seller),
            buyer: await shieldedNight(buyer),
          })),
          Rx.tap(({ seller: s, buyer: b }) => logger.info(`seller ${s}, buyer ${b}`)),
          Rx.filter(({ seller: s }) => s >= before.seller + total),
          Rx.timeout({ each: 240_000 }),
        ),
      );

      assert(
        settled.seller === before.seller + total,
        `the seller gained ${settled.seller - before.seller}, expected exactly ${total}`,
      );
      assert(
        settled.buyer <= before.buyer - total,
        `the buyer paid ${before.buyer - settled.buyer}, expected at least ${total}`,
      );
    });

    await step('the chain records the settlement and still hides the amount', async () => {
      const state = await sellerProviders.publicDataProvider.queryContractState(address);
      assert(state !== null, 'no contract state');
      const { fromHex, ledger } = await import('@quietbooks/contract');
      const l = ledger(state.data);
      // The ledger is keyed by the raw 32 bytes. `invoiceId` on a stored record
      // is the hex spelling of them, which `lookup` rejects with a type error
      // naming a line of the contract rather than the mistake.
      const key = fromHex(shared.invoiceId);

      assert(l.settledCount >= 1n, 'settledCount did not advance');
      assert(l.settlements.member(key), 'no settlement record for this invoice');

      // The public record of a paid invoice, in full. Not one of these is the
      // amount, and the amount is the whole reason the product exists.
      const anchor = l.invoices.lookup(key);
      const settlement = l.settlements.lookup(key);
      const published = JSON.stringify({ anchor, settlement }, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      assert(
        !published.includes(total.toString()),
        `the invoiced total ${total} is readable in public state`,
      );
      assert(
        !published.includes('3000000') && !published.includes('250000'),
        'a component of the invoice amount is readable in public state',
      );
    });
  } finally {
    await seller.wallet.stop().catch(() => undefined);
    await buyer.wallet.stop().catch(() => undefined);
  }
};

const report = (): void => {
  const passed = results.filter((r) => r.ok).length;
  process.stdout.write('\nTwo-party result\n');
  process.stdout.write('----------------\n');
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n`);
    if (!r.ok) process.stdout.write(`      ${r.detail}\n`);
  }
  process.stdout.write(`\n${passed}/${results.length} steps passed\n`);
};

main()
  .then(() => {
    report();
    process.exit(results.every((r) => r.ok) ? 0 : 1);
  })
  .catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    report();
    process.exit(1);
  });
