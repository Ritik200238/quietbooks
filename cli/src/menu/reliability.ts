// Menu: reliability counters and the threshold proof.
//
// SPDX-License-Identifier: Apache-2.0

import type { AppContext } from '../context.js';
import { heading, out, renderFields } from '../format.js';
import { loadState } from '../select.js';

export const reliability = async (context: AppContext): Promise<void> => {
  const state = await loadState(context);
  const counters = state.reliability;

  out(heading('Reliability'));
  out('  These counters are maintained by the contract as invoices settle, not by');
  out('  this wallet. That is the difference between a payment record and a claim on');
  out('  a website.');
  out('');
  out(
    renderFields([
      ['Settled', counters.settled.toString()],
      ['Settled on time', counters.settledOnTime.toString()],
      ['Cancelled', counters.cancelled.toString()],
      ['Disputes opened', counters.disputesOpened.toString()],
      ['Disputes lost', counters.disputesLost.toString()],
    ]),
  );
  out('');
  out('  A threshold proof convinces a counterparty that this record clears a bar');
  out('  without opening a single invoice behind it.');

  if (!(await context.ask.yesNo('  Run a threshold proof now?', false))) {
    return;
  }

  const minSettled = await context.ask.bigint('  Minimum invoices settled', {
    min: 0n,
    fallback: counters.settled,
  });
  const minOnTime = await context.ask.bigint('  Minimum settled on time', {
    min: 0n,
    fallback: counters.settledOnTime,
  });
  const maxDisputesLost = await context.ask.bigint('  Maximum disputes lost', {
    min: 0n,
    fallback: counters.disputesLost,
  });

  out('');
  out('  Proving and submitting. The circuit asserts against the ledger\'s own');
  out('  counters, so a threshold this record does not meet fails here rather than');
  out('  producing a proof of something untrue.');

  await context.api.proveReliability({ minSettled, minOnTime, maxDisputesLost });

  out('');
  out('  Proof accepted on chain: this wallet has settled at least');
  out(
    `  ${minSettled.toString()} invoices, ${minOnTime.toString()} of them on time, ` +
      `losing at most ${maxDisputesLost.toString()} disputes.`,
  );
};
