// Invoice lifecycle: issue, settle, cancel.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  actor,
  advance,
  bytes32,
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
  pk,
  SELLER_PIN,
  SELLER_SECRET,
  share,
  stageFor,
  STRANGER_SECRET,
  T0,
} from './harness.js';

import { InvoiceStatus, pureCircuits, SettlementMode } from '../build/contract/index.js';
import { NATIVE_SHIELDED_TOKEN, payableTotal, prepareInvoice } from '../src/invoice.js';
import { randomBytes32, toHex } from '../src/util.js';

/** Where the buyer sends the payment. The contract only forwards to it. */
const SELLER_PAYOUT = pk(0x77);

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
    expect(anchor.rulesVersion).toBe(2n);

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
   */
  const settle = async (options: { at?: bigint; draft?: Parameters<typeof draft>[0] } = {}) => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d0, seller, buyer, { draft: options.draft });

    // The buyer can only settle an invoice whose terms they can open, so the
    // seller must share the record out of band first. That is a real step in the
    // product, not a test artefact.
    const buyerState = stageFor(share(buyer.state, issued.stored), issued.prepared);
    const at = options.at ?? T0 + DAY;
    const payment = coin(payableTotal(issued.prepared.terms), issued.prepared.terms.tokenType);

    const result = issued.d.contract.impureCircuits.settleWithNote(
      ctx(issued.d, buyerState, at),
      issued.invoiceId,
      buyer.pin,
      payment,
      SELLER_PAYOUT,
      at,
    );
    return { ...issued, seller, buyer, d: advance(issued.d, result), at, payment };
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
    const { d, invoiceId } = await settle({ at: draft().dueDate });
    expect(led(d).settlements.lookup(invoiceId).onTime).toBe(true);
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
          SELLER_PAYOUT,
          T0 + 2n * DAY,
        ),
      'not open for settlement',
    );
  });

  /**
   * Set up a settlement attempt and hand back the call, unmade.
   *
   * The token the invoice names, the token actually paid and the amount paid
   * vary independently, which is the only way a test can say which of the two
   * payment rules refused a coin.
   */
  const settleWith = async (attempt: {
    delta?: bigint;
    invoiceToken?: Uint8Array;
    paidToken?: Uint8Array;
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
        SELLER_PAYOUT,
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
          SELLER_PAYOUT,
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
          SELLER_PAYOUT,
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
          SELLER_PAYOUT,
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
          SELLER_PAYOUT,
          T0 + DAY,
        ),
      'unknown invoice',
    );
  });
});

describe('settling by seller attestation', () => {
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
        SELLER_PAYOUT,
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
          SELLER_PAYOUT,
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
