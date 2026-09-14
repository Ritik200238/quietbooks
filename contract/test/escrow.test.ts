// Escrow custody: funding, release, refund, and the dispute path.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  actor,
  advance,
  ARBITER_PIN,
  ARBITER_SECRET,
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
  total,
} from './harness.js';

import { DisputeOutcome, InvoiceStatus, SettlementMode } from '../build/contract/index.js';
import { NATIVE_SHIELDED_TOKEN, payableTotal } from '../src/invoice.js';
import { toHex } from '../src/util.js';

/**
 * The two addresses this invoice names, shaped as the circuits take them.
 *
 * Every payout is now checked against the terms, so which of these a call
 * carries is the difference between a release and a refusal.
 */
const TO_SELLER = payoutTo(SELLER_PAYOUT);
const TO_BUYER = payoutTo(BUYER_PAYOUT);
const TO_STRANGER = payoutTo(STRANGER_PAYOUT);

const DEADLINE = T0 + 14n * DAY;

/** JSON with the byte arrays and bigints of a ledger record made readable. */
const dump = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : v,
  );

type EscrowOptions = {
  readonly arbiter?: boolean;
  readonly value?: bigint;
  readonly deadline?: bigint;
  readonly draft?: Parameters<typeof draft>[0];
};

/** A fresh deployment with an invoice open, plus the three parties to it. */
const openInvoice = async (
  options: { arbiter?: boolean; draft?: Parameters<typeof draft>[0] } = {},
) => {
  const d0 = deploy();
  const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
  const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
  const arbiter = actor(d0, ARBITER_SECRET, ARBITER_PIN);
  const issued = await issue(d0, seller, buyer, {
    arbiterKey: options.arbiter === true ? arbiter.key : undefined,
    draft: options.draft,
  });
  return { ...issued, seller, buyer, arbiter };
};

/**
 * The buyer locks the payment with the contract.
 *
 * The buyer stages the openings the seller shared out of band, because
 * `fundEscrow` proves the funder can open the recorded terms before it takes
 * custody. Skipping the share is not a shortcut here .. the call would fail.
 *
 * The default value is the invoiced total, read off those same terms. A test
 * that wants a rejected amount asks for one; it cannot get one by accident.
 */
const funded = async (options: EscrowOptions = {}) => {
  const open = await openInvoice({ arbiter: options.arbiter, draft: options.draft });
  const deadline = options.deadline ?? DEADLINE;
  const value = options.value ?? total(open.prepared);
  const buyerState = stageFor(share(open.buyer.state, open.stored), open.prepared);

  const d = advance(
    open.d,
    open.d.contract.impureCircuits.fundEscrow(
      ctx(open.d, buyerState),
      open.invoiceId,
      open.buyer.pin,
      // Locked in whatever token this invoice is payable in, because the circuit
      // refuses any other .. the same rule the escrow tests below pin down.
      coin(value, open.prepared.terms.tokenType),
      deadline,
    ),
  );
  return { ...open, d, deadline, value };
};

/** A funded escrow the buyer has escalated to the arbiter named at issuance. */
const disputed = async () => {
  const f = await funded({ arbiter: true });
  const d = advance(
    f.d,
    f.d.contract.impureCircuits.openDispute(ctx(f.d, f.buyer.state), f.invoiceId, f.buyer.pin),
  );
  return { ...f, d };
};

describe('funding an escrow', () => {
  it('takes custody of the coin and puts the invoice under a deadline', async () => {
    const { d, invoiceId, deadline, value } = await funded();

    const anchor = led(d).invoices.lookup(invoiceId);
    expect(anchor.status).toBe(InvoiceStatus.escrowFunded);
    expect(anchor.escrowDeadline).toBe(deadline);
    expect(anchor.settledAt).toBe(0n);

    expect(led(d).escrowVault.member(invoiceId)).toBe(true);
    expect(led(d).escrowVault.lookup(invoiceId).value).toBe(value);
  });

  it('publishes the escrowed amount, which is the documented cost of custody', async () => {
    const { d, invoiceId, value } = await funded();

    // This is the one place in the contract where a commercial figure reaches
    // public state, and it is deliberate. `receiveShielded` requires a disclosed
    // coin, so a contract cannot hold funds and hide their value at the same
    // time; escrow mode trades the hidden amount for funds the contract actually
    // controls, and the private settlement path trades custody for secrecy.
    // Pinning it here stops anyone later claiming escrow is private too.
    expect(dump(led(d).escrowVault.lookup(invoiceId))).toContain(value.toString());

    // The anchor stays clean either way: only the vault entry carries a number.
    expect(dump(led(d).invoices.lookup(invoiceId))).not.toContain(value.toString());
  });

  it('refuses anyone who is not the named buyer', async () => {
    const open = await openInvoice();
    const stranger = actor(open.d, STRANGER_SECRET, 7n);
    const strangerState = stageFor(share(stranger.state, open.stored), open.prepared);

    expectThrows(
      () =>
        open.d.contract.impureCircuits.fundEscrow(
          ctx(open.d, strangerState),
          open.invoiceId,
          stranger.pin,
          coin(total(open.prepared)),
          DEADLINE,
        ),
      'caller is not the buyer',
    );
  });

  it('refuses the right buyer using the wrong PIN', async () => {
    const open = await openInvoice();
    const buyerState = stageFor(share(open.buyer.state, open.stored), open.prepared);

    // A rotated PIN is a different identity by construction, so the same wallet
    // cannot reach an invoice addressed to one of its other keys.
    expectThrows(
      () =>
        open.d.contract.impureCircuits.fundEscrow(
          ctx(open.d, buyerState),
          open.invoiceId,
          open.buyer.pin + 1n,
          coin(total(open.prepared)),
          DEADLINE,
        ),
      'caller is not the buyer',
    );
  });

  /**
   * Try to fund at block `at` with a given deadline.
   *
   * `fundEscrow` used to take a `fundedAt` alongside the deadline and compare
   * the two -- figures the same caller chose together, which is no check at
   * all. The check now rests on the block, and the argument is gone: the tests
   * below vary the block instead, because there is no longer a caller-supplied
   * date for them to vary.
   */
  const fundAt = async (attempt: {
    deadline: bigint;
    at?: bigint;
    /** Locked instead of the invoiced total. */
    value?: bigint;
    /** Locked away from the invoiced total, when the gap is the point. */
    delta?: bigint;
  }) => {
    const open = await openInvoice();
    const buyerState = stageFor(share(open.buyer.state, open.stored), open.prepared);
    const value = (attempt.value ?? total(open.prepared)) + (attempt.delta ?? 0n);

    return () =>
      open.d.contract.impureCircuits.fundEscrow(
        ctx(open.d, buyerState, attempt.at ?? T0),
        open.invoiceId,
        open.buyer.pin,
        coin(value, open.prepared.terms.tokenType),
        attempt.deadline,
      );
  };

  it('refuses a deadline that is not in the future', async () => {
    // Equal, not merely earlier: a deadline the refund clock has already reached
    // would let the buyer fund and withdraw in consecutive blocks, which is a
    // locked balance the seller can never rely on.
    expectThrows(await fundAt({ deadline: T0 }), 'escrow deadline must be in the future');
  });

  it('refuses a deadline already in the past', async () => {
    // A fortnight gone. Under the old rule the buyer escaped this by writing a
    // `fundedAt` three weeks older still, so that `deadline > fundedAt` held
    // comfortably; that was the entire check. The argument no longer exists, so
    // the old bypass is not merely refused here, it cannot be written down.
    expectThrows(
      await fundAt({ deadline: T0 - 14n * DAY }),
      'escrow deadline must be in the future',
    );
  });

  it('refuses a deadline the block has already passed, however early the block', async () => {
    // Same deadline, read at two different blocks. The rule tracks the chain
    // rather than anything in the call, so the same arguments pass before it and
    // fail after it -- which is what "checked against the block" has to mean.
    const before = await fundAt({ deadline: T0 + DAY, at: T0 });
    expect(() => before()).not.toThrow();
    expectThrows(
      await fundAt({ deadline: T0 + DAY, at: T0 + 2n * DAY }),
      'escrow deadline must be in the future',
    );
  });

  it('accepts a deadline one second ahead of the block', async () => {
    // The other side of the boundary, never probed before. Strictly-greater is
    // the rule, so a single second is enough and the escrow is taken.
    const fund = await fundAt({ deadline: T0 + 1n });
    expect(() => fund()).not.toThrow();
  });

  it('refuses an escrow short of the invoiced total', async () => {
    // Releasing an escrow marks the invoice settled and credits the seller, so
    // an escrow worth less than the invoice is a settlement for less than the
    // invoice. A single unit short is refused, and so is the 4,550,000 this
    // suite used to lock against a 6,050,000 invoice while asserting the call
    // succeeded -- which made the fixture the bug's alibi.
    expectThrows(
      await fundAt({ deadline: DEADLINE, delta: -1n }),
      'escrow must equal the invoice total',
    );
    expectThrows(
      await fundAt({ deadline: DEADLINE, value: 4_550_000n }),
      'escrow must equal the invoice total',
    );
  });

  it('refuses an escrow over the invoiced total', async () => {
    // Overpaying is refused too, not tolerated as generosity: the release path
    // pays the whole vault entry to the seller, so an over-funded escrow is the
    // buyer quietly losing the difference with no way to claw it back.
    expectThrows(
      await fundAt({ deadline: DEADLINE, delta: 1n }),
      'escrow must equal the invoice total',
    );
  });

  it('refuses an escrow worth nothing', async () => {
    // Zero used to have its own rule. It is now the extreme case of the total
    // check, and the message says so.
    expectThrows(
      await fundAt({ deadline: DEADLINE, value: 0n }),
      'escrow must equal the invoice total',
    );
  });

  it('refuses a coin in a token the invoice does not name', async () => {
    const open = await openInvoice();
    const buyerState = stageFor(share(open.buyer.state, open.stored), open.prepared);

    // The escrowed coin is the one that later pays the seller, so a lock in the
    // wrong token would leave the contract holding something the invoice never
    // asked for and the seller no way to refuse it when it is released.
    expectThrows(
      () =>
        open.d.contract.impureCircuits.fundEscrow(
          ctx(open.d, buyerState),
          open.invoiceId,
          open.buyer.pin,
          coin(total(open.prepared), OTHER_TOKEN),
          DEADLINE,
        ),
      'escrow is not in the token this invoice is payable in',
    );
  });

  it('follows the token the invoice names rather than a fixed one', async () => {
    const f = await funded({ draft: { tokenType: OTHER_TOKEN } });
    expect(toHex(led(f.d).escrowVault.lookup(f.invoiceId).color)).toBe(toHex(OTHER_TOKEN));

    // The native token is what every other escrow in this file locks, and this
    // invoice refuses it. That is the difference between a rule that reads the
    // terms and one that hard-codes a colour.
    const open = await openInvoice({ draft: { tokenType: OTHER_TOKEN } });
    const buyerState = stageFor(share(open.buyer.state, open.stored), open.prepared);
    expectThrows(
      () =>
        open.d.contract.impureCircuits.fundEscrow(
          ctx(open.d, buyerState),
          open.invoiceId,
          open.buyer.pin,
          coin(total(open.prepared), NATIVE_SHIELDED_TOKEN),
          DEADLINE,
        ),
      'escrow is not in the token this invoice is payable in',
    );
  });

  it('refuses an invoice that was already settled another way', async () => {
    const open = await openInvoice();
    const buyerState = stageFor(share(open.buyer.state, open.stored), open.prepared);

    const settled = advance(
      open.d,
      open.d.contract.impureCircuits.settleWithNote(
        ctx(open.d, buyerState),
        open.invoiceId,
        open.buyer.pin,
        coin(payableTotal(open.prepared.terms)),
        TO_SELLER,
        T0 + DAY,
      ),
    );

    const again = stageFor(share(open.buyer.state, open.stored), open.prepared);
    expectThrows(
      () =>
        settled.contract.impureCircuits.fundEscrow(
          ctx(settled, again),
          open.invoiceId,
          open.buyer.pin,
          coin(total(open.prepared)),
          DEADLINE,
        ),
      'invoice is not open for escrow',
    );
  });

  it('refuses a buyer who cannot open the recorded terms', async () => {
    const open = await openInvoice();

    // A buyer handed tampered terms .. here a larger amount .. cannot rebuild the
    // commitment on the anchor. Without this check the contract would happily
    // escrow funds against an invoice the two sides read differently.
    const tampered = {
      ...open.prepared,
      terms: { ...open.prepared.terms, amount: open.prepared.terms.amount + 1n },
    };
    const buyerState = stageFor(share(open.buyer.state, open.stored), tampered);

    expectThrows(
      () =>
        open.d.contract.impureCircuits.fundEscrow(
          ctx(open.d, buyerState),
          open.invoiceId,
          open.buyer.pin,
          coin(total(open.prepared)),
          DEADLINE,
        ),
      'terms do not open the recorded commitment',
    );
  });

  it('refuses to fund the same invoice twice', async () => {
    const f = await funded();
    const buyerState = stageFor(share(f.buyer.state, f.stored), f.prepared);

    expectThrows(
      () =>
        f.d.contract.impureCircuits.fundEscrow(
          ctx(f.d, buyerState),
          f.invoiceId,
          f.buyer.pin,
          coin(total(f.prepared)),
          DEADLINE,
        ),
      'invoice is not open for escrow',
    );
  });
});

describe('releasing an escrow', () => {
  /**
   * The buyer confirms delivery. `at` is the block; `claims` is the date they
   * write on the settlement, which is only ever a different figure when a test
   * is showing that punctuality does not follow it.
   */
  const release = async (options: { at?: bigint; claims?: bigint } = {}) => {
    const f = await funded();
    const at = options.at ?? T0 + DAY;
    const claims = options.claims ?? at;
    const buyerState = stageFor(share(f.buyer.state, f.stored), f.prepared);
    const d = advance(
      f.d,
      f.d.contract.impureCircuits.releaseEscrow(
        ctx(f.d, buyerState, at),
        f.invoiceId,
        f.buyer.pin,
        TO_SELLER,
        claims,
      ),
    );
    return { ...f, d, at, claims };
  };

  it('pays the seller, settles the invoice and empties the vault', async () => {
    const { d, invoiceId, seller, at } = await release();

    const anchor = led(d).invoices.lookup(invoiceId);
    expect(anchor.status).toBe(InvoiceStatus.settled);
    expect(anchor.settledAt).toBe(at);

    const settlement = led(d).settlements.lookup(invoiceId);
    expect(settlement.mode).toBe(SettlementMode.escrow);
    expect(led(d).settledCount).toBe(1n);

    // Custody ends with the payout. A vault entry left behind would be a coin the
    // contract believes it still holds and can pay out a second time.
    expect(led(d).escrowVault.member(invoiceId)).toBe(false);
    expect(led(d).escrowVault.size()).toBe(0n);

    expect(led(d).reliability.lookup(seller.key).settled).toBe(1n);
  });

  it('credits the seller an on-time mark when released before the due date', async () => {
    const { d, invoiceId, seller } = await release({ at: T0 + DAY });
    expect(led(d).settlements.lookup(invoiceId).onTime).toBe(true);

    const r = led(d).reliability.lookup(seller.key);
    expect(r.settled).toBe(1n);
    expect(r.settledOnTime).toBe(1n);
  });

  it('records a release after the due date as settled but late', async () => {
    // Late is still a release: the escrow deadline governs refunds, not payment,
    // so a buyer who confirms delivery late still pays and the seller still gets
    // the settlement .. they just do not get the punctuality mark.
    const { d, invoiceId, seller } = await release({ at: draft().dueDate + DAY });
    expect(led(d).settlements.lookup(invoiceId).onTime).toBe(false);

    const r = led(d).reliability.lookup(seller.key);
    expect(r.settled).toBe(1n);
    expect(r.settledOnTime).toBe(0n);
  });

  it('takes punctuality from the block, not from the date the buyer writes', async () => {
    // The buyer confirms delivery a day past the due date and dates the record a
    // month earlier. The seller's punctuality record must not follow the figure
    // the party with an interest in it chose.
    const claims = T0 + DAY;
    const { d, invoiceId, seller } = await release({ at: draft().dueDate + DAY, claims });

    const settlement = led(d).settlements.lookup(invoiceId);
    expect(settlement.onTime).toBe(false);
    expect(settlement.settledAt).toBe(claims);
    expect(led(d).reliability.lookup(seller.key).settledOnTime).toBe(0n);
  });

  it('refuses a release addressed to anyone but the seller on the invoice', async () => {
    const f = await funded();

    // The buyer is the only caller `releaseEscrow` accepts, and the recipient
    // used to be a free argument. Together that meant the buyer could send the
    // contract's custody of the money back to themselves and still have the
    // invoice recorded as settled, with the seller credited for it.
    const attempt = (to: { readonly bytes: Uint8Array }) => () =>
      f.d.contract.impureCircuits.releaseEscrow(
        ctx(f.d, stageFor(share(f.buyer.state, f.stored), f.prepared), T0 + DAY),
        f.invoiceId,
        f.buyer.pin,
        to,
        T0 + DAY,
      );

    expectThrows(attempt(TO_BUYER), 'release is not addressed to the seller on this invoice');
    expectThrows(attempt(TO_STRANGER), 'release is not addressed to the seller on this invoice');

    // The escrow is untouched by a refused release, so the seller's claim on it
    // survives the attempt.
    expect(led(f.d).escrowVault.member(f.invoiceId)).toBe(true);
  });

  it('refuses anyone who is not the buyer, including the seller being paid', async () => {
    const f = await funded();
    const sellerState = stageFor(share(f.seller.state, f.stored), f.prepared);

    expectThrows(
      () =>
        f.d.contract.impureCircuits.releaseEscrow(
          ctx(f.d, sellerState),
          f.invoiceId,
          f.seller.pin,
          TO_SELLER,
          T0 + DAY,
        ),
      'caller is not the buyer',
    );
  });

  it('refuses an invoice whose escrow was never funded', async () => {
    const open = await openInvoice();
    const buyerState = stageFor(share(open.buyer.state, open.stored), open.prepared);

    expectThrows(
      () =>
        open.d.contract.impureCircuits.releaseEscrow(
          ctx(open.d, buyerState),
          open.invoiceId,
          open.buyer.pin,
          TO_SELLER,
          T0 + DAY,
        ),
      'invoice has no funded escrow',
    );
  });

  it('refuses a second release of the same escrow', async () => {
    const { d, invoiceId, buyer, stored, prepared } = await release();
    const buyerState = stageFor(share(buyer.state, stored), prepared);

    expectThrows(
      () =>
        d.contract.impureCircuits.releaseEscrow(
          ctx(d, buyerState),
          invoiceId,
          buyer.pin,
          TO_SELLER,
          T0 + 2n * DAY,
        ),
      'invoice has no funded escrow',
    );
  });

  it('refuses a release once the buyer has taken the refund', async () => {
    const f = await funded();
    const refunded = advance(
      f.d,
      f.d.contract.impureCircuits.refundEscrow(
        ctx(f.d, f.buyer.state, f.deadline + 1n),
        f.invoiceId,
        f.buyer.pin,
        TO_BUYER,
      ),
    );

    // The two exits are mutually exclusive because both leave the status out of
    // `escrowFunded`, which is the only state either accepts.
    const buyerState = stageFor(share(f.buyer.state, f.stored), f.prepared);
    expectThrows(
      () =>
        refunded.contract.impureCircuits.releaseEscrow(
          ctx(refunded, buyerState, f.deadline + 2n),
          f.invoiceId,
          f.buyer.pin,
          TO_SELLER,
          f.deadline + 2n,
        ),
      'invoice has no funded escrow',
    );
  });

  it('needs the invoice staged, because release re-opens the terms', async () => {
    const f = await funded();

    // Release re-opens the recorded terms to read the seller's payout address
    // out of them, and it writes a settlement receipt under the staged salt.
    // Both come from the same staged context, so calling with a bare wallet
    // state fails in the witness before the circuit sees anything.
    expectThrows(
      () =>
        f.d.contract.impureCircuits.releaseEscrow(
          ctx(f.d, f.buyer.state),
          f.invoiceId,
          f.buyer.pin,
          TO_SELLER,
          T0 + DAY,
        ),
      'no invoice is staged',
    );
  });
});

describe('refunding an escrow', () => {
  it('refuses a refund before the deadline has passed', async () => {
    const f = await funded();

    // Exactly on the deadline, not merely before it: the contract reads the block
    // clock and requires it to be strictly past, so a buyer cannot round their way
    // out of an escrow the seller could still fulfil.
    expectThrows(
      () =>
        f.d.contract.impureCircuits.refundEscrow(
          ctx(f.d, f.buyer.state, f.deadline),
          f.invoiceId,
          f.buyer.pin,
          TO_BUYER,
        ),
      'escrow deadline has not passed',
    );
  });

  it('returns the money to the buyer once the deadline has passed', async () => {
    const f = await funded();
    const d = advance(
      f.d,
      f.d.contract.impureCircuits.refundEscrow(
        ctx(f.d, f.buyer.state, f.deadline + 1n),
        f.invoiceId,
        f.buyer.pin,
        TO_BUYER,
      ),
    );

    const anchor = led(d).invoices.lookup(f.invoiceId);
    expect(anchor.status).toBe(InvoiceStatus.refunded);
    // The deadline survives the refund, so the record still says when the seller's
    // window closed.
    expect(anchor.escrowDeadline).toBe(f.deadline);
    expect(led(d).escrowVault.member(f.invoiceId)).toBe(false);
  });

  it('refuses anyone who is not the buyer', async () => {
    const f = await funded();

    expectThrows(
      () =>
        f.d.contract.impureCircuits.refundEscrow(
          ctx(f.d, f.seller.state, f.deadline + 1n),
          f.invoiceId,
          f.seller.pin,
          TO_BUYER,
        ),
      'caller is not the buyer',
    );
  });

  it('refuses an invoice whose escrow was never funded', async () => {
    const open = await openInvoice();

    expectThrows(
      () =>
        open.d.contract.impureCircuits.refundEscrow(
          ctx(open.d, open.buyer.state, DEADLINE + 1n),
          open.invoiceId,
          open.buyer.pin,
          TO_BUYER,
        ),
      'invoice has no funded escrow',
    );
  });

  it('leaves the seller no settlement credit for an escrow that came back', async () => {
    const f = await funded();
    const d = advance(
      f.d,
      f.d.contract.impureCircuits.refundEscrow(
        ctx(f.d, f.buyer.state, f.deadline + 1n),
        f.invoiceId,
        f.buyer.pin,
        TO_BUYER,
      ),
    );

    // A refund means the seller was not paid, so the reliability record .. which a
    // seller later shows to prospective customers .. must not gain anything from it.
    expect(led(d).settledCount).toBe(0n);
    expect(led(d).settlements.member(f.invoiceId)).toBe(false);
    expect(led(d).reliability.member(f.seller.key)).toBe(false);
  });

  it('returns the money even while the contract is paused', async () => {
    const f = await funded();
    const paused = advance(
      f.d,
      f.d.contract.impureCircuits.setPaused(ctx(f.d, f.seller.state), true),
    );
    expect(led(paused).paused).toBe(true);

    // The deadline has passed, the money is the buyer's, and the seller's window
    // to earn it has closed. An administrator who pauses -- or who loses their
    // key while paused -- would otherwise hold funds nobody disputes are owed
    // back. A stop exists to halt new business, not to freeze a refund.
    const d = advance(
      paused,
      paused.contract.impureCircuits.refundEscrow(
        ctx(paused, f.buyer.state, f.deadline + 1n),
        f.invoiceId,
        f.buyer.pin,
        TO_BUYER,
      ),
    );

    expect(led(d).invoices.lookup(f.invoiceId).status).toBe(InvoiceStatus.refunded);
    expect(led(d).escrowVault.member(f.invoiceId)).toBe(false);
    expect(led(d).paused).toBe(true);
  });

  it('is the only escrow exit a pause leaves open', async () => {
    const f = await funded();
    const paused = advance(
      f.d,
      f.d.contract.impureCircuits.setPaused(ctx(f.d, f.seller.state), true),
    );

    // The counterpart to the test above. Releasing moves money on a live invoice,
    // which is exactly the new business a stop is for, so it is refused. If a
    // pause blocked both, an emergency stop would trap the buyer's own money.
    const buyerState = stageFor(share(f.buyer.state, f.stored), f.prepared);
    expectThrows(
      () =>
        paused.contract.impureCircuits.releaseEscrow(
          ctx(paused, buyerState, T0 + DAY),
          f.invoiceId,
          f.buyer.pin,
          TO_SELLER,
          T0 + DAY,
        ),
      'contract is paused',
    );
    expect(led(paused).escrowVault.member(f.invoiceId)).toBe(true);
  });
});

describe('opening a dispute', () => {
  it('escalates a funded escrow and marks the party who raised it', async () => {
    const { d, invoiceId, buyer } = await disputed();

    expect(led(d).invoices.lookup(invoiceId).status).toBe(InvoiceStatus.disputed);
    expect(led(d).disputes.lookup(invoiceId)).toBe(DisputeOutcome.undecided);
    expect(led(d).disputedCount).toBe(1n);
    expect(led(d).reliability.lookup(buyer.key).disputesOpened).toBe(1n);
  });

  it('lets the seller raise one too, and counts only the opener', async () => {
    const f = await funded({ arbiter: true });
    const d = advance(
      f.d,
      f.d.contract.impureCircuits.openDispute(ctx(f.d, f.seller.state), f.invoiceId, f.seller.pin),
    );

    expect(led(d).reliability.lookup(f.seller.key).disputesOpened).toBe(1n);
    // Opening a dispute is not a mark against the other side. Only losing one is.
    expect(led(d).reliability.member(f.buyer.key)).toBe(false);
  });

  it('refuses an invoice issued without an arbiter', async () => {
    const f = await funded();

    // No arbiter was named at issuance, so there is nobody who could ever decide.
    // Refusing here rather than at resolution keeps a party from freezing funds in
    // a forum that does not exist.
    expectThrows(
      () => f.d.contract.impureCircuits.openDispute(ctx(f.d, f.buyer.state), f.invoiceId, f.buyer.pin),
      'invoice has no arbiter',
    );
  });

  it('refuses someone who is not a party to the invoice', async () => {
    const f = await funded({ arbiter: true });
    const stranger = actor(f.d, STRANGER_SECRET, 7n);

    expectThrows(
      () =>
        f.d.contract.impureCircuits.openDispute(ctx(f.d, stranger.state), f.invoiceId, stranger.pin),
      'caller is not a party to this invoice',
    );
  });

  it('refuses an invoice with nothing in escrow to argue about', async () => {
    const open = await openInvoice({ arbiter: true });

    expectThrows(
      () =>
        open.d.contract.impureCircuits.openDispute(
          ctx(open.d, open.buyer.state),
          open.invoiceId,
          open.buyer.pin,
        ),
      'only a funded escrow can be disputed',
    );
  });

  it('freezes the buyer out of releasing while the dispute is open', async () => {
    const { d, invoiceId, buyer, stored, prepared } = await disputed();
    const buyerState = stageFor(share(buyer.state, stored), prepared);

    // Once the arbiter is seized of it, neither party can move the coin on their
    // own .. the status is no longer `escrowFunded`, which every unilateral exit
    // requires.
    expectThrows(
      () =>
        d.contract.impureCircuits.releaseEscrow(
          ctx(d, buyerState),
          invoiceId,
          buyer.pin,
          TO_SELLER,
          T0 + DAY,
        ),
      'invoice has no funded escrow',
    );
  });
});

describe('resolving a dispute', () => {
  /**
   * The arbiter rules, and the escrowed coin moves in the same call.
   *
   * The arbiter has to stage the invoice openings: the circuit re-opens the
   * terms to read the two payout addresses out of them, so it is the ruling that
   * picks the address rather than the arbiter. Both parties therefore have to
   * share the record with whoever they appointed -- see the report note, because
   * it costs the arbiter's blindness to the amount.
   */
  const resolve = async (forSeller: boolean, at: bigint = T0 + 2n * DAY) => {
    const dispute = await disputed();
    const arbiterState = stageFor(
      share(dispute.arbiter.state, dispute.stored),
      dispute.prepared,
    );
    const d = advance(
      dispute.d,
      dispute.d.contract.impureCircuits.resolveDispute(
        ctx(dispute.d, arbiterState, at),
        dispute.invoiceId,
        dispute.arbiter.pin,
        forSeller,
        forSeller ? TO_SELLER : TO_BUYER,
        at,
      ),
    );
    return { ...dispute, d, at };
  };

  /** A ruling and a payout address, chosen independently, made but not run. */
  const ruleAndPay = async (forSeller: boolean, to: { readonly bytes: Uint8Array }) => {
    const dispute = await disputed();
    const arbiterState = stageFor(
      share(dispute.arbiter.state, dispute.stored),
      dispute.prepared,
    );

    return () =>
      dispute.d.contract.impureCircuits.resolveDispute(
        ctx(dispute.d, arbiterState, T0 + 2n * DAY),
        dispute.invoiceId,
        dispute.arbiter.pin,
        forSeller,
        to,
        T0 + 2n * DAY,
      );
  };

  it('pays the seller and counts the settlement when the arbiter rules for them', async () => {
    const { d, invoiceId, seller, buyer, at } = await resolve(true);

    const anchor = led(d).invoices.lookup(invoiceId);
    expect(anchor.status).toBe(InvoiceStatus.resolved);
    expect(anchor.settledAt).toBe(at);
    expect(led(d).disputes.lookup(invoiceId)).toBe(DisputeOutcome.forSeller);
    expect(led(d).escrowVault.member(invoiceId)).toBe(false);

    // A seller who wins was owed the money, so the invoice counts as settled.
    expect(led(d).settledCount).toBe(1n);
    expect(led(d).reliability.lookup(seller.key).settled).toBe(1n);

    // The buyer withheld payment that was due, and carries the mark for it.
    expect(led(d).reliability.lookup(buyer.key).disputesLost).toBe(1n);
    expect(led(d).reliability.lookup(seller.key).disputesLost).toBe(0n);
  });

  it('pays the buyer and counts no settlement when the arbiter rules for them', async () => {
    const { d, invoiceId, seller, buyer } = await resolve(false);

    expect(led(d).invoices.lookup(invoiceId).status).toBe(InvoiceStatus.resolved);
    expect(led(d).disputes.lookup(invoiceId)).toBe(DisputeOutcome.forBuyer);
    expect(led(d).escrowVault.member(invoiceId)).toBe(false);

    // Nothing was owed, so nothing settled. A seller who lost a dispute must not
    // be able to point at it as evidence of a paid invoice.
    expect(led(d).settledCount).toBe(0n);
    expect(led(d).settlements.member(invoiceId)).toBe(false);
    expect(led(d).reliability.lookup(seller.key).settled).toBe(0n);

    expect(led(d).reliability.lookup(seller.key).disputesLost).toBe(1n);
    expect(led(d).reliability.lookup(buyer.key).disputesLost).toBe(0n);
  });

  // `forSeller` and `payout` used to be unrelated arguments. An arbiter could
  // rule for one party and send the escrow to the other, or to themselves, and
  // the ledger would record a verdict that had nothing to do with where the
  // money went. The verdict now picks the address out of the terms, so the
  // arbiter chooses a direction and nothing else.
  it('refuses a seller-favouring ruling that pays the buyer', async () => {
    expectThrows(
      await ruleAndPay(true, TO_BUYER),
      'payout does not match the party the ruling favours',
    );
  });

  it('refuses a buyer-favouring ruling that pays the seller', async () => {
    expectThrows(
      await ruleAndPay(false, TO_SELLER),
      'payout does not match the party the ruling favours',
    );
  });

  it('refuses either ruling paying an address on neither side', async () => {
    // The case the rule exists for: an arbiter awarding the escrow to a wallet
    // of their own while recording a verdict that looks ordinary.
    expectThrows(
      await ruleAndPay(true, TO_STRANGER),
      'payout does not match the party the ruling favours',
    );
    expectThrows(
      await ruleAndPay(false, TO_STRANGER),
      'payout does not match the party the ruling favours',
    );
  });

  it('refuses anyone but the named arbiter, including both parties', async () => {
    const dispute = await disputed();

    expectThrows(
      () =>
        dispute.d.contract.impureCircuits.resolveDispute(
          ctx(dispute.d, dispute.buyer.state),
          dispute.invoiceId,
          dispute.buyer.pin,
          false,
          TO_BUYER,
          T0 + 2n * DAY,
        ),
      'caller is not the named arbiter',
    );

    expectThrows(
      () =>
        dispute.d.contract.impureCircuits.resolveDispute(
          ctx(dispute.d, dispute.seller.state),
          dispute.invoiceId,
          dispute.seller.pin,
          true,
          TO_SELLER,
          T0 + 2n * DAY,
        ),
      'caller is not the named arbiter',
    );
  });

  it('refuses an invoice nobody has disputed', async () => {
    const f = await funded({ arbiter: true });

    // The arbiter is named on the anchor from issuance, but that is an appointment,
    // not standing authority over the funds.
    expectThrows(
      () =>
        f.d.contract.impureCircuits.resolveDispute(
          ctx(f.d, f.arbiter.state),
          f.invoiceId,
          f.arbiter.pin,
          true,
          TO_SELLER,
          T0 + 2n * DAY,
        ),
      'invoice is not under dispute',
    );
  });

  it('refuses a second resolution of the same dispute', async () => {
    const { d, invoiceId, arbiter } = await resolve(true);

    expectThrows(
      () =>
        d.contract.impureCircuits.resolveDispute(
          ctx(d, arbiter.state),
          invoiceId,
          arbiter.pin,
          false,
          TO_BUYER,
          T0 + 3n * DAY,
        ),
      'invoice is not under dispute',
    );
  });
});
