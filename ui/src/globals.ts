// Globals the Midnight libraries expect a Node runtime to have provided.
//
// SPDX-License-Identifier: Apache-2.0
//
// Imported for its side effects, first, before anything that could reach one.
//
// `Buffer` is the one that matters. A wallet hands out its shielded coin public
// key in Bech32m, and midnight-js normalises that to hex on every deploy and
// every circuit call. The parser does `Buffer.from(bytes).toString('hex')` on
// the bare global, which a browser does not define. Aliasing the `node:buffer`
// module specifier in `vite.config.ts` does not help: the call is to the global,
// not to an import. The official bboard example does the same thing here, for
// the same reason.
//
// `process.env.NODE_ENV` is read by third-party libraries in the dependency
// tree that assume a bundler defined it.

import { Buffer } from 'buffer';

declare global {
  // eslint-disable-next-line no-var
  var Buffer: typeof import('buffer').Buffer;
}

globalThis.Buffer = Buffer;

if (typeof globalThis.process === 'undefined') {
  (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
    env: { NODE_ENV: import.meta.env.MODE },
  };
}

export {};
