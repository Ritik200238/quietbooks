// Menu: the reliability counters the contract keeps for this party.
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
      ['Attested only', counters.settledAttested.toString()],
      ['Attested only, on time', counters.settledAttestedOnTime.toString()],
      ['Watched by the chain', (counters.settled - counters.settledAttested).toString()],
      ['Cancelled', counters.cancelled.toString()],
      ['Disputes opened', counters.disputesOpened.toString()],
      ['Disputes lost', counters.disputesLost.toString()],
    ]),
  );
  out('');
  out('  They are counts, never amounts, and they carry no link back to any');
  out('  individual invoice. Anyone can read them for any party key.');
  out('');
  out('  Read the last three lines before the first two. An attested settlement is');
  out('  one the seller recorded for a payment the contract could not see -- a bank');
  out('  transfer, an older block -- and no value moves in that transaction. A');
  out('  seller can therefore issue an invoice to a key nobody holds, attest it');
  out('  paid, and raise their own total for the price of the fees.');
  out('');
  out('  The contract cannot stop that without destroying the case the attested');
  out('  path exists for, so it publishes the split instead: subtract the attested');
  out('  count from the total and what is left is the settlements where the chain');
  out('  itself saw a coin move. Which of the two numbers to trust is the reader\'s');
  out('  judgement, and it was never ours to make for them.');
};
