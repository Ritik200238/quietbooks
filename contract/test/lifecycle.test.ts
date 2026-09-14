// Invoice lifecycle: issue, settle, cancel.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  actor,
  advance,
  bytes32,
  BUYER_PAYOUT,
  BUYER_PIN,
  BUYER_SECRET,
  coin,
  ctx,
  DAY,
  deploy,
  draft,
  expectThrows,
  issue,
  led,
  OTHER_TOKEN,
  payoutTo,
  SELLER_PAYOUT,
  SELLER_PIN,
  SELLER_SECRET,
  share,
  stageFor,
  STRANGER_PAYOUT,
  STRANGER_SECRET,
  T0,
} from './harness.js';

import { InvoiceStatus, pureCircuits, SettlementMode } from '../build/contract/index.js';
import type { InvoiceTerms } from '../build/contract/index.js';
import {
  NATIVE_SHIELDED_TOKEN,
  payableTotal,
  prepareInvoice,
  type PreparedInvoice,
} from '../src/invoice.js';
import { randomBytes32, toHex } from '../src/util.js';

/** The address the fixture invoice names, shaped as the circuit wants it. */
const TO_SELLER = payoutTo(SELLER_PAYOUT);

describe('issuing an invoice', () => {
  it('writes an anchor holding no commercial value at all', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const { d, invoiceId, prepared } = await issue(d0, seller, buyer);

    const anchor = led(d).invoices.lookup(invoiceId);
    expect(anchor.status).toBe(InvoiceStatus.issued);
    expect(toHex(anchor.sellerKey)).toBe(toHex(seller.key));
    expect(toHex(anchor.buyerKey)).toBe(toHex(buyer.key));
    expect(anchor.dueDate).toBe(draft().dueDate);
    expect(anchor.settledAt).toBe(0n);
    // Against the circuit, not a literal: what this pins down is that the anchor
    // records the rule set the contract actually enforced, so an invoice issued
    // under one set can never be read back as if it were issued under another.
    expect(anchor.rulesVersion).toBe(pureCircuits.RULES_VERSION());
    // And the literal separately, so that changing the issuance rules without
    // bumping the version is a failing test rather than a silent rewrite of what
    // every earlier invoice appears to have promised.
    expect(pureCircuits.RULES_VERSION()).toBe(3n);

    // The anchor is fixed width and carries only digests and timestamps. The
    // amount exists nowhere in it, which is the property the whole design is
    // built to preserve.
    const serialised = JSON.stringify(anchor, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : v,
    );
    expect(serialised).not.toContain(prepared.terms.amount.toString());
    expect(serialised).not.toContain(prepared.terms.taxAmount.toString());
  });

  it('counts issuance publicly without revealing anything about it', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    expect(led(d0).issuedCount).toBe(0n);

    const first = await issue(d0, seller, buyer);
    expect(led(first.d).issuedCount).toBe(1n);

    const second = await issue(first.d, seller, buyer);
    expect(led(second.d).issuedCount).toBe(2n);
    expect(led(second.d).invoices.size()).toBe(2n);
  });

  it('gives two invoices with identical terms different identifiers', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const a = await issue(d0, seller, buyer);
    const b = await issue(a.d, seller, buyer);
    expect(a.invoiceHex).not.toBe(b.invoiceHex);
  });

  it('refuses to reuse an invoice nonce', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const first = await issue(d0, seller, buyer);

    const staged = stageFor(seller.state, first.prepared);
    expectThrows(
      () =>
        first.d.contract.impureCircuits.issueInvoice(
          ctx(first.d, staged),
          seller.pin,
          buyer.key,
          new Uint8Array(32),
          draft().dueDate,
          T0,
        ),
      'invoice id already used',
    );
  });

  it('enforces every issuance rule', async () => {
    const d = deploy();
    const seller = actor(d, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d, BUYER_SECRET, BUYER_PIN);

    const attempt = async (
      overrides: Parameters<typeof draft>[0],
      buyerKey: Uint8Array,
      dueDate: bigint,
      issuedAt: bigint,
    ) => {
      const prepared = await prepareInvoice(draft(overrides));
      const staged = stageFor(seller.state, prepared);
      return () =>
        d.contract.impureCircuits.issueInvoice(
          ctx(d, staged),
          seller.pin,
          buyerKey,
          new Uint8Array(32),
          dueDate,
          issuedAt,
        );
    };

    expectThrows(
      await attempt({}, buyer.key, T0 - 1n, T0),
      'due date must be after issuance',
    );
    expectThrows(await attempt({}, seller.key, draft().dueDate, T0), 'seller and buyer must differ');
    expectThrows(
      await attempt({}, new Uint8Array(32), draft().dueDate, T0),
      'buyer key must be set',
    );

    // A shielded coin's value is a Uint<128>, so a total above that ceiling can
    // never be paid. Refusing it here beats issuing an invoice nobody can settle
    // and nobody can cancel out of without the seller's key.
    expectThrows(
      await attempt(
        {
          lineItems: [{ description: 'Tranche', quantity: 1n, unitPrice: 2n ** 128n - 1n }],
          taxAmount: 1n,
        },
        buyer.key,
        draft().dueDate,
        T0,
      ),
      'invoice total is too large to be paid',
    );
  });

  it('refuses to issue while paused, and resumes afterwards', async () => {
    const d0 = deploy(SELLER_SECRET);
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);

    const paused = advance(
      d0,
      d0.contract.impureCircuits.setPaused(ctx(d0, d0.privateState), true),
    );
    expect(led(paused).paused).toBe(true);

    const prepared = await prepareInvoice(draft());
    const staged = stageFor(seller.state, prepared);
    expectThrows(
      () =>
        paused.contract.impureCircuits.issueInvoice(
          ctx(paused, staged),
          seller.pin,
          buyer.key,
          new Uint8Array(32),
          draft().dueDate,
          T0,
        ),
      'contract is paused',
    );

    const resumed = advance(
      paused,
      paused.contract.impureCircuits.setPaused(ctx(paused, paused.privateState), false),
    );
    const issued = await issue(resumed, seller, buyer);
    expect(led(issued.d).invoices.size()).toBe(1n);
  });
});

describe('settling with a bound shielded transfer', () => {
  /**
   * Issue an invoice and pay it with a coin worth exactly what it asks for.
   *
   * The coin is handed back with the result because the recorded note is a
   * commitment to it: a test that wants to check the note has to know which coin
   * was spent.
   *
   * `at` is the block the settlement lands in and `claims` is the timestamp the
   * buyer writes on it. They are the same figure unless a test pulls them apart,
   * which is the only way to show that punctuality is decided by the chain and
   * not by the party filling in the form.
   */
  const settle = async (
    options: {
      at?: bigint;
      claims?: bigint;
      draft?: Parameters<typeof draft>[0];
      /** The settlement salt to stage, when a test needs to know which one. */
      salt?: Uint8Array;
      prepared?: PreparedInvoice;
      payment?: ReturnType<typeof coin>;
    } = {},
  ) => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer, {
      draft: options.draft,
      prepared: options.prepared,
    });

    // The buyer can only settle an invoice whose terms they can open, so the
    // seller must share the record out of band first. That is a real step in the
    // product, not a test artefact.
    const buyerState = stageFor(
      share(buyer.state, issued.stored),
      issued.prepared,
      options.salt ?? randomBytes32(),
    );
    const at = options.at ?? T0 + DAY;
    const claims = options.claims ?? at;
    const payment =
      options.payment ?? coin(payableTotal(issued.prepared.terms), issued.prepared.terms.tokenType);

    const result = issued.d.contract.impureCircuits.settleWithNote(
      ctx(issued.d, buyerState, at),
      issued.invoiceId,
      buyer.pin,
      payment,
      TO_SELLER,
      claims,
    );
    return { ...issued, seller, buyer, d: advance(issued.d, result), at, claims, payment };
  };

  it('marks the invoice settled and records only a digest', async () => {
    const { d, invoiceId, at, payment } = await settle();
    const anchor = led(d).invoices.lookup(invoiceId);
    expect(anchor.status).toBe(InvoiceStatus.settled);
    expect(anchor.settledAt).toBe(at);

    const settlement = led(d).settlements.lookup(invoiceId);
    expect(settlement.mode).toBe(SettlementMode.privateNote);
    expect(toHex(settlement.note)).toBe(toHex(pureCircuits.commitPaidCoin(payment)));
    expect(settlement.onTime).toBe(true);
    expect(led(d).settledCount).toBe(1n);
  });

  it('credits the seller a settlement and an on-time mark', async () => {
    const { d, seller } = await settle();
    const r = led(d).reliability.lookup(seller.key);
    expect(r.settled).toBe(1n);
    expect(r.settledOnTime).toBe(1n);
    expect(r.disputesLost).toBe(0n);
  });

  it('records a late settlement as settled but not on time', async () => {
    const { d, seller, invoiceId } = await settle({ at: draft().dueDate + DAY });
    expect(led(d).settlements.lookup(invoiceId).onTime).toBe(false);
    const r = led(d).reliability.lookup(seller.key);
    expect(r.settled).toBe(1n);
    expect(r.settledOnTime).toBe(0n);
  });

  it('treats settlement exactly on the due date as on time', async () => {
    // The boundary the counters turn on, and one nothing exercised before. The
    // circuit asks whether the block is strictly past the due date, so a block
    // landing on the second of the deadline is punctual.
    const { d, invoiceId } = await settle({ at: draft().dueDate, claims: draft().dueDate + DAY });
    expect(led(d).settlements.lookup(invoiceId).onTime).toBe(true);
  });

  it('takes punctuality from the block, not from the timestamp the buyer supplies', async () => {
    // The buyer settles a month late and writes yesterday's date on it. Every
    // settlement path used to compute `onTime` from exactly that figure, so a
    // payer could award the seller a punctuality mark -- or withhold one -- by
    // choosing a number. The block is the one clock nobody at the keyboard owns.
    const claims = T0 + DAY;
    const { d, invoiceId, seller } = await settle({ at: draft().dueDate + DAY, claims });

    const settlement = led(d).settlements.lookup(invoiceId);
    expect(settlement.onTime).toBe(false);

    // The claimed date is still what the record shows, so the two really are
    // independent and the test is not passing because the argument was ignored.
    expect(settlement.settledAt).toBe(claims);
    expect(led(d).invoices.lookup(invoiceId).settledAt).toBe(claims);
    expect(led(d).reliability.lookup(seller.key).settledOnTime).toBe(0n);
  });

  it('refuses a second settlement of the same invoice', async () => {
    const { d, invoiceId, buyer, prepared, stored } = await settle();
    const buyerState = stageFor(share(buyer.state, stored), prepared);
    expectThrows(
      () =>
        d.contract.impureCircuits.settleWithNote(
          ctx(d, buyerState),
          invoiceId,
          buyer.pin,
          coin(payableTotal(prepared.terms)),
          TO_SELLER,
          T0 + 2n * DAY,
        ),
      'not open for settlement',
    );
  });

  /**
   * Set up a settlement attempt and hand back the call, unmade.
   *
   * The token the invoice names, the token actually paid, the amount paid and
   * the address paid vary independently, which is the only way a test can say
   * which of the three payment rules refused a settlement.
   */
  const settleWith = async (attempt: {
    delta?: bigint;
    invoiceToken?: Uint8Array;
    paidToken?: Uint8Array;
    payTo?: Uint8Array;
  }) => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer, {
      draft: { tokenType: attempt.invoiceToken },
    });
    const buyerState = stageFor(share(buyer.state, issued.stored), issued.prepared);

    return () =>
      issued.d.contract.impureCircuits.settleWithNote(
        ctx(issued.d, buyerState, T0 + DAY),
        issued.invoiceId,
        buyer.pin,
        coin(
          payableTotal(issued.prepared.terms) + (attempt.delta ?? 0n),
          attempt.paidToken ?? issued.prepared.terms.tokenType,
        ),
        payoutTo(attempt.payTo ?? SELLER_PAYOUT),
        T0 + DAY,
      );
  };

  /** An attempt to pay `delta` away from what the invoice asks for. */
  const settleOffBy = (delta: bigint) => settleWith({ delta });

  // Neither the invoiced total nor the coin's value reaches public state, so the
  // only place this can be enforced is inside the circuit, against the terms the
  // buyer has just proven open the commitment recorded at issuance.
  it('refuses a payment short of the invoiced total', async () => {
    expectThrows(await settleOffBy(-1n), 'payment does not equal the invoice total');
  });

  it('refuses a payment over the invoiced total', async () => {
    expectThrows(await settleOffBy(1n), 'payment does not equal the invoice total');
  });

  // The token is bound exactly as the total is: it comes out of the terms the
  // buyer has just proven open the commitment recorded at issuance, so neither
  // side can change it afterwards. Without the rule, an invoice for five figures
  // of real money is settled by the same number of units of anything at all.
  it('refuses the invoiced total paid in a token the invoice does not name', async () => {
    expectThrows(
      await settleWith({ paidToken: OTHER_TOKEN }),
      'payment is not in the token this invoice is payable in',
    );
  });

  it('settles an invoice payable in a token other than the native one', async () => {
    const { d, invoiceId, payment } = await settle({ draft: { tokenType: OTHER_TOKEN } });

    expect(toHex(payment.color)).toBe(toHex(OTHER_TOKEN));
    expect(led(d).invoices.lookup(invoiceId).status).toBe(InvoiceStatus.settled);
    expect(toHex(led(d).settlements.lookup(invoiceId).note)).toBe(
      toHex(pureCircuits.commitPaidCoin(payment)),
    );
  });

  it('checks the value and the token separately, on one invoice', async () => {
    // An invoice denominated in something other than the native token is what
    // tells the two rules apart: the token check has to follow what this invoice
    // names rather than a fixed colour, and a buyer who gets one of the two
    // wrong has to be told which one.
    expectThrows(
      await settleWith({ invoiceToken: OTHER_TOKEN, delta: 1n }),
      'payment does not equal the invoice total',
    );
    expectThrows(
      await settleWith({ invoiceToken: OTHER_TOKEN, paidToken: NATIVE_SHIELDED_TOKEN }),
      'payment is not in the token this invoice is payable in',
    );
  });

  // The recipient used to be a free argument nothing asserted on. The buyer is
  // the only caller here, so an unbound recipient let them forward their own
  // payment to themselves and still have the invoice recorded as settled -- a
  // paid invoice with no money in it, and no trace of the substitution in public
  // state. The address now comes out of the terms the chain committed to at
  // issuance, so neither side can change it after the fact.
  it('refuses a payment addressed to the buyer instead of the seller', async () => {
    expectThrows(
      await settleWith({ payTo: BUYER_PAYOUT }),
      'payment is not addressed to the seller on this invoice',
    );
  });

  it('refuses a payment addressed to someone outside the invoice entirely', async () => {
    expectThrows(
      await settleWith({ payTo: STRANGER_PAYOUT }),
      'payment is not addressed to the seller on this invoice',
    );
  });

  it('records a digest of the coin that was actually paid', async () => {
    const a = await settle();
    const b = await settle({ draft: { taxAmount: 125_000n } });
    expect(b.payment.value).not.toBe(a.payment.value);

    const first = led(a.d).settlements.lookup(a.invoiceId);
    const second = led(b.d).settlements.lookup(b.invoiceId);

    expect(toHex(first.note)).toBe(toHex(pureCircuits.commitPaidCoin(a.payment)));
    expect(toHex(second.note)).toBe(toHex(pureCircuits.commitPaidCoin(b.payment)));
    expect(toHex(first.note)).not.toBe(toHex(second.note));
  });

  it('records a receipt that opens under the salt the payer staged', async () => {
    const salt = bytes32(0x5d);
    const { d, invoiceId, buyer } = await settle({ salt });

    // Nothing asserted on the receipt before this. Replacing `settlementSalt()`
    // with a constant left the whole suite green, and that salt is the only
    // high-entropy input to a digest the contract writes to public state: with a
    // fixed one, anybody could recompute the receipt for a guessed payer key and
    // read off who paid an invoice they are not party to.
    const settlement = led(d).settlements.lookup(invoiceId);
    expect(toHex(settlement.receipt)).toBe(
      toHex(pureCircuits.commitSettlementReceipt(invoiceId, settlement.note, buyer.key, salt)),
    );

    // Under any other salt the same three inputs give a different digest, so the
    // equality above is a statement about this opening and not a tautology.
    expect(toHex(settlement.receipt)).not.toBe(
      toHex(
        pureCircuits.commitSettlementReceipt(invoiceId, settlement.note, buyer.key, bytes32(0x5e)),
      ),
    );
  });

  it('gives two structurally identical settlements unrelated receipts', async () => {
    // Same deployment salt, same invoice openings, same coin and the same buyer,
    // so the identifier, the note and the payer key all match across the two.
    // The settlement salt is the only input left that can separate the digests,
    // which makes this the test a constant salt cannot survive.
    const prepared = await prepareInvoice(draft());
    const payment = coin(payableTotal(prepared.terms), prepared.terms.tokenType);

    const a = await settle({ prepared, payment });
    const b = await settle({ prepared, payment });

    const first = led(a.d).settlements.lookup(a.invoiceId);
    const second = led(b.d).settlements.lookup(b.invoiceId);

    expect(b.invoiceHex).toBe(a.invoiceHex);
    expect(toHex(second.note)).toBe(toHex(first.note));
    expect(toHex(b.buyer.key)).toBe(toHex(a.buyer.key));
    expect(toHex(second.receipt)).not.toBe(toHex(first.receipt));
  });

  it('keeps the paid amount out of the digest', async () => {
    const a = await settle();
    const b = await settle();
    expect(b.payment.value).toBe(a.payment.value);

    const first = led(a.d).settlements.lookup(a.invoiceId);
    const second = led(b.d).settlements.lookup(b.invoiceId);
    expect(toHex(first.note)).not.toContain(a.payment.value.toString());

    // Absent digits prove little on their own: invoice totals are low entropy, so
    // a digest over the value alone would be worth brute-forcing. What defeats
    // that is the nonce the buyer draws per coin .. the same amount paid twice
    // lands as two unrelated digests, and nobody can tell they match.
    expect(toHex(first.note)).not.toBe(toHex(second.note));
  });

  it('refuses anyone who is not the named buyer', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const stranger = actor(d0, STRANGER_SECRET, 7n);
    const issued = await issue(d0, seller, buyer);

    const strangerState = stageFor(share(stranger.state, issued.stored), issued.prepared);
    expectThrows(
      () =>
        issued.d.contract.impureCircuits.settleWithNote(
          ctx(issued.d, strangerState),
          issued.invoiceId,
          stranger.pin,
          coin(payableTotal(issued.prepared.terms)),
          TO_SELLER,
          T0 + DAY,
        ),
      'caller is not the buyer',
    );
  });

  it('refuses the right buyer using the wrong PIN', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer);

    const buyerState = stageFor(share(buyer.state, issued.stored), issued.prepared);
    expectThrows(
      () =>
        issued.d.contract.impureCircuits.settleWithNote(
          ctx(issued.d, buyerState),
          issued.invoiceId,
          buyer.pin + 1n,
          coin(payableTotal(issued.prepared.terms)),
          TO_SELLER,
          T0 + DAY,
        ),
      'caller is not the buyer',
    );
  });

  it('refuses a buyer who cannot open the recorded terms', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer);

    // A buyer who was handed tampered terms .. here, a larger amount .. cannot
    // produce the commitment on the anchor, so the settlement is refused. This
    // is what stops the two sides settling against different numbers.
    const tampered = {
      ...issued.prepared,
      terms: { ...issued.prepared.terms, amount: issued.prepared.terms.amount + 1n },
    };
    const buyerState = stageFor(share(buyer.state, issued.stored), tampered);

    expectThrows(
      () =>
        issued.d.contract.impureCircuits.settleWithNote(
          ctx(issued.d, buyerState),
          issued.invoiceId,
          buyer.pin,
          coin(payableTotal(tampered.terms)),
          TO_SELLER,
          T0 + DAY,
        ),
      'terms do not open the recorded commitment',
    );
  });

  it('refuses an unknown invoice', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer);
    const buyerState = stageFor(share(buyer.state, issued.stored), issued.prepared);

    expectThrows(
      () =>
        issued.d.contract.impureCircuits.settleWithNote(
          ctx(issued.d, buyerState),
          bytes32(0xee),
          buyer.pin,
          coin(payableTotal(issued.prepared.terms)),
          TO_SELLER,
          T0 + DAY,
        ),
      'unknown invoice',
    );
  });
});

describe('settling by seller attestation', () => {
  /** Attest at block `at`, writing `claims` on the record. */
  const attest = async (options: { at: bigint; claims: bigint }) => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer);

    const sellerState = stageFor(share(seller.state, issued.stored), issued.prepared);
    const result = issued.d.contract.impureCircuits.settleAttested(
      ctx(issued.d, sellerState, options.at),
      issued.invoiceId,
      seller.pin,
      bytes32(0x7c),
      options.claims,
    );
    return { ...issued, seller, d: advance(issued.d, result) };
  };

  it('takes punctuality from the block, not from the seller attesting', async () => {
    // This is the path the self-certification mattered most on: the seller is
    // the caller, the reliability record is the seller's own, and the timestamp
    // used to be theirs to choose. A seller attesting a month late could file a
    // date inside the window and award themselves the punctuality mark that
    // counterparties are asked to read.
    const claims = T0 + DAY;
    const { d, invoiceId, seller } = await attest({ at: draft().dueDate + DAY, claims });

    const settlement = led(d).settlements.lookup(invoiceId);
    expect(settlement.onTime).toBe(false);
    expect(settlement.settledAt).toBe(claims);
    expect(led(d).reliability.lookup(seller.key).settled).toBe(1n);
    expect(led(d).reliability.lookup(seller.key).settledOnTime).toBe(0n);
  });

  it('treats an attestation exactly on the due date as on time', async () => {
    const { d, invoiceId } = await attest({
      at: draft().dueDate,
      claims: draft().dueDate + 10n * DAY,
    });
    expect(led(d).settlements.lookup(invoiceId).onTime).toBe(true);
  });

  it('lets the seller record an off-chain payment', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer);

    const sellerState = stageFor(share(seller.state, issued.stored), issued.prepared);
    const receipt = bytes32(0x7c);
    const at = T0 + 2n * DAY;

    const d = advance(
      issued.d,
      issued.d.contract.impureCircuits.settleAttested(
        ctx(issued.d, sellerState, at),
        issued.invoiceId,
        seller.pin,
        receipt,
        at,
      ),
    );

    const settlement = led(d).settlements.lookup(issued.invoiceId);
    expect(settlement.mode).toBe(SettlementMode.attested);
    expect(toHex(settlement.note)).toBe(toHex(receipt));
    expect(led(d).invoices.lookup(issued.invoiceId).status).toBe(InvoiceStatus.settled);
  });

  it('refuses the buyer, because only the seller can vouch for receipt', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer);

    const buyerState = stageFor(share(buyer.state, issued.stored), issued.prepared);
    expectThrows(
      () =>
        issued.d.contract.impureCircuits.settleAttested(
          ctx(issued.d, buyerState),
          issued.invoiceId,
          buyer.pin,
          bytes32(0x7c),
          T0 + DAY,
        ),
      'caller is not the seller',
    );
  });
});

describe('cancelling', () => {
  it('lets the seller withdraw an unpaid invoice', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer);

    const d = advance(
      issued.d,
      issued.d.contract.impureCircuits.cancelInvoice(
        ctx(issued.d, seller.state),
        issued.invoiceId,
        seller.pin,
      ),
    );

    expect(led(d).invoices.lookup(issued.invoiceId).status).toBe(InvoiceStatus.cancelled);
    expect(led(d).cancelledCount).toBe(1n);
    expect(led(d).reliability.lookup(seller.key).cancelled).toBe(1n);
  });

  it('refuses anyone but the seller', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer);

    expectThrows(
      () =>
        issued.d.contract.impureCircuits.cancelInvoice(
          ctx(issued.d, buyer.state),
          issued.invoiceId,
          buyer.pin,
        ),
      'caller is not the seller',
    );
  });

  it('refuses to retract a settled invoice', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer);

    const buyerState = stageFor(share(buyer.state, issued.stored), issued.prepared);
    const settled = advance(
      issued.d,
      issued.d.contract.impureCircuits.settleWithNote(
        ctx(issued.d, buyerState),
        issued.invoiceId,
        buyer.pin,
        coin(payableTotal(issued.prepared.terms)),
        TO_SELLER,
        T0 + DAY,
      ),
    );

    expectThrows(
      () =>
        settled.contract.impureCircuits.cancelInvoice(
          ctx(settled, seller.state),
          issued.invoiceId,
          seller.pin,
        ),
      'only an open invoice can be cancelled',
    );
  });

  it('refuses to settle an invoice that was cancelled', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer);

    const cancelled = advance(
      issued.d,
      issued.d.contract.impureCircuits.cancelInvoice(
        ctx(issued.d, seller.state),
        issued.invoiceId,
        seller.pin,
      ),
    );

    const buyerState = stageFor(share(buyer.state, issued.stored), issued.prepared);
    expectThrows(
      () =>
        cancelled.contract.impureCircuits.settleWithNote(
          ctx(cancelled, buyerState),
          issued.invoiceId,
          buyer.pin,
          coin(payableTotal(issued.prepared.terms)),
          TO_SELLER,
          T0 + DAY,
        ),
      'not open for settlement',
    );
  });
});

describe('private state guards', () => {
  it('refuses to run a circuit with no invoice staged', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);

    expectThrows(
      () =>
        d0.contract.impureCircuits.issueInvoice(
          ctx(d0, seller.state),
          seller.pin,
          buyer.key,
          new Uint8Array(32),
          draft().dueDate,
          T0,
        ),
      'no invoice is staged',
    );
  });

  it('refuses an all-zero salt, which would make the commitment guessable', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const prepared = await prepareInvoice(draft());

    expect(() =>
      stageFor(seller.state, { ...prepared, termsSalt: new Uint8Array(32) }),
    ).toThrow('all zeros');
  });

  it('refuses terms no invoice could ever have', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const prepared = await prepareInvoice(draft());

    const staging = (terms: Partial<InvoiceTerms>) => () =>
      stageFor(seller.state, { ...prepared, terms: { ...prepared.terms, ...terms } });

    // None of these can be caught in circuit. A commitment to nonsense verifies
    // exactly as well as a commitment to a real invoice, so the rule set has to
    // hold on this side of the trust boundary -- and a mutation run deleted every
    // one of these checks in turn without the suite noticing.
    expect(staging({ amount: 0n })).toThrow('amount must be positive');
    expect(staging({ taxAmount: -1n })).toThrow('tax cannot be negative');
    expect(staging({ taxAmount: prepared.terms.amount + 1n })).toThrow('tax cannot exceed amount');
    expect(staging({ currency: new Uint8Array(32) })).toThrow('currency must be set');

    // A zero payout is a key nobody controls. The paying circuits compare their
    // recipient against it, so an invoice carrying one could only ever be
    // settled by sending the money nowhere.
    expect(staging({ sellerPayout: new Uint8Array(32) })).toThrow('sellerPayout must be set');
  });

  it('clears staged openings after a call so they cannot be reused', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer);
    expect(issued.d.privateState.active).toBeNull();
  });

  it('refuses to stage an invoice this wallet does not hold', async () => {
    const d0 = deploy();
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const { stage } = await import('../src/witnesses.js');
    expect(() => stage(buyer.state, 'deadbeef', randomBytes32())).toThrow(
      'not in this wallet',
    );
  });
});
