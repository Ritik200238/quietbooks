// Selective audit, reliability proofs, identity and administration.
//
// SPDX-License-Identifier: Apache-2.0
//
// The lifecycle suite covers what happens to an invoice. This one covers what a
// party can prove about it afterwards: which fields an auditor was authorised to
// see and until when, what a counterparty learns from a reliability proof, and
// which of those paths an emergency stop is allowed to block.

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
  INSTANCE_SALT,
  issue,
  led,
  pk,
  SELLER_PIN,
  SELLER_SECRET,
  share,
  stageFor,
  STRANGER_SECRET,
  T0,
  type Actor,
  type Deployed,
  type IssuedInvoice,
} from './harness.js';

import { pureCircuits } from '../build/contract/index.js';
import { grantCovers } from '../src/audit.js';
import { allScopes, noScopes, payableTotal, scopeNames, scopesFrom } from '../src/invoice.js';
import { toHex } from '../src/util.js';

// The seller hands the symmetric audit key to the auditor out of band; only its
// hash is ever an argument to a circuit, so these fixtures stand in for a digest,
// never for a key.
const AUDIT_KEY = bytes32(0xa0);
const OTHER_AUDIT_KEY = bytes32(0xb1);

const EXPIRY = T0 + 30n * DAY;

/** Where the buyer sends the payment. Nothing here asserts on it. */
const SELLER_PAYOUT = pk(0x77);

/** A deployment carrying one open invoice, and the parties to it. */
const anInvoice = async () => {
  const d0 = deploy();
  const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
  const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
  const issued = await issue(d0, seller, buyer);
  return { ...issued, seller, buyer };
};

const grant = (
  d: Deployed,
  invoiceId: Uint8Array,
  seller: Actor,
  scopes: boolean[],
  options: { keyHash?: Uint8Array; expiresAt?: bigint; grantedAt?: bigint } = {},
): Deployed =>
  advance(
    d,
    d.contract.impureCircuits.grantAudit(
      ctx(d, seller.state),
      invoiceId,
      seller.pin,
      options.keyHash ?? AUDIT_KEY,
      scopes,
      options.expiresAt ?? EXPIRY,
      options.grantedAt ?? T0,
    ),
  );

const revoke = (d: Deployed, invoiceId: Uint8Array, seller: Actor): Deployed =>
  advance(d, d.contract.impureCircuits.revokeAudit(ctx(d, seller.state), invoiceId, seller.pin));

/**
 * Is the stored grant usable for `scopes` at time `time`?
 *
 * Reads the grant the contract actually wrote and applies `grantCovers`, the
 * same rule the envelope validator applies. What is under test here is what
 * `grantAudit` and `revokeAudit` put in the ledger; the rule itself is covered
 * in the envelope suite.
 */
const covers = (
  d: Deployed,
  invoiceId: Uint8Array,
  scopes: boolean[],
  time: bigint = T0,
): boolean => {
  const grants = led(d).auditGrants;
  const stored = grants.member(invoiceId) ? grants.lookup(invoiceId) : undefined;
  return grantCovers(stored, scopes, time);
};

const settle = (d: Deployed, issued: IssuedInvoice, buyer: Actor, at: bigint): Deployed =>
  advance(
    d,
    d.contract.impureCircuits.settleWithNote(
      ctx(d, stageFor(share(buyer.state, issued.stored), issued.prepared), at),
      issued.invoiceId,
      buyer.pin,
      coin(payableTotal(issued.prepared.terms)),
      SELLER_PAYOUT,
      at,
    ),
  );

const setPaused = (d: Deployed, admin: Actor, value: boolean): Deployed =>
  advance(d, d.contract.impureCircuits.setPaused(ctx(d, admin.state), value));

/**
 * A party's counters, straight from public ledger state.
 *
 * The counters are public by construction, so a reader takes them from the
 * ledger rather than through a circuit. A party with no history has no map
 * entry at all, which reads as all zeros -- the same value the contract's
 * internal `readReliability` returns for that case.
 */
const reliabilityOf = (d: Deployed, key: Uint8Array) => {
  const counters = led(d).reliability;
  return counters.member(key)
    ? counters.lookup(key)
    : { settled: 0n, settledOnTime: 0n, cancelled: 0n, disputesOpened: 0n, disputesLost: 0n };
};

const adminKeyFor = (d: Deployed, secret: Uint8Array): Uint8Array =>
  pureCircuits.deriveAdminKeyWith(led(d).instanceSalt, secret);

describe('granting an auditor sight of an invoice', () => {
  it('pins the key hash, the fields and the window the seller authorised', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const scopes = scopesFrom(['amount', 'tax', 'currency']);
    const d = grant(issued, invoiceId, seller, scopes);

    const g = led(d).auditGrants.lookup(invoiceId);
    expect(toHex(g.auditKeyHash)).toBe(toHex(AUDIT_KEY));
    expect(g.scopes).toEqual(scopes);
    expect(scopeNames(g.scopes)).toEqual(['amount', 'tax', 'currency']);
    expect(g.grantedAt).toBe(T0);
    expect(g.expiresAt).toBe(EXPIRY);
    expect(g.revoked).toBe(false);
  });

  it('refuses anyone but the seller', async () => {
    const { d, invoiceId, buyer } = await anInvoice();
    expectThrows(
      () =>
        d.contract.impureCircuits.grantAudit(
          ctx(d, buyer.state),
          invoiceId,
          buyer.pin,
          AUDIT_KEY,
          allScopes(),
          EXPIRY,
          T0,
        ),
      'caller is not the seller',
    );
  });

  it('refuses a zero key hash, which would authorise no identifiable auditor', async () => {
    const { d, invoiceId, seller } = await anInvoice();
    expectThrows(
      () => grant(d, invoiceId, seller, allScopes(), { keyHash: new Uint8Array(32) }),
      'audit key hash must be set',
    );
  });

  it('refuses a grant that would disclose nothing', async () => {
    const { d, invoiceId, seller } = await anInvoice();
    expectThrows(() => grant(d, invoiceId, seller, noScopes()), 'grant must disclose at least one field');
  });

  it('refuses a window that has already closed', async () => {
    const { d, invoiceId, seller } = await anInvoice();
    expectThrows(
      () => grant(d, invoiceId, seller, allScopes(), { expiresAt: T0, grantedAt: T0 }),
      'grant must expire in the future',
    );
    expectThrows(
      () => grant(d, invoiceId, seller, allScopes(), { expiresAt: T0 - DAY, grantedAt: T0 }),
      'grant must expire in the future',
    );
  });

  it('refuses to grant while the contract is paused', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const paused = setPaused(issued, seller, true);
    expectThrows(() => grant(paused, invoiceId, seller, allScopes()), 'contract is paused');
  });

  it('replaces an earlier grant outright rather than widening it', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const wide = grant(issued, invoiceId, seller, scopesFrom(['amount', 'tax']));
    const narrow = grant(wide, invoiceId, seller, scopesFrom(['memo']), {
      keyHash: OTHER_AUDIT_KEY,
      expiresAt: EXPIRY + DAY,
    });

    const g = led(narrow).auditGrants.lookup(invoiceId);
    expect(scopeNames(g.scopes)).toEqual(['memo']);
    expect(toHex(g.auditKeyHash)).toBe(toHex(OTHER_AUDIT_KEY));
    expect(g.expiresAt).toBe(EXPIRY + DAY);
    expect(led(narrow).auditGrants.size()).toBe(1n);

    // One grant per invoice, so narrowing must genuinely withdraw the fields the
    // previous auditor held. Leaving them live would hand the new, narrower key
    // holder nothing while quietly keeping the old one in business.
    expect(covers(narrow, invoiceId, scopesFrom(['amount']))).toBe(false);
  });

  it('grants on an invoice that has already been settled', async () => {
    const invoice = await anInvoice();
    const settled = settle(invoice.d, invoice, invoice.buyer, T0 + DAY);

    // The ordinary case: a tax authority or a lender asks for an invoice months
    // after it was paid. Nothing about a grant depends on the invoice still
    // being open.
    const d = grant(settled, invoice.invoiceId, invoice.seller, scopesFrom(['amount', 'seller']));
    expect(covers(d, invoice.invoiceId, scopesFrom(['amount', 'seller']))).toBe(true);
  });

  it('refuses an invoice that does not exist', async () => {
    const { d, seller } = await anInvoice();
    expectThrows(() => grant(d, bytes32(0xee), seller, allScopes()), 'unknown invoice');
  });
});

describe('checking a request against a grant', () => {
  it('covers a request for exactly the fields granted', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const scopes = scopesFrom(['amount', 'dueDate', 'orderRef']);
    const d = grant(issued, invoiceId, seller, scopes);
    expect(covers(d, invoiceId, scopes)).toBe(true);
  });

  it('covers a request for less than was granted', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const d = grant(issued, invoiceId, seller, scopesFrom(['amount', 'tax', 'dueDate']));
    expect(covers(d, invoiceId, scopesFrom(['tax']))).toBe(true);
  });

  it('refuses a request reaching for a field outside the grant', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const d = grant(issued, invoiceId, seller, scopesFrom(['amount', 'tax']));
    expect(covers(d, invoiceId, scopesFrom(['amount', 'memo']))).toBe(false);
    expect(covers(d, invoiceId, allScopes())).toBe(false);
  });

  it('refuses everything when no grant was ever made', async () => {
    const { d, invoiceId } = await anInvoice();
    expect(covers(d, invoiceId, scopesFrom(['amount']))).toBe(false);
    expect(covers(d, bytes32(0xee), scopesFrom(['amount']))).toBe(false);
  });

  it('refuses once the grant has been revoked', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const granted = grant(issued, invoiceId, seller, allScopes());
    expect(covers(granted, invoiceId, allScopes())).toBe(true);

    const d = revoke(granted, invoiceId, seller);
    expect(covers(d, invoiceId, allScopes())).toBe(false);
  });

  it('refuses once the window has closed', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const d = grant(issued, invoiceId, seller, allScopes());

    // Expiry is read from the block, not from an argument, so an auditor cannot
    // extend their own window by claiming an earlier time.
    expect(covers(d, invoiceId, allScopes(), EXPIRY)).toBe(false);
    expect(covers(d, invoiceId, allScopes(), EXPIRY + DAY)).toBe(false);
  });

  it('still covers a request one second before expiry', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const d = grant(issued, invoiceId, seller, allScopes());
    expect(covers(d, invoiceId, allScopes(), EXPIRY - 1n)).toBe(true);
  });

  it('refuses a request for no fields, even against a live grant', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const d = grant(issued, invoiceId, seller, scopesFrom(['amount']));

    // Under ordinary subset semantics an empty request is vacuously covered,
    // and that is the wrong answer to hand a validator. A caller asking "may I
    // see nothing" has almost certainly built its request vector wrongly, and
    // answering true would let a malformed envelope pass as authorised. The
    // contract checks for an empty request first and returns false, so the
    // mistake surfaces where it happens rather than downstream.
    expect(covers(d, invoiceId, noScopes())).toBe(false);

    // The guard is unconditional: it does not depend on the grant's state.
    expect(covers(revoke(d, invoiceId, seller), invoiceId, noScopes())).toBe(false);
  });
});

describe('revoking a grant', () => {
  it('marks the grant revoked and leaves the rest of the record standing', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const scopes = scopesFrom(['amount', 'dueDate']);
    const d = revoke(grant(issued, invoiceId, seller, scopes), invoiceId, seller);

    // The grant is kept rather than deleted so the ledger still shows what was
    // authorised, to whom and over which window, after access ended.
    const g = led(d).auditGrants.lookup(invoiceId);
    expect(g.revoked).toBe(true);
    expect(g.scopes).toEqual(scopes);
    expect(toHex(g.auditKeyHash)).toBe(toHex(AUDIT_KEY));
    expect(g.grantedAt).toBe(T0);
    expect(g.expiresAt).toBe(EXPIRY);
  });

  it('refuses anyone but the seller', async () => {
    const { d: issued, invoiceId, seller, buyer } = await anInvoice();
    const d = grant(issued, invoiceId, seller, allScopes());
    expectThrows(
      () => d.contract.impureCircuits.revokeAudit(ctx(d, buyer.state), invoiceId, buyer.pin),
      'caller is not the seller',
    );
  });

  it('refuses when there is nothing to revoke', async () => {
    const { d, invoiceId, seller } = await anInvoice();
    expectThrows(() => revoke(d, invoiceId, seller), 'no audit grant for this invoice');
  });

  it('revokes while the contract is paused', async () => {
    const { d: issued, invoiceId, seller } = await anInvoice();
    const granted = grant(issued, invoiceId, seller, allScopes());
    const paused = setPaused(granted, seller, true);

    // Revocation is deliberately the one state-advancing circuit with no pause
    // guard. A stop exists to halt new business; a seller who has just learnt
    // their auditor is compromised must not have to wait for an admin to lift it
    // before withdrawing that auditor's access.
    const d = revoke(paused, invoiceId, seller);
    expect(led(d).paused).toBe(true);
    expect(led(d).auditGrants.lookup(invoiceId).revoked).toBe(true);
    expect(covers(d, invoiceId, allScopes())).toBe(false);
  });
});

describe('the reliability record', () => {
  /** A seller with two settlements against them, one of them late. */
  const sellerWithHistory = async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);

    const first = await issue(d0, seller, buyer);
    const afterFirst = settle(first.d, first, buyer, T0 + DAY);
    const second = await issue(afterFirst, seller, buyer);
    const d = settle(second.d, second, buyer, draft().dueDate + DAY);

    return { d, seller, buyer };
  };

  it('reads a party with no history as all zeros', () => {
    const d = deploy();
    const stranger = actor(d, STRANGER_SECRET, 7n);
    expect(reliabilityOf(d, stranger.key)).toEqual({
      settled: 0n,
      settledOnTime: 0n,
      cancelled: 0n,
      disputesOpened: 0n,
      disputesLost: 0n,
    });
  });

  it('moves the seller counters as invoices settle', async () => {
    const { d, seller } = await sellerWithHistory();
    const r = reliabilityOf(d, seller.key);
    expect(r.settled).toBe(2n);
    expect(r.settledOnTime).toBe(1n);
    expect(r.cancelled).toBe(0n);
    expect(r.disputesLost).toBe(0n);
  });

  it('marks a lost dispute against the party that lost it', async () => {
    const d0 = deploy();
    const seller = actor(d0, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d0, BUYER_SECRET, BUYER_PIN);
    const arbiter = actor(d0, ARBITER_SECRET, ARBITER_PIN);

    const issued = await issue(d0, seller, buyer, { arbiterKey: arbiter.key });
    const buyerState = stageFor(share(buyer.state, issued.stored), issued.prepared);
    const funded = advance(
      issued.d,
      issued.d.contract.impureCircuits.fundEscrow(
        ctx(issued.d, buyerState, T0),
        issued.invoiceId,
        buyer.pin,
        coin(1_000n),
        T0 + 10n * DAY,
        T0,
      ),
    );
    const disputed = advance(
      funded,
      funded.contract.impureCircuits.openDispute(
        ctx(funded, buyer.state),
        issued.invoiceId,
        buyer.pin,
      ),
    );
    const d = advance(
      disputed,
      disputed.contract.impureCircuits.resolveDispute(
        ctx(disputed, arbiter.state),
        issued.invoiceId,
        arbiter.pin,
        false,
        pk(0x01),
        T0 + DAY,
      ),
    );

    expect(reliabilityOf(d, seller.key).disputesLost).toBe(1n);
    expect(reliabilityOf(d, buyer.key).disputesLost).toBe(0n);
    expect(reliabilityOf(d, buyer.key).disputesOpened).toBe(1n);
  });

  it('counts against the key that settled, not the wallet behind it', async () => {
    const { d, seller } = await sellerWithHistory();

    // Rotating a PIN yields an unrelated key, and the history does not follow it.
    // That is the price of shedding linkability, and it should be visible.
    const rotated = actor(d, SELLER_SECRET, SELLER_PIN + 1n);
    expect(reliabilityOf(d, rotated.key).settled).toBe(0n);
    expect(reliabilityOf(d, rotated.key).settledOnTime).toBe(0n);
  });
});

describe('party identity', () => {
  it('gives a party an unrelated key for every PIN', () => {
    const d = deploy();
    const first = actor(d, SELLER_SECRET, 1n);
    const second = actor(d, SELLER_SECRET, 2n);
    expect(toHex(first.key)).not.toBe(toHex(second.key));
  });

  it('gives back the same key for the same secret and PIN', () => {
    const d = deploy();
    expect(toHex(actor(d, SELLER_SECRET, SELLER_PIN).key)).toBe(
      toHex(actor(d, SELLER_SECRET, SELLER_PIN).key),
    );
  });

  it('gives the same wallet different keys on two deployments', () => {
    const here = deploy(SELLER_SECRET, INSTANCE_SALT);
    const there = deploy(SELLER_SECRET, bytes32(0x5b));

    // The instance salt is what stops an observer following one wallet across
    // contracts by matching party keys.
    expect(toHex(actor(here, SELLER_SECRET, SELLER_PIN).key)).not.toBe(
      toHex(actor(there, SELLER_SECRET, SELLER_PIN).key),
    );
  });

  it('derives an admin key that no PIN is part of', () => {
    const d = deploy(SELLER_SECRET);
    const key = adminKeyFor(d, SELLER_SECRET);
    expect(toHex(key)).toBe(toHex(led(d).admin));

    // The admin role survives the admin rotating their own party PIN, which is
    // only true because the two derivations share nothing but the secret.
    expect(toHex(key)).not.toBe(toHex(actor(d, SELLER_SECRET, 1n).key));
    expect(toHex(key)).not.toBe(toHex(actor(d, SELLER_SECRET, 2n).key));
    expect(toHex(key)).not.toBe(toHex(adminKeyFor(d, BUYER_SECRET)));
  });
});

describe('administration', () => {
  it('pauses and resumes the contract', () => {
    const d0 = deploy(SELLER_SECRET);
    const admin = actor(d0, SELLER_SECRET, SELLER_PIN);
    expect(led(d0).paused).toBe(false);

    const paused = setPaused(d0, admin, true);
    expect(led(paused).paused).toBe(true);

    const resumed = setPaused(paused, admin, false);
    expect(led(resumed).paused).toBe(false);
  });

  it('refuses a pause from anyone but the admin', () => {
    const d = deploy(SELLER_SECRET);
    const stranger = actor(d, STRANGER_SECRET, 7n);
    expectThrows(() => setPaused(d, stranger, true), 'caller is not the admin');
  });
});
