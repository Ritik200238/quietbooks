// No exported circuit may read the same witness twice.
//
// SPDX-License-Identifier: Apache-2.0
//
// This is the structural form of the worst bug the contract has had. A witness
// is not an input the chain validates: every call to one is an independent
// private value the prover chooses. So a circuit that reads `invoiceTerms()`
// once to prove it opens the commitment on chain, and again to check an amount,
// is comparing two unrelated values. The prover answers the first honestly and
// the second however they like.
//
// `settleWithNote` did exactly that, and a buyer could settle a six-million
// invoice for one unit. `hostile-witness.test.ts` now pins the read count for
// the five circuits that open the terms, by running them behind a prover that
// counts. This script covers what those tests cannot: every witness, in every
// exported circuit, including the ones no test drives yet and the ones somebody
// adds next year.
//
// It reads the Compact source rather than the compiled output, because the
// property is about the source a person edits. Comments are stripped and witness
// declarations dropped before counting, or the prose explaining this rule and
// the `witness invoiceTerms(): InvoiceTerms;` line would both count as calls --
// which is exactly what a first, sloppier version of this check did, and it
// reported two false positives with total confidence.
//
//   npm run check:witness-reads --workspace @quietbooks/contract

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src', 'quietbooks.compact');

/** Every witness the contract declares, read from the declarations themselves. */
const declaredWitnesses = (text) =>
  [...text.matchAll(/^\s*witness\s+(\w+)\s*\(/gm)].map((m) => m[1]);

/** Source with comments and witness declarations removed. */
const strip = (text) =>
  text
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .filter((line) => !/^\s*witness\s+\w+\s*\(/.test(line))
    .join('\n');

/**
 * Circuit bodies, brace-matched.
 *
 * Splitting on `circuit` and taking everything up to the next one is the
 * tempting shortcut and it is wrong: the tail of the last circuit in a section
 * swallows the ledger and witness declarations that follow it.
 */
const circuitBodies = (code) => {
  const bodies = new Map();
  for (const match of code.matchAll(/(?:export\s+)?circuit\s+(\w+)[^{;]*\{/g)) {
    const open = code.indexOf('{', match.index);
    let depth = 0;
    let i = open;
    for (; i < code.length; i += 1) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.set(match[1], code.slice(open, i + 1));
  }
  return bodies;
};

const calls = (body, name) =>
  [...body.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))].length;

/**
 * How many times `circuit` reads each witness, counting through the helper
 * circuits it calls.
 *
 * A helper called twice contributes its own reads twice, which is the case that
 * matters: two call sites of a one-read helper is still two reads of one
 * witness, and that is just as exploitable as reading it twice inline.
 */
const witnessReads = (name, bodies, witnesses, seen = new Set(), depth = 0) => {
  if (seen.has(name) || !bodies.has(name) || depth > 8) return {};
  const body = bodies.get(name);
  const next = new Set(seen).add(name);
  const totals = {};

  for (const witness of witnesses) {
    const n = calls(body, witness);
    if (n > 0) totals[witness] = (totals[witness] ?? 0) + n;
  }

  const callees = new Set([...body.matchAll(/\b(\w+)\s*\(/g)].map((m) => m[1]));
  for (const callee of callees) {
    if (callee === name || !bodies.has(callee) || witnesses.includes(callee)) continue;
    const times = calls(body, callee);
    for (const [witness, count] of Object.entries(
      witnessReads(callee, bodies, witnesses, next, depth + 1),
    )) {
      totals[witness] = (totals[witness] ?? 0) + count * times;
    }
  }
  return totals;
};

const text = readFileSync(SOURCE, 'utf8');
const witnesses = declaredWitnesses(text);
if (witnesses.length === 0) {
  console.error('found no witness declarations - has the contract moved?');
  process.exit(2);
}

const code = strip(text);
const bodies = circuitBodies(code);
const exported = [...code.matchAll(/export\s+circuit\s+(\w+)/g)].map((m) => m[1]);

const offenders = [];
for (const name of exported) {
  const totals = witnessReads(name, bodies, witnesses);
  const repeated = Object.entries(totals).filter(([, count]) => count > 1);
  if (repeated.length > 0) offenders.push([name, repeated]);
}

console.log(
  `${exported.length} exported circuits, ${witnesses.length} witnesses: ` +
    `${witnesses.join(', ')}`,
);

if (offenders.length === 0) {
  console.log('No exported circuit reads any witness more than once.');
  process.exit(0);
}

console.error('\nA circuit reads a witness more than once:\n');
for (const [name, repeated] of offenders) {
  for (const [witness, count] of repeated) {
    console.error(`  ${name} reads ${witness}() ${count} times`);
  }
}
console.error(
  '\nEach call to a witness is an independent value the prover chooses, so two\n' +
    'reads are two unrelated values. Read it once and thread the result through.',
);
process.exit(1);
