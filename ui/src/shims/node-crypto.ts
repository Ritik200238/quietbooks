// Browser stand-in for the part of `node:crypto` the contract package imports.
//
// SPDX-License-Identifier: Apache-2.0
//
// `@quietbooks/contract` is shared with a Node CLI, so it imports `webcrypto`
// and then prefers `globalThis.crypto` when one is present. In a browser
// `globalThis.crypto` is always the real WebCrypto implementation, so this file
// only has to make the import resolve .. it is not a reimplementation of
// anything, and no key material is generated here.

const browserCrypto = globalThis.crypto;

if (browserCrypto === undefined || browserCrypto.subtle === undefined) {
  // Without a secure context there is no SubtleCrypto, and every commitment and
  // audit envelope in this application depends on it. Failing here is far better
  // than failing later inside a proof with an unreadable message.
  throw new Error(
    'QuietBooks needs WebCrypto. Open the application over https, or on localhost.',
  );
}

export const webcrypto = browserCrypto;

export default { webcrypto };
