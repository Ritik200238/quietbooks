// The shared invoice record: the format two parties exchange out of band.
//
// SPDX-License-Identifier: Apache-2.0
//
// This is the interop contract of the whole product. A seller exports it, sends
// it over whatever channel the two already trust with their commercial terms,
// and the buyer imports it; without it the buyer cannot settle and no auditor
// can verify anything. The two front ends write it from different stacks -- a
// browser wallet and a locally built one -- so it is also the place where their
// two dialects have to meet.
//
// It lives in its own file rather than as private helpers inside the API class
// because a format that crosses a trust boundary deserves to be read, and tested,
// on its own.

import { fromHex, toHex, type StoredInvoice } from '@quietbooks/contract';

import { QuietBooksError } from './errors.js';

// ---------------------------------------------------------------------------

export type SerialisedInvoice = {
  invoiceId: string;
  terms: {
    amount: string;
    taxAmount: string;
    currency: string;
    tokenType: string;
    sellerPayout: string;
    buyerPayout: string;
    orderRef: string;
    itemsHash: string;
    memoHash: string;
  };
  termsSalt: string;
  fieldSalts: string[];
  nonce: string;
  sellerKey: string;
  buyerKey: string;
  dueDate: string;
  issuedAt: string;
  pin: string;
  /**
   * The exporting seller's Zswap encryption public key.
   *
   * Optional in the type because a record written before this field existed is
   * still a valid record .. its commitments open exactly as they always did.
   * Missing it costs the buyer the ability to pay the seller, not the ability to
   * read the invoice, so it is not in `requireField` with the committed fields.
   */
  sellerEncryptionKey?: string;
};

export const serialiseStored = (stored: StoredInvoice): SerialisedInvoice => ({
  invoiceId: stored.invoiceId,
  terms: {
    amount: stored.terms.amount.toString(),
    taxAmount: stored.terms.taxAmount.toString(),
    currency: toHex(stored.terms.currency),
    tokenType: toHex(stored.terms.tokenType),
    sellerPayout: toHex(stored.terms.sellerPayout),
    buyerPayout: toHex(stored.terms.buyerPayout),
    orderRef: toHex(stored.terms.orderRef),
    itemsHash: toHex(stored.terms.itemsHash),
    memoHash: toHex(stored.terms.memoHash),
  },
  termsSalt: toHex(stored.termsSalt),
  fieldSalts: stored.fieldSalts.map(toHex),
  nonce: toHex(stored.nonce),
  sellerKey: stored.sellerKey,
  buyerKey: stored.buyerKey,
  dueDate: stored.dueDate.toString(),
  issuedAt: stored.issuedAt.toString(),
  pin: stored.pin.toString(),
  ...(stored.sellerEncryptionKey === undefined
    ? {}
    : { sellerEncryptionKey: stored.sellerEncryptionKey }),
});

/** Read a field a shared record cannot be understood without. */
const requireField = (value: unknown, name: string): string => {
  if (typeof value !== 'string') {
    throw new QuietBooksError(
      `shared invoice is missing ${name}. It was written by an older version of ` +
        'QuietBooks, whose terms were committed to differently, so it cannot be ' +
        'opened here. Ask the counterparty to export it again.',
      'importInvoice',
    );
  }
  return value;
};

export const deserialiseStored = (value: unknown): StoredInvoice => {
  const raw = value as SerialisedInvoice;
  if (typeof raw?.invoiceId !== 'string' || !Array.isArray(raw?.fieldSalts)) {
    throw new QuietBooksError('shared invoice is missing required fields', 'importInvoice');
  }
  return {
    invoiceId: raw.invoiceId,
    terms: {
      amount: BigInt(raw.terms.amount),
      taxAmount: BigInt(raw.terms.taxAmount),
      currency: fromHex(raw.terms.currency),
      // Required, and refused loudly when absent.
      //
      // Substituting the native token here would be worse than failing: a
      // record shared before this field existed was committed to under rules
      // version 1, whose terms encoding had no token type at all, so its
      // commitment cannot open against version 2 whatever is filled in. The
      // import would succeed and the first settlement would fail deep inside a
      // circuit with a message about terms not opening.
      tokenType: fromHex(requireField(raw.terms?.tokenType, 'terms.tokenType')),
      sellerPayout: fromHex(requireField(raw.terms?.sellerPayout, 'terms.sellerPayout')),
      buyerPayout: fromHex(requireField(raw.terms?.buyerPayout, 'terms.buyerPayout')),
      orderRef: fromHex(raw.terms.orderRef),
      itemsHash: fromHex(raw.terms.itemsHash),
      memoHash: fromHex(raw.terms.memoHash),
    },
    termsSalt: fromHex(raw.termsSalt),
    fieldSalts: raw.fieldSalts.map(fromHex),
    nonce: fromHex(raw.nonce),
    sellerKey: raw.sellerKey,
    buyerKey: raw.buyerKey,
    dueDate: BigInt(raw.dueDate),
    issuedAt: BigInt(raw.issuedAt),
    pin: BigInt(raw.pin),
    role: 'buyer',
    ...(typeof raw.sellerEncryptionKey === 'string'
      ? { sellerEncryptionKey: raw.sellerEncryptionKey }
      : {}),
  };
};

