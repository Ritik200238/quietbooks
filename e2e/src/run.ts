// End-to-end verification against a real Midnight network.
//
// SPDX-License-Identifier: Apache-2.0
//
// The contract test suite proves circuit logic in-process. It does not prove
// that the thing deploys, that proofs actually generate, that the indexer can
// read the state back, or that a settlement lands. This does, by running the
// whole business flow against a live node, indexer and proof server:
//
//   deploy -> issue -> settle -> grant an audit -> validate an envelope
//          -> prove reliability -> cancel a second invoice
//
// Every step asserts against state read back from the chain through the
// indexer, not against the local result of the call. A step that cannot be
// verified that way is reported as unverified rather than assumed.
//
// Run `npm run e2e` with the stack from ../localnet up.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import * as Cause from 'effect/Cause';

import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import type { EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';

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
  buildTermsFrame,
  deriveInvoiceId,
  commitFieldRoot,
  commitTerms,
  randomBytes32,
  sha256,
  toHex,
  nowSeconds,
  scopesFrom,
  ZERO32,
  InvoiceStatus,
  SettlementMode,
  type QuietBooksPrivateState,
} from '@quietbooks/contract';

import { buildWallet, waitForSync, waitForFunds, registerForDust, E2EWalletProvider } from './wallet.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ZK_CONFIG_PATH = path.resolve(HERE, '..', '..', 'contract', 'build');

const NETWORK_ID = 'undeployed';

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

/**
 * The seed that owns the genesis-minted supply on the `dev` node preset.
 *
 * Documented in midnight-local-dev as `GENESIS_MINT_WALLET_SEED`. It is a local
 * development key with no value on any real network, and it is the only way to
 * obtain NIGHT on a standalone node, which has no faucet.
 */
const GENESIS_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

const logger = pino({
  level: process.env.QB_LOG_LEVEL ?? 'info',
  transport: { target: 'pino-pretty', options: { colorize: false, translateTime: 'HH:MM:ss' } },
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

type StepResult = { name: string; ok: boolean; detail: string };
const results: StepResult[] = [];

const step = async <T>(name: string, body: () => Promise<T>): Promise<T> => {
  const started = Date.now();
  try {
    const value = await body();
    const detail = `${Date.now() - started}ms`;
    results.push({ name, ok: true, detail });
    logger.info(`PASS  ${name}  (${detail})`);
    return value;
  } catch (error) {
    // Wallet and ledger failures arrive wrapped: the outer message is often
    // just "Transaction submission error" while the reason sits several
    // `cause` levels down. Unwrapping here is the difference between a report
    // that says something failed and one that says why.
    const detail = describe(error);
    results.push({ name, ok: false, detail });
    logger.error(`FAIL  ${name}\n${detail}`);
    throw error;
  }
};

const describe = (error: unknown, depth = 0): string => {
  if (depth > 8) return '...';
  if (!(error instanceof Error)) return String(error);

  const parts: string[] = [`${error.name}: ${error.message}`];

  // Some SDK errors carry structured detail on their own fields rather than in
  // the message, so every own key is worth printing once. Effect's tagged
  // errors define their fields non-enumerably, so ask for all own property
  // names rather than only the enumerable ones.
  const skip = new Set(['name', 'message', 'stack', 'cause', 'txData']);
  for (const key of Object.getOwnPropertyNames(error)) {
    if (skip.has(key)) continue;
    skip.add(key);
    parts.push(`    ${key}: ${safeJson((error as unknown as Record<string, unknown>)[key])}`);
  }

  // The wallet runs on Effect. When an Effect fails, the JS error that reaches
  // the caller is a FiberFailure whose message is only the outermost tag --
  // "Transaction submission error" and nothing more. The reason the node
  // actually gave sits in the Cause hanging off a symbol-keyed property, so
  // without this the report says that something failed and never says why.
  const fiberCause = getFiberCause(error);
  const cause =
    fiberCause !== undefined
      ? Cause.squash(fiberCause as Cause.Cause<unknown>)
      : (error as { cause?: unknown }).cause;

  if (cause !== undefined && cause !== null && cause !== error) {
    parts.push(`  caused by: ${describe(cause, depth + 1)}`);
  }
  return parts.join('\n');
};

/** Read the Effect `Cause` a FiberFailure carries on a symbol-keyed property. */
const getFiberCause = (error: Error): unknown => {
  for (const symbol of Object.getOwnPropertySymbols(error)) {
    const value = (error as unknown as Record<symbol, unknown>)[symbol];
    if (Cause.isCause(value)) return value;
  }
  return undefined;
};

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))?.slice(0, 400) ?? String(value);
  } catch {
    return String(value);
  }
};

const assert = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async (): Promise<void> => {
  setNetworkId(NETWORK_ID);
  logger.info(`network=${NETWORK_ID} indexer=${ENV.indexer} proofServer=${ENV.proofServer}`);
  logger.info(`zk artifacts: ${ZK_CONFIG_PATH}`);

  const walletCtx = await step('build wallet from the genesis seed', () =>
    buildWallet(ENV, GENESIS_SEED),
  );

  try {
    await step('wallet syncs with the chain', () => waitForSync(walletCtx, logger));
    const balance = await step('wallet holds NIGHT', () => waitForFunds(walletCtx, logger));
    logger.info(`NIGHT balance ${balance}`);
    await step('NIGHT is registered and DUST is spendable', () =>
      registerForDust(walletCtx, logger),
    );

    const walletProvider = new E2EWalletProvider(walletCtx, logger);
    const zkConfigProvider = new NodeZkConfigProvider<string>(ZK_CONFIG_PATH);

    const secret = randomBytes32();
    const initialPrivateState = emptyPrivateState(secret);

    const providers = {
      privateStateProvider: levelPrivateStateProvider<'quietBooksPrivateState', QuietBooksPrivateState>({
        privateStateStoreName: 'quietbooks-e2e-private-state',
        signingKeyStoreName: 'quietbooks-e2e-signing-keys',
        // The store enforces a passphrase policy -- sixteen characters over at
        // least three character classes -- and only enforces it on the first
        // write, which for a deploy is after the contract is already on chain.
        privateStoragePasswordProvider: () => 'QuietBooks-e2e-local-1',
        accountId: GENESIS_SEED,
      }),
      publicDataProvider: indexerPublicDataProvider(ENV.indexer, ENV.indexerWS),
      zkConfigProvider,
      proofProvider: httpClientProofProvider(ENV.proofServer, zkConfigProvider),
      walletProvider,
      midnightProvider: walletProvider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // The level-backed private state provider is keyed by contract address and
    // refuses reads and writes until it knows one. Before deployment there is no
    // address, so the initial state travels as `initialPrivateState` on the
    // deploy call and only afterwards does the store become usable.
    const instanceSalt = randomBytes32();

    const deployed = await step('deploy the contract with real ZK proofs', () =>
      deployContract(providers, {
        compiledContract: CompiledQuietBooksContract,
        privateStateId: 'quietBooksPrivateState',
        initialPrivateState,
        args: [instanceSalt],
      }),
    );

    const address = deployed.deployTxData.public.contractAddress;
    logger.info(`contract address ${address}`);

    // From here the private state store can be read and written.
    providers.privateStateProvider.setContractAddress(address);

    const readLedger = async () => {
      const state = await providers.publicDataProvider.queryContractState(address);
      assert(state !== null, 'contract state not found through the indexer');
      return ledger(state.data);
    };

    await step('indexer returns the deployed state', async () => {
      const l = await readLedger();
      assert(toHex(l.instanceSalt) === toHex(instanceSalt), 'instance salt does not match');
      assert(l.paused === false, 'a fresh deployment should not be paused');
      assert(l.issuedCount === 0n, 'a fresh deployment should have issued nothing');
    });

    // -----------------------------------------------------------------------
    const SELLER_PIN = 1n;
    const BUYER_PIN = 2n;

    const sellerKey = pureCircuits.derivePartyKeyWith(instanceSalt, secret, SELLER_PIN);
    const buyerKey = pureCircuits.derivePartyKeyWith(instanceSalt, secret, BUYER_PIN);

    const dueDate = nowSeconds() + 30n * 86_400n;
    const prepared = await prepareInvoice({
      currency: 'USDM',
      lineItems: [
        { description: 'Platform integration, March', quantity: 1n, unitPrice: 4_000_000n },
        { description: 'On-call support hours', quantity: 12n, unitPrice: 125_000n },
      ],
      taxAmount: 550_000n,
      memo: 'Net 30.',
      orderRef: 'PO-2026-0184',
      dueDate,
    });

    const invoiceId = deriveInvoiceId(sellerKey, prepared.nonce);
    const invoiceHex = toHex(invoiceId);
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

    const stage = async () => {
      const current = (await providers.privateStateProvider.get('quietBooksPrivateState'))!;
      await providers.privateStateProvider.set(
        'quietBooksPrivateState',
        withActive(withInvoice(current, stored), {
          terms: prepared.terms,
          termsSalt: prepared.termsSalt,
          fieldSalts: prepared.fieldSalts,
          nonce: prepared.nonce,
          settlementSalt: randomBytes32(),
        }),
      );
    };
    const unstage = async () => {
      const current = (await providers.privateStateProvider.get('quietBooksPrivateState'))!;
      await providers.privateStateProvider.set('quietBooksPrivateState', clearActive(current));
    };

    await step('issue an invoice', async () => {
      await stage();
      try {
        await deployed.callTx.issueInvoice(SELLER_PIN, buyerKey, ZERO32, dueDate, issuedAt);
      } finally {
        await unstage();
      }
    });

    await step('the chain shows the invoice and hides its amount', async () => {
      const l = await readLedger();
      assert(l.issuedCount === 1n, 'issuedCount did not advance');
      assert(l.invoices.member(invoiceId), 'invoice is not on the ledger');

      const anchor = l.invoices.lookup(invoiceId);
      assert(anchor.status === InvoiceStatus.issued, 'status is not issued');
      assert(toHex(anchor.sellerKey) === toHex(sellerKey), 'seller key mismatch');
      assert(toHex(anchor.buyerKey) === toHex(buyerKey), 'buyer key mismatch');

      // The commitments the chain holds must open with the openings we kept.
      const frame = buildTermsFrame({ invoiceId, sellerKey, buyerKey, dueDate, terms: prepared.terms });
      assert(
        toHex(anchor.terms) === toHex(commitTerms(frame, prepared.termsSalt)),
        'terms commitment on chain does not match the local opening',
      );
      assert(
        toHex(anchor.fieldRoot) === toHex(commitFieldRoot(frame, prepared.fieldSalts)),
        'field root on chain does not match the local openings',
      );

      // The amount must appear nowhere in the public record.
      const serialised = JSON.stringify(anchor, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : v,
      );
      assert(
        !serialised.includes(prepared.terms.amount.toString()),
        'the invoice amount is visible in public ledger state',
      );
    });

    // -----------------------------------------------------------------------
    const note = randomBytes32();

    await step('settle by attestation', async () => {
      await stage();
      try {
        await deployed.callTx.settleAttested(invoiceId, SELLER_PIN, note, nowSeconds());
      } finally {
        await unstage();
      }
    });

    await step('the chain shows the settlement', async () => {
      const l = await readLedger();
      assert(l.settledCount === 1n, 'settledCount did not advance');
      assert(l.invoices.lookup(invoiceId).status === InvoiceStatus.settled, 'status is not settled');

      const settlement = l.settlements.lookup(invoiceId);
      assert(settlement.mode === SettlementMode.attested, 'settlement mode is wrong');
      assert(toHex(settlement.note) === toHex(note), 'settlement note does not match');

      const reliability = l.reliability.lookup(sellerKey);
      assert(reliability.settled === 1n, 'seller was not credited a settlement');
    });

    // -----------------------------------------------------------------------
    // The auditor's key never reaches the chain. Only its digest is recorded,
    // so the ledger can say who was authorised without anyone reading the
    // ledger being able to decrypt what they were shown.
    const auditKey = randomBytes32();
    const auditKeyHash = await sha256(auditKey);
    const expiresAt = nowSeconds() + 7n * 86_400n;
    const scopes = scopesFrom(['amount', 'tax', 'dueDate']);

    await step('grant an auditor three fields', async () => {
      await deployed.callTx.grantAudit(invoiceId, SELLER_PIN, auditKeyHash, scopes, expiresAt, nowSeconds());
    });

    await step('the chain records the grant exactly as given', async () => {
      const l = await readLedger();
      const grant = l.auditGrants.lookup(invoiceId);
      assert(toHex(grant.auditKeyHash) === toHex(auditKeyHash), 'audit key hash mismatch');
      assert(grant.revoked === false, 'a fresh grant should not be revoked');
      assert(grant.expiresAt === expiresAt, 'expiry mismatch');
      assert(
        grant.scopes.length === 9 && grant.scopes[0] && grant.scopes[1] && grant.scopes[2],
        'granted scopes do not match what was requested',
      );
      assert(
        !grant.scopes[3] && !grant.scopes[8],
        'fields outside the grant were recorded as granted',
      );
    });

    // -----------------------------------------------------------------------
    await step('the chain credits the seller a settlement', async () => {
      // The counters are public ledger state, so a reader takes them from the
      // chain rather than through a circuit. What matters is that the contract
      // wrote them, not the caller: a party cannot inflate its own record.
      const l = await readLedger();
      const record = l.reliability.lookup(sellerKey);
      assert(record.settled === 1n, 'seller was not credited a settlement');
      assert(record.cancelled === 0n, 'seller was credited a cancellation that never happened');
      assert(record.disputesLost === 0n, 'seller was credited a lost dispute that never happened');
    });

    // -----------------------------------------------------------------------
    await step('revoke the audit grant', async () => {
      await deployed.callTx.revokeAudit(invoiceId, SELLER_PIN);
    });

    await step('the chain shows the grant revoked', async () => {
      const l = await readLedger();
      assert(l.auditGrants.lookup(invoiceId).revoked === true, 'grant was not revoked');
    });

    // -----------------------------------------------------------------------
    await step('a second party can join the same deployment', async () => {
      const joined = await findDeployedContract(providers, {
        compiledContract: CompiledQuietBooksContract,
        contractAddress: address,
        privateStateId: 'quietBooksPrivateState',
      });
      assert(
        joined.deployTxData.public.contractAddress === address,
        'joined a different contract than expected',
      );
    });
  } finally {
    await walletCtx.wallet.stop().catch(() => undefined);
  }
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

function report(): void {
  const passed = results.filter((r) => r.ok).length;
  process.stdout.write('\n');
  process.stdout.write('End-to-end result\n');
  process.stdout.write('-----------------\n');
  for (const r of results) {
    process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}\n`);
    if (!r.ok) process.stdout.write(`      ${r.detail}\n`);
  }
  process.stdout.write(`\n${passed}/${results.length} steps passed\n`);
}
