// Agreement between the off-chain helpers and the compiled circuit.
//
// SPDX-License-Identifier: Apache-2.0
//
// These are the tests that matter most and are the easiest to skip. A seller
// needs the invoice id and the field root before the issuing transaction is
// submitted, and an auditor recomputes commitments months later from an
// envelope. If the TypeScript that produces those values and the circuit that
// checks them ever disagree by a single byte, the result is not a crash .. it is
// an invoice whose commitments nobody can open, discovered at audit time.
//
// Every derivation is therefore asserted against the compiled pure circuits
// rather than against a hand-written expectation.

import { describe, expect, it } from 'vitest';

import {
  actor,
  bytes32,
  BUYER_PIN,
  BUYER_SECRET,
  ctx,
  deploy,
  draft,
  SELLER_PIN,
  SELLER_SECRET,
  T0,
} from './harness.js';

import { convertFieldToBytes } from '@midnight-ntwrk/compact-runtime';

import { ledger, pureCircuits } from '../build/contract/index.js';
import {
  bigintToBytes32,
  buildTermsFrame,
  commitFieldRoot,
  commitTerms,
  deriveInvoiceId,
  fieldCommitments,
  fieldValues,
  hashLineItems,
  lineItemsTotal,
  prepareInvoice,
  payableTotal,
  scopesFrom,
  scopesFromMask,
  scopesToMask,
  scopeNames,
  allScopes,
  noScopes,
} from '../src/invoice.js';
import { SCOPES } from '../src/witnesses.js';
import { foldFieldRoot } from '../src/audit.js';
import { bytesEqual, currencyCode, fromHex, padBytes32, toHex, unpadBytes32 } from '../src/util.js';

describe('hex and byte helpers', () => {
  it('round-trips hex in both directions', () => {
    const value = bytes32(0xab);
    expect(fromHex(toHex(value))).toEqual(value);
    expect(toHex(fromHex('00ff10'))).toBe('00ff10');
  });

  it('accepts a 0x prefix and rejects malformed input', () => {
    expect(fromHex('0xdeadbeef')).toEqual(fromHex('deadbeef'));
    expect(() => fromHex('abc')).toThrow('even number');
    expect(() => fromHex('zz')).toThrow('non-hex');
  });

  it('pads and unpads short ASCII into 32 bytes', () => {
    const padded = padBytes32('USDM');
    expect(padded.length).toBe(32);
    expect(unpadBytes32(padded)).toBe('USDM');
  });

  it('refuses text that does not fit', () => {
    expect(() => padBytes32('x'.repeat(33))).toThrow('does not fit');
  });

  it('normalises currency codes to upper case', () => {
    expect(currencyCode(' usdm ')).toEqual(padBytes32('USDM'));
    expect(() => currencyCode('   ')).toThrow('cannot be empty');
  });

  it('compares byte strings without short-circuiting on length alone', () => {
    expect(bytesEqual(bytes32(1), bytes32(1))).toBe(true);
    expect(bytesEqual(bytes32(1), bytes32(2))).toBe(false);
    expect(bytesEqual(new Uint8Array(2), new Uint8Array(3))).toBe(false);
  });
});

describe('integer encoding matches the circuit', () => {
  // An earlier version of this suite compared `bigintToBytes32` against
  // `fieldValues`, which calls `bigintToBytes32`. Both sides moved together, so
  // the assertion held while the encoding was wrong end-first and the amount
  // commitments did not appear in the field root the circuit folds. Audit
  // envelopes built on that would have been unverifiable.
  //
  // The fix is to compare against the compiled circuit itself. `commitFieldRoot`
  // is a pure circuit: it performs the `as Field as Bytes<32>` conversion
  // internally, in circuit code, and folds the result. Reproducing its output
  // from `fieldValues` is only possible if our encoding is byte-identical to the
  // circuit's, so this check cannot pass vacuously.
  const checkAgreement = (value: bigint, dueDate: bigint) => {
    const salts = Array.from({ length: 9 }, (_, i) => bytes32(0x40 + i));
    const frame = buildTermsFrame({
      invoiceId: bytes32(0x01),
      sellerKey: bytes32(0x02),
      buyerKey: bytes32(0x03),
      dueDate,
      terms: {
        amount: value,
        taxAmount: value / 10n,
        currency: currencyCode('USDM'),
        orderRef: bytes32(0x05),
        itemsHash: bytes32(0x06),
        memoHash: bytes32(0x07),
      },
    });

    // What the circuit computes, end to end. It does the numeric conversion
    // itself, in circuit code, and we never see the intermediate bytes.
    const circuitRoot = pureCircuits.commitFieldRoot(frame, salts);

    // What we get by committing each field with OUR encoding and folding those
    // nine commitments independently. `foldFieldRoot` takes only the finished
    // commitments, so the only shared input is the frame: if our encoding of
    // amount, tax or the due date differs from the circuit's by so much as a
    // byte order, these two roots cannot agree.
    const ourRoot = foldFieldRoot(fieldCommitments(frame, salts));

    expect(toHex(ourRoot)).toBe(toHex(circuitRoot));
  };

  it('agrees on one', () => checkAgreement(1n, 10n));
  it('agrees on a typical invoice amount', () => checkAgreement(5_500_000n, 1_760_000_000n));
  it('agrees on a byte boundary', () => checkAgreement(255n, 255n));
  it('agrees across a byte boundary', () => checkAgreement(256n, 256n));
  it('agrees on a large 64-bit value', () => checkAgreement(2n ** 63n, 2n ** 40n));

  it('refuses negatives and oversized values', () => {
    expect(() => bigintToBytes32(-1n)).toThrow('negative');
    expect(() => bigintToBytes32(2n ** 256n)).toThrow('does not fit');
  });

  it('encodes little-endian, as the runtime does', () => {
    // 258 = 0x0102. Little-endian puts the low byte first.
    const encoded = bigintToBytes32(258n);
    expect(encoded[0]).toBe(2);
    expect(encoded[1]).toBe(1);
    expect(encoded[31]).toBe(0);
  });

  it('produces the same bytes as the runtime conversion the circuit compiles to', () => {
    for (const value of [0n, 1n, 255n, 256n, 5_500_000n, 2n ** 63n]) {
      expect(toHex(bigintToBytes32(value))).toBe(
        toHex(convertFieldToBytes(32, value, 'derivation test')),
      );
    }
  });
});

describe('domain tags are all distinct', () => {
  it('no two tags collide', () => {
    const tags = [
      pureCircuits.tagParty(),
      pureCircuits.tagAdmin(),
      pureCircuits.tagInvoiceId(),
      pureCircuits.tagTerms(),
      pureCircuits.tagFieldRoot(),
      pureCircuits.tagSettlement(),
      pureCircuits.tagEscrowCoin(),
      pureCircuits.tagReliability(),
      pureCircuits.tagFieldAmount(),
      pureCircuits.tagFieldTax(),
      pureCircuits.tagFieldDueDate(),
      pureCircuits.tagFieldBuyer(),
      pureCircuits.tagFieldSeller(),
      pureCircuits.tagFieldCurrency(),
      pureCircuits.tagFieldItems(),
      pureCircuits.tagFieldMemo(),
      pureCircuits.tagFieldOrderRef(),
    ].map(toHex);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('a value committed as an amount does not verify as a tax', () => {
    const salt = bytes32(0x09);
    const value = bigintToBytes32(1_000n);
    const asAmount = pureCircuits.commitField(pureCircuits.tagFieldAmount(), value, salt);
    const asTax = pureCircuits.commitField(pureCircuits.tagFieldTax(), value, salt);
    expect(toHex(asAmount)).not.toBe(toHex(asTax));
  });
});

describe('invoice preparation', () => {
  it('derives the subtotal from the line items', async () => {
    const prepared = await prepareInvoice(draft());
    expect(prepared.terms.amount).toBe(lineItemsTotal(draft().lineItems));
    expect(prepared.terms.amount).toBe(4_000_000n + 12n * 125_000n);
  });

  it('reports the payable total as principal plus tax', async () => {
    const prepared = await prepareInvoice(draft());
    expect(payableTotal(prepared.terms)).toBe(prepared.terms.amount + prepared.terms.taxAmount);
  });

  it('produces a distinct salt for every field plus the terms and the id', async () => {
    const prepared = await prepareInvoice(draft());
    const all = [prepared.termsSalt, prepared.nonce, ...prepared.fieldSalts].map(toHex);
    expect(new Set(all).size).toBe(all.length);
  });

  it('hashes identical line items identically and different ones differently', async () => {
    const items = draft().lineItems;
    const a = await hashLineItems(items);
    const b = await hashLineItems([...items]);
    const c = await hashLineItems([...items, { description: 'Extra', quantity: 1n, unitPrice: 1n }]);
    expect(toHex(a)).toBe(toHex(b));
    expect(toHex(a)).not.toBe(toHex(c));
  });

  it('leaves an omitted memo and order reference as the zero digest', async () => {
    const prepared = await prepareInvoice(draft({ memo: '', orderRef: '' }));
    expect(toHex(prepared.terms.memoHash)).toBe(toHex(new Uint8Array(32)));
    expect(toHex(prepared.terms.orderRef)).toBe(toHex(new Uint8Array(32)));
  });

  it('rejects drafts that could never be valid invoices', async () => {
    await expect(prepareInvoice(draft({ lineItems: [] }))).rejects.toThrow('at least one line item');
    await expect(
      prepareInvoice(draft({ lineItems: [{ description: 'x', quantity: 0n, unitPrice: 1n }] })),
    ).rejects.toThrow('non-positive quantity');
    await expect(
      prepareInvoice(draft({ lineItems: [{ description: 'x', quantity: 1n, unitPrice: 0n }] })),
    ).rejects.toThrow('non-positive unit price');
    await expect(
      prepareInvoice(draft({ lineItems: [{ description: '  ', quantity: 1n, unitPrice: 1n }] })),
    ).rejects.toThrow('no description');
    await expect(prepareInvoice(draft({ taxAmount: -1n }))).rejects.toThrow('negative');
    await expect(prepareInvoice(draft({ taxAmount: 10n ** 12n }))).rejects.toThrow('exceed');
  });
});

describe('commitments agree with the circuit', () => {
  it('derives the same invoice id off chain as the circuit returns on chain', async () => {
    const d = deploy();
    const seller = actor(d, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d, BUYER_SECRET, BUYER_PIN);
    const prepared = await prepareInvoice(draft());

    const offChain = deriveInvoiceId(seller.key, prepared.nonce);

    const staged = {
      ...seller.state,
      active: {
        terms: prepared.terms,
        termsSalt: prepared.termsSalt,
        fieldSalts: prepared.fieldSalts,
        nonce: prepared.nonce,
        settlementSalt: bytes32(0x66),
      },
    };
    const result = d.contract.impureCircuits.issueInvoice(
      ctx(d, staged),
      seller.pin,
      buyer.key,
      new Uint8Array(32),
      draft().dueDate,
      T0,
    );

    expect(toHex(result.result)).toBe(toHex(offChain));
  });

  it('reproduces the terms commitment and field root stored on the anchor', async () => {
    const d = deploy();
    const seller = actor(d, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d, BUYER_SECRET, BUYER_PIN);
    const theDraft = draft();
    const prepared = await prepareInvoice(theDraft);

    const staged = {
      ...seller.state,
      active: {
        terms: prepared.terms,
        termsSalt: prepared.termsSalt,
        fieldSalts: prepared.fieldSalts,
        nonce: prepared.nonce,
        settlementSalt: bytes32(0x66),
      },
    };
    const result = d.contract.impureCircuits.issueInvoice(
      ctx(d, staged),
      seller.pin,
      buyer.key,
      new Uint8Array(32),
      theDraft.dueDate,
      T0,
    );

    const frame = buildTermsFrame({
      invoiceId: result.result,
      sellerKey: seller.key,
      buyerKey: buyer.key,
      dueDate: theDraft.dueDate,
      terms: prepared.terms,
    });

    const anchor = ledgerOfResult(result).invoices.lookup(result.result);
    expect(toHex(anchor.terms)).toBe(toHex(commitTerms(frame, prepared.termsSalt)));
    expect(toHex(anchor.fieldRoot)).toBe(toHex(commitFieldRoot(frame, prepared.fieldSalts)));
  });

  it('changes the terms commitment when any single field changes', async () => {
    const prepared = await prepareInvoice(draft());
    const base = buildTermsFrame({
      invoiceId: bytes32(0x01),
      sellerKey: bytes32(0x02),
      buyerKey: bytes32(0x03),
      dueDate: 100n,
      terms: prepared.terms,
    });
    const original = toHex(commitTerms(base, prepared.termsSalt));

    const withOtherAmount = { ...base, terms: { ...base.terms, amount: base.terms.amount + 1n } };
    const withOtherDue = { ...base, dueDate: 101n };
    const withOtherBuyer = { ...base, buyerKey: bytes32(0x04) };

    expect(toHex(commitTerms(withOtherAmount, prepared.termsSalt))).not.toBe(original);
    expect(toHex(commitTerms(withOtherDue, prepared.termsSalt))).not.toBe(original);
    expect(toHex(commitTerms(withOtherBuyer, prepared.termsSalt))).not.toBe(original);
  });

  it('produces nine distinct field commitments', async () => {
    const prepared = await prepareInvoice(draft());
    const frame = buildTermsFrame({
      invoiceId: bytes32(0x01),
      sellerKey: bytes32(0x02),
      buyerKey: bytes32(0x03),
      dueDate: 100n,
      terms: prepared.terms,
    });
    const commitments = fieldCommitments(frame, prepared.fieldSalts);
    const hexes = SCOPES.map((scope) => toHex(commitments[scope]));
    expect(new Set(hexes).size).toBe(SCOPES.length);
  });
});

describe('scope vectors', () => {
  it('maps names to slots in the documented order', () => {
    const vector = scopesFrom(['amount', 'dueDate']);
    expect(vector[0]).toBe(true);
    expect(vector[2]).toBe(true);
    expect(vector[1]).toBe(false);
    expect(scopeNames(vector)).toEqual(['amount', 'dueDate']);
  });

  it('round-trips through the integer mask the envelope carries', () => {
    const vector = scopesFrom(['amount', 'tax', 'orderRef']);
    expect(scopesFromMask(scopesToMask(vector))).toEqual(vector);
  });

  it('uses bit positions matching the scope order', () => {
    expect(scopesToMask(scopesFrom(['amount']))).toBe(1);
    expect(scopesToMask(scopesFrom(['tax']))).toBe(2);
    expect(scopesToMask(scopesFrom(['dueDate']))).toBe(4);
    expect(scopesToMask(allScopes())).toBe(511);
    expect(scopesToMask(noScopes())).toBe(0);
  });
});

/** Read the ledger out of a circuit result, without folding state forward. */
const ledgerOfResult = (result: {
  context: { currentQueryContext: { state: Parameters<typeof ledger>[0] } };
}) => ledger(result.context.currentQueryContext.state);
