// The invoice domain model.
//
// SPDX-License-Identifier: Apache-2.0
//
// Turns application-shaped data .. a draft with line items, a currency string, a
// due date .. into the exact witness values the circuit expects, and derives the
// same commitments the circuit will derive.
//
// Every derivation here routes through `pureCircuits`, the compiled pure
// circuits emitted alongside the contract, rather than reimplementing SHA-256
// framing in TypeScript. That matters more than it looks: the seller needs the
// invoice id and the field root before the issuing transaction is submitted, and
// any drift between an off-chain reimplementation and the circuit would produce
// invoices whose commitments nobody can ever open. Calling the compiled code
// makes drift impossible by construction.

import { convertFieldToBytes } from '@midnight-ntwrk/compact-runtime';

import { pureCircuits } from '../build/contract/index.js';
import type { InvoiceTerms, TermsFrame } from '../build/contract/index.js';
import {
  SCOPES,
  SCOPE_COUNT,
  assertBytes32,
  assertSecret,
  type ScopeName,
  type StoredInvoice,
} from './witnesses.js';
import {
  currencyCode,
  hashJson,
  randomBytes32,
  randomSalts,
  sha256,
  toHex,
  ZERO32,
} from './util.js';

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

/**
 * One billable line. Amounts are integers in the currency's smallest unit .. no
 * floating point anywhere near money.
 */
export type LineItem = {
  readonly description: string;
  readonly quantity: bigint;
  readonly unitPrice: bigint;
};

export const lineItemTotal = (item: LineItem): bigint => item.quantity * item.unitPrice;

export const lineItemsTotal = (items: readonly LineItem[]): bigint =>
  items.reduce((sum, item) => sum + lineItemTotal(item), 0n);

/**
 * Digest of a line-item list.
 *
 * The chain stores only this. When an auditor is granted the `items` scope they
 * receive the list itself and recompute the digest; without that scope they
 * cannot learn even how many lines there were.
 */
export const hashLineItems = (items: readonly LineItem[]): Promise<Uint8Array> =>
  hashJson(
    items.map((item) => ({
      description: item.description,
      quantity: item.quantity.toString(),
      unitPrice: item.unitPrice.toString(),
    })),
  );

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** What a seller fills in. Plain application data, no crypto. */
export type InvoiceDraft = {
  readonly currency: string;
  /**
   * The shielded token the invoice is payable in, as Zswap's own colour.
   *
   * Distinct from `currency`, which is a label a person reads. The contract
   * compares a payment against this and refuses a coin of any other token, so
   * an invoice denominated in one thing cannot be settled with another. Left
   * unset it is the native shielded token.
   */
  readonly tokenType?: Uint8Array;
  /**
   * Where the seller is paid: their Zswap coin public key, 32 bytes.
   *
   * Not the party key on the invoice. A party key is a hash of a secret and
   * nothing can be paid to it. The paying circuits compare the recipient against
   * this, so an invoice issued without it cannot be settled, and one issued with
   * it cannot be redirected.
   */
  readonly sellerPayout: Uint8Array;
  /**
   * Where the buyer is paid when an arbiter rules in their favour.
   *
   * The seller has to ask for it before issuing, alongside the buyer's party
   * key. Left unset it is zero, which means a dispute cannot be resolved for the
   * buyer -- so an invoice with an arbiter should always carry one.
   */
  readonly buyerPayout?: Uint8Array;
  readonly lineItems: readonly LineItem[];
  /** Tax on top of the line-item subtotal, in the smallest unit. */
  readonly taxAmount: bigint;
  readonly memo: string;
  /** The seller's own reference, e.g. a purchase-order number. */
  readonly orderRef: string;
  /** Unix seconds. Must be later than the issue time. */
  readonly dueDate: bigint;
};

/** A draft turned into circuit-shaped terms, with its openings. */
export type PreparedInvoice = {
  readonly terms: InvoiceTerms;
  readonly termsSalt: Uint8Array;
  readonly fieldSalts: Uint8Array[];
  readonly nonce: Uint8Array;
  /** Kept so the audit envelope can disclose what was hashed. */
  readonly plaintext: {
    readonly currency: string;
    readonly lineItems: readonly LineItem[];
    readonly memo: string;
    readonly orderRef: string;
  };
};

/**
 * Prepare a draft for issuance.
 *
 * Generates every opening fresh. The subtotal is computed from the line items
 * rather than accepted as a separate figure, which removes a whole class of
 * disputes where the stated total and the lines disagree.
 */
export const prepareInvoice = async (draft: InvoiceDraft): Promise<PreparedInvoice> => {
  if (draft.lineItems.length === 0) {
    throw new Error('quietbooks: an invoice needs at least one line item');
  }
  for (const [index, item] of draft.lineItems.entries()) {
    if (item.quantity <= 0n) {
      throw new Error(`quietbooks: line ${index + 1} has a non-positive quantity`);
    }
    if (item.unitPrice <= 0n) {
      throw new Error(`quietbooks: line ${index + 1} has a non-positive unit price`);
    }
    if (item.description.trim().length === 0) {
      throw new Error(`quietbooks: line ${index + 1} has no description`);
    }
  }
  if (draft.taxAmount < 0n) {
    throw new Error('quietbooks: tax cannot be negative');
  }

  const amount = lineItemsTotal(draft.lineItems);
  if (draft.taxAmount > amount) {
    throw new Error('quietbooks: tax cannot exceed the line-item subtotal');
  }

  const terms: InvoiceTerms = {
    amount,
    taxAmount: draft.taxAmount,
    currency: currencyCode(draft.currency),
    tokenType: draft.tokenType ?? NATIVE_SHIELDED_TOKEN,
    sellerPayout: assertBytes32(draft.sellerPayout, 'sellerPayout'),
    buyerPayout: draft.buyerPayout ?? ZERO32,
    orderRef: draft.orderRef.length === 0 ? ZERO32 : await sha256(draft.orderRef),
    itemsHash: await hashLineItems(draft.lineItems),
    memoHash: draft.memo.length === 0 ? ZERO32 : await sha256(draft.memo),
  };

  return {
    terms,
    termsSalt: randomBytes32(),
    fieldSalts: randomSalts(SCOPE_COUNT),
    nonce: randomBytes32(),
    plaintext: {
      currency: draft.currency.trim().toUpperCase(),
      lineItems: draft.lineItems,
      memo: draft.memo,
      orderRef: draft.orderRef,
    },
  };
};

/**
 * Zswap's native shielded token, which is what an all-zero colour means.
 *
 * Named because `ZERO32` appears in this file for several unrelated reasons --
 * an absent memo, an absent order reference -- and a reader should not have to
 * work out which zero is which.
 */
export const NATIVE_SHIELDED_TOKEN: Uint8Array = ZERO32;

/** The grand total a buyer actually pays: principal plus tax. */
export const payableTotal = (terms: InvoiceTerms): bigint => terms.amount + terms.taxAmount;

// ---------------------------------------------------------------------------
// Derivations .. all via the compiled pure circuits
// ---------------------------------------------------------------------------

export const deriveInvoiceId = (sellerKey: Uint8Array, nonce: Uint8Array): Uint8Array =>
  pureCircuits.deriveInvoiceId(assertBytes32(sellerKey, 'sellerKey'), assertSecret(nonce, 'nonce'));

export const buildTermsFrame = (args: {
  invoiceId: Uint8Array;
  sellerKey: Uint8Array;
  buyerKey: Uint8Array;
  dueDate: bigint;
  terms: InvoiceTerms;
}): TermsFrame => ({
  invoiceId: assertBytes32(args.invoiceId, 'invoiceId'),
  sellerKey: assertBytes32(args.sellerKey, 'sellerKey'),
  buyerKey: assertBytes32(args.buyerKey, 'buyerKey'),
  dueDate: args.dueDate,
  terms: args.terms,
});

export const commitTerms = (frame: TermsFrame, salt: Uint8Array): Uint8Array =>
  pureCircuits.commitTerms(frame, assertSecret(salt, 'termsSalt'));

export const commitFieldRoot = (frame: TermsFrame, salts: readonly Uint8Array[]): Uint8Array =>
  pureCircuits.commitFieldRoot(frame, [...salts]);

export const commitSettlementReceipt = (
  invoiceId: Uint8Array,
  note: Uint8Array,
  payerKey: Uint8Array,
  salt: Uint8Array,
): Uint8Array => pureCircuits.commitSettlementReceipt(invoiceId, note, payerKey, salt);

/**
 * The per-field commitments, in scope order.
 *
 * The auditor recomputes the entries they were granted and takes the rest from
 * the envelope verbatim; folding all nine back through `commitFieldRoot` must
 * reproduce the root stored on the anchor.
 */
export const fieldCommitments = (
  frame: TermsFrame,
  salts: readonly Uint8Array[],
): Record<ScopeName, Uint8Array> => {
  const value = fieldValues(frame);
  const tags = fieldTags();
  const out = {} as Record<ScopeName, Uint8Array>;
  for (const [index, scope] of SCOPES.entries()) {
    out[scope] = pureCircuits.commitField(tags[scope], value[scope], salts[index]);
  }
  return out;
};

/** The exact 32-byte value each field commits to. */
export const fieldValues = (frame: TermsFrame): Record<ScopeName, Uint8Array> => ({
  amount: bigintToBytes32(frame.terms.amount),
  tax: bigintToBytes32(frame.terms.taxAmount),
  dueDate: bigintToBytes32(frame.dueDate),
  buyer: frame.buyerKey,
  seller: frame.sellerKey,
  currency: frame.terms.currency,
  items: frame.terms.itemsHash,
  memo: frame.terms.memoHash,
  orderRef: frame.terms.orderRef,
});

export const fieldTags = (): Record<ScopeName, Uint8Array> => ({
  amount: pureCircuits.tagFieldAmount(),
  tax: pureCircuits.tagFieldTax(),
  dueDate: pureCircuits.tagFieldDueDate(),
  buyer: pureCircuits.tagFieldBuyer(),
  seller: pureCircuits.tagFieldSeller(),
  currency: pureCircuits.tagFieldCurrency(),
  items: pureCircuits.tagFieldItems(),
  memo: pureCircuits.tagFieldMemo(),
  orderRef: pureCircuits.tagFieldOrderRef(),
});

/**
 * The 32 bytes a number commits to, exactly as the circuit encodes it.
 *
 * Compact's `x as Field as Bytes<32>` compiles to the runtime's
 * `convertFieldToBytes`, which is LITTLE-endian. Calling that function rather
 * than hand-rolling the conversion is not a style preference: an earlier
 * big-endian implementation here produced amount, tax and due-date commitments
 * that did not appear in the field root the circuit folds, which would have
 * shipped audit envelopes no auditor could ever verify. The bug survived its
 * first test because that test compared this helper against itself. The suite
 * now checks it against `pureCircuits.commitFieldRoot`, so the only way to
 * reintroduce the fault is to make the compiled circuit disagree with itself.
 */
export const bigintToBytes32 = (value: bigint): Uint8Array => {
  if (value < 0n) {
    throw new Error('quietbooks: cannot encode a negative value as Bytes<32>');
  }
  if (value >= 1n << 256n) {
    throw new Error('quietbooks: value does not fit in 32 bytes');
  }
  return convertFieldToBytes(32, value, 'quietbooks: encoding a field as Bytes<32>');
};

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

/** A grant expressed the way the circuit wants it: nine booleans, in order. */
export type ScopeVector = boolean[];

export const noScopes = (): ScopeVector => SCOPES.map(() => false);

export const allScopes = (): ScopeVector => SCOPES.map(() => true);

export const scopesFrom = (names: readonly ScopeName[]): ScopeVector =>
  SCOPES.map((scope) => names.includes(scope));

export const scopeNames = (vector: readonly boolean[]): ScopeName[] =>
  SCOPES.filter((_, index) => vector[index]);

/**
 * The same grant as an integer bitmask.
 *
 * The circuit cannot use this .. Compact has no bitwise operators .. but the
 * envelope format carries one because that is what auditors and existing tools
 * expect, and because it survives a JSON round trip without ambiguity about
 * array length.
 */
export const scopesToMask = (vector: readonly boolean[]): number =>
  vector.reduce((mask, on, index) => (on ? mask | (1 << index) : mask), 0);

export const scopesFromMask = (mask: number): ScopeVector =>
  SCOPES.map((_, index) => (mask & (1 << index)) !== 0);

// ---------------------------------------------------------------------------
// Stored records
// ---------------------------------------------------------------------------

/** Assemble the record a wallet keeps so it can open this invoice later. */
export const storedInvoiceFrom = (args: {
  invoiceId: Uint8Array;
  prepared: PreparedInvoice;
  sellerKey: Uint8Array;
  buyerKey: Uint8Array;
  dueDate: bigint;
  issuedAt: bigint;
  pin: bigint;
  role: StoredInvoice['role'];
  sellerEncryptionKey?: string;
}): StoredInvoice => ({
  invoiceId: toHex(args.invoiceId),
  terms: args.prepared.terms,
  termsSalt: args.prepared.termsSalt,
  fieldSalts: args.prepared.fieldSalts,
  nonce: args.prepared.nonce,
  sellerKey: toHex(args.sellerKey),
  buyerKey: toHex(args.buyerKey),
  dueDate: args.dueDate,
  issuedAt: args.issuedAt,
  pin: args.pin,
  role: args.role,
  ...(args.sellerEncryptionKey === undefined
    ? {}
    : { sellerEncryptionKey: args.sellerEncryptionKey }),
});
