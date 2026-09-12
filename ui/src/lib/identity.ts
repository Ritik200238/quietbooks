// This browser's QuietBooks root secret.
//
// SPDX-License-Identifier: Apache-2.0
//
// Every identity in the contract .. the party key an invoice is addressed to, the
// administrative key, the reliability record a counterparty can check .. is a
// domain-separated hash of one 32-byte secret. The contract deliberately does not
// derive identity from the wallet's public key, because a prover-claimed public
// key is not bound to the transaction signer and any assertion resting on it can
// be bypassed.
//
// The consequence for this interface is direct: the secret is the account. It is
// generated here on first use and kept in this browser. A wallet restored on
// another machine keeps its invoices and its reliability history only if the same
// secret goes with it, which is why the interface offers it for backup in plain
// sight instead of pretending the browser is durable.

import { bytesToHex, hexToBytes } from './codec';

const SECRET_KEY = 'quietbooks/v1/identity/root-secret';

const isAllZero = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);

const generate = (): Uint8Array => {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return secret;
};

/** Read this browser's secret, creating one on first use. */
export const loadOrCreateRootSecret = (): Uint8Array => {
  const stored = window.localStorage.getItem(SECRET_KEY);
  if (stored !== null && /^[0-9a-f]{64}$/.test(stored)) {
    const bytes = hexToBytes(stored);
    if (!isAllZero(bytes)) {
      return bytes;
    }
  }
  const created = generate();
  window.localStorage.setItem(SECRET_KEY, bytesToHex(created));
  return created;
};

export const rootSecretHex = (): string => bytesToHex(loadOrCreateRootSecret());

/** Whether this browser already holds a secret, without creating one. */
export const hasRootSecret = (): boolean => window.localStorage.getItem(SECRET_KEY) !== null;

/**
 * Replace the secret with one carried over from another browser.
 *
 * Refuses an all-zero value for the same reason the witness layer does: every
 * commitment in the contract takes a salt derived from this as its only
 * high-entropy input, and a zero secret makes those commitments publicly
 * recomputable.
 */
export const importRootSecret = (hex: string): void => {
  const clean = hex.trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{64}$/.test(clean)) {
    throw new Error('a QuietBooks identity secret is 64 hexadecimal characters');
  }
  if (isAllZero(hexToBytes(clean))) {
    throw new Error('that secret is all zeros, which is not a secret');
  }
  window.localStorage.setItem(SECRET_KEY, clean);
};
