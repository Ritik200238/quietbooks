// Escrow custody: funding, release, refund, and the dispute path.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import {
  actor,
  advance,
  ARBITER_PIN,
  ARBITER_SECRET,
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
  pk,
  SELLER_PIN,
  SELLER_SECRET,
  share,
  stageFor,
  STRANGER_SECRET,
  T0,
} from './harness.js';

import { DisputeOutcome, InvoiceStatus, SettlementMode } from '../build/contract/index.js';
import { toHex } from '../src/util.js';

/** Payout addresses. Nothing here asserts on them beyond the call succeeding. */
const SELLER_PAYOUT = pk(0xa1);
const BUYER_PAYOUT = pk(0xb2);

const ESCROW_VALUE = 4_550_000n;
const DEADLINE = T0 + 14n * DAY;
const NOTE = bytes32(0x9e);

/** JSON with the byte arrays and bigints of a ledger record made readable. */
const dump = (value: unknown): string =>
  JSON.stringify(value, (_k, v) =>
    typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? toHex(v) : v,
  );

type EscrowOptions = {
  readonly arbiter?: boolean;
  readonly value?: bigint;
  readonly deadline?: bigint;
};

/** A fresh deployment with an invoice open, plus the three parties to it. */
const openInvoice = async (options: { arbiter?: boolean } = {}) => {
  const d0 = deploy();
  const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
  const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
  const arbiter = actor(d0, ARBITER_SECRET, ARBITER_PIN);
  const issued = await issue(
    d0,
    seller,
    buyer,
    options.arbiter === true ? { arbiterKey: arbiter.key } : {},
  );
  return { ...issued, seller, buyer, arbiter };
};

/**
 * The buyer locks the payment with the contract.
 *
 * The buyer stages the openings the seller shared out of band, because
 * `fundEscrow` proves the funder can open the recorded terms before it takes
 * custody. Skipping the share is not a shortcut here .. the call would fail.
 */
const funded = async (options: EscrowOptions = {}) => {
  const open = await openInvoice({ arbiter: options.arbiter });
  const deadline = options.deadline ?? DEADLINE;
  const value = options.value ?? ESCROW_VALUE;
  const buyerState = stageFor(share(open.buyer.state, open.stored), open.prepared);

  const d = advance(
    open.d,
    open.d.contract.impureCircuits.fundEscrow(
      ctx(open.d, buyerState),
      open.invoiceId,
      open.buyer.pin,
      coin(value),
      deadline,
      T0,
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
          coin(ESCROW_VALUE),
          DEADLINE,
          T0,
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
          coin(ESCROW_VALUE),
          DEADLINE,
          T0,
        ),
      'caller is not the buyer',
    );
  });

  it('refuses a deadline that is not in the future', async () => {
    const open = await openInvoice();
    const buyerState = stageFor(share(open.buyer.state, open.stored), open.prepared);

    // Equal, not merely earlier: a deadline the refund clock has already reached
    // would let the buyer fund and withdraw in consecutive blocks, which is a
    // locked balance the seller can never rely on.
    expectThrows(
      () =>
        open.d.contract.impureCircuits.fundEscrow(
          ctx(open.d, buyerState),
          open.invoiceId,
          open.buyer.pin,
          coin(ESCROW_VALUE),
          T0,
          T0,
        ),
      'escrow deadline must be in the future',
    );
  });

  it('refuses an escrow worth nothing', async () => {
    const open = await openInvoice();
    const buyerState = stageFor(share(open.buyer.state, open.stored), open.prepared);

    expectThrows(
      () =>
        open.d.contract.impureCircuits.fundEscrow(
          ctx(open.d, buyerState),
          open.invoiceId,
          open.buyer.pin,
          coin(0n),
          DEADLINE,
          T0,
        ),
      'escrowed amount must be positive',
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
        NOTE,
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
          coin(ESCROW_VALUE),
          DEADLINE,
          T0,
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
          coin(ESCROW_VALUE),
          DEADLINE,
          T0,
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
          coin(ESCROW_VALUE),
          DEADLINE,
          T0,
        ),
      'invoice is not open for escrow',
    );
  });
});

describe('releasing an escrow', () => {
  const release = async (at: bigint = T0 + DAY) => {
    const f = await funded();
    const buyerState = stageFor(share(f.buyer.state, f.stored), f.prepared);
    const d = advance(
      f.d,
      f.d.contract.impureCircuits.releaseEscrow(
        ctx(f.d, buyerState, at),
        f.invoiceId,
        f.buyer.pin,
        SELLER_PAYOUT,
        at,
      ),
    );
    return { ...f, d, at };
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
    const { d, invoiceId, seller } = await release(T0 + DAY);
    expect(led(d).settlements.lookup(invoiceId).onTime).toBe(true);

    const r = led(d).reliability.lookup(seller.key);
    expect(r.settled).toBe(1n);
    expect(r.settledOnTime).toBe(1n);
  });

  it('records a release after the due date as settled but late', async () => {
    // Late is still a release: the escrow deadline governs refunds, not payment,
    // so a buyer who confirms delivery late still pays and the seller still gets
    // the settlement .. they just do not get the punctuality mark.
    const { d, invoiceId, seller } = await release(draft().dueDate + DAY);
    expect(led(d).settlements.lookup(invoiceId).onTime).toBe(false);

    const r = led(d).reliability.lookup(seller.key);
    expect(r.settled).toBe(1n);
    expect(r.settledOnTime).toBe(0n);
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
          SELLER_PAYOUT,
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
          SELLER_PAYOUT,
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
          SELLER_PAYOUT,
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
        BUYER_PAYOUT,
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
          SELLER_PAYOUT,
          f.deadline + 2n,
        ),
      'invoice has no funded escrow',
    );
  });

  it('still needs the invoice staged, because the receipt salt is a witness', async () => {
    const f = await funded();

    // Release never re-opens the terms .. the escrow was bound to them at funding
    // time .. but it writes a settlement receipt, and the salt behind that receipt
    // comes from the same staged context. Calling with a bare wallet state fails
    // in the witness, before the circuit sees anything.
    expectThrows(
      () =>
        f.d.contract.impureCircuits.releaseEscrow(
          ctx(f.d, f.buyer.state),
          f.invoiceId,
          f.buyer.pin,
          SELLER_PAYOUT,
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
          BUYER_PAYOUT,
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
        BUYER_PAYOUT,
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
          BUYER_PAYOUT,
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
          BUYER_PAYOUT,
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
        BUYER_PAYOUT,
      ),
    );

    // A refund means the seller was not paid, so the reliability record .. which a
    // seller later shows to prospective customers .. must not gain anything from it.
    expect(led(d).settledCount).toBe(0n);
    expect(led(d).settlements.member(f.invoiceId)).toBe(false);
    expect(led(d).reliability.member(f.seller.key)).toBe(false);
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
          SELLER_PAYOUT,
          T0 + DAY,
        ),
      'invoice has no funded escrow',
    );
  });
});

describe('resolving a dispute', () => {
  const resolve = async (forSeller: boolean, at: bigint = T0 + 2n * DAY) => {
    const dispute = await disputed();
    const d = advance(
      dispute.d,
      dispute.d.contract.impureCircuits.resolveDispute(
        ctx(dispute.d, dispute.arbiter.state, at),
        dispute.invoiceId,
        dispute.arbiter.pin,
        forSeller,
        forSeller ? SELLER_PAYOUT : BUYER_PAYOUT,
        at,
      ),
    );
    return { ...dispute, d, at };
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

  it('refuses anyone but the named arbiter, including both parties', async () => {
    const dispute = await disputed();

    expectThrows(
      () =>
        dispute.d.contract.impureCircuits.resolveDispute(
          ctx(dispute.d, dispute.buyer.state),
          dispute.invoiceId,
          dispute.buyer.pin,
          false,
          BUYER_PAYOUT,
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
          SELLER_PAYOUT,
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
          SELLER_PAYOUT,
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
          BUYER_PAYOUT,
          T0 + 3n * DAY,
        ),
      'invoice is not under dispute',
    );
  });
});
