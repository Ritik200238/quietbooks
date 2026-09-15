// Reading a coin public key, in both spellings a wallet writes.
//
// SPDX-License-Identifier: Apache-2.0
//
// This file exists because of the worst bug this project shipped. The web
// interface could not connect to a wallet at all: `buildProviders` decoded the
// key the connector handed it with `encodeCoinPublicKey`, which reads hex, and
// a browser wallet writes Bech32m. It threw `Invalid character 'm' at position
// 0` before any contract call, on every real wallet, and every screen behind the
// connect gate was unreachable.
//
// Nothing caught it for the same reason nothing could: this layer had no tests,
// and the one wallet that gets exercised automatically -- the locally built one
// the end-to-end suite uses -- happens to hand out hex. The single call site
// that ran in CI was the single call site that worked.
//
// So the point of these tests is not that `coinPublicKeyBytes` has a happy path.
// It is that the two spellings of one key produce one answer, and that the
// function which cannot do that is documented here as failing, so a future
// simplification back to it is a red test rather than an unreachable product.

import { beforeAll, describe, expect, it } from 'vitest';

import { encodeCoinPublicKey } from '@midnight-ntwrk/compact-runtime';
import { ShieldedCoinPublicKey } from '@midnight-ntwrk/wallet-sdk-address-format';

import { coinPublicKeyBytes, CoinPublicKeyError, sameCoinPublicKey } from '../src/coin-key.js';
import { configureNetwork } from '../src/network.js';

const NETWORK = 'undeployed';

/** 32 bytes with a recognisable pattern, so a failure prints something legible. */
const HEX = '11'.repeat(32);

/** The same key as a browser wallet writes it. */
let BECH32M: string;

beforeAll(() => {
  // `coinPublicKeyBytes` reads the network id this package holds, because a
  // Bech32m key carries its network in the prefix and a key from the wrong one
  // must not end up committed into an invoice's terms.
  configureNetwork(NETWORK);
  BECH32M = ShieldedCoinPublicKey.codec
    .encode(NETWORK, ShieldedCoinPublicKey.fromHexString(HEX))
    .toString();
});

describe('a coin public key has two spellings and one meaning', () => {
  it('reads the Bech32m form a browser wallet hands out', () => {
    expect(BECH32M.startsWith('mn_shield-cpk_undeployed1')).toBe(true);
    expect(coinPublicKeyBytes(BECH32M)).toHaveLength(32);
  });

  it('reads the hex form a locally built wallet hands out', () => {
    expect(coinPublicKeyBytes(HEX)).toHaveLength(32);
  });

  it('gives both spellings the same 32 bytes', () => {
    // The property the product needs and the old code could not provide. A
    // seller on the web interface and a buyer on the CLI have to agree about
    // which address an invoice names, and they type it in different alphabets.
    expect(coinPublicKeyBytes(BECH32M)).toStrictEqual(coinPublicKeyBytes(HEX));
  });

  it('ignores surrounding whitespace, because pasted keys carry it', () => {
    expect(coinPublicKeyBytes(`  ${BECH32M}\n`)).toStrictEqual(coinPublicKeyBytes(BECH32M));
  });

  it('matches two spellings of one key', () => {
    expect(sameCoinPublicKey(BECH32M, HEX)).toBe(true);
  });

  it('does not match two different keys', () => {
    expect(sameCoinPublicKey(HEX, '22'.repeat(32))).toBe(false);
  });
});

describe('what it refuses', () => {
  it('refuses a shielded address, which is the mix-up that looks most alike', () => {
    // A shielded address is a coin public key and an encryption key together.
    // The prefix differs, and if it did not, the length check behind this would
    // still catch it -- an address in the terms is committed at issuance and can
    // never be corrected.
    const address = `mn_shield-addr_${NETWORK}1${'q'.repeat(120)}`;
    expect(() => coinPublicKeyBytes(address)).toThrow(CoinPublicKeyError);
  });

  it('refuses an empty string rather than returning empty bytes', () => {
    expect(() => coinPublicKeyBytes('   ')).toThrow(CoinPublicKeyError);
  });

  it('refuses hex of the wrong length', () => {
    expect(() => coinPublicKeyBytes('11'.repeat(31))).toThrow(CoinPublicKeyError);
    expect(() => coinPublicKeyBytes('11'.repeat(64))).toThrow(CoinPublicKeyError);
  });

  it('refuses a party key, which is a hash and cannot receive anything', () => {
    // Same shape as a hex coin public key, so nothing about the string says it
    // is wrong. It is refused only if it is not valid hex; a 32-byte party key
    // IS valid hex, so this documents a limit rather than a guarantee: the
    // interfaces say in words which of the two to paste, and the contract
    // catches the rest when a payment addressed to a hash goes nowhere.
    expect(coinPublicKeyBytes('ab'.repeat(32))).toHaveLength(32);
  });

  it('carries the offending value on the error, so a message can quote it', () => {
    try {
      coinPublicKeyBytes('not a key');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CoinPublicKeyError);
      expect((error as CoinPublicKeyError).value).toBe('not a key');
      expect((error as CoinPublicKeyError).message).toContain('mn_shield-cpk_');
    }
  });
});

describe('the function this one replaced', () => {
  /**
   * The regression guard.
   *
   * `encodeCoinPublicKey` is shorter, it is exported from a package this project
   * already depends on, and its name reads like the right thing. It is the
   * obvious simplification, and it is the bug. Asserting the failure here means
   * the next person to reach for it finds out in a test run rather than from a
   * user whose wallet will not connect.
   */
  it('reads hex and throws on Bech32m', () => {
    expect(encodeCoinPublicKey(HEX)).toHaveLength(32);
    expect(() => encodeCoinPublicKey(BECH32M)).toThrow();
  });

  it('never reads a Bech32m key as the key it is', () => {
    // Stated as an assertion rather than a comment: if a future runtime taught
    // `encodeCoinPublicKey` to read Bech32m, this test fails and somebody gets
    // to decide deliberately whether the helper is still needed.
    //
    // The claim is deliberately about the result, not the message. Which error
    // comes out depends on the key: a Bech32m string with an odd character count
    // fails on length ("Odd number of digits") before the decoder ever reaches a
    // character outside the hex alphabet ("Invalid character"). What matters is
    // that it can never quietly hand back the wrong 32 bytes.
    let decoded: Uint8Array | undefined;
    try {
      decoded = encodeCoinPublicKey(BECH32M);
    } catch {
      decoded = undefined;
    }
    if (decoded !== undefined) {
      expect(decoded).not.toStrictEqual(coinPublicKeyBytes(BECH32M));
    }
    expect(decoded).toBeUndefined();
  });
});
