// QuietBooks private state and witness implementations.
//
// SPDX-License-Identifier: Apache-2.0
//
// This module is the trust boundary. Everything here runs on the prover's own
// machine and nothing it returns is ever placed in a transaction: the circuit
// only ever publishes hiding commitments derived from these values.
//
// The circuit cannot distinguish a real secret from an unset one .. a commitment
// to thirty-two zero bytes is a perfectly valid commitment .. so the guards that
// stop a caller from publishing a publicly-derivable digest have to live on this
// side. Every accessor below validates before it hands a value to a circuit.

import {
  type WitnessContext,
} from '@midnight-ntwrk/compact-runtime';

import type {
  InvoiceTerms,
  Ledger,
} from '../build/contract/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Width of every secret, salt and digest this contract handles. */
export const SECRET_BYTES = 32;

/** Number of independently disclosable invoice fields. Mirrors SCOPE_COUNT(). */
export const SCOPE_COUNT = 9;

/**
 * Scope slot order. Fixed, and identical in the circuit, the envelope format and
 * the validator. Changing the order silently invalidates every grant already on
 * chain, so it is expressed once, here, and imported everywhere else.
 */
export const SCOPES = [
  'amount',
  'tax',
  'dueDate',
  'buyer',
  'seller',
  'currency',
  'items',
  'memo',
  'orderRef',
] as const;

export type ScopeName = (typeof SCOPES)[number];

// ---------------------------------------------------------------------------
// Private state
// ---------------------------------------------------------------------------

/**
 * Everything a party knows about one invoice that the ledger does not.
 *
 * `terms` plus `termsSalt` open the anchor's terms commitment; `fieldSalts`
 * open the nine per-field commitments behind its field root. Losing this record
 * does not lose money .. settlement is peer to peer .. but it does lose the
 * ability to prove anything about the invoice to an auditor, which is the whole
 * product. The API layer persists it before the issuing transaction is
 * submitted, not after, so a transaction that lands is always openable.
 */
export type StoredInvoice = {
  /** Hex, no 0x prefix. Matches the on-chain map key. */
  readonly invoiceId: string;
  readonly terms: InvoiceTerms;
  readonly termsSalt: Uint8Array;
  readonly fieldSalts: readonly Uint8Array[];
  /** Opening for the invoice id itself. Kept so the id can be re-derived. */
  readonly nonce: Uint8Array;
  readonly sellerKey: string;
  readonly buyerKey: string;
  readonly dueDate: bigint;
  readonly issuedAt: bigint;
  /** Which of our PINs issued or received this invoice. */
  readonly pin: bigint;
  /** 'seller' when we issued it, 'buyer' when it was addressed to us. */
  readonly role: 'seller' | 'buyer' | 'arbiter';
};

/**
 * The values the next circuit call will consume.
 *
 * Witnesses receive only the ledger and the private state .. never the circuit's
 * arguments .. so they cannot work out which invoice a call is about. The API
 * layer therefore stages the relevant openings here immediately before each
 * call. `withActive` is the only supported way to do that, and it returns a new
 * state rather than mutating, so a failed call cannot leave stale openings armed
 * for the next one.
 */
export type ActiveContext = {
  readonly terms: InvoiceTerms;
  readonly termsSalt: Uint8Array;
  readonly fieldSalts: readonly Uint8Array[];
  readonly nonce: Uint8Array;
  readonly settlementSalt: Uint8Array;
};

export type QuietBooksPrivateState = {
  /** The wallet's root secret. Every identity is a domain-separated hash of it. */
  readonly secret: Uint8Array;
  /** Invoices this wallet can open, keyed by hex invoice id. */
  readonly invoices: Readonly<Record<string, StoredInvoice>>;
  /** Openings staged for the next circuit call, or null when none is staged. */
  readonly active: ActiveContext | null;
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isAllZero = (value: Uint8Array): boolean => value.every((byte) => byte === 0);

/** Thrown when private state cannot safely drive a circuit. */
export class WitnessError extends Error {
  constructor(message: string) {
    super(`quietbooks: ${message}`);
    this.name = 'WitnessError';
  }
}

export const assertBytes32 = (value: unknown, name: string): Uint8Array => {
  if (!(value instanceof Uint8Array) || value.length !== SECRET_BYTES) {
    throw new WitnessError(`${name} must be exactly ${SECRET_BYTES} bytes`);
  }
  return value;
};

/**
 * A secret or salt must be 32 bytes and not all zero.
 *
 * The all-zero check is load-bearing rather than hygiene. Each commitment in
 * this contract takes the salt as its only high-entropy input, so an unset salt
 * yields a fixed, publicly computable digest: anybody reading the ledger could
 * confirm a guessed amount by recomputing the commitment. Refusing here is the
 * only place that can be caught, because the circuit sees a valid commitment
 * either way.
 */
export const assertSecret = (value: unknown, name: string): Uint8Array => {
  const bytes = assertBytes32(value, name);
  if (isAllZero(bytes)) {
    throw new WitnessError(
      `${name} is all zeros .. refusing to build a publicly-derivable commitment`,
    );
  }
  return bytes;
};

const assertTerms = (terms: InvoiceTerms | undefined, name: string): InvoiceTerms => {
  if (terms === undefined || terms === null) {
    throw new WitnessError(`${name} is missing`);
  }
  if (typeof terms.amount !== 'bigint' || typeof terms.taxAmount !== 'bigint') {
    throw new WitnessError(`${name}: amount and taxAmount must be bigints`);
  }
  if (terms.amount <= 0n) {
    throw new WitnessError(`${name}: amount must be positive`);
  }
  if (terms.taxAmount < 0n) {
    throw new WitnessError(`${name}: tax cannot be negative`);
  }
  if (terms.taxAmount > terms.amount) {
    throw new WitnessError(`${name}: tax cannot exceed amount`);
  }
  assertBytes32(terms.currency, `${name}.currency`);
  assertBytes32(terms.tokenType, `${name}.tokenType`);
  assertBytes32(terms.sellerPayout, `${name}.sellerPayout`);
  assertBytes32(terms.buyerPayout, `${name}.buyerPayout`);
  assertBytes32(terms.orderRef, `${name}.orderRef`);
  assertBytes32(terms.itemsHash, `${name}.itemsHash`);
  assertBytes32(terms.memoHash, `${name}.memoHash`);
  // A payout of all zeroes is a key nobody controls, and the paying circuits
  // compare against these. Catching it here means the mistake surfaces when the
  // invoice is drafted rather than when someone tries to pay it.
  if (isAllZero(terms.sellerPayout)) {
    throw new WitnessError(`${name}.sellerPayout must be set`);
  }
  if (isAllZero(terms.currency)) {
    throw new WitnessError(`${name}.currency must be set`);
  }
  return terms;
};

const assertSalts = (salts: readonly Uint8Array[] | undefined): Uint8Array[] => {
  if (!Array.isArray(salts) || salts.length !== SCOPE_COUNT) {
    throw new WitnessError(`fieldSalts must contain exactly ${SCOPE_COUNT} salts`);
  }
  return salts.map((salt, index) => assertSecret(salt, `fieldSalts[${index}] (${SCOPES[index]})`));
};

const requireActive = (state: QuietBooksPrivateState): ActiveContext => {
  if (state.active === null) {
    throw new WitnessError(
      'no invoice is staged. Call withActive(state, invoice) before invoking a ' +
        'circuit that needs the invoice openings .. a witness cannot see which ' +
        'invoice the call is about.',
    );
  }
  return state.active;
};

// ---------------------------------------------------------------------------
// Private state constructors
// ---------------------------------------------------------------------------

/** A fresh wallet holding only its root secret. */
export const emptyPrivateState = (secret: Uint8Array): QuietBooksPrivateState => ({
  secret: assertSecret(secret, 'secret'),
  invoices: {},
  active: null,
});

/** Record an invoice this wallet can open, keyed by its id. */
export const withInvoice = (
  state: QuietBooksPrivateState,
  invoice: StoredInvoice,
): QuietBooksPrivateState => ({
  ...state,
  invoices: { ...state.invoices, [invoice.invoiceId]: invoice },
});

/**
 * Stage the openings the next circuit call will consume.
 *
 * `settlementSalt` is generated per call rather than stored per invoice: it
 * opens a settlement receipt, and an invoice can be settled only once, so there
 * is nothing to reuse and a fresh value avoids any chance of a salt being shared
 * between two receipts.
 */
export const withActive = (
  state: QuietBooksPrivateState,
  active: ActiveContext,
): QuietBooksPrivateState => ({
  ...state,
  active: {
    terms: assertTerms(active.terms, 'active.terms'),
    termsSalt: assertSecret(active.termsSalt, 'active.termsSalt'),
    fieldSalts: assertSalts(active.fieldSalts),
    nonce: assertSecret(active.nonce, 'active.nonce'),
    settlementSalt: assertSecret(active.settlementSalt, 'active.settlementSalt'),
  },
});

/** Stage a stored invoice for a call, supplying a fresh settlement salt. */
export const stage = (
  state: QuietBooksPrivateState,
  invoiceId: string,
  settlementSalt: Uint8Array,
): QuietBooksPrivateState => {
  const stored = state.invoices[invoiceId];
  if (stored === undefined) {
    throw new WitnessError(
      `invoice ${invoiceId} is not in this wallet's private state, so its terms ` +
        'cannot be opened. The counterparty must share the invoice record first.',
    );
  }
  return withActive(state, {
    terms: stored.terms,
    termsSalt: stored.termsSalt,
    fieldSalts: stored.fieldSalts,
    nonce: stored.nonce,
    settlementSalt,
  });
};

/** Clear staged openings. Called after every circuit invocation. */
export const clearActive = (state: QuietBooksPrivateState): QuietBooksPrivateState => ({
  ...state,
  active: null,
});

// ---------------------------------------------------------------------------
// Witnesses
//
// These must match the Witnesses<PS> type in the generated index.d.ts exactly:
// same names, same order of return tuple, [privateState, value].
// ---------------------------------------------------------------------------

type Ctx = WitnessContext<Ledger, QuietBooksPrivateState>;

export const witnesses = {
  localSecret: ({ privateState }: Ctx): [QuietBooksPrivateState, Uint8Array] => [
    privateState,
    assertSecret(privateState.secret, 'secret'),
  ],

  invoiceTerms: ({ privateState }: Ctx): [QuietBooksPrivateState, InvoiceTerms] => [
    privateState,
    assertTerms(requireActive(privateState).terms, 'active.terms'),
  ],

  termsSalt: ({ privateState }: Ctx): [QuietBooksPrivateState, Uint8Array] => [
    privateState,
    assertSecret(requireActive(privateState).termsSalt, 'active.termsSalt'),
  ],

  fieldSalts: ({ privateState }: Ctx): [QuietBooksPrivateState, Uint8Array[]] => [
    privateState,
    assertSalts(requireActive(privateState).fieldSalts),
  ],

  invoiceNonce: ({ privateState }: Ctx): [QuietBooksPrivateState, Uint8Array] => [
    privateState,
    assertSecret(requireActive(privateState).nonce, 'active.nonce'),
  ],

  settlementSalt: ({ privateState }: Ctx): [QuietBooksPrivateState, Uint8Array] => [
    privateState,
    assertSecret(requireActive(privateState).settlementSalt, 'active.settlementSalt'),
  ],
};
