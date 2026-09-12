// Byte, hex and field-encoding helpers shared by the contract package, the API
// and the audit validator.
//
// SPDX-License-Identifier: Apache-2.0
//
// Everything the circuit hashes is a fixed 32-byte value, so the job of this
// module is to turn ordinary application data .. a currency code, a line-item
// list, a free-text memo .. into exactly 32 bytes, the same way every time. Any
// disagreement between the wallet that issues an invoice and the auditor that
// checks it would surface as an unopenable commitment, so these encodings are
// deliberately simple and are covered by tests.

import { webcrypto } from 'node:crypto';

const crypto: Crypto = (globalThis as { crypto?: Crypto }).crypto ?? (webcrypto as unknown as Crypto);

export const BYTES32 = 32;

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

const HEX = '0123456789abcdef';

export const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 0x0f];
  }
  return out;
};

export const fromHex = (hex: string): Uint8Array => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error('quietbooks: hex string must have an even number of characters');
  }
  if (!/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error('quietbooks: hex string contains a non-hex character');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/** Constant-time-ish equality. Used when comparing digests in the validator. */
export const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
};

// ---------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------

/**
 * A fresh 32-byte value from the platform CSPRNG.
 *
 * Used for every secret, salt and nonce. `Math.random` would be catastrophic
 * here .. a predictable salt makes a commitment publicly recomputable, which
 * turns a hidden amount into a guessable one .. so there is no fallback path.
 */
export const randomBytes32 = (): Uint8Array => {
  const out = new Uint8Array(BYTES32);
  crypto.getRandomValues(out);
  return out;
};

/** A vector of fresh salts, one per disclosable field. */
export const randomSalts = (count: number): Uint8Array[] =>
  Array.from({ length: count }, () => randomBytes32());

// ---------------------------------------------------------------------------
// 32-byte encodings
// ---------------------------------------------------------------------------

/**
 * Right-pad a short ASCII string into 32 bytes.
 *
 * Mirrors Compact's `pad(32, "...")`, which the circuit uses for its domain
 * tags and which the contract also relies on for currency codes.
 */
export const padBytes32 = (text: string): Uint8Array => {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length > BYTES32) {
    throw new Error(`quietbooks: "${text}" does not fit in ${BYTES32} bytes`);
  }
  const out = new Uint8Array(BYTES32);
  out.set(encoded);
  return out;
};

/** Read a padded ASCII string back out of 32 bytes. */
export const unpadBytes32 = (bytes: Uint8Array): string => {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end === -1 ? bytes : bytes.subarray(0, end));
};

/**
 * A currency as the circuit sees it: an ISO-4217-style code padded to 32 bytes.
 *
 * Codes are held as text rather than an enum so that a deployment can settle in
 * a token the contract has never heard of without a redeploy.
 */
export const currencyCode = (code: string): Uint8Array => {
  const trimmed = code.trim().toUpperCase();
  if (trimmed.length === 0) {
    throw new Error('quietbooks: currency code cannot be empty');
  }
  return padBytes32(trimmed);
};

/**
 * SHA-256 of arbitrary text, as 32 bytes.
 *
 * Line-item lists and memos are hashed rather than stored so that an invoice of
 * any size still commits to a fixed-width value. The plaintext travels in the
 * audit envelope when the auditor is granted that field; the chain only ever
 * sees the digest.
 */
export const sha256 = async (input: string | Uint8Array): Promise<Uint8Array> => {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return new Uint8Array(digest);
};

/** Canonical JSON so that two wallets hash the same line items identically. */
export const canonicalJson = (value: unknown): string => {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(
        Object.keys(node as Record<string, unknown>)
          .sort()
          .map((key) => [key, walk((node as Record<string, unknown>)[key])]),
      );
    }
    if (typeof node === 'bigint') return node.toString();
    return node;
  };
  return JSON.stringify(walk(value));
};

/** Hash a structured value through its canonical JSON form. */
export const hashJson = async (value: unknown): Promise<Uint8Array> => sha256(canonicalJson(value));

export const ZERO32 = new Uint8Array(BYTES32);

/** Seconds since the Unix epoch, as the contract's timestamps are expressed. */
export const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

export const daysFromNow = (days: number): bigint => nowSeconds() + BigInt(Math.round(days * 86_400));
