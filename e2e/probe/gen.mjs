// Generate a Compact contract with N distinct ledger-writing entry points.
//
// SPDX-License-Identifier: Apache-2.0
//
// Used to measure how much a single deploy transaction can carry on a given
// node, by bisecting N until the node stops accepting the deploy.
//
// The circuits must be structurally DIFFERENT from one another. N copies of the
// same circuit produce N identical verifier keys, which the transaction
// encoding compresses away -- 18 identical circuits serialize to 6 KB while 18
// distinct ones serialize to 41 KB. Varying the work per circuit makes each
// verifier key distinct, so the measurement reflects a real contract.
import { writeFileSync } from 'node:fs';

const n = Number(process.argv[2]);
if (!Number.isInteger(n) || n < 1) throw new Error('usage: node gen.mjs <entry-point-count>');

const NL = String.fromCharCode(10);

const header = [
  'pragma language_version 0.23;',
  'import CompactStandardLibrary;',
  '',
  'export ledger counters: Counter;',
  'export ledger digest: Bytes<32>;',
  '',
].join(NL);

const circuits = [];
for (let i = 0; i < n; i++) {
  const rounds = (i % 5) + 1;
  const lines = [];
  for (let r = 0; r < rounds; r++) {
    const prev = r === 0 ? 'seed' : 'acc' + (r - 1);
    lines.push('  const acc' + r + ' = persistentHash<Vector<2, Bytes<32>>>([' + prev + ', seed]);');
  }
  circuits.push(
    [
      'export circuit entry' + i + '(seed: Bytes<32>): [] {',
      ...lines,
      '  digest = disclose(acc' + (rounds - 1) + ');',
      '  counters.increment(' + (i + 1) + ');',
      '}',
      '',
    ].join(NL),
  );
}

writeFileSync('probe.compact', header + circuits.join(NL));
console.log('wrote probe.compact with ' + n + ' distinct entry points');
