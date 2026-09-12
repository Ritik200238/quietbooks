// JSON that survives a QuietBooks private state.
//
// SPDX-License-Identifier: Apache-2.0
//
// `JSON.stringify` turns a `Uint8Array` into `{"0":12,"1":255,...}` and throws on
// a `bigint`. Both appear throughout the private state: every salt is 32 bytes,
// every amount and timestamp is a bigint. A round trip through plain JSON would
// hand the witness layer an object where it expects bytes, and it would refuse
// with "must be exactly 32 bytes" long after the real mistake was made.
//
// So values of those two types are tagged on the way out and rebuilt on the way
// in. The tags are deliberately ugly to avoid colliding with a real key.

type Tagged = { readonly $bytes: string } | { readonly $bigint: string };

const HEX = '0123456789abcdef';

const toHex = (bytes: Uint8Array): string => {
  let out = '';
  for (const byte of bytes) {
    out += HEX[byte >> 4] + HEX[byte & 0x0f];
  }
  return out;
};

const fromHex = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

const isTagged = (value: object): value is Tagged =>
  ('$bytes' in value && typeof (value as { $bytes: unknown }).$bytes === 'string') ||
  ('$bigint' in value && typeof (value as { $bigint: unknown }).$bigint === 'string');

const pack = (value: unknown): unknown => {
  if (value instanceof Uint8Array) {
    return { $bytes: toHex(value) };
  }
  if (typeof value === 'bigint') {
    return { $bigint: value.toString() };
  }
  if (Array.isArray(value)) {
    return value.map(pack);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, pack(inner)]));
  }
  return value;
};

const unpack = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(unpack);
  }
  if (value !== null && typeof value === 'object') {
    if (isTagged(value)) {
      return '$bytes' in value ? fromHex(value.$bytes) : BigInt(value.$bigint);
    }
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, unpack(inner)]));
  }
  return value;
};

export const encodeState = (value: unknown): string => JSON.stringify(pack(value));

export const decodeState = <T>(text: string): T => unpack(JSON.parse(text)) as T;

export { toHex as bytesToHex, fromHex as hexToBytes };
