// Test harness: drives the compiled QuietBooks contract in-process.
//
// SPDX-License-Identifier: Apache-2.0
//
// These tests exercise circuit LOGIC .. state transitions, asserts, the
// disclosure boundary and the token calls .. against the real compiled contract
// through `@midnight-ntwrk/compact-runtime`. No Docker, no node, no proof server
// and no network: a full run finishes in seconds on a laptop, which is what
// makes it realistic to run them on every commit.
//
// Proof generation is deliberately out of scope here. It needs a proof server
// and is covered by the end-to-end suite against the local network.

import {
  createCircuitContext,
  createConstructorContext,
  dummyContractAddress,
} from '@midnight-ntwrk/compact-runtime';

import {
  Contract,
  ledger,
  pureCircuits,
  type Ledger,
} from '../build/contract/index.js';

import {
  emptyPrivateState,
  withActive,
  withInvoice,
  clearActive,
  type QuietBooksPrivateState,
  type StoredInvoice,
} from '../src/witnesses.js';

import {
  NATIVE_SHIELDED_TOKEN,
  prepareInvoice,
  storedInvoiceFrom,
  type InvoiceDraft,
  type PreparedInvoice,
} from '../src/invoice.js';

import { randomBytes32, toHex } from '../src/util.js';
import { witnesses } from '../src/witnesses.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A Zswap coin public key, as the runtime wants it: 64 hex characters. */
export const COIN_PK = '0'.repeat(64);

/** Deterministic 32-byte value. Readable in failure output, unlike random ones. */
export const bytes32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

/** A non-zero instance salt, as the constructor demands. */
export const INSTANCE_SALT = bytes32(0x5a);

export const SELLER_SECRET = bytes32(0x11);
export const BUYER_SECRET = bytes32(0x22);
export const ARBITER_SECRET = bytes32(0x33);
export const STRANGER_SECRET = bytes32(0x44);

export const SELLER_PIN = 1n;
export const BUYER_PIN = 2n;
export const ARBITER_PIN = 3n;

/** Fixed clock so time-dependent assertions read the same on every machine. */
export const T0 = 1_760_000_000n;
export const DAY = 86_400n;

export type ChargedState = Parameters<typeof ledger>[0];

export type Deployed = {
  readonly contract: Contract<QuietBooksPrivateState>;
  readonly contractState: ChargedState;
  readonly privateState: QuietBooksPrivateState;
};

type CircuitResult = {
  context: {
    currentQueryContext: { state: ChargedState };
    currentPrivateState: QuietBooksPrivateState;
  };
};

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

/**
 * Deploy with `deployerSecret` as the administrator.
 *
 * The constructor derives the admin key from whatever secret is in the
 * deploying private state, so who deploys decides who administers.
 */
export const deploy = (
  deployerSecret: Uint8Array = SELLER_SECRET,
  salt: Uint8Array = INSTANCE_SALT,
): Deployed => {
  const contract = new Contract<QuietBooksPrivateState>(witnesses);
  const privateState = emptyPrivateState(deployerSecret);
  const init = contract.initialState(createConstructorContext(privateState, COIN_PK), salt);
  return {
    contract,
    contractState: init.currentContractState.data,
    privateState: init.currentPrivateState,
  };
};

/** Build a circuit context, optionally as a different actor and at a set time. */
export const ctx = (
  d: Deployed,
  privateState: QuietBooksPrivateState = d.privateState,
  time: bigint = T0,
) =>
  createCircuitContext(
    dummyContractAddress(),
    COIN_PK,
    d.contractState,
    privateState,
    undefined,
    undefined,
    Number(time),
  );

/** Fold a circuit result back in so the next call sees the new state. */
export const advance = (d: Deployed, result: CircuitResult): Deployed => ({
  contract: d.contract,
  contractState: result.context.currentQueryContext.state,
  privateState: clearActive(result.context.currentPrivateState),
});

export const led = (d: Deployed): Ledger => ledger(d.contractState);

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

/**
 * A party: their own private state, plus the party key the contract will derive
 * for them at a given PIN.
 */
export type Actor = {
  readonly state: QuietBooksPrivateState;
  readonly pin: bigint;
  readonly key: Uint8Array;
};

/**
 * Derive a party's key through the contract's own circuit rather than
 * recomputing the hash here, so a test can never disagree with the contract
 * about what a party key is.
 *
 * `derivePartyKeyWith` is pure and takes the salt as an argument, so it runs
 * without a circuit context; the salt comes from the deployment's ledger state,
 * which is the same value the contract's internal `callerKey` reads.
 */
export const actor = (d: Deployed, secret: Uint8Array, pin: bigint): Actor => ({
  state: emptyPrivateState(secret),
  pin,
  key: pureCircuits.derivePartyKeyWith(led(d).instanceSalt, secret, pin),
});

// ---------------------------------------------------------------------------
// Invoice helpers
// ---------------------------------------------------------------------------

export const draft = (overrides: Partial<InvoiceDraft> = {}): InvoiceDraft => ({
  currency: 'USDM',
  lineItems: [
    { description: 'Integration retainer, March', quantity: 1n, unitPrice: 4_000_000n },
    { description: 'On-call hours', quantity: 12n, unitPrice: 125_000n },
  ],
  taxAmount: 550_000n,
  memo: 'Net 30. Wire to the account on file.',
  orderRef: 'PO-2026-0184',
  dueDate: T0 + 30n * DAY,
  ...overrides,
});

export type IssuedInvoice = {
  readonly d: Deployed;
  readonly invoiceId: Uint8Array;
  readonly invoiceHex: string;
  readonly prepared: PreparedInvoice;
  readonly stored: StoredInvoice;
};

/**
 * Stage a prepared invoice into a party's private state.
 *
 * Witnesses cannot see circuit arguments, so the openings for the invoice under
 * test have to be staged before the call. Every helper below does this
 * explicitly rather than hiding it, because forgetting it is the single most
 * likely mistake when writing a new test.
 */
export const stageFor = (
  state: QuietBooksPrivateState,
  prepared: PreparedInvoice,
  settlementSalt: Uint8Array = randomBytes32(),
): QuietBooksPrivateState =>
  withActive(state, {
    terms: prepared.terms,
    termsSalt: prepared.termsSalt,
    fieldSalts: prepared.fieldSalts,
    nonce: prepared.nonce,
    settlementSalt,
  });

/** Issue an invoice from `seller` to `buyer`, returning everything about it. */
export const issue = async (
  d: Deployed,
  seller: Actor,
  buyer: Actor,
  options: {
    arbiterKey?: Uint8Array;
    draft?: Partial<InvoiceDraft>;
    issuedAt?: bigint;
    time?: bigint;
  } = {},
): Promise<IssuedInvoice> => {
  const theDraft = draft(options.draft);
  const prepared = await prepareInvoice(theDraft);
  const issuedAt = options.issuedAt ?? T0;

  const staged = stageFor(seller.state, prepared);
  const result = d.contract.impureCircuits.issueInvoice(
    ctx(d, staged, options.time ?? T0),
    seller.pin,
    buyer.key,
    options.arbiterKey ?? new Uint8Array(32),
    theDraft.dueDate,
    issuedAt,
  );

  const invoiceId = result.result;
  const stored = storedInvoiceFrom({
    invoiceId,
    prepared,
    sellerKey: seller.key,
    buyerKey: buyer.key,
    dueDate: theDraft.dueDate,
    issuedAt,
    pin: seller.pin,
    role: 'seller',
  });

  return {
    d: advance(d, result),
    invoiceId,
    invoiceHex: toHex(invoiceId),
    prepared,
    stored,
  };
};

/** Give a counterparty the record they need to open the invoice themselves. */
export const share = (actorState: QuietBooksPrivateState, stored: StoredInvoice): QuietBooksPrivateState =>
  withInvoice(actorState, stored);

/** Assert a call throws, and that the message names the expected cause. */
export const expectThrows = (fn: () => unknown, fragment: string): Error => {
  try {
    fn();
  } catch (error) {
    const err = error as Error;
    if (!err.message.includes(fragment)) {
      throw new Error(
        `expected an error mentioning "${fragment}", got: ${err.message}`,
      );
    }
    return err;
  }
  throw new Error(`expected a failure mentioning "${fragment}", but the call succeeded`);
};

/**
 * A shielded token that is not the native one.
 *
 * Stands in for any issued token an invoice might be denominated in. The
 * circuits only ever compare colours, so the byte pattern is arbitrary; all
 * that matters is that it differs from the native token's all-zero colour.
 */
export const OTHER_TOKEN = bytes32(0xc0);

/**
 * A shielded coin descriptor, as `settleWithNote` and `fundEscrow` want it.
 *
 * The colour defaults to the native token because that is what `prepareInvoice`
 * puts in the terms when a draft names none, and both circuits refuse a coin
 * whose colour is not the one the invoice is payable in. A test that wants that
 * refusal has to ask for it by passing a colour.
 */
export const coin = (
  value: bigint,
  color: Uint8Array = NATIVE_SHIELDED_TOKEN,
  nonce = randomBytes32(),
) => ({
  nonce,
  color,
  value,
});

export const pk = (fill: number) => ({ bytes: bytes32(fill) });
