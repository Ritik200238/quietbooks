// What the contract does when the prover lies.
//
// SPDX-License-Identifier: Apache-2.0
//
// The other four suites run `src/witnesses.ts`, the honest witness set that
// ships with the product. That makes them tests of the happy path even when
// they assert a refusal, because the values under test always arrived from
// software that was trying to be correct.
//
// A witness is not like that. It is a private input the caller's own machine
// produces, the chain never sees it, and nothing stops a party from replacing
// `src/witnesses.ts` with one that returns whatever suits them. Every claim this
// contract makes about money it cannot see -- that the amount is the one both
// sides agreed, that the payment reached the seller, that the terms behind an
// invoice are the terms the chain committed to -- is a claim about what happens
// when the prover is hostile.
//
// So these tests are hostile. They were written because a mutation run found
// that reverting the single most serious fix in the contract, the one that
// stopped `settleWithNote` reading the terms witness twice, left every one of
// the other 215 tests green.

import { describe, expect, it } from 'vitest';

import { pureCircuits } from '../build/contract/index.js';
import type { InvoiceTerms } from '../build/contract/index.js';

import {
  actor,
  advance,
  ARBITER_PIN,
  ARBITER_SECRET,
  BUYER_PIN,
  BUYER_SECRET,
  bytes32,
  coin,
  ctx,
  deploy,
  draft,
  DAY,
  issue,
  led,
  lyingTerms,
  payoutTo,
  SELLER_PAYOUT,
  SELLER_PIN,
  SELLER_SECRET,
  share,
  stageFor,
  STRANGER_PAYOUT,
  T0,
  total,
  withProver,
  expectThrows,
  type Deployed,
} from './harness.js';

/** One invoice, issued honestly, with the buyer holding the openings. */
const openInvoice = async (options: { arbiter?: boolean } = {}) => {
  const d0 = deploy();
  const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
  const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
  const arbiter = actor(d0, ARBITER_SECRET, ARBITER_PIN);

  const issued = await issue(d0, seller, buyer, {
    arbiterKey: options.arbiter === true ? arbiter.key : undefined,
  });
  return {
    ...issued,
    seller,
    buyer,
    arbiter,
    buyerState: stageFor(share(buyer.state, issued.stored), issued.prepared),
  };
};

describe('a prover that changes its story mid-circuit', () => {
  /**
   * The attack the fix exists for.
   *
   * `settleWithNote` proves the caller can open the invoice's terms commitment,
   * then checks the coin against the amount in those terms. When the two steps
   * each called `invoiceTerms()`, they were reading two independent private
   * inputs. The buyer proved the real terms to the first and handed the second a
   * one-unit invoice, paid one unit, and walked away with the invoice marked
   * settled in full.
   *
   * The prover below is exactly that attacker: honest on the first read,
   * one-unit on every read after it.
   */
  it('cannot settle a six-million invoice for one unit', async () => {
    const open = await openInvoice();
    const forge = lyingTerms(
      (real, read): InvoiceTerms =>
        read === 1 ? real : { ...real, amount: 1n, taxAmount: 0n },
    );

    expectThrows(
      () =>
        withProver(open.d, forge.witnesses).contract.impureCircuits.settleWithNote(
          ctx(open.d, open.buyerState),
          open.invoiceId,
          open.buyer.pin,
          coin(1n),
          payoutTo(SELLER_PAYOUT),
          T0 + DAY,
        ),
      'payment does not equal the invoice total',
    );

    // And the reason it failed is the one that matters. The circuit asked for
    // the terms once, so the lie was never reachable: there was no second read
    // for it to answer. If this count is ever two again, the assertion above
    // starts passing for an invoice the buyer can settle for a unit.
    expect(forge.log.reads).toBe(1);
  });

  /**
   * Every circuit that opens the terms, not just the one the mutation run
   * caught.
   *
   * Each is driven by a counting prover and each must ask exactly once. The
   * table is the invariant written down: any future edit that re-reads the
   * witness anywhere shows up here as a count of two, whether or not anyone
   * thought to write a test for the value it happened to compare.
   */
  const opensTheTerms = [
    {
      name: 'settleWithNote',
      run: async (forge: ReturnType<typeof lyingTerms>) => {
        const open = await openInvoice();
        withProver(open.d, forge.witnesses).contract.impureCircuits.settleWithNote(
          ctx(open.d, open.buyerState),
          open.invoiceId,
          open.buyer.pin,
          coin(total(open.prepared)),
          payoutTo(SELLER_PAYOUT),
          T0 + DAY,
        );
      },
    },
    {
      name: 'settleAttested',
      run: async (forge: ReturnType<typeof lyingTerms>) => {
        const open = await openInvoice();
        const sellerState = stageFor(open.seller.state, open.prepared);
        withProver(open.d, forge.witnesses).contract.impureCircuits.settleAttested(
          ctx(open.d, sellerState),
          open.invoiceId,
          open.seller.pin,
          bytes32(0x5e),
          T0 + DAY,
        );
      },
    },
    {
      name: 'fundEscrow',
      run: async (forge: ReturnType<typeof lyingTerms>) => {
        const open = await openInvoice();
        withProver(open.d, forge.witnesses).contract.impureCircuits.fundEscrow(
          ctx(open.d, open.buyerState),
          open.invoiceId,
          open.buyer.pin,
          coin(total(open.prepared)),
          T0 + 10n * DAY,
        );
      },
    },
    {
      name: 'releaseEscrow',
      run: async (forge: ReturnType<typeof lyingTerms>) => {
        const open = await openInvoice();
        const funded = advance(
          open.d,
          open.d.contract.impureCircuits.fundEscrow(
            ctx(open.d, open.buyerState),
            open.invoiceId,
            open.buyer.pin,
            coin(total(open.prepared)),
            T0 + 10n * DAY,
          ),
        );
        withProver(funded, forge.witnesses).contract.impureCircuits.releaseEscrow(
          ctx(funded, open.buyerState),
          open.invoiceId,
          open.buyer.pin,
          payoutTo(SELLER_PAYOUT),
          T0 + DAY,
        );
      },
    },
    {
      name: 'resolveDispute',
      run: async (forge: ReturnType<typeof lyingTerms>) => {
        const open = await openInvoice({ arbiter: true });
        const funded = advance(
          open.d,
          open.d.contract.impureCircuits.fundEscrow(
            ctx(open.d, open.buyerState),
            open.invoiceId,
            open.buyer.pin,
            coin(total(open.prepared)),
            T0 + 10n * DAY,
          ),
        );
        const disputed = advance(
          funded,
          funded.contract.impureCircuits.openDispute(
            ctx(funded, open.buyer.state),
            open.invoiceId,
            open.buyer.pin,
          ),
        );
        // The arbiter holds the openings. That is the documented cost of binding
        // the ruling to an address: proving the binding needs the terms, so the
        // arbiter sees the amount.
        const arbiterState = stageFor(share(open.arbiter.state, open.stored), open.prepared);
        withProver(disputed, forge.witnesses).contract.impureCircuits.resolveDispute(
          ctx(disputed, arbiterState),
          open.invoiceId,
          open.arbiter.pin,
          true,
          payoutTo(SELLER_PAYOUT),
          T0 + DAY,
        );
      },
    },
  ] as const;

  for (const circuit of opensTheTerms) {
    it(`${circuit.name} asks the prover for the terms exactly once`, async () => {
      const forge = lyingTerms((real) => real);
      await circuit.run(forge);
      expect(forge.log.reads).toBe(1);
    });
  }

  /**
   * The mirror image, and the reason the single read has to be the one that is
   * proven rather than merely the first.
   *
   * Here the prover lies first and tells the truth afterwards. A circuit that
   * proved the commitment against a later read would accept this.
   */
  it('cannot open the commitment with terms it did not commit to', async () => {
    const open = await openInvoice();
    const forge = lyingTerms((real, read): InvoiceTerms =>
      read === 1 ? { ...real, amount: 1n, taxAmount: 0n } : real,
    );

    expectThrows(
      () =>
        withProver(open.d, forge.witnesses).contract.impureCircuits.settleWithNote(
          ctx(open.d, open.buyerState),
          open.invoiceId,
          open.buyer.pin,
          coin(1n),
          payoutTo(SELLER_PAYOUT),
          T0 + DAY,
        ),
      'terms do not open the recorded commitment',
    );
  });
});

describe('a prover that rewrites the parts of the terms nobody looks at', () => {
  /**
   * The payout address is inside the terms commitment, not beside it.
   *
   * This is the difference between "the contract checks the payment is addressed
   * to `terms.sellerPayout`" and "the contract checks the payment is addressed
   * to wherever the payer says the seller is". The first is a rule; the second
   * is a formality the payer performs on themselves. The prover here supplies
   * genuine terms with one field swapped, and the commitment check is what
   * catches it.
   */
  it('cannot redirect the payment by claiming a different seller address', async () => {
    const open = await openInvoice();
    const forge = lyingTerms((real): InvoiceTerms => ({ ...real, sellerPayout: STRANGER_PAYOUT }));

    expectThrows(
      () =>
        withProver(open.d, forge.witnesses).contract.impureCircuits.settleWithNote(
          ctx(open.d, open.buyerState),
          open.invoiceId,
          open.buyer.pin,
          coin(total(open.prepared)),
          payoutTo(STRANGER_PAYOUT),
          T0 + DAY,
        ),
      'terms do not open the recorded commitment',
    );
  });

  /** The same for the token an invoice is payable in. */
  it('cannot change the token an invoice is payable in', async () => {
    const open = await openInvoice();
    const cheapToken = bytes32(0xc0);
    const forge = lyingTerms((real): InvoiceTerms => ({ ...real, tokenType: cheapToken }));

    expectThrows(
      () =>
        withProver(open.d, forge.witnesses).contract.impureCircuits.settleWithNote(
          ctx(open.d, open.buyerState),
          open.invoiceId,
          open.buyer.pin,
          coin(total(open.prepared), cheapToken),
          payoutTo(SELLER_PAYOUT),
          T0 + DAY,
        ),
      'terms do not open the recorded commitment',
    );
  });
});

describe('issuance rules a hostile prover is the only way to reach', () => {
  /**
   * `assertTerms` in `src/witnesses.ts` refuses an all-zero seller payout, so
   * the honest prover can never present one and no honest test can reach the
   * circuit's copy of the rule. That is precisely why the circuit needs its own
   * copy: the witness check is a courtesy to the user at the keyboard, and the
   * assertion below is the one an attacker cannot edit out.
   *
   * Every paying circuit sends to the address the terms name. An invoice naming
   * the zero key is an invoice whose settlement burns the money.
   */
  it('refuses an invoice that names nowhere to pay the seller', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const prepared = await (await import('../src/invoice.js')).prepareInvoice(draft());
    const staged = stageFor(seller.state, prepared);
    const forge = lyingTerms((real): InvoiceTerms => ({
      ...real,
      sellerPayout: new Uint8Array(32),
    }));

    expectThrows(
      () =>
        withProver(d0, forge.witnesses).contract.impureCircuits.issueInvoice(
          ctx(d0, staged),
          seller.pin,
          buyer.key,
          new Uint8Array(32),
          draft().dueDate,
          T0,
        ),
      'seller payout address must be set',
    );
  });
});

describe('an invoice an arbiter could not rule against', () => {
  /**
   * A seller writes the terms, and `resolveDispute` pays the address those terms
   * name for whichever side wins. So the seller chooses what a ruling against
   * them costs -- and left alone, they can set that cost to nothing.
   *
   * Name no buyer address and a ruling for the buyer sends the escrow to the
   * zero key, where it is gone for good. Name the seller's own address for both
   * sides and a ruling for the buyer pays the seller. Either way the escrow
   * never reaches the buyer, whatever the arbiter decides, and the arbiter is
   * decoration. The rule below is checked at issuance because that is the last
   * moment anyone can still walk away.
   */
  const issueWithArbiter = async (buyerPayout: Uint8Array): Promise<() => unknown> => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const arbiter = actor(d0, ARBITER_SECRET, ARBITER_PIN);
    const theDraft = draft({ buyerPayout });
    const prepared = await (await import('../src/invoice.js')).prepareInvoice(theDraft);
    const staged = stageFor(seller.state, prepared);
    return () =>
      d0.contract.impureCircuits.issueInvoice(
        ctx(d0, staged),
        seller.pin,
        buyer.key,
        arbiter.key,
        theDraft.dueDate,
        T0,
      );
  };

  it('refuses an arbiter with no address to pay the buyer at', async () => {
    expectThrows(
      await issueWithArbiter(new Uint8Array(32)),
      'an invoice with an arbiter needs a buyer payout address of its own',
    );
  });

  it('refuses an arbiter whose two outcomes pay the same address', async () => {
    expectThrows(
      await issueWithArbiter(SELLER_PAYOUT),
      'an invoice with an arbiter needs a buyer payout address of its own',
    );
  });

  it('allows an invoice with no arbiter to name no buyer address', async () => {
    // Nothing can ever pay the buyer on an invoice with no arbiter: the only
    // circuit that sends money to them is `refundEscrow`, and that one takes the
    // address from the buyer themselves. Requiring the field here would refuse
    // ordinary invoices for the sake of a path they do not have.
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const theDraft = draft({ buyerPayout: new Uint8Array(32) });
    const prepared = await (await import('../src/invoice.js')).prepareInvoice(theDraft);
    const staged = stageFor(seller.state, prepared);

    expect(() =>
      d0.contract.impureCircuits.issueInvoice(
        ctx(d0, staged),
        seller.pin,
        buyer.key,
        new Uint8Array(32),
        theDraft.dueDate,
        T0,
      ),
    ).not.toThrow();
  });
});

describe('the reliability a dispute writes', () => {
  /**
   * The counter and the record beside it now read the same clock.
   *
   * `resolveDispute` used to write `onTime: onTimeNow(dueDate)` into the public
   * settlement record and `bumpSettled(seller, at <= dueDate)` into the seller's
   * reliability, where `at` is the date the arbiter typed. So the two could
   * disagree, and the number a counterparty is actually shown -- the counter --
   * was the one a caller chose.
   */
  it('takes punctuality from the block, not from the date the arbiter types', async () => {
    const open = await openInvoice({ arbiter: true });
    const funded = advance(
      open.d,
      open.d.contract.impureCircuits.fundEscrow(
        ctx(open.d, open.buyerState),
        open.invoiceId,
        open.buyer.pin,
        coin(total(open.prepared)),
        T0 + 90n * DAY,
      ),
    );
    const disputed = advance(
      funded,
      funded.contract.impureCircuits.openDispute(
        ctx(funded, open.buyer.state),
        open.invoiceId,
        open.buyer.pin,
      ),
    );

    const arbiterState = stageFor(share(open.arbiter.state, open.stored), open.prepared);
    const late = draft().dueDate + 10n * DAY;
    const resolved = advance(
      disputed,
      disputed.contract.impureCircuits.resolveDispute(
        // The block is ten days past the due date. The arbiter dates the ruling
        // a day inside it.
        ctx(disputed, arbiterState, late),
        open.invoiceId,
        open.arbiter.pin,
        true,
        payoutTo(SELLER_PAYOUT),
        draft().dueDate - DAY,
      ),
    );

    const l = led(resolved);
    const settlement = l.settlements.lookup(open.invoiceId);
    expect(settlement.onTime).toBe(false);
    // The date the arbiter typed is still recorded, because a reader wants to
    // see what was claimed. It just decides nothing.
    expect(settlement.settledAt).toBe(draft().dueDate - DAY);

    const record = l.reliability.lookup(open.seller.key);
    expect(record.settled).toBe(1n);
    expect(record.settledOnTime).toBe(0n);
  });

  it('credits an on-time resolution to the seller', async () => {
    const open = await openInvoice({ arbiter: true });
    const funded = advance(
      open.d,
      open.d.contract.impureCircuits.fundEscrow(
        ctx(open.d, open.buyerState),
        open.invoiceId,
        open.buyer.pin,
        coin(total(open.prepared)),
        T0 + 90n * DAY,
      ),
    );
    const disputed = advance(
      funded,
      funded.contract.impureCircuits.openDispute(
        ctx(funded, open.buyer.state),
        open.invoiceId,
        open.buyer.pin,
      ),
    );
    const arbiterState = stageFor(share(open.arbiter.state, open.stored), open.prepared);
    const resolved = advance(
      disputed,
      disputed.contract.impureCircuits.resolveDispute(
        ctx(disputed, arbiterState, draft().dueDate - DAY),
        open.invoiceId,
        open.arbiter.pin,
        true,
        payoutTo(SELLER_PAYOUT),
        // Dated late by the arbiter, settled early by the block. The mirror of
        // the test above: the counter follows the chain in both directions.
        draft().dueDate + 10n * DAY,
      ),
    );

    const l = led(resolved);
    expect(l.settlements.lookup(open.invoiceId).onTime).toBe(true);
    expect(l.reliability.lookup(open.seller.key).settledOnTime).toBe(1n);
  });
});

describe('what the party key is derived from', () => {
  /**
   * Not `ownPublicKey()`, which Midnight's own security guidance calls out as an
   * anti-pattern because a transaction's public key is chosen by whoever submits
   * it (`docs/compact/smart-contract-security.mdx`). Identity here is a
   * domain-separated hash of a wallet secret the chain never sees, so a caller
   * who does not hold the secret cannot produce the key however they submit.
   */
  it('gives a different party key to a different secret at the same pin', () => {
    const d0 = deploy();
    const salt = led(d0).instanceSalt;
    const mine = pureCircuits.derivePartyKeyWith(salt, SELLER_SECRET, SELLER_PIN);
    const theirs = pureCircuits.derivePartyKeyWith(salt, bytes32(0xfe), SELLER_PIN);
    expect(mine).not.toStrictEqual(theirs);
  });

  it('gives a different party key to the same secret on a different deployment', () => {
    // The instance salt is what stops one wallet's identity being the same value
    // across deployments, which would make its invoices linkable between them.
    const a = deploy(SELLER_SECRET, bytes32(0x01));
    const b = deploy(SELLER_SECRET, bytes32(0x02));
    const here = pureCircuits.derivePartyKeyWith(led(a).instanceSalt, SELLER_SECRET, SELLER_PIN);
    const there = pureCircuits.derivePartyKeyWith(led(b).instanceSalt, SELLER_SECRET, SELLER_PIN);
    expect(here).not.toStrictEqual(there);
  });

  it('refuses a caller who cannot produce the seller secret', async () => {
    const open = await openInvoice();
    const impostor: Deployed = { ...open.d, privateState: open.buyer.state };
    expectThrows(
      () =>
        impostor.contract.impureCircuits.revokeAudit(
          ctx(impostor, open.buyer.state),
          open.invoiceId,
          SELLER_PIN,
        ),
      'caller is not the seller',
    );
  });
});
