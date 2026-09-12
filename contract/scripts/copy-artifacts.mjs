// Copy the compiled contract bindings next to the emitted TypeScript.
//
// SPDX-License-Identifier: Apache-2.0
//
// `src/index.ts` imports the generated bindings as `../build/contract/index.js`.
// After tsc emits to `dist/src/`, that relative path points at
// `dist/build/contract/index.js`, which tsc does not produce: the bindings are
// generated JavaScript, not TypeScript sources it compiles.
//
// Copying them keeps the published package self-contained, so a consumer never
// has to know that part of this package comes from the Compact compiler rather
// than from tsc. Written in Node rather than a shell command because npm runs
// scripts through cmd.exe on Windows, where `cp -R` does not exist.

import { cp, access, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const from = resolve(root, 'build', 'contract');
const to = resolve(root, 'dist', 'build', 'contract');

try {
  await access(from);
} catch {
  console.error(
    `quietbooks: ${from} does not exist.\n` +
      'Run `npm run compact` first: the TypeScript build depends on artifacts the ' +
      'Compact compiler produces, and they are not checked in.',
  );
  process.exit(1);
}

await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
console.log(`copied contract bindings to ${to}`);
