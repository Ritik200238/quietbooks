// Selective-disclosure audit envelopes.
//
// SPDX-License-Identifier: Apache-2.0
//
// An audit envelope is what a seller hands an auditor. It carries the plaintext
// of the fields the auditor was granted, the salts that open those fields, and
// the per-field commitments for all nine fields .. sealed under a symmetric key
// the two parties exchange out of band.
//
// WHY THE KEY IS OFF CHAIN AND ONLY ITS HASH IS ON CHAIN
// ------------------------------------------------------
// `grantAudit` records `auditKeyHash`, never the key. Public ledger state on
// Midnight is readable by everyone forever, so a key written there would make
// every envelope it ever sealed openable by anybody who bothered to scrape the
// chain .. including envelopes sealed years later under the same key. Recording
// only the hash keeps the ledger's role to the part that must be public and
// tamper-evident: who was authorised, for which fields, and until when. The
// envelope itself, and the key that opens it, travel between the two parties
// directly. The chain never needs to see either, and so it never does.
//
// The consequence for this module is that possession of the key is not proof of
// anything on its own. `validateAuditEnvelope` therefore checks that the key it
// was handed hashes to the value the grant pins, rather than assuming that a key
// which happens to decrypt the ciphertext is the authorised one. A seller who
// seals an envelope under a key the grant does not name has produced a document
// with no on-chain authorisation behind it, and the validator says so.
//
// WHY AN OVER-DISCLOSING ENVELOPE IS REJECTED RATHER THAN TRUSTED
// ---------------------------------------------------------------
// The tempting behaviour is to accept an envelope that contains more than the
// grant covers, on the reasoning that extra data cannot hurt the auditor. It is
// the wrong call in both directions.
//
// For the disclosing parties, the grant is the record of what the buyer's and
// seller's commercial terms were exposed to. An auditor's tool that silently
// accepts an unauthorised field turns a nine-slot permission into advice, and
// the invoice's counterparty .. who never saw the envelope .. has no way to find
// out. For the auditor, accepting it is worse: they now hold data they cannot
// show they were entitled to, against an on-chain record that says otherwise.
// That is a liability, not a windfall.
//
// So the containment check compares the grant against both the envelope's
// declared scope mask and the fields actually present inside the ciphertext, and
// fails if either exceeds the grant. A validator that cannot see inside the
// ciphertext .. because it did not decrypt .. reports the containment check as
// failed rather than as passed, because "I could not look" is not "I looked and
// it was fine".
//
// ENCODING NOTE
// -------------
// The 32-byte value each field commits to is produced here with the runtime's
// own `convertFieldToBytes`, which is the function the compiled circuit calls
// for `x as Field as Bytes<32>`. It is little-endian. `bigintToBytes32` in
// `invoice.ts` encodes big-endian, so `fieldValues`/`fieldCommitments` there do
// not reproduce the amount, tax and due-date commitments the circuit folds into
// the field root; this module deliberately does not use them. `foldFieldRoot`
// below is asserted against the compiled `commitFieldRoot` in the test suite, so
// a future change to either side that breaks the agreement fails a test rather
// than producing envelopes no auditor can check.

import {
  CompactTypeBytes,
  CompactTypeVector,
  convertFieldToBytes,
  persistentHash,
} from '@midnight-ntwrk/compact-runtime';
import { Buffer } from 'node:buffer';
import { webcrypto } from 'node:crypto';

import { pureCircuits } from '../build/contract/index.js';
import type { TermsFrame } from '../build/contract/index.js';

import {
  commitFieldRoot,
  commitTerms,
  fieldTags,
  scopesFromMask,
  scopesToMask,
  type LineItem,
  type PreparedInvoice,
} from './invoice.js';
import { SCOPE_COUNT, SCOPES, type ScopeName } from './witnesses.js';
import {
  BYTES32,
  bytesEqual,
  canonicalJson,
  fromHex,
  padBytes32,
  randomBytes32,
  sha256,
  toHex,
  ZERO32,
} from './util.js';

const crypto: Crypto = (globalThis as { crypto?: Crypto }).crypto ?? (webcrypto as unknown as Crypto);

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

/** The only envelope format this module writes, and the only one it reads. */
export const AUDIT_ENVELOPE_VERSION = 'quietbooks-audit/1';

/**
 * GCM's standard nonce width. Twelve bytes is the size the construction is
 * specified for; anything else is run through a length-extension step first and
 * loses the guarantee that two distinct nonces give two distinct counters.
 */
const IV_BYTES = 12;

/** GCM authentication tag width, in bytes. */
const TAG_BYTES = 16;

/** Highest scope mask a nine-slot grant can produce. */
const MAX_SCOPE_MASK = (1 << SCOPE_COUNT) - 1;

/** Names of the validation checks, in the order the validator runs them. */
export const AUDIT_CHECKS = {
  version: 'envelope-version',
  revocation: 'grant-not-revoked',
  expiry: 'grant-not-expired',
  keyBinding: 'audit-key-binding',
  scopeContainment: 'scope-containment',
  payloadIntegrity: 'payload-integrity',
  fieldCommitments: 'field-commitments',
  fieldRoot: 'field-root',
} as const;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when an envelope cannot be built or opened at all. */
export class AuditEnvelopeError extends Error {
  constructor(message: string) {
    super(`quietbooks: ${message}`);
    this.name = 'AuditEnvelopeError';
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How a field's plaintext turns into the 32 bytes its commitment is taken over.
 *
 * Derived from the scope name rather than carried in the envelope. If the
 * envelope named its own encoding, an envelope could disclose a plaintext and
 * then declare it unverifiable, which is exactly the case the checks exist for.
 */
export type FieldEncoding = 'uint' | 'ascii32' | 'sha256' | 'bytes32';

const FIELD_ENCODING: Readonly<Record<ScopeName, FieldEncoding>> = {
  amount: 'uint',
  tax: 'uint',
  dueDate: 'uint',
  buyer: 'bytes32',
  seller: 'bytes32',
  currency: 'ascii32',
  items: 'sha256',
  memo: 'sha256',
  orderRef: 'sha256',
};

/** One field the auditor was granted, with everything needed to check it. */
export type DisclosedField = {
  /** Hex of the exact 32 bytes this field's commitment is taken over. */
  readonly value: string;
  /** Hex of the opening for that commitment. */
  readonly salt: string;
  /**
   * The preimage of `value` under this field's encoding: a decimal string for
   * amounts and timestamps, the currency code, the memo or order-reference text,
   * the canonical line-item JSON. `null` for party keys, whose committed bytes
   * are already the value.
   */
  readonly plaintext: string | null;
};

/** What the ciphertext decrypts to. */
export type AuditPayload = {
  /** Hex invoice id. Binds the payload to the envelope that carries it. */
  readonly invoiceId: string;
  /** Repeat of the header's mask, so a rewritten header can be detected. */
  readonly scopeMask: number;
  /** Only the granted fields appear. An undisclosed field has no entry at all. */
  readonly disclosed: Readonly<Partial<Record<ScopeName, DisclosedField>>>;
  /**
   * All nine per-field commitments, hex, keyed by scope.
   *
   * The disclosed ones let the auditor recompute and compare; the undisclosed
   * ones are what makes the field root rebuildable without handing over the
   * values behind them. A commitment reveals nothing without its salt.
   */
  readonly commitments: Readonly<Record<ScopeName, string>>;
  /** Hex. Cross-checked against the anchor the chain holds. */
  readonly fieldRoot: string;
  /** Hex. Cross-checked against the anchor the chain holds. */
  readonly termsCommitment: string;
};

/**
 * The envelope as it travels: JSON, no binary, safe to email or attach.
 *
 * Everything outside `encryption` is in the clear. None of it is commercially
 * sensitive .. it is an invoice id, a network name, a contract address, a scope
 * mask and two timestamps .. and all of it is authenticated as GCM associated
 * data, so an intermediary cannot rewrite the header of an envelope they cannot
 * open.
 */
export type AuditEnvelope = {
  readonly version: string;
  /** Hex invoice id, matching the key of the on-chain anchor. */
  readonly invoiceId: string;
  readonly network: string;
  readonly contractAddress: string;
  readonly scopeMask: number;
  /** Decimal string of a Uint<64>, because JSON has no bigint. */
  readonly expiresAt: string;
  /** Hex sha256 of the audit key. The same value the grant pins on chain. */
  readonly auditKeyHash: string;
  readonly encryption: {
    readonly algorithm: 'AES-256-GCM';
    readonly iv: string;
    readonly authTag: string;
    readonly ciphertext: string;
  };
  readonly integrity: {
    /** Hex sha256 of the plaintext bytes that were sealed. */
    readonly payloadHash: string;
  };
};

/** The parts of the on-chain `InvoiceAnchor` an auditor checks against. */
export type AuditAnchor = {
  readonly fieldRoot: Uint8Array;
  readonly terms: Uint8Array;
};

/** The on-chain `AuditGrant`, as the validator needs it. */
export type AuditGrantView = {
  readonly auditKeyHash: Uint8Array;
  readonly scopes: readonly boolean[];
  readonly expiresAt: bigint;
  readonly revoked: boolean;
};

export type BuildAuditEnvelopeArgs = {
  readonly invoiceId: Uint8Array;
  readonly frame: TermsFrame;
  readonly prepared: PreparedInvoice;
  readonly scopes: readonly boolean[];
  readonly expiresAt: bigint;
  readonly auditKey: Uint8Array;
  readonly network: string;
  readonly contractAddress: string;
};

export type ValidateAuditEnvelopeArgs = {
  readonly envelope: AuditEnvelope;
  readonly auditKey: Uint8Array;
  readonly anchor: AuditAnchor;
  readonly grant: AuditGrantView;
  readonly now: bigint;
};

/** One line of the report. `detail` is written to be read by a person. */
export type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};

export type ValidationReport = {
  readonly ok: boolean;
  readonly checks: readonly Check[];
};

// ---------------------------------------------------------------------------
// Committed values and the field root
// ---------------------------------------------------------------------------

/**
 * A Uint<n> as the circuit encodes it before committing.
 *
 * This is the runtime function the generated contract calls, not a
 * reimplementation of it, so the two cannot drift.
 */
const fieldNumber = (value: bigint): Uint8Array =>
  convertFieldToBytes(BYTES32, value, 'quietbooks audit envelope');

/** The exact 32 bytes each of the nine fields commits to, in scope order. */
export const committedFieldValues = (frame: TermsFrame): Record<ScopeName, Uint8Array> => ({
  amount: fieldNumber(frame.terms.amount),
  tax: fieldNumber(frame.terms.taxAmount),
  dueDate: fieldNumber(frame.dueDate),
  buyer: frame.buyerKey,
  seller: frame.sellerKey,
  currency: frame.terms.currency,
  items: frame.terms.itemsHash,
  memo: frame.terms.memoHash,
  orderRef: frame.terms.orderRef,
});

/** The nine per-field commitments, each taken by the compiled circuit. */
export const committedFieldCommitments = (
  frame: TermsFrame,
  salts: readonly Uint8Array[],
): Record<ScopeName, Uint8Array> => {
  if (salts.length !== SCOPE_COUNT) {
    throw new AuditEnvelopeError(`expected ${SCOPE_COUNT} field salts, got ${salts.length}`);
  }
  const values = committedFieldValues(frame);
  const tags = fieldTags();
  const out = {} as Record<ScopeName, Uint8Array>;
  for (const [index, scope] of SCOPES.entries()) {
    out[scope] = pureCircuits.commitField(tags[scope], values[scope], salts[index]);
  }
  return out;
};

/**
 * Vector<10, Bytes<32>>: the field-root tag followed by the nine commitments.
 *
 * Matching the circuit's own descriptor exactly is what makes the fold below
 * reproduce `commitFieldRoot`.
 */
const FIELD_ROOT_TYPE = new CompactTypeVector<Uint8Array>(
  SCOPE_COUNT + 1,
  new CompactTypeBytes(BYTES32),
);

/**
 * Rebuild the anchor's field root from the nine commitments alone.
 *
 * The circuit's `commitFieldRoot` needs every salt, which an auditor holding a
 * partial grant does not have and must never be given. This takes the same last
 * step .. one `persistentHash` over the tag and the nine commitments .. so a
 * partial grant is still enough to tie the envelope to the chain.
 */
export const foldFieldRoot = (commitments: Readonly<Record<ScopeName, Uint8Array>>): Uint8Array =>
  persistentHash(FIELD_ROOT_TYPE, [
    pureCircuits.tagFieldRoot(),
    ...SCOPES.map((scope) => commitments[scope]),
  ]);

// ---------------------------------------------------------------------------
// Plaintext forms
// ---------------------------------------------------------------------------

/**
 * The canonical line-item preimage.
 *
 * Mirrors what `hashLineItems` hashes. `buildAuditEnvelope` verifies the result
 * against `itemsHash` before sealing, so a drift between the two shows up in the
 * seller's own wallet rather than months later in the auditor's.
 */
const lineItemsPreimage = (items: readonly LineItem[]): string =>
  canonicalJson(
    items.map((item) => ({
      description: item.description,
      quantity: item.quantity.toString(),
      unitPrice: item.unitPrice.toString(),
    })),
  );

const plaintextFor = (
  scope: ScopeName,
  frame: TermsFrame,
  prepared: PreparedInvoice,
): string | null => {
  switch (scope) {
    case 'amount':
      return frame.terms.amount.toString();
    case 'tax':
      return frame.terms.taxAmount.toString();
    case 'dueDate':
      return frame.dueDate.toString();
    case 'currency':
      return prepared.plaintext.currency;
    case 'items':
      return lineItemsPreimage(prepared.plaintext.lineItems);
    case 'memo':
      return prepared.plaintext.memo;
    case 'orderRef':
      return prepared.plaintext.orderRef;
    case 'buyer':
    case 'seller':
      return null;
  }
};

/**
 * Re-encode a disclosed plaintext and compare it with the committed bytes.
 *
 * Without this a seller could ship a correct `value`/`salt` pair beside a
 * plaintext that reads differently .. an amount of 1,000 next to bytes that
 * commit to 100,000 .. and every commitment check would still pass while the
 * auditor read the wrong number. Returns null when consistent, or the reason.
 */
const plaintextMismatch = async (
  scope: ScopeName,
  plaintext: string | null,
  value: Uint8Array,
): Promise<string | null> => {
  const encoding = FIELD_ENCODING[scope];

  if (encoding === 'bytes32') {
    return plaintext === null
      ? null
      : `${scope} carries a plaintext form, but its committed bytes are the value itself`;
  }
  if (plaintext === null) {
    return `${scope} discloses no plaintext for its committed value`;
  }

  let expected: Uint8Array;
  if (encoding === 'uint') {
    expected = fieldNumber(BigInt(plaintext));
  } else if (encoding === 'ascii32') {
    expected = padBytes32(plaintext);
  } else {
    // An empty memo or order reference is committed as the zero digest, not as
    // sha256(""), because `prepareInvoice` leaves the field unset rather than
    // hashing nothing.
    expected = plaintext.length === 0 ? ZERO32 : await sha256(plaintext);
  }

  return bytesEqual(expected, value)
    ? null
    : `${scope} plaintext does not encode to the value its commitment is taken over`;
};

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * A fresh audit key.
 *
 * One key per grant. Reusing a key across invoices would let an auditor granted
 * one invoice open the envelope for another, which the chain's per-invoice grant
 * would then have no way to prevent.
 */
/**
 * Is this grant usable right now, for exactly these fields?
 *
 * The contract enforces what may be *granted*; nothing on chain enforces what a
 * reader may *open*, because opening happens off chain against an encrypted
 * envelope. This is that rule, and it is deliberately the only copy of it: an
 * earlier version also lived in the contract as an entry point, which cost a
 * verifier key in every deploy transaction, was called by nothing, and gave two
 * implementations a chance to drift apart.
 *
 * The clauses mirror the chain's own semantics:
 *
 *  - Expiry is exclusive. The contract's guard is `blockTime < expiresAt`, so a
 *    grant read exactly at its expiry has already lapsed.
 *  - A request for no fields is refused rather than vacuously covered. Under
 *    ordinary subset semantics the empty set is covered by anything, which is
 *    exactly the wrong answer to hand a validator: a caller asking to see
 *    nothing has almost certainly built its request wrongly, and a `true` here
 *    would let a malformed envelope look authorised.
 */
export const grantCovers = (
  grant: AuditGrantView | undefined,
  requested: readonly boolean[],
  now: bigint,
): boolean => {
  if (grant === undefined) return false;
  if (grant.revoked) return false;
  if (requested.length !== SCOPE_COUNT || grant.scopes.length !== SCOPE_COUNT) return false;
  if (!requested.some((on) => on)) return false;
  if (now >= grant.expiresAt) return false;
  return requested.every((on, index) => !on || grant.scopes[index]);
};

export const deriveAuditKey = (): Uint8Array => randomBytes32();

/** The value the grant pins on chain. The key itself never goes there. */
export const auditKeyHash = (key: Uint8Array): Promise<Uint8Array> => sha256(assertAuditKey(key));

const assertAuditKey = (key: unknown): Uint8Array => {
  if (!(key instanceof Uint8Array) || key.length !== BYTES32) {
    throw new AuditEnvelopeError(`the audit key must be exactly ${BYTES32} bytes`);
  }
  if (key.every((byte) => byte === 0)) {
    throw new AuditEnvelopeError('refusing an all-zero audit key .. it is not a secret');
  }
  return key;
};

const importAesKey = async (key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', assertAuditKey(key) as unknown as BufferSource, 'AES-GCM', false, [
    usage,
  ]);

// ---------------------------------------------------------------------------
// Envelope header, as authenticated data
// ---------------------------------------------------------------------------

type EnvelopeHeader = {
  readonly version: string;
  readonly invoiceId: string;
  readonly network: string;
  readonly contractAddress: string;
  readonly scopeMask: number;
  readonly expiresAt: string;
  readonly auditKeyHash: string;
};

/**
 * The header as GCM associated data.
 *
 * Binding it means a header field cannot be edited in transit without the
 * ciphertext failing to open: an intermediary cannot quietly widen a scope mask,
 * repoint an envelope at another invoice, or extend its stated expiry. The
 * validator still cross-checks every header field that matters against the
 * payload or the grant, because the party who built the envelope holds the key
 * and can seal a header that lies.
 */
const associatedData = (header: EnvelopeHeader): Uint8Array =>
  new TextEncoder().encode(canonicalJson(header));

const headerOf = (envelope: AuditEnvelope): EnvelopeHeader => ({
  version: envelope.version,
  invoiceId: envelope.invoiceId,
  network: envelope.network,
  contractAddress: envelope.contractAddress,
  scopeMask: envelope.scopeMask,
  expiresAt: envelope.expiresAt,
  auditKeyHash: envelope.auditKeyHash,
});

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

const toBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

const fromBase64 = (text: string): Uint8Array => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new AuditEnvelopeError('the ciphertext is not base64');
  }
  return new Uint8Array(Buffer.from(text, 'base64'));
};

const concatBytes = (head: Uint8Array, tail: Uint8Array): Uint8Array => {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head);
  out.set(tail, head.length);
  return out;
};

/**
 * Seal an invoice's disclosed fields for one auditor.
 *
 * The IV is fresh on every call. AES-GCM fails catastrophically on nonce reuse
 * .. two envelopes sealed under the same key and IV leak the XOR of their
 * plaintexts and, worse, the authentication subkey .. so it is generated here
 * rather than accepted as an argument, where a caller could pass a constant.
 */
export const buildAuditEnvelope = async (args: BuildAuditEnvelopeArgs): Promise<AuditEnvelope> => {
  const scopes = [...args.scopes];
  if (scopes.length !== SCOPE_COUNT) {
    throw new AuditEnvelopeError(`scopes must have exactly ${SCOPE_COUNT} slots`);
  }
  // `grantAudit` refuses a grant with no slot set, so an envelope that discloses
  // nothing could never have an authorisation behind it.
  if (!scopes.some((on) => on)) {
    throw new AuditEnvelopeError('an envelope must disclose at least one field');
  }
  assertAuditKey(args.auditKey);
  if (!bytesEqual(args.invoiceId, args.frame.invoiceId)) {
    throw new AuditEnvelopeError(
      'the invoice id does not match the frame the commitments are taken over',
    );
  }
  if (args.prepared.fieldSalts.length !== SCOPE_COUNT) {
    throw new AuditEnvelopeError(`expected ${SCOPE_COUNT} field salts to open the invoice`);
  }

  const values = committedFieldValues(args.frame);
  const commitments = committedFieldCommitments(args.frame, args.prepared.fieldSalts);

  const disclosed: Partial<Record<ScopeName, DisclosedField>> = {};
  for (const [index, scope] of SCOPES.entries()) {
    if (!scopes[index]) continue;
    const plaintext = plaintextFor(scope, args.frame, args.prepared);
    const mismatch = await plaintextMismatch(scope, plaintext, values[scope]);
    if (mismatch !== null) {
      throw new AuditEnvelopeError(`refusing to seal an envelope the auditor could not check: ${mismatch}`);
    }
    disclosed[scope] = {
      value: toHex(values[scope]),
      salt: toHex(args.prepared.fieldSalts[index]),
      plaintext,
    };
  }

  const commitmentHex = {} as Record<ScopeName, string>;
  for (const scope of SCOPES) {
    commitmentHex[scope] = toHex(commitments[scope]);
  }

  const payload: AuditPayload = {
    invoiceId: toHex(args.invoiceId),
    scopeMask: scopesToMask(scopes),
    disclosed,
    commitments: commitmentHex,
    // Taken by the circuit, not by `foldFieldRoot`, so the validator's fold has
    // something independent to agree with.
    fieldRoot: toHex(commitFieldRoot(args.frame, args.prepared.fieldSalts)),
    termsCommitment: toHex(commitTerms(args.frame, args.prepared.termsSalt)),
  };

  const plaintextBytes = new TextEncoder().encode(canonicalJson(payload));
  const payloadHash = await sha256(plaintextBytes);

  const header: EnvelopeHeader = {
    version: AUDIT_ENVELOPE_VERSION,
    invoiceId: payload.invoiceId,
    network: args.network,
    contractAddress: args.contractAddress,
    scopeMask: payload.scopeMask,
    expiresAt: args.expiresAt.toString(),
    auditKeyHash: toHex(await auditKeyHash(args.auditKey)),
  };

  const iv = new Uint8Array(IV_BYTES);
  crypto.getRandomValues(iv);

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        tagLength: TAG_BYTES * 8,
        additionalData: associatedData(header) as unknown as BufferSource,
      },
      await importAesKey(args.auditKey, 'encrypt'),
      plaintextBytes as unknown as BufferSource,
    ),
  );

  // WebCrypto returns ciphertext and tag concatenated. The envelope keeps them
  // apart so the format reads the same as every other GCM envelope an auditor
  // will have seen.
  const split = sealed.length - TAG_BYTES;

  return {
    ...header,
    encryption: {
      algorithm: 'AES-256-GCM',
      iv: toHex(iv),
      authTag: toHex(sealed.subarray(split)),
      ciphertext: toBase64(sealed.subarray(0, split)),
    },
    integrity: { payloadHash: toHex(payloadHash) },
  };
};

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

const asRecord = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AuditEnvelopeError(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
};

const asString = (value: unknown, what: string): string => {
  if (typeof value !== 'string') {
    throw new AuditEnvelopeError(`${what} is not a string`);
  }
  return value;
};

const isScopeName = (value: string): value is ScopeName =>
  (SCOPES as readonly string[]).includes(value);

const parsePayload = (value: unknown): AuditPayload => {
  const root = asRecord(value, 'the payload');

  const commitmentsRaw = asRecord(root.commitments, 'payload.commitments');
  const commitments = {} as Record<ScopeName, string>;
  for (const scope of SCOPES) {
    commitments[scope] = asString(commitmentsRaw[scope], `payload.commitments.${scope}`);
  }

  const disclosedRaw = asRecord(root.disclosed, 'payload.disclosed');
  const disclosed: Partial<Record<ScopeName, DisclosedField>> = {};
  for (const key of Object.keys(disclosedRaw)) {
    if (!isScopeName(key)) {
      throw new AuditEnvelopeError(`payload.disclosed names an unknown field "${key}"`);
    }
    const field = asRecord(disclosedRaw[key], `payload.disclosed.${key}`);
    disclosed[key] = {
      value: asString(field.value, `payload.disclosed.${key}.value`),
      salt: asString(field.salt, `payload.disclosed.${key}.salt`),
      plaintext:
        field.plaintext === null
          ? null
          : asString(field.plaintext, `payload.disclosed.${key}.plaintext`),
    };
  }

  if (typeof root.scopeMask !== 'number' || !Number.isInteger(root.scopeMask)) {
    throw new AuditEnvelopeError('payload.scopeMask is not an integer');
  }

  return {
    invoiceId: asString(root.invoiceId, 'payload.invoiceId'),
    scopeMask: root.scopeMask,
    disclosed,
    commitments,
    fieldRoot: asString(root.fieldRoot, 'payload.fieldRoot'),
    termsCommitment: asString(root.termsCommitment, 'payload.termsCommitment'),
  };
};

type Opened = {
  /** The exact bytes that were sealed, which `integrity.payloadHash` covers. */
  readonly bytes: Uint8Array;
  readonly payload: AuditPayload;
};

const openSealed = async (envelope: AuditEnvelope, auditKey: Uint8Array): Promise<Opened> => {
  const encryption = envelope.encryption;
  if (encryption === undefined || encryption === null) {
    throw new AuditEnvelopeError('the envelope carries no encryption block');
  }
  if (encryption.algorithm !== 'AES-256-GCM') {
    throw new AuditEnvelopeError(
      `unsupported algorithm "${String(encryption.algorithm)}"; this reader only opens AES-256-GCM`,
    );
  }

  const iv = fromHex(asString(encryption.iv, 'encryption.iv'));
  if (iv.length !== IV_BYTES) {
    throw new AuditEnvelopeError(`the IV must be ${IV_BYTES} bytes, got ${iv.length}`);
  }
  const authTag = fromHex(asString(encryption.authTag, 'encryption.authTag'));
  if (authTag.length !== TAG_BYTES) {
    throw new AuditEnvelopeError(`the auth tag must be ${TAG_BYTES} bytes, got ${authTag.length}`);
  }
  const body = fromBase64(asString(encryption.ciphertext, 'encryption.ciphertext'));
  if (body.length === 0) {
    throw new AuditEnvelopeError('the ciphertext is empty');
  }

  let clear: ArrayBuffer;
  try {
    clear = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as unknown as BufferSource,
        tagLength: TAG_BYTES * 8,
        additionalData: associatedData(headerOf(envelope)) as unknown as BufferSource,
      },
      await importAesKey(auditKey, 'decrypt'),
      concatBytes(body, authTag) as unknown as BufferSource,
    );
  } catch {
    // GCM cannot tell these apart, and neither should the message: a wrong key,
    // a flipped ciphertext bit, a swapped IV and an edited header all land here.
    throw new AuditEnvelopeError(
      'the audit envelope did not decrypt .. the key is wrong, or the ciphertext, ' +
        'IV, auth tag or header has been altered since it was sealed',
    );
  }

  const bytes = new Uint8Array(clear);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AuditEnvelopeError('the envelope decrypted but its payload is not JSON');
  }
  return { bytes, payload: parsePayload(parsed) };
};

/** Decrypt and parse. Throws when the key is wrong or the envelope was altered. */
export const openAuditEnvelope = async (
  envelope: AuditEnvelope,
  auditKey: Uint8Array,
): Promise<AuditPayload> => (await openSealed(envelope, auditKey)).payload;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type CheckOutcome = { readonly ok: boolean; readonly detail: string };

const pass = (detail: string): CheckOutcome => ({ ok: true, detail });
const fail = (detail: string): CheckOutcome => ({ ok: false, detail });

/**
 * Check every claim an envelope makes, and report rather than throw.
 *
 * A validator that crashes on a malformed envelope is useless in the one
 * situation it exists for. Every check is therefore wrapped: a hostile envelope
 * with a non-hex digest or a truncated ciphertext produces a failed check with
 * the reason attached, not an exception the caller has to catch.
 *
 * `anchor` is what the caller read from the chain and `grant` is the on-chain
 * `AuditGrant`; nothing in the envelope is allowed to stand in for either.
 */
export const validateAuditEnvelope = async (
  args: ValidateAuditEnvelopeArgs,
): Promise<ValidationReport> => {
  const { envelope, auditKey, anchor, grant, now } = args;

  // Decrypted once, before the checks run, because the containment check has to
  // see the fields actually present inside the ciphertext and not just the mask
  // the header advertises. The checks are still reported in the documented
  // order; only the decryption is hoisted.
  let opened: Opened | null = null;
  let openFailure = '';
  try {
    opened = await openSealed(envelope, auditKey);
  } catch (error) {
    openFailure = messageOf(error);
  }

  const checks: Check[] = [];
  const record = async (
    name: string,
    body: () => CheckOutcome | Promise<CheckOutcome>,
  ): Promise<void> => {
    try {
      const outcome = await body();
      checks.push({ name, ok: outcome.ok, detail: outcome.detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: `the check could not run: ${messageOf(error)}` });
    }
  };

  // (a) A format this validator actually understands.
  await record(AUDIT_CHECKS.version, () =>
    envelope.version === AUDIT_ENVELOPE_VERSION
      ? pass(`envelope format ${AUDIT_ENVELOPE_VERSION}`)
      : fail(
          `unrecognised envelope format "${String(envelope.version)}"; ` +
            `this validator reads ${AUDIT_ENVELOPE_VERSION}`,
        ),
  );

  // (b) Revocation is immediate and beats everything else the grant says.
  await record(AUDIT_CHECKS.revocation, () =>
    grant.revoked
      ? fail('the seller has revoked this grant')
      : pass('the grant is still in force'),
  );

  // (c) The chain's clock rule is `blockTime < expiresAt`, so expiry is exclusive.
  await record(AUDIT_CHECKS.expiry, () => {
    if (now >= grant.expiresAt) {
      return fail(`the grant expired at ${grant.expiresAt}; this envelope is being read at ${now}`);
    }
    const declared = BigInt(envelope.expiresAt);
    if (declared > grant.expiresAt) {
      return fail(
        `the envelope claims to run until ${declared}, past the grant's ${grant.expiresAt}`,
      );
    }
    return pass(`valid until ${grant.expiresAt}, read at ${now}`);
  });

  // (d) The grant authorises a key, not a bearer. Both directions are checked:
  // the envelope must name the granted key, and the key in hand must be it.
  await record(AUDIT_CHECKS.keyBinding, async () => {
    const claimed = fromHex(envelope.auditKeyHash);
    if (!bytesEqual(claimed, grant.auditKeyHash)) {
      return fail('the envelope names an audit key the grant does not authorise');
    }
    const hashed = await auditKeyHash(auditKey);
    if (!bytesEqual(hashed, grant.auditKeyHash)) {
      return fail('the supplied key does not hash to the audit key hash the grant pins');
    }
    return pass('the supplied key is the one the grant authorises');
  });

  // (e) The check the whole format exists for. See the module header.
  await record(AUDIT_CHECKS.scopeContainment, () => {
    if (grant.scopes.length !== SCOPE_COUNT) {
      return fail(`the grant has ${grant.scopes.length} scope slots, expected ${SCOPE_COUNT}`);
    }
    if (
      !Number.isInteger(envelope.scopeMask) ||
      envelope.scopeMask < 0 ||
      envelope.scopeMask > MAX_SCOPE_MASK
    ) {
      return fail(`the scope mask ${String(envelope.scopeMask)} is not a nine-slot mask`);
    }

    const declared = scopesFromMask(envelope.scopeMask);
    const overDeclared = SCOPES.filter((_, index) => declared[index] && !grant.scopes[index]);
    if (overDeclared.length > 0) {
      return fail(
        `the envelope declares ${overDeclared.join(', ')}, which the grant does not cover`,
      );
    }

    if (opened === null) {
      return fail(
        `the ciphertext could not be opened, so the disclosed fields could not be ` +
          `inspected: ${openFailure}`,
      );
    }
    if (opened.payload.scopeMask !== envelope.scopeMask) {
      return fail(
        `the sealed payload declares scope mask ${opened.payload.scopeMask} while the ` +
          `envelope header declares ${envelope.scopeMask}`,
      );
    }

    const carried = SCOPES.filter((scope) => opened?.payload.disclosed[scope] !== undefined);
    const overCarried = carried.filter((scope) => !grant.scopes[SCOPES.indexOf(scope)]);
    if (overCarried.length > 0) {
      return fail(
        `the sealed payload carries ${overCarried.join(', ')}, which the grant does not cover`,
      );
    }
    const undeclared = carried.filter((scope) => !declared[SCOPES.indexOf(scope)]);
    if (undeclared.length > 0) {
      return fail(
        `the sealed payload carries ${undeclared.join(', ')} without declaring them in the mask`,
      );
    }

    return pass(
      carried.length === 0
        ? 'the envelope discloses nothing'
        : `discloses ${carried.join(', ')}, all within the grant`,
    );
  });

  // (f) The ciphertext opens and the plaintext is the one the header vouches for.
  await record(AUDIT_CHECKS.payloadIntegrity, async () => {
    if (opened === null) {
      return fail(openFailure);
    }
    const expected = fromHex(envelope.integrity.payloadHash);
    const actual = await sha256(opened.bytes);
    if (!bytesEqual(expected, actual)) {
      return fail('the payload hash in the envelope is not the hash of the sealed payload');
    }
    if (opened.payload.invoiceId !== envelope.invoiceId) {
      return fail(
        `the sealed payload is for invoice ${opened.payload.invoiceId}, not ${envelope.invoiceId}`,
      );
    }
    return pass('the payload decrypts and matches its recorded hash');
  });

  // (g) Each disclosed field opens its own commitment, and reads as it opens.
  await record(AUDIT_CHECKS.fieldCommitments, async () => {
    if (opened === null) {
      return fail(openFailure);
    }
    const payload = opened.payload;
    const tags = fieldTags();
    const problems: string[] = [];
    let checked = 0;

    for (const scope of SCOPES) {
      const field = payload.disclosed[scope];
      if (field === undefined) continue;
      checked += 1;

      const value = fromHex(field.value);
      const salt = fromHex(field.salt);
      if (value.length !== BYTES32 || salt.length !== BYTES32) {
        problems.push(`${scope}: value and salt must both be ${BYTES32} bytes`);
        continue;
      }
      const recomputed = pureCircuits.commitField(tags[scope], value, salt);
      if (!bytesEqual(recomputed, fromHex(payload.commitments[scope]))) {
        problems.push(`${scope}: the disclosed value and salt do not open its commitment`);
        continue;
      }
      const mismatch = await plaintextMismatch(scope, field.plaintext, value);
      if (mismatch !== null) {
        problems.push(mismatch);
      }
    }

    if (problems.length > 0) {
      return fail(problems.join('; '));
    }
    return pass(
      checked === 0
        ? 'no fields were disclosed, so there was nothing to open'
        : `${checked} disclosed field${checked === 1 ? '' : 's'} open the recorded commitments`,
    );
  });

  // (h) The commitments are the ones the chain already anchored, so the auditor
  // is checking the invoice that was issued and not a plausible rewrite of it.
  await record(AUDIT_CHECKS.fieldRoot, () => {
    if (opened === null) {
      return fail(openFailure);
    }
    const payload = opened.payload;
    const commitments = {} as Record<ScopeName, Uint8Array>;
    for (const scope of SCOPES) {
      const bytes = fromHex(payload.commitments[scope]);
      if (bytes.length !== BYTES32) {
        return fail(`the ${scope} commitment is not ${BYTES32} bytes`);
      }
      commitments[scope] = bytes;
    }

    const folded = foldFieldRoot(commitments);
    if (!bytesEqual(folded, anchor.fieldRoot)) {
      return fail('the nine commitments do not fold to the field root the chain holds');
    }
    if (!bytesEqual(fromHex(payload.fieldRoot), anchor.fieldRoot)) {
      return fail('the payload names a field root that is not the one on the anchor');
    }
    if (!bytesEqual(fromHex(payload.termsCommitment), anchor.terms)) {
      return fail('the payload names a terms commitment that is not the one on the anchor');
    }
    return pass('the commitments fold to the field root and terms commitment on chain');
  });

  return { ok: checks.every((check) => check.ok), checks };
};

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * The report as a person reads it in a terminal.
 *
 * A clean report contains no occurrence of the word FAIL, so a human skimming a
 * long log, or a script grepping one, cannot mistake a pass for a failure.
 */
export const formatValidationReport = (report: ValidationReport): string => {
  const width = report.checks.reduce((widest, check) => Math.max(widest, check.name.length), 0);
  const passed = report.checks.filter((check) => check.ok).length;
  const total = report.checks.length;

  const lines = [
    `QuietBooks audit envelope: ${report.ok ? 'PASS' : 'FAIL'}`,
    '',
    ...report.checks.map(
      (check) => `  [${check.ok ? 'PASS' : 'FAIL'}] ${check.name.padEnd(width)}  ${check.detail}`,
    ),
    '',
    `${passed} of ${total} check${total === 1 ? '' : 's'} passed.`,
  ];
  return lines.join('\n');
};
