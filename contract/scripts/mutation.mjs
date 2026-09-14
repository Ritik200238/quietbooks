// Mutation testing for the QuietBooks contract.
//
// SPDX-License-Identifier: Apache-2.0
//
// A passing test suite tells you the tests pass. It does not tell you they
// would have failed. This script answers the second question the only way it
// can be answered: it reverts each security fix in `src/quietbooks.compact` one
// at a time, recompiles, runs the tests that are supposed to be guarding it, and
// reports whether they actually went red.
//
// Two of the findings in this repository came from running it. The suite once
// stayed entirely green with the double witness read in `settleWithNote` put
// back -- the hole that lets a buyer settle a six-million invoice for one unit.
// `test/hostile-witness.test.ts` exists because of that result.
//
// Why it is fast enough to be worth running: `compact compile --skip-zk` emits a
// `build/contract/index.js` that is byte-identical to the one a full compile
// produces (the difference is the proving and verifying keys, which the
// in-process tests never touch). A mutant therefore costs about eight seconds of
// compilation instead of four minutes, and the whole sweep runs in a few.
//
//   npm run test:mutation              every mutant
//   npm run test:mutation -- escrow    only those whose name contains "escrow"
//
// Requires the Compact toolchain on PATH. On Windows that means WSL, so the
// compile is shelled through `wsl.exe`; see COMPILE below.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'src', 'quietbooks.compact');
const BUILT = join(ROOT, 'build', 'contract', 'index.js');

// ---------------------------------------------------------------------------
// The mutants
// ---------------------------------------------------------------------------
//
// Each one reverts a real fix to the state it was in when the bug was live, and
// names the test files that should notice. `find` must appear exactly once in
// the source, so a mutant whose target has been edited fails loudly as
// "pattern not found" rather than quietly testing nothing.

const MUTANTS = [
  {
    name: 'settle: drop the seller-payout binding',
    files: ['test/lifecycle.test.ts'],
    find: `  assert(disclose(sellerPayout).bytes == terms.sellerPayout,
         "quietbooks: payment is not addressed to the seller on this invoice");\n`,
    replace: '',
  },
  {
    name: 'settle: accept any payment value',
    files: ['test/lifecycle.test.ts'],
    find: `  assert(coin.value == terms.amount + terms.taxAmount,
         "quietbooks: payment does not equal the invoice total");`,
    replace: `  assert(coin.value > 0,
         "quietbooks: payment does not equal the invoice total");`,
  },
  {
    name: 'settle: take punctuality from the caller again',
    files: ['test/lifecycle.test.ts'],
    find: `  const n = disclose(commitPaidCoin(coin));
  const onTime = onTimeNow(anchor.dueDate);`,
    replace: `  const n = disclose(commitPaidCoin(coin));
  const onTime = at <= anchor.dueDate;`,
  },
  {
    name: 'attest: take punctuality from the caller again',
    files: ['test/lifecycle.test.ts'],
    find: `  assertHoldsTerms(id, anchor, invoiceTerms());

  const onTime = onTimeNow(anchor.dueDate);`,
    replace: `  assertHoldsTerms(id, anchor, invoiceTerms());

  const onTime = at <= anchor.dueDate;`,
  },
  {
    name: 'settle: read the terms witness twice',
    files: ['test/lifecycle.test.ts', 'test/hostile-witness.test.ts'],
    find: `  const terms = invoiceTerms();
  assertHoldsTerms(id, anchor, terms);

  // The payment has to be the invoiced total`,
    replace: `  assertHoldsTerms(id, anchor, invoiceTerms());
  const terms = invoiceTerms();

  // The payment has to be the invoiced total`,
  },
  {
    name: 'punctuality: move the due-date boundary by one second',
    files: ['test/lifecycle.test.ts', 'test/escrow.test.ts'],
    find: '  return !blockTimeGt(dueDate);',
    replace: '  return !blockTimeGte(dueDate);',
  },
  {
    name: 'escrow: accept any amount',
    files: ['test/escrow.test.ts'],
    find: `  assert(coin.value == terms.amount + terms.taxAmount,
         "quietbooks: escrow must equal the invoice total");`,
    replace: `  assert(coin.value > 0,
         "quietbooks: escrow must equal the invoice total");`,
  },
  {
    name: 'escrow: accept a deadline equal to the block time',
    files: ['test/escrow.test.ts'],
    find: '  assert(blockTimeLt(disclose(deadline)), "quietbooks: escrow deadline must be in the future");',
    replace: '  assert(blockTimeLte(disclose(deadline)), "quietbooks: escrow deadline must be in the future");',
  },
  {
    name: 'release: drop the seller-payout binding',
    files: ['test/escrow.test.ts'],
    find: `  assert(disclose(sellerPayout).bytes == terms.sellerPayout,
         "quietbooks: release is not addressed to the seller on this invoice");\n`,
    replace: '',
  },
  {
    name: 'dispute: unbind the payout from the verdict',
    files: ['test/escrow.test.ts'],
    find: `  assert(disclose(payout).bytes == (decided ? terms.sellerPayout : terms.buyerPayout),
         "quietbooks: payout does not match the party the ruling favours");\n`,
    replace: '',
  },
  {
    name: 'dispute: take the reliability counter from the arbiter again',
    files: ['test/hostile-witness.test.ts'],
    find: '    bumpSettled(anchor.sellerKey, onTime);',
    replace: '    bumpSettled(anchor.sellerKey, at <= anchor.dueDate);',
  },
  {
    name: 'refund: block it while the contract is paused',
    files: ['test/escrow.test.ts'],
    find: `  const id = disclose(invoiceId);

  assert(invoices.member(id), "quietbooks: unknown invoice");
  const anchor = invoices.lookup(id);
  assert(anchor.status == InvoiceStatus.escrowFunded || anchor.status == InvoiceStatus.disputed,`,
    replace: `  assertNotPaused();
  const id = disclose(invoiceId);

  assert(invoices.member(id), "quietbooks: unknown invoice");
  const anchor = invoices.lookup(id);
  assert(anchor.status == InvoiceStatus.escrowFunded || anchor.status == InvoiceStatus.disputed,`,
  },
  {
    name: 'refund: lock an abandoned dispute again',
    files: ['test/escrow.test.ts'],
    find: `  assert(anchor.status == InvoiceStatus.escrowFunded || anchor.status == InvoiceStatus.disputed,
         "quietbooks: invoice has no funded escrow");`,
    replace: `  assert(anchor.status == InvoiceStatus.escrowFunded,
         "quietbooks: invoice has no funded escrow");`,
  },
  {
    name: 'refund: allow a dispute refund on the deadline itself',
    files: ['test/escrow.test.ts'],
    find: '  assert(blockTimeGt(anchor.escrowDeadline), "quietbooks: escrow deadline has not passed");',
    replace: '  assert(blockTimeGte(anchor.escrowDeadline), "quietbooks: escrow deadline has not passed");',
  },
  {
    name: 'grant: compare expiry to the caller own grantedAt',
    files: ['test/audit.test.ts'],
    find: '  assert(blockTimeLt(disclose(expiresAt)), "quietbooks: grant must expire in the future");',
    replace: '  assert(disclose(expiresAt) > disclose(grantedAt), "quietbooks: grant must expire in the future");',
  },
  {
    name: 'grant: accept an expiry equal to the block time',
    files: ['test/audit.test.ts'],
    find: '  assert(blockTimeLt(disclose(expiresAt)), "quietbooks: grant must expire in the future");',
    replace: '  assert(blockTimeLte(disclose(expiresAt)), "quietbooks: grant must expire in the future");',
  },
  {
    name: 'issue: let an invoice name nowhere to pay the seller',
    files: ['test/hostile-witness.test.ts'],
    find: `  assert(frame.terms.sellerPayout != default<Bytes<32>>,
         "quietbooks: seller payout address must be set");\n`,
    replace: '',
  },
  {
    name: 'issue: let an arbiter have no buyer address to pay',
    files: ['test/hostile-witness.test.ts'],
    find: `  assert(arbiterKey == default<Bytes<32>> ||
         (frame.terms.buyerPayout != default<Bytes<32>> &&
          frame.terms.buyerPayout != frame.terms.sellerPayout),
         "quietbooks: an invoice with an arbiter needs a buyer payout address of its own");\n`,
    replace: '',
  },
];

// ---------------------------------------------------------------------------
// Running one mutant
// ---------------------------------------------------------------------------

const run = (command, args) => {
  try {
    return {
      code: 0,
      out: execFileSync(command, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe' }),
    };
  } catch (error) {
    return {
      code: error.status ?? 1,
      out: `${error.stdout ?? ''}${error.stderr ?? ''}`,
    };
  }
};

/**
 * Compile to a scratch directory and copy only `contract/index.js` into place.
 *
 * Compiling straight into `build/` would delete the proving keys, which take
 * four minutes to regenerate and which the end-to-end suite needs. The tests
 * import `../build/contract/index.js` and nothing else from that tree, so this
 * is the smallest thing that can be swapped.
 */
const compile = (outDir) => {
  if (process.platform === 'win32') {
    // The Compact toolchain does not run on native Windows
    // (`getting-started/installation.mdx`), so it lives in WSL. Paths crossing
    // the boundary are translated here rather than by shelling out to
    // `wslpath`, which needs its own argument escaping to survive the trip.
    const toWsl = (p) => `/mnt/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}`;
    return run('wsl.exe', [
      '-d',
      'Ubuntu',
      '--',
      'bash',
      '-lc',
      `cd '${toWsl(ROOT)}' && compact compile --skip-zk src/quietbooks.compact '${toWsl(outDir)}'`,
    ]);
  }
  return run('compact', ['compile', '--skip-zk', 'src/quietbooks.compact', outDir]);
};

/**
 * Read the outcome out of a vitest run.
 *
 * Returns null when the output carries no summary line at all, which means the
 * runner never got as far as running anything. That case has to be
 * distinguishable from a clean pass: treating "no summary" as "nothing failed"
 * reports every mutant as surviving and turns this script into one that always
 * says the tests are worthless.
 */
const failureCount = (output) => {
  const plain = output.replace(/\[[0-9;]*m/g, '');
  const summary = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed/.exec(plain);
  if (summary === null) {
    return null;
  }
  const names = [...plain.matchAll(/(?:FAIL|×)\s+(test\/\S+\s*>\s*.+)$/gm)]
    .map((m) => m[1].replace(/\s+\d+ms$/, '').trim());
  return { failed: summary[1] === undefined ? 0 : Number(summary[1]), names: [...new Set(names)] };
};

/**
 * Vitest, run as a JavaScript file rather than through its bin shim.
 *
 * `npx` is a shell script on Unix and a `.cmd` on Windows, and recent Node
 * refuses to `execFileSync` a `.cmd` without a shell. Resolving the module and
 * handing it to this same Node binary sidesteps both and pins the run to the
 * vitest this workspace installed.
 */
const VITEST = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'));

// ---------------------------------------------------------------------------
// The sweep
// ---------------------------------------------------------------------------

const filter = process.argv.slice(2);
const selected = MUTANTS.filter(
  (m) => filter.length === 0 || filter.some((f) => m.name.includes(f)),
);

if (selected.length === 0) {
  console.error(`no mutant matches ${filter.join(' ')}`);
  process.exit(2);
}

const scratch = mkdtempSync(join(tmpdir(), 'quietbooks-mutation-'));
const original = { source: readFileSync(SOURCE, 'utf8'), built: readFileSync(BUILT) };
const restore = () => {
  writeFileSync(SOURCE, original.source);
  writeFileSync(BUILT, original.built);
};
process.on('exit', restore);
process.on('SIGINT', () => process.exit(130));

console.log(`${selected.length} mutant(s), against the compiled contract\n`);

const results = [];
for (const mutant of selected) {
  const occurrences = original.source.split(mutant.find).length - 1;
  if (occurrences !== 1) {
    results.push({ name: mutant.name, verdict: occurrences === 0 ? 'NOT FOUND' : 'AMBIGUOUS' });
    console.log(`${occurrences === 0 ? 'NOT FOUND' : 'AMBIGUOUS'}  ${mutant.name}`);
    continue;
  }

  writeFileSync(SOURCE, original.source.replace(mutant.find, mutant.replace));
  const outDir = join(scratch, 'out');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const compiled = compile(outDir);
  if (compiled.code !== 0) {
    // A mutant that will not compile proves nothing either way, so it is
    // reported rather than counted.
    results.push({ name: mutant.name, verdict: 'NO COMPILE' });
    console.log(`NO COMPILE  ${mutant.name}\n${compiled.out.trim().slice(-400)}`);
    restore();
    continue;
  }
  cpSync(join(outDir, 'contract', 'index.js'), BUILT);

  const vitest = run(process.execPath, [VITEST, 'run', ...mutant.files]);
  const outcome = failureCount(vitest.out);
  if (outcome === null) {
    results.push({ name: mutant.name, verdict: 'NO RUN' });
    console.log(`NO RUN      ${mutant.name}\n${vitest.out.trim().slice(-400) || '(no output)'}`);
    restore();
    continue;
  }
  const { failed, names } = outcome;
  const verdict = failed > 0 ? 'CAUGHT' : 'SURVIVED';
  results.push({ name: mutant.name, verdict, failed, names });
  console.log(`${verdict.padEnd(10)}  ${mutant.name}${failed > 0 ? `  (${failed} red)` : ''}`);
  for (const test of names.slice(0, 4)) {
    console.log(`              - ${test}`);
  }
  restore();
}

rmSync(scratch, { recursive: true, force: true });

const caught = results.filter((r) => r.verdict === 'CAUGHT').length;
console.log(`\n${caught} of ${results.length} reverted fixes fail a test.`);

const survivors = results.filter((r) => r.verdict !== 'CAUGHT');
if (survivors.length > 0) {
  console.log('\nNot caught:');
  for (const s of survivors) {
    console.log(`  ${s.verdict.padEnd(10)}  ${s.name}`);
  }
  // A survivor is a fix nothing is guarding. That is a finding, so it is an
  // exit code rather than a line of output somebody has to notice.
  process.exit(1);
}
