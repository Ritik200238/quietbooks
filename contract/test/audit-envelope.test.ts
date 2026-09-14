// Selective-disclosure audit envelopes, end to end.
//
// SPDX-License-Identifier: Apache-2.0
//
// Two properties carry the whole feature and both are easy to get quietly
// wrong. The first is that an envelope built by a seller reproduces the field
// root the circuit already wrote to the anchor, from a partial set of salts .. if
// that fails, every invoice is unauditable and nobody finds out until an auditor
// asks. The second is that a validator refuses an envelope that discloses more
// than its grant covers, rather than accepting the extra data because it is
// harmless to the auditor holding it.
//
// The tests below check both against the compiled circuit and against an anchor
// written by an actual `issueInvoice` call, not against hand-written constants.

import { webcrypto } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import {
  actor,
  BUYER_PIN,
  BUYER_SECRET,
  bytes32,
  DAY,
  deploy,
  draft,
  issue,
  led,
  SELLER_PIN,
  SELLER_SECRET,
  T0,
} from './harness.js';

import { pureCircuits } from '../build/contract/index.js';
import type { TermsFrame } from '../build/contract/index.js';

import {
  AUDIT_CHECKS,
  AUDIT_ENVELOPE_VERSION,
  auditKeyHash,
  buildAuditEnvelope,
  committedFieldCommitments,
  deriveAuditKey,
  foldFieldRoot,
  formatValidationReport,
  openAuditEnvelope,
  validateAuditEnvelope,
  type AuditAnchor,
  type AuditEnvelope,
  type AuditGrantView,
  type AuditPayload,
  type Check,
  type ValidationReport,
} from '../src/audit.js';

import {
  allScopes,
  buildTermsFrame,
  commitFieldRoot,
  commitTerms,
  prepareInvoice,
  scopesFrom,
  scopesFromMask,
  scopesToMask,
  type PreparedInvoice,
} from '../src/invoice.js';
import { SCOPES, type ScopeName } from '../src/witnesses.js';
import { canonicalJson, fromHex, randomBytes32, sha256, toHex } from '../src/util.js';

const crypto: Crypto = (globalThis as { crypto?: Crypto }).crypto ?? (webcrypto as unknown as Crypto);

const EXPIRES_AT = T0 + 30n * DAY;
const NETWORK = 'midnight-testnet-02';
const CONTRACT = '0200'.padEnd(68, '0');

/** The draft's line items total 4_000_000 + 12 * 125_000. */
const AMOUNT = '5500000';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Fixture = {
  readonly prepared: PreparedInvoice;
  readonly frame: TermsFrame;
  readonly anchor: AuditAnchor;
  readonly auditKey: Uint8Array;
  readonly envelope: AuditEnvelope;
  readonly grant: AuditGrantView;
};

/**
 * One invoice, its anchor and an envelope over it.
 *
 * `scopes` is what the seller sealed; `granted` is what the chain authorised.
 * They are the same unless a test is deliberately pulling them apart, which is
 * the whole point of the containment check.
 */
const fixture = async (
  options: {
    scopes?: readonly boolean[];
    granted?: readonly boolean[];
    expiresAt?: bigint;
  } = {},
): Promise<Fixture> => {
  const scopes = options.scopes ?? allScopes();
  const granted = options.granted ?? scopes;
  const expiresAt = options.expiresAt ?? EXPIRES_AT;

  const theDraft = draft();
  const prepared = await prepareInvoice(theDraft);
  const frame = buildTermsFrame({
    invoiceId: bytes32(0xa1),
    sellerKey: bytes32(0xb2),
    buyerKey: bytes32(0xc3),
    dueDate: theDraft.dueDate,
    terms: prepared.terms,
  });

  const anchor: AuditAnchor = {
    fieldRoot: commitFieldRoot(frame, prepared.fieldSalts),
    terms: commitTerms(frame, prepared.termsSalt),
  };

  const auditKey = deriveAuditKey();
  const envelope = await buildAuditEnvelope({
    invoiceId: frame.invoiceId,
    frame,
    prepared,
    scopes,
    expiresAt,
    auditKey,
    network: NETWORK,
    contractAddress: CONTRACT,
  });

  return {
    prepared,
    frame,
    anchor,
    auditKey,
    envelope,
    grant: {
      auditKeyHash: await auditKeyHash(auditKey),
      scopes: granted,
      expiresAt,
      revoked: false,
    },
  };
};

const validate = (f: Fixture, overrides: Partial<Parameters<typeof validateAuditEnvelope>[0]> = {}) =>
  validateAuditEnvelope({
    envelope: f.envelope,
    auditKey: f.auditKey,
    anchor: f.anchor,
    grant: f.grant,
    now: T0,
    ...overrides,
  });

const checkNamed = (report: ValidationReport, name: string): Check => {
  const found = report.checks.find((check) => check.name === name);
  if (found === undefined) {
    throw new Error(`the report has no check named "${name}"`);
  }
  return found;
};

/** Every check except the named one passed. Keeps failure assertions honest. */
const onlyFailure = (report: ValidationReport, name: string): void => {
  expect(report.ok).toBe(false);
  expect(checkNamed(report, name).ok).toBe(false);
  const others = report.checks.filter((check) => check.name !== name);
  expect(others.filter((check) => !check.ok).map((check) => check.name)).toEqual([]);
};

// ---------------------------------------------------------------------------
// Tampering helpers
// ---------------------------------------------------------------------------

/** A writable view of an envelope, for the tests that have to corrupt one. */
type MutableEnvelope = {
  version: string;
  invoiceId: string;
  network: string;
  contractAddress: string;
  scopeMask: number;
  expiresAt: string;
  auditKeyHash: string;
  encryption: { algorithm: string; iv: string; authTag: string; ciphertext: string };
  integrity: { payloadHash: string };
};

const mutable = (envelope: AuditEnvelope): MutableEnvelope =>
  JSON.parse(JSON.stringify(envelope)) as MutableEnvelope;

const sealed = (envelope: MutableEnvelope): AuditEnvelope =>
  envelope as unknown as AuditEnvelope;

const flipHex = (hex: string): string => (hex[0] === '0' ? 'f' : '0') + hex.slice(1);

const flipBase64 = (text: string): string => (text[0] === 'A' ? 'B' : 'A') + text.slice(1);

/**
 * The associated data the envelope is sealed under.
 *
 * Reconstructed here rather than imported, because a test that re-seals an
 * envelope is standing in for a malicious seller and has to reproduce the
 * format from the outside. If the header's key set ever changes, the re-sealing
 * tests fail, which is the signal we want.
 */
const headerJson = (envelope: AuditEnvelope, payloadHash: string): string =>
  canonicalJson({
    version: envelope.version,
    invoiceId: envelope.invoiceId,
    network: envelope.network,
    contractAddress: envelope.contractAddress,
    scopeMask: envelope.scopeMask,
    expiresAt: envelope.expiresAt,
    auditKeyHash: envelope.auditKeyHash,
    // Passed in rather than read off the envelope, because a re-seal produces a
    // new payload and therefore a new hash, and the hash is authenticated: the
    // associated data has to carry the one being sealed under, not the one the
    // envelope arrived with. When this field was added to the header, every
    // re-sealing test failed at once .. which is what the note above promises.
    payloadHash,
  });

/**
 * Re-seal a modified payload under the same key and header.
 *
 * This is what a seller who wants to hand an auditor a doctored envelope can
 * actually do: they hold the key, so every cryptographic check still passes and
 * only the commitment and containment checks can catch them.
 */
const reseal = async (
  envelope: AuditEnvelope,
  auditKey: Uint8Array,
  payload: AuditPayload,
  /**
   * Claim a payload hash other than the true one.
   *
   * Only a party holding the key can do this, because the hash is inside the
   * associated data: a relay that edits it breaks decryption instead. It is the
   * one remaining way to reach the payload-integrity check, which is what that
   * check is for.
   */
  claimedHash?: string,
): Promise<AuditEnvelope> => {
  const bytes = new TextEncoder().encode(canonicalJson(payload));
  const payloadHash = claimedHash ?? toHex(await sha256(bytes));
  const iv = randomBytes32().subarray(0, 12);
  const key = await crypto.subtle.importKey(
    'raw',
    auditKey as unknown as BufferSource,
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const out = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        tagLength: 128,
        additionalData: new TextEncoder().encode(
          headerJson(envelope, payloadHash),
        ) as unknown as BufferSource,
      },
      key,
      bytes as unknown as BufferSource,
    ),
  );
  const split = out.length - 16;

  const next = mutable(envelope);
  next.encryption.iv = toHex(iv);
  next.encryption.authTag = toHex(out.subarray(split));
  next.encryption.ciphertext = Buffer.from(out.subarray(0, split)).toString('base64');
  next.integrity.payloadHash = payloadHash;
  return sealed(next);
};

/** Deep copy of a payload, so a test can edit one field and re-seal. */
const copyPayload = (payload: AuditPayload): AuditPayload =>
  JSON.parse(JSON.stringify(payload)) as AuditPayload;

// ---------------------------------------------------------------------------
// Agreement with the compiled circuit
// ---------------------------------------------------------------------------

describe('rebuilding the field root', () => {
  it('folds the nine commitments into the root the circuit computes', async () => {
    const prepared = await prepareInvoice(draft());
    const frame = buildTermsFrame({
      invoiceId: bytes32(0x01),
      sellerKey: bytes32(0x02),
      buyerKey: bytes32(0x03),
      dueDate: T0 + DAY,
      terms: prepared.terms,
    });
    const commitments = committedFieldCommitments(frame, prepared.fieldSalts);
    expect(toHex(foldFieldRoot(commitments))).toBe(
      toHex(commitFieldRoot(frame, prepared.fieldSalts)),
    );
  });

  it('changes the root when a single commitment changes', async () => {
    const prepared = await prepareInvoice(draft());
    const frame = buildTermsFrame({
      invoiceId: bytes32(0x01),
      sellerKey: bytes32(0x02),
      buyerKey: bytes32(0x03),
      dueDate: T0 + DAY,
      terms: prepared.terms,
    });
    const commitments = committedFieldCommitments(frame, prepared.fieldSalts);
    const original = toHex(foldFieldRoot(commitments));
    expect(toHex(foldFieldRoot({ ...commitments, memo: bytes32(0xee) }))).not.toBe(original);
  });

  it('rejects a salt vector that is not nine long', async () => {
    const prepared = await prepareInvoice(draft());
    const frame = buildTermsFrame({
      invoiceId: bytes32(0x01),
      sellerKey: bytes32(0x02),
      buyerKey: bytes32(0x03),
      dueDate: T0 + DAY,
      terms: prepared.terms,
    });
    expect(() => committedFieldCommitments(frame, prepared.fieldSalts.slice(0, 8))).toThrow(
      '9 field salts',
    );
  });
});

// ---------------------------------------------------------------------------
// Sealing and opening
// ---------------------------------------------------------------------------

describe('sealing and opening an envelope', () => {
  it('round-trips the payload when opened with the key it was sealed under', async () => {
    const f = await fixture();
    const payload = await openAuditEnvelope(f.envelope, f.auditKey);
    expect(payload.invoiceId).toBe(toHex(f.frame.invoiceId));
    expect(payload.disclosed.amount?.plaintext).toBe(AMOUNT);
  });

  it('refuses to open with a key it was not sealed under, and says why', async () => {
    const f = await fixture();
    await expect(openAuditEnvelope(f.envelope, deriveAuditKey())).rejects.toThrow(
      'did not decrypt',
    );
  });

  it('refuses to open a ciphertext that has been altered by one character', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    next.encryption.ciphertext = flipBase64(next.encryption.ciphertext);
    await expect(openAuditEnvelope(sealed(next), f.auditKey)).rejects.toThrow('did not decrypt');
  });

  it('refuses to open when the IV has been changed', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    next.encryption.iv = flipHex(next.encryption.iv);
    await expect(openAuditEnvelope(sealed(next), f.auditKey)).rejects.toThrow('did not decrypt');
  });

  it('refuses to open when the authentication tag has been changed', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    next.encryption.authTag = flipHex(next.encryption.authTag);
    await expect(openAuditEnvelope(sealed(next), f.auditKey)).rejects.toThrow('did not decrypt');
  });

  it('refuses to open when a header field has been rewritten in transit', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    next.network = 'midnight-mainnet';
    await expect(openAuditEnvelope(sealed(next), f.auditKey)).rejects.toThrow('did not decrypt');
  });

  it('refuses an IV of the wrong width rather than silently padding it', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    next.encryption.iv = next.encryption.iv.slice(0, 16);
    await expect(openAuditEnvelope(sealed(next), f.auditKey)).rejects.toThrow('IV must be 12');
  });

  it('refuses an algorithm it does not implement', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    next.encryption.algorithm = 'AES-128-CBC';
    await expect(openAuditEnvelope(sealed(next), f.auditKey)).rejects.toThrow(
      'only opens AES-256-GCM',
    );
  });

  it('seals under a fresh IV every time, so no two envelopes share one', async () => {
    const a = await fixture();
    const b = await buildAuditEnvelope({
      invoiceId: a.frame.invoiceId,
      frame: a.frame,
      prepared: a.prepared,
      scopes: allScopes(),
      expiresAt: EXPIRES_AT,
      auditKey: a.auditKey,
      network: NETWORK,
      contractAddress: CONTRACT,
    });
    expect(b.encryption.iv).not.toBe(a.envelope.encryption.iv);
    expect(b.encryption.ciphertext).not.toBe(a.envelope.encryption.ciphertext);
  });

  it('survives the JSON round trip an envelope makes in transit', async () => {
    const f = await fixture();
    const shipped = JSON.parse(JSON.stringify(f.envelope)) as AuditEnvelope;
    const payload = await openAuditEnvelope(shipped, f.auditKey);
    expect(payload.scopeMask).toBe(scopesToMask(allScopes()));
  });

  it('leaves no disclosed text in the part of the envelope that travels in the clear', async () => {
    const f = await fixture();
    const wire = JSON.stringify(f.envelope);
    // Both strings contain characters that cannot occur in hex or base64, so
    // their absence is a fact about the format and not a coincidence.
    expect(wire).not.toContain('Net 30. Wire to the account on file.');
    expect(wire).not.toContain('PO-2026-0184');
  });
});

// ---------------------------------------------------------------------------
// What the payload carries
// ---------------------------------------------------------------------------

describe('what the payload carries', () => {
  it('discloses all nine fields when the grant covers all nine', async () => {
    const f = await fixture();
    const payload = await openAuditEnvelope(f.envelope, f.auditKey);
    expect(SCOPES.filter((scope) => payload.disclosed[scope] !== undefined)).toEqual([...SCOPES]);
  });

  it('omits every field outside the scope mask entirely', async () => {
    const scopes = scopesFrom(['amount', 'currency']);
    const f = await fixture({ scopes });
    const payload = await openAuditEnvelope(f.envelope, f.auditKey);

    expect(Object.keys(payload.disclosed).sort()).toEqual(['amount', 'currency']);
    expect(payload.disclosed.memo).toBeUndefined();
    expect(payload.disclosed.items).toBeUndefined();

    // Nothing about the withheld fields survives anywhere in the payload.
    const text = canonicalJson(payload);
    expect(text).not.toContain('Net 30. Wire to the account on file.');
    expect(text).not.toContain('PO-2026-0184');
  });

  it('carries all nine commitments even under a single-field grant', async () => {
    const f = await fixture({ scopes: scopesFrom(['memo']) });
    const payload = await openAuditEnvelope(f.envelope, f.auditKey);
    expect(Object.keys(payload.commitments).sort()).toEqual([...SCOPES].sort());
    for (const scope of SCOPES) {
      expect(payload.commitments[scope]).toHaveLength(64);
    }
  });

  it('carries the field root and terms commitment the chain holds', async () => {
    const f = await fixture();
    const payload = await openAuditEnvelope(f.envelope, f.auditKey);
    expect(payload.fieldRoot).toBe(toHex(f.anchor.fieldRoot));
    expect(payload.termsCommitment).toBe(toHex(f.anchor.terms));
  });

  it('round-trips the scope mask through the envelope and back to a vector', async () => {
    const scopes = scopesFrom(['tax', 'dueDate', 'orderRef']);
    const f = await fixture({ scopes });
    expect(f.envelope.scopeMask).toBe(scopesToMask(scopes));
    expect(scopesFromMask(f.envelope.scopeMask)).toEqual(scopes);
    const payload = await openAuditEnvelope(f.envelope, f.auditKey);
    expect(payload.scopeMask).toBe(f.envelope.scopeMask);
  });

  it('discloses the amount as a decimal string that re-encodes to the committed bytes', async () => {
    const f = await fixture({ scopes: scopesFrom(['amount']) });
    const payload = await openAuditEnvelope(f.envelope, f.auditKey);
    const field = payload.disclosed.amount;
    expect(field?.plaintext).toBe(AMOUNT);
    const recomputed = pureCircuits.commitField(
      pureCircuits.tagFieldAmount(),
      fromHex(field?.value ?? ''),
      fromHex(field?.salt ?? ''),
    );
    expect(toHex(recomputed)).toBe(payload.commitments.amount);
  });
});

// ---------------------------------------------------------------------------
// Building refusals
// ---------------------------------------------------------------------------

describe('refusing to build an envelope that could not be checked', () => {
  it('refuses a grant that discloses nothing', async () => {
    const f = await fixture();
    await expect(
      buildAuditEnvelope({
        invoiceId: f.frame.invoiceId,
        frame: f.frame,
        prepared: f.prepared,
        scopes: SCOPES.map(() => false),
        expiresAt: EXPIRES_AT,
        auditKey: f.auditKey,
        network: NETWORK,
        contractAddress: CONTRACT,
      }),
    ).rejects.toThrow('at least one field');
  });

  it('refuses a key that is not 32 bytes', async () => {
    const f = await fixture();
    await expect(
      buildAuditEnvelope({
        invoiceId: f.frame.invoiceId,
        frame: f.frame,
        prepared: f.prepared,
        scopes: allScopes(),
        expiresAt: EXPIRES_AT,
        auditKey: new Uint8Array(16).fill(7),
        network: NETWORK,
        contractAddress: CONTRACT,
      }),
    ).rejects.toThrow('exactly 32 bytes');
  });

  it('refuses an all-zero key', async () => {
    const f = await fixture();
    await expect(
      buildAuditEnvelope({
        invoiceId: f.frame.invoiceId,
        frame: f.frame,
        prepared: f.prepared,
        scopes: allScopes(),
        expiresAt: EXPIRES_AT,
        auditKey: new Uint8Array(32),
        network: NETWORK,
        contractAddress: CONTRACT,
      }),
    ).rejects.toThrow('all-zero audit key');
  });

  it('refuses an invoice id that is not the one the commitments are taken over', async () => {
    const f = await fixture();
    await expect(
      buildAuditEnvelope({
        invoiceId: bytes32(0x77),
        frame: f.frame,
        prepared: f.prepared,
        scopes: allScopes(),
        expiresAt: EXPIRES_AT,
        auditKey: f.auditKey,
        network: NETWORK,
        contractAddress: CONTRACT,
      }),
    ).rejects.toThrow('does not match the frame');
  });
});

// ---------------------------------------------------------------------------
// Validation, clean paths
// ---------------------------------------------------------------------------

describe('validating a well-formed envelope', () => {
  it('passes every check for a full-scope envelope against a real anchor', async () => {
    const f = await fixture();
    const report = await validate(f);
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('passes every check for a partial-scope envelope', async () => {
    const f = await fixture({ scopes: scopesFrom(['amount', 'tax', 'currency']) });
    const report = await validate(f);
    expect(report.ok).toBe(true);
  });

  it('passes when the grant is wider than the envelope discloses', async () => {
    const f = await fixture({ scopes: scopesFrom(['amount']), granted: allScopes() });
    const report = await validate(f);
    expect(report.ok).toBe(true);
  });

  it('reports the eight checks once each, in the documented order', async () => {
    const f = await fixture();
    const report = await validate(f);
    expect(report.checks.map((check) => check.name)).toEqual([
      AUDIT_CHECKS.version,
      AUDIT_CHECKS.revocation,
      AUDIT_CHECKS.expiry,
      AUDIT_CHECKS.keyBinding,
      AUDIT_CHECKS.scopeContainment,
      AUDIT_CHECKS.payloadIntegrity,
      AUDIT_CHECKS.fieldCommitments,
      AUDIT_CHECKS.fieldRoot,
    ]);
  });

  it('validates against an anchor written by an actual issueInvoice call', async () => {
    const d = deploy();
    const seller = actor(d, SELLER_SECRET, SELLER_PIN);
    const buyer = actor(d, BUYER_SECRET, BUYER_PIN);
    const issued = await issue(d, seller, buyer);
    const onChain = led(issued.d).invoices.lookup(issued.invoiceId);

    const frame = buildTermsFrame({
      invoiceId: issued.invoiceId,
      sellerKey: seller.key,
      buyerKey: buyer.key,
      dueDate: draft().dueDate,
      terms: issued.prepared.terms,
    });

    const auditKey = deriveAuditKey();
    const envelope = await buildAuditEnvelope({
      invoiceId: issued.invoiceId,
      frame,
      prepared: issued.prepared,
      scopes: allScopes(),
      expiresAt: EXPIRES_AT,
      auditKey,
      network: NETWORK,
      contractAddress: CONTRACT,
    });

    const report = await validateAuditEnvelope({
      envelope,
      auditKey,
      anchor: { fieldRoot: onChain.fieldRoot, terms: onChain.terms },
      grant: {
        auditKeyHash: await auditKeyHash(auditKey),
        scopes: allScopes(),
        expiresAt: EXPIRES_AT,
        revoked: false,
      },
      now: T0,
    });

    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe('each scope can be disclosed on its own', () => {
  it.each([...SCOPES])('validates a grant of only %s', async (scope: ScopeName) => {
    const scopes = scopesFrom([scope]);
    const f = await fixture({ scopes });
    const report = await validate(f);
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);

    const payload = await openAuditEnvelope(f.envelope, f.auditKey);
    expect(Object.keys(payload.disclosed)).toEqual([scope]);
  });
});

// ---------------------------------------------------------------------------
// Validation, failure paths
// ---------------------------------------------------------------------------

/**
 * A sealer who writes the payload text by hand.
 *
 * `reseal` goes through `canonicalJson`, which is `JSON.stringify` over a
 * JavaScript object -- and a JavaScript object cannot have the same key twice.
 * So the whole suite was structurally unable to express the attack below: not
 * because anyone decided it was out of scope, but because the tool used to build
 * hostile envelopes could not build that one.
 *
 * This seals arbitrary bytes instead.
 */
const sealText = async (
  envelope: AuditEnvelope,
  auditKey: Uint8Array,
  text: string,
): Promise<AuditEnvelope> => {
  const bytes = new TextEncoder().encode(text);
  const payloadHash = toHex(await sha256(bytes));
  const iv = randomBytes32().subarray(0, 12);
  const key = await crypto.subtle.importKey(
    'raw',
    auditKey as unknown as BufferSource,
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const out = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        tagLength: 128,
        additionalData: new TextEncoder().encode(
          headerJson(envelope, payloadHash),
        ) as unknown as BufferSource,
      },
      key,
      bytes as unknown as BufferSource,
    ),
  );
  const split = out.length - 16;
  const next = mutable(envelope);
  next.encryption.iv = toHex(iv);
  next.encryption.authTag = toHex(out.subarray(split));
  next.encryption.ciphertext = Buffer.from(out.subarray(0, split)).toString('base64');
  next.integrity.payloadHash = payloadHash;
  return sealed(next);
};

describe('a payload that is not what it parses to', () => {
  /**
   * The attack every other test in this file was unable to write.
   *
   * `JSON.parse` keeps the last of two identical keys and drops the first
   * without a word. Every check in `audit.ts` reads the parsed object, so a
   * sealer could put an object full of ungranted fields under the first
   * `"disclosed"` and the one field they were granted under the second: the
   * containment check counted one field and passed, while the auditor decrypted
   * the text and read all of them.
   *
   * The fields smuggled this way are not decoration. They carry real salts, so
   * they open the real commitments the chain has held since issuance -- the
   * auditor ends up with cryptographic proof of an amount they were never
   * granted, inside a document the validator called contained.
   */
  it('refuses a payload carrying the same key twice', async () => {
    const f = await fixture({ scopes: scopesFrom(['currency']), granted: scopesFrom(['currency']) });
    const full = await fixture();
    const everything = await openAuditEnvelope(full.envelope, full.auditKey);
    const granted = await openAuditEnvelope(f.envelope, f.auditKey);

    // Ungranted fields first, the granted one second. A parser keeps the second.
    const smuggled =
      '{"disclosed":' +
      JSON.stringify(everything.disclosed) +
      ',' +
      canonicalJson({ ...granted, disclosed: undefined }).slice(1, -1).replace(/^,/, '') +
      ',"disclosed":' +
      JSON.stringify(granted.disclosed) +
      '}';

    const forged = await sealText(f.envelope, f.auditKey, smuggled);
    const report = await validate(f, { envelope: forged });
    expect(report.ok).toBe(false);
    // It fails before any check can be computed from it, which is the point: the
    // document is refused for not being a single document.
    expect(report.checks.some((check) => check.detail.includes('canonical form'))).toBe(true);
  });

  it('refuses a payload with whitespace the hash covers and the parser ignores', async () => {
    // The same seam, smaller. Two byte-distinct payloads that parse identically
    // would each have their own valid `payloadHash`, so the hash would not
    // identify a unique disclosure.
    const f = await fixture();
    const payload = await openAuditEnvelope(f.envelope, f.auditKey);
    const padded = JSON.stringify(payload, null, 2);
    const forged = await sealText(f.envelope, f.auditKey, padded);
    const report = await validate(f, { envelope: forged });
    expect(report.ok).toBe(false);
  });

  it('accepts the canonical form of the same payload', async () => {
    // The other direction, so the check above cannot pass by rejecting
    // everything: re-sealing the identical payload through the canonical
    // serialiser still validates.
    const f = await fixture();
    const payload = await openAuditEnvelope(f.envelope, f.auditKey);
    const resealed = await sealText(f.envelope, f.auditKey, canonicalJson(payload));
    const report = await validate(f, { envelope: resealed });
    expect(report.ok).toBe(true);
  });
});

describe('an envelope carrying more than the format defines', () => {
  it('refuses a cleartext field beside the sealed payload', async () => {
    // Outside the ciphertext and outside the associated data, so this is the one
    // kind of smuggling a relay can do as easily as the sealer. It used to
    // validate clean, with the disclosure sitting in the open next to a report
    // saying the envelope was contained.
    const f = await fixture();
    const next = mutable(f.envelope) as unknown as Record<string, unknown>;
    next.sellerNote = 'amount 5,500,000; memo "Q3 retainer, net 30"';
    const report = await validate(f, { envelope: next as unknown as AuditEnvelope });
    expect(report.ok).toBe(false);
    expect(report.checks.some((check) => check.detail.includes('sellerNote'))).toBe(true);
  });

  it('refuses an unknown field inside the encryption block', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    (next.encryption as unknown as Record<string, unknown>).keyHint = 'the usual one';
    const report = await validate(f, { envelope: sealed(next) });
    expect(report.ok).toBe(false);
  });

  it('refuses an envelope in the retired format', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    next.version = 'quietbooks-audit/1';
    const report = await validate(f, { envelope: sealed(next) });
    expect(report.ok).toBe(false);
  });
});

describe('rejecting an envelope the grant does not stand behind', () => {
  it('rejects an envelope format it does not recognise', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    next.version = 'quietbooks-audit/99';
    // Rewriting the version also breaks the sealed header, so the reader can no
    // longer look inside .. which is itself reported rather than glossed over.
    const report = await validate(f, { envelope: sealed(next) });
    expect(report.ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.version).ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.version).detail).toContain(AUDIT_ENVELOPE_VERSION);
  });

  it('rejects a grant the seller has revoked', async () => {
    const f = await fixture();
    const report = await validate(f, { grant: { ...f.grant, revoked: true } });
    onlyFailure(report, AUDIT_CHECKS.revocation);
    expect(checkNamed(report, AUDIT_CHECKS.revocation).detail).toContain('revoked');
  });

  it('rejects a grant that has expired by the time it is read', async () => {
    const f = await fixture();
    const report = await validate(f, { now: EXPIRES_AT + 1n });
    onlyFailure(report, AUDIT_CHECKS.expiry);
  });

  it('treats the expiry instant itself as expired, as the circuit does', async () => {
    const f = await fixture();
    const report = await validate(f, { now: EXPIRES_AT });
    onlyFailure(report, AUDIT_CHECKS.expiry);
  });

  it('rejects an envelope that claims to run past its grant', async () => {
    const f = await fixture({ expiresAt: EXPIRES_AT + DAY });
    const report = await validate(f, { grant: { ...f.grant, expiresAt: EXPIRES_AT } });
    onlyFailure(report, AUDIT_CHECKS.expiry);
    expect(checkNamed(report, AUDIT_CHECKS.expiry).detail).toContain('past the grant');
  });

  it('rejects an envelope naming an audit key the grant does not authorise', async () => {
    const f = await fixture();
    const report = await validate(f, {
      grant: { ...f.grant, auditKeyHash: await auditKeyHash(deriveAuditKey()) },
    });
    expect(report.ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.keyBinding).ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.keyBinding).detail).toContain('does not authorise');
  });

  it('rejects a key that opens the envelope but does not hash to the granted value', async () => {
    // The envelope and the grant agree; the key handed to the validator does
    // not. Possession of a working key is not the same as being the auditor the
    // seller authorised.
    const f = await fixture();
    const report = await validate(f, {
      auditKey: deriveAuditKey(),
      grant: { ...f.grant, auditKeyHash: await auditKeyHash(f.auditKey) },
    });
    expect(report.ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.keyBinding).ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.keyBinding).detail).toContain('does not hash');
  });

  it('rejects an envelope that discloses a field outside its grant, naming the check', async () => {
    const f = await fixture({ scopes: allScopes(), granted: scopesFrom(['amount']) });
    const report = await validate(f);
    onlyFailure(report, AUDIT_CHECKS.scopeContainment);

    const detail = checkNamed(report, AUDIT_CHECKS.scopeContainment).detail;
    expect(detail).toContain('memo');
    expect(detail).toContain('does not cover');
    expect(formatValidationReport(report)).toContain(AUDIT_CHECKS.scopeContainment);
  });

  it('rejects a single field disclosed beyond a wide grant', async () => {
    const f = await fixture({
      scopes: scopesFrom(['amount', 'tax', 'memo']),
      granted: scopesFrom(['amount', 'tax']),
    });
    const report = await validate(f);
    onlyFailure(report, AUDIT_CHECKS.scopeContainment);
    expect(checkNamed(report, AUDIT_CHECKS.scopeContainment).detail).toContain('memo');
  });

  it('names the over-declared fields even when the ciphertext cannot be opened', async () => {
    // The declared mask is checked before the payload, so an auditor who cannot
    // decrypt still learns that the envelope reaches past its grant.
    const f = await fixture({ scopes: allScopes(), granted: scopesFrom(['amount']) });
    const report = await validate(f, { auditKey: deriveAuditKey() });
    const detail = checkNamed(report, AUDIT_CHECKS.scopeContainment).detail;
    expect(detail).toContain('the envelope declares');
    expect(detail).toContain('memo');
  });

  it('rejects a payload that carries a field its own scope mask does not admit', async () => {
    // The party who seals an envelope holds the key, so they can put more inside
    // the ciphertext than the header advertises. Checking the mask alone would
    // let this through; the validator looks at what is actually disclosed.
    const f = await fixture();
    const full = await openAuditEnvelope(f.envelope, f.auditKey);
    const memo = full.disclosed.memo;
    if (memo === undefined) throw new Error('the fixture should disclose the memo');

    const narrow = await buildAuditEnvelope({
      invoiceId: f.frame.invoiceId,
      frame: f.frame,
      prepared: f.prepared,
      scopes: scopesFrom(['amount']),
      expiresAt: EXPIRES_AT,
      auditKey: f.auditKey,
      network: NETWORK,
      contractAddress: CONTRACT,
    });
    const narrowPayload = await openAuditEnvelope(narrow, f.auditKey);
    const forged = await reseal(narrow, f.auditKey, {
      ...narrowPayload,
      disclosed: { ...narrowPayload.disclosed, memo },
    });

    const report = await validateAuditEnvelope({
      envelope: forged,
      auditKey: f.auditKey,
      anchor: f.anchor,
      grant: { ...f.grant, scopes: scopesFrom(['amount']) },
      now: T0,
    });
    onlyFailure(report, AUDIT_CHECKS.scopeContainment);
    expect(checkNamed(report, AUDIT_CHECKS.scopeContainment).detail).toContain(
      'the sealed payload carries',
    );
  });

  it('rejects a scope mask rewritten downward to hide an over-disclosure', async () => {
    const f = await fixture({ scopes: allScopes(), granted: scopesFrom(['amount']) });
    const next = mutable(f.envelope);
    next.scopeMask = scopesToMask(scopesFrom(['amount']));
    const report = await validate(f, { envelope: sealed(next) });
    expect(report.ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.scopeContainment).ok).toBe(false);
  });

  it('rejects a scope mask that is not a nine-slot mask', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    next.scopeMask = 4096;
    const report = await validate(f, { envelope: sealed(next) });
    expect(report.ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.scopeContainment).detail).toContain('nine-slot');
  });

  it('rejects a grant whose scope vector is the wrong length', async () => {
    const f = await fixture();
    const report = await validate(f, { grant: { ...f.grant, scopes: [true, false] } });
    expect(report.ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.scopeContainment).detail).toContain('scope slots');
  });

  it('rejects a tampered ciphertext without throwing', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    next.encryption.ciphertext = flipBase64(next.encryption.ciphertext);
    const report = await validate(f, { envelope: sealed(next) });
    expect(report.ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.payloadIntegrity).ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.payloadIntegrity).detail).toContain('did not decrypt');
  });

  it('rejects a payload hash the sealer got wrong on purpose', async () => {
    // Sealed under the wrong hash rather than edited afterwards, because the
    // hash is authenticated now: only the party holding the key can produce an
    // envelope that decrypts and still misreports what it contains. That is the
    // only remaining way to reach this check, and it is the case the check is
    // about -- a sealer whose document does not describe itself.
    const f = await fixture();
    const payload = copyPayload(await openAuditEnvelope(f.envelope, f.auditKey));
    const forged = await reseal(f.envelope, f.auditKey, payload, toHex(bytes32(0x5e)));
    const report = await validate(f, { envelope: forged });
    onlyFailure(report, AUDIT_CHECKS.payloadIntegrity);
  });

  it('refuses an envelope whose payload hash was edited in transit', async () => {
    // The same edit by somebody who does not hold the key. It used to produce a
    // payload-integrity failure, whose message says the payload does not match
    // its own hash -- so a relay could flip one character and make an honest
    // seller look like they had forged the document. Binding the hash into the
    // associated data turns it into what it actually is: tampering, reported as
    // a failure to decrypt.
    const f = await fixture();
    const next = mutable(f.envelope);
    next.integrity.payloadHash = toHex(bytes32(0x5e));
    const report = await validate(f, { envelope: sealed(next) });
    expect(report.ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.payloadIntegrity).detail).toContain('did not decrypt');
  });

  it('rejects a payload sealed for a different invoice than the envelope names', async () => {
    const f = await fixture();
    const payload = copyPayload(await openAuditEnvelope(f.envelope, f.auditKey));
    const forged = await reseal(f.envelope, f.auditKey, {
      ...payload,
      invoiceId: toHex(bytes32(0x99)),
    });
    const report = await validate(f, { envelope: forged });
    expect(report.ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.payloadIntegrity).ok).toBe(false);
  });

  it('rejects a single corrupted field commitment', async () => {
    const f = await fixture();
    const payload = copyPayload(await openAuditEnvelope(f.envelope, f.auditKey));
    const forged = await reseal(f.envelope, f.auditKey, {
      ...payload,
      commitments: { ...payload.commitments, tax: toHex(bytes32(0x3c)) },
    });
    const report = await validate(f, { envelope: forged });
    expect(report.ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.fieldCommitments).ok).toBe(false);
    expect(checkNamed(report, AUDIT_CHECKS.fieldCommitments).detail).toContain('tax');
  });

  it('rejects a salt that does not open the commitment it is paired with', async () => {
    const f = await fixture();
    const payload = copyPayload(await openAuditEnvelope(f.envelope, f.auditKey));
    const amount = payload.disclosed.amount;
    if (amount === undefined) throw new Error('the fixture should disclose the amount');
    const forged = await reseal(f.envelope, f.auditKey, {
      ...payload,
      disclosed: { ...payload.disclosed, amount: { ...amount, salt: toHex(bytes32(0x4d)) } },
    });
    const report = await validate(f, { envelope: forged });
    // The commitments themselves are untouched, so the anchor still matches and
    // only the opening fails. That isolation is what makes the report useful.
    onlyFailure(report, AUDIT_CHECKS.fieldCommitments);
    expect(checkNamed(report, AUDIT_CHECKS.fieldCommitments).detail).toContain('do not open');
  });

  it('rejects a disclosed plaintext that disagrees with the value it commits to', async () => {
    const f = await fixture();
    const payload = copyPayload(await openAuditEnvelope(f.envelope, f.auditKey));
    const amount = payload.disclosed.amount;
    if (amount === undefined) throw new Error('the fixture should disclose the amount');
    const forged = await reseal(f.envelope, f.auditKey, {
      ...payload,
      disclosed: { ...payload.disclosed, amount: { ...amount, plaintext: '55000' } },
    });
    const report = await validate(f, { envelope: forged });
    onlyFailure(report, AUDIT_CHECKS.fieldCommitments);
    expect(checkNamed(report, AUDIT_CHECKS.fieldCommitments).detail).toContain('does not encode');
  });

  it('rejects a memo plaintext swapped for a different one', async () => {
    const f = await fixture();
    const payload = copyPayload(await openAuditEnvelope(f.envelope, f.auditKey));
    const memo = payload.disclosed.memo;
    if (memo === undefined) throw new Error('the fixture should disclose the memo');
    const forged = await reseal(f.envelope, f.auditKey, {
      ...payload,
      disclosed: { ...payload.disclosed, memo: { ...memo, plaintext: 'Paid in full.' } },
    });
    const report = await validate(f, { envelope: forged });
    onlyFailure(report, AUDIT_CHECKS.fieldCommitments);
  });

  it('rejects a field root on the anchor that the commitments do not fold to', async () => {
    const f = await fixture();
    const report = await validate(f, {
      anchor: { ...f.anchor, fieldRoot: bytes32(0xee) },
    });
    onlyFailure(report, AUDIT_CHECKS.fieldRoot);
    expect(checkNamed(report, AUDIT_CHECKS.fieldRoot).detail).toContain('do not fold');
  });

  it('rejects an anchor whose terms commitment is not the one the payload names', async () => {
    const f = await fixture();
    const report = await validate(f, { anchor: { ...f.anchor, terms: bytes32(0xef) } });
    onlyFailure(report, AUDIT_CHECKS.fieldRoot);
    expect(checkNamed(report, AUDIT_CHECKS.fieldRoot).detail).toContain('terms commitment');
  });

  it('is never ok while any single check is false', async () => {
    const cases = [
      await validate(await fixture(), { grant: (await fixture()).grant, now: EXPIRES_AT + 1n }),
      await validate(await fixture({ scopes: allScopes(), granted: scopesFrom(['tax']) })),
      await validate(await fixture(), { anchor: { fieldRoot: bytes32(1), terms: bytes32(2) } }),
    ];
    for (const report of cases) {
      expect(report.checks.some((check) => !check.ok)).toBe(true);
      expect(report.ok).toBe(false);
    }
  });

  it('reports rather than throws on an envelope that is malformed throughout', async () => {
    const f = await fixture();
    const next = mutable(f.envelope);
    next.version = '';
    next.auditKeyHash = 'not-hex';
    next.expiresAt = 'tomorrow';
    next.scopeMask = -1;
    next.encryption.iv = '';
    next.encryption.authTag = '';
    next.encryption.ciphertext = '!!!!';
    next.integrity.payloadHash = 'zz';

    const report = await validate(f, { envelope: sealed(next) });
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(8);
    expect(report.checks.filter((check) => check.ok).map((check) => check.name)).toEqual([
      AUDIT_CHECKS.revocation,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The human-readable report
// ---------------------------------------------------------------------------

describe('the printed report', () => {
  it('says PASS and never says FAIL when every check passed', async () => {
    const f = await fixture();
    const text = formatValidationReport(await validate(f));
    expect(text).toContain('PASS');
    expect(text).not.toContain('FAIL');
    expect(text).toContain('8 of 8 checks passed.');
  });

  it('says FAIL and names the check that failed', async () => {
    const f = await fixture({ scopes: allScopes(), granted: scopesFrom(['amount']) });
    const text = formatValidationReport(await validate(f));
    expect(text).toContain('QuietBooks audit envelope: FAIL');
    expect(text).toContain(`[FAIL] ${AUDIT_CHECKS.scopeContainment}`);
    expect(text).toContain('7 of 8 checks passed.');
  });

  it('lists every check on its own line, in order', async () => {
    const f = await fixture();
    const lines = formatValidationReport(await validate(f)).split('\n');
    const checkLines = lines.filter((line) => line.startsWith('  ['));
    expect(checkLines).toHaveLength(8);
    expect(checkLines[0]).toContain(AUDIT_CHECKS.version);
    expect(checkLines[7]).toContain(AUDIT_CHECKS.fieldRoot);
  });

  it('handles an empty report without producing nonsense', () => {
    const text = formatValidationReport({ ok: true, checks: [] });
    expect(text).toContain('0 of 0 checks passed.');
  });
});
