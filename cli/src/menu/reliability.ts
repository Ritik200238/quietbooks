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
      ['Cancelled', counters.cancelled.toString()],
      ['Disputes opened', counters.disputesOpened.toString()],
      ['Disputes lost', counters.disputesLost.toString()],
    ]),
  );
  out('');
  out('  They are counts, never amounts, and they carry no link back to any');
  out('  individual invoice. Anyone can read them for any party key.');
  out('');
  out('  A circuit that proves a threshold over these -- "at least N settled, at');
  out('  least M on time" -- without disclosing the counts is Wave 2 work. Every');
  out('  entry point costs a verifier key in the deploy transaction, and a deploy');
  out('  has to fit inside one block. The record is being kept now so that proof');
  out('  has something to run against.');
};
