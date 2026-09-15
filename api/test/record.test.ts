// The shared invoice record, which is the only thing that crosses between two
// parties and between the two interfaces.
//
// SPDX-License-Identifier: Apache-2.0
//
// Everything downstream of an invoice depends on this surviving a round trip
// through JSON and a messaging app: the buyer cannot settle without the
// openings, and no auditor can verify anything without them. Losing a field
// here does not fail loudly at the seam. It fails a minute later, inside a
// circuit, as "terms do not open the recorded commitment" -- which reads like
// the counterparty forged something rather than like a serialiser dropped a key.
//
// So the tests below are mostly about the unhappy cases: what a record written
// by an older version does, what a truncated one does, and whether a field added
// later travels at all.

import { describe, expect, it } from 'vitest';

import { prepareInvoice, storedInvoiceFrom, toHex, type StoredInvoice } from '@quietbooks/contract';

import { QuietBooksError } from '../src/errors.js';
import { deserialiseStored, serialiseStored } from '../src/record.js';

const bytes32 = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

const DUE = 1_760_000_000n + 30n * 86_400n;

const record = async (overrides: Partial<StoredInvoice> = {}): Promise<StoredInvoice> => {
  const prepared = await prepareInvoice({
    currency: 'USDM',
    lineItems: [{ description: 'Integration retainer', quantity: 1n, unitPrice: 4_000_000n }],
    taxAmount: 550_000n,
    memo: 'Net 30.',
    orderRef: 'PO-2026-0184',
    dueDate: DUE,
    sellerPayout: bytes32(0x77),
    buyerPayout: bytes32(0xb2),
  });
  return {
    ...storedInvoiceFrom({
      invoiceId: bytes32(0x01),
      prepared,
      sellerKey: bytes32(0x11),
      buyerKey: bytes32(0x22),
      dueDate: DUE,
      issuedAt: 1_760_000_000n,
      pin: 1n,
      role: 'seller',
    }),
    ...overrides,
  };
};

const roundTrip = (stored: StoredInvoice): StoredInvoice =>
  deserialiseStored(JSON.parse(JSON.stringify(serialiseStored(stored))));

describe('a record survives the trip between two wallets', () => {
  it('brings back every committed field byte for byte', async () => {
    const original = await record();
    const back = roundTrip(original);

    // Compared field by field rather than with one deep equal, because the two
    // sides of this differ deliberately: `role` is set by the importer, not
    // carried, since a record does not get to tell you who you are.
    expect(back.invoiceId).toBe(original.invoiceId);
    expect(back.terms.amount).toBe(original.terms.amount);
    expect(back.terms.taxAmount).toBe(original.terms.taxAmount);
    expect(toHex(back.terms.currency)).toBe(toHex(original.terms.currency));
    expect(toHex(back.terms.tokenType)).toBe(toHex(original.terms.tokenType));
    expect(toHex(back.terms.sellerPayout)).toBe(toHex(original.terms.sellerPayout));
    expect(toHex(back.terms.buyerPayout)).toBe(toHex(original.terms.buyerPayout));
    expect(toHex(back.terms.orderRef)).toBe(toHex(original.terms.orderRef));
    expect(toHex(back.terms.itemsHash)).toBe(toHex(original.terms.itemsHash));
    expect(toHex(back.terms.memoHash)).toBe(toHex(original.terms.memoHash));
    expect(toHex(back.termsSalt)).toBe(toHex(original.termsSalt));
    expect(back.fieldSalts.map(toHex)).toStrictEqual(original.fieldSalts.map(toHex));
    expect(toHex(back.nonce)).toBe(toHex(original.nonce));
    expect(back.sellerKey).toBe(original.sellerKey);
    expect(back.buyerKey).toBe(original.buyerKey);
    expect(back.dueDate).toBe(original.dueDate);
    expect(back.issuedAt).toBe(original.issuedAt);
    expect(back.pin).toBe(original.pin);
  });

  it('keeps all nine field salts, in order', async () => {
    // Order is the whole meaning of this array: the salts are positional, in
    // scope order, and a reordering opens the wrong commitments while still
    // being nine 32-byte values.
    const original = await record();
    const back = roundTrip(original);
    expect(back.fieldSalts).toHaveLength(9);
    for (let i = 0; i < 9; i += 1) {
      expect(toHex(back.fieldSalts[i]!)).toBe(toHex(original.fieldSalts[i]!));
    }
  });

  it('files the record as the importer’s role, not the exporter’s', async () => {
    const original = await record({ role: 'seller' });
    expect(roundTrip(original).role).toBe('buyer');
  });

  it('carries the seller encryption key when there is one', async () => {
    // Not covered by any commitment, and not a secret -- it is transport. The
    // buyer needs it to build a shielded output the seller's wallet can find,
    // and before it travelled here a payment to anyone but yourself could not
    // be built at all.
    const original = await record({ sellerEncryptionKey: 'mn_shield-epk_undeployed1abc' });
    expect(roundTrip(original).sellerEncryptionKey).toBe('mn_shield-epk_undeployed1abc');
  });

  it('omits the encryption key rather than inventing one', async () => {
    const original = await record();
    expect(serialiseStored(original).sellerEncryptionKey).toBeUndefined();
    expect(roundTrip(original).sellerEncryptionKey).toBeUndefined();
  });
});

describe('a record this version cannot open', () => {
  /**
   * Fields added after the format shipped are refused by name, never defaulted.
   *
   * Filling in a plausible value would be worse than failing: a record written
   * before `tokenType` existed was committed to under a terms encoding that had
   * no token type in it, so its commitment cannot open against this encoding
   * whatever is substituted. The import would succeed and the first settlement
   * would fail deep inside a circuit, complaining about terms rather than about
   * an old record.
   */
  const required = ['tokenType', 'sellerPayout', 'buyerPayout'] as const;

  for (const field of required) {
    it(`refuses a record with no ${field}, and says which`, async () => {
      const raw = serialiseStored(await record()) as unknown as {
        terms: Record<string, unknown>;
      };
      delete raw.terms[field];
      expect(() => deserialiseStored(raw)).toThrow(QuietBooksError);
      expect(() => deserialiseStored(raw)).toThrow(new RegExp(field));
    });
  }

  it('tells the reader what to do about it', async () => {
    const raw = serialiseStored(await record()) as unknown as { terms: Record<string, unknown> };
    delete raw.terms.tokenType;
    try {
      deserialiseStored(raw);
      expect.unreachable('should have thrown');
    } catch (error) {
      // The message is read by somebody who did nothing wrong and cannot tell an
      // old record from a corrupt one, so it has to name the remedy.
      expect((error as Error).message).toContain('export it again');
    }
  });

  it('refuses a record missing its identifier', async () => {
    const raw = serialiseStored(await record()) as unknown as Record<string, unknown>;
    delete raw.invoiceId;
    expect(() => deserialiseStored(raw)).toThrow(QuietBooksError);
  });

  it('refuses a record missing its salts', async () => {
    const raw = serialiseStored(await record()) as unknown as Record<string, unknown>;
    delete raw.fieldSalts;
    expect(() => deserialiseStored(raw)).toThrow(QuietBooksError);
  });

  it('refuses something that is not a record at all', () => {
    expect(() => deserialiseStored(null)).toThrow(QuietBooksError);
    expect(() => deserialiseStored('a string')).toThrow(QuietBooksError);
    expect(() => deserialiseStored(42)).toThrow(QuietBooksError);
  });
});

describe('what the wire format looks like', () => {
  it('writes numbers as decimal strings, not JSON numbers', async () => {
    // An invoice total is a Uint<128>. JSON numbers are doubles, so a large
    // amount that went out as a number would come back rounded, and the rounded
    // value would not open the commitment. Strings are the only safe carrier,
    // and this asserts it rather than trusting that nobody "tidies" it later.
    const raw = serialiseStored(await record());
    expect(typeof raw.terms.amount).toBe('string');
    expect(typeof raw.terms.taxAmount).toBe('string');
    expect(typeof raw.dueDate).toBe('string');
    expect(typeof raw.issuedAt).toBe('string');
    expect(typeof raw.pin).toBe('string');
  });

  it('round-trips an amount too large for a JSON number', async () => {
    const huge = 2n ** 90n + 12_345n;
    const original = await record();
    const stored: StoredInvoice = { ...original, terms: { ...original.terms, amount: huge } };
    expect(roundTrip(stored).terms.amount).toBe(huge);
  });

  it('is plain JSON a person can read before they send it', async () => {
    // Deliberate: the record travels over whatever channel two businesses
    // already trust with their terms, and somebody should be able to look at it.
    const text = JSON.stringify(serialiseStored(await record()), null, 2);
    expect(text).toContain('"invoiceId"');
    expect(text).toContain('"termsSalt"');
    expect(JSON.parse(text)).toBeTypeOf('object');
  });
});
