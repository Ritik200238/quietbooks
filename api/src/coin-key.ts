// Turning a wallet's coin public key into the 32 bytes a circuit wants.
//
// SPDX-License-Identifier: Apache-2.0
//
// There is one function here because there were four, in four files, and three
// of them were wrong in a way nothing could catch: they produced no error and no
// bytes, or bytes of the wrong length, depending on which wallet the user
// happened to have.
//
// The problem is that a Zswap coin public key has two spellings, and the two
// interfaces meet different ones.
//
//   Bech32m   mn_shield-cpk_undeployed1qq...    what a browser wallet hands a
//                                               dApp. `dapp-connector-api`'s
//                                               `getShieldedAddresses()` is
//                                               documented as returning all
//                                               three of its values in this
//                                               form.
//   Hex       64 hex characters                 what `CoinPublicKey` is in
//                                               `ledger-v8` (`type
//                                               CoinPublicKey = string`), and
//                                               what a locally built wallet's
//                                               `zswapSecretKeys.coinPublicKey`
//                                               is.
//
// `encodeCoinPublicKey` from `@midnight-ntwrk/compact-runtime` reads only the
// second. Run it on a Bech32m key and it throws `Invalid character 'm' at
// position 0` -- which is what the web interface did to every real wallet the
// moment it tried to connect, and what both front ends did to a buyer pasting
// the key their own wallet had given them.
//
// `parseCoinPublicKeyToHex` reads both, and is what midnight-js itself runs on
// `walletProvider.getCoinPublicKey()` before building a transaction. Going
// through it means the two front ends agree about what a coin public key is,
// and agree with the library underneath them.

import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { parseCoinPublicKeyToHex } from '@midnight-ntwrk/midnight-js-utils';
import { fromHex } from '@quietbooks/contract';

/** A coin public key was not one. Carries the value, so the message can say so. */
export class CoinPublicKeyError extends Error {
  constructor(readonly value: string, cause?: unknown) {
    super(
      'that is not a coin public key. A wallet gives it out either as ' +
        '"mn_shield-cpk_..." or as 64 hexadecimal characters; anything else is a ' +
        'different kind of address, and a shielded address is the usual mix-up.',
    );
    this.name = 'CoinPublicKeyError';
    this.cause = cause;
  }
}

/**
 * The 32 bytes behind a coin public key, in either spelling.
 *
 * Bech32m keys carry the network in their prefix and are rejected if it is not
 * the network this session is on, which is worth having: a key copied from a
 * testnet wallet into a mainnet invoice would otherwise be committed to at
 * issuance and only discovered when the payment went nowhere.
 */
export const coinPublicKeyBytes = (value: string): Uint8Array => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new CoinPublicKeyError(value);
  }
  let hex: string;
  try {
    // This package's own copy of the network id, which `configureNetwork` sets.
    // Reading it through `getNetworkId` rather than accepting a parameter keeps
    // the two front ends from disagreeing about which network a key belongs to.
    hex = parseCoinPublicKeyToHex(trimmed, getNetworkId());
  } catch (error) {
    throw new CoinPublicKeyError(value, error);
  }
  const bytes = fromHex(hex);
  if (bytes.length !== 32) {
    // Reachable: the parser is happy with any Bech32m payload carrying the right
    // prefix, and a shielded *address* is a coin public key and an encryption
    // key concatenated. Letting a 64-byte value through would put it in the
    // terms, where it is committed to and can never be corrected.
    throw new CoinPublicKeyError(value);
  }
  return bytes;
};

/** True when two coin public keys name the same recipient, in either spelling. */
export const sameCoinPublicKey = (a: string, b: string): boolean => {
  try {
    const left = coinPublicKeyBytes(a);
    const right = coinPublicKeyBytes(b);
    return left.length === right.length && left.every((byte, i) => byte === right[i]);
  } catch {
    return false;
  }
};
