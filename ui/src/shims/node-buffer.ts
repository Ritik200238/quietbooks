// Browser stand-in for the sliver of `node:buffer` the contract package uses.
//
// SPDX-License-Identifier: Apache-2.0
//
// The audit envelope carries its ciphertext as base64, and `@quietbooks/contract`
// reaches for `Buffer` to produce it because that module is also run by a Node
// CLI. Only two calls exist .. bytes to base64 and base64 to bytes .. so the
// whole Node buffer polyfill is not worth 40 kB of bundle. Anything else on the
// Buffer surface deliberately throws rather than returning a wrong answer
// quietly.

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const encodeBase64 = (bytes: Uint8Array): string => {
  // Chunked because `String.fromCharCode(...bytes)` overflows the call stack on
  // envelopes of any real size.
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
};

const decodeBase64 = (text: string): Uint8Array => {
  if (!BASE64.test(text)) {
    throw new Error('not base64');
  }
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
};

/** Bytes that can also encode themselves, which is all `Buffer` is used for. */
export interface BufferLike extends Uint8Array {
  toString(encoding?: string): string;
}

/**
 * Bytes with an encoding-aware `toString`.
 *
 * Deliberately not a `Uint8Array` subclass: `Uint8Array.from` and this `from`
 * have incompatible signatures, and inheriting one while overriding the other
 * produces a type that lies about what it accepts.
 */
const asBufferLike = (bytes: Uint8Array): BufferLike => {
  const out = bytes as BufferLike;
  Object.defineProperty(out, 'toString', {
    configurable: true,
    value: (encoding?: string): string => {
      if (encoding === 'base64') {
        return encodeBase64(out);
      }
      if (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') {
        return new TextDecoder().decode(out);
      }
      throw new Error(`QuietBooks browser Buffer shim does not encode "${encoding}"`);
    },
  });
  return out;
};

export const Buffer = {
  from(value: Uint8Array | ArrayBuffer | string, encoding?: string): BufferLike {
    if (typeof value === 'string') {
      if (encoding === 'base64') {
        return asBufferLike(decodeBase64(value));
      }
      if (encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') {
        return asBufferLike(new TextEncoder().encode(value));
      }
      throw new Error(`QuietBooks browser Buffer shim does not decode "${encoding}"`);
    }
    return asBufferLike(
      value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value),
    );
  },
};

export default { Buffer };
