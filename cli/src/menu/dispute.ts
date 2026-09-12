// Menu: disputes .. open and resolve.
//
// SPDX-License-Identifier: Apache-2.0

import { toHex } from '@quietbooks/contract';

import type { AppContext } from '../context.js';
import { heading, keyOrNone, out } from '../format.js';
import { selectInvoice } from '../select.js';

const openDispute = async (context: AppContext): Promise<void> => {
  out(heading('Open a dispute'));
  out('  Either party to an invoice can open one. It is recorded against the opener\'s');
  out('  reliability counters whatever the outcome, so it is not a free move.');
  out('');

  const view = await selectInvoice(context, '  Dispute which invoice?');
  if (view === undefined) {
    return;
  }
  if (view.role === 'observer') {
    out('  This wallet is not a party to that invoice, so the contract will refuse.');
    if (!(await context.ask.yesNo('  Send the call anyway?', false))) {
      return;
    }
  }

  out(`  Arbiter on this invoice: ${keyOrNone(toHex(view.anchor.arbiterKey))}`);
  if (!(await context.ask.yesNo('  Open the dispute?', false))) {
    out('  Nothing was sent.');
    return;
  }

  await context.api.openDispute(view.invoiceId);
  out(`  Dispute opened on ${view.invoiceId}.`);
};

const resolveDispute = async (context: AppContext): Promise<void> => {
  out(heading('Resolve a dispute'));
  out('  Only the arbiter named on the invoice can do this, and the decision pays out');
  out('  whatever is sitting in escrow.');
  out('');

  const view = await selectInvoice(context, '  Resolve which invoice?');
  if (view === undefined) {
    return;
  }
  if (view.role !== 'arbiter') {
    out(`  This wallet is the ${view.role} on that invoice, not the arbiter.`);
    if (!(await context.ask.yesNo('  Send the call anyway?', false))) {
      out('  Nothing was sent.');
      return;
    }
  }

  const winner = await context.ask.choice('  Decide in favour of', ['seller', 'buyer']);
  const forSeller = winner === 'seller';
  const payout = await context.ask.hex32(
    `  ${forSeller ? 'Seller' : 'Buyer'}'s Zswap coin public key (64 hex)`,
  );
  if (payout === undefined) {
    return;
  }

  out(`  This pays the escrowed balance to the ${winner} and cannot be undone.`);
  if (!(await context.ask.confirmExactly('  Resolve the dispute?', 'resolve'))) {
    out('  Nothing was sent.');
    return;
  }

  await context.api.resolveDispute(view.invoiceId, forSeller, payout);
  out(`  Dispute on ${view.invoiceId} resolved in favour of the ${winner}.`);
};

const DISPUTE_MENU = `
  Disputes
    1. Open a dispute
    2. Resolve a dispute (arbiter)
    0. Back`;

export const disputeMenu = async (context: AppContext): Promise<void> => {
  const choice = await context.ask.menu(DISPUTE_MENU, ['1', '2', '0']);
  switch (choice) {
    case '1':
      return openDispute(context);
    case '2':
      return resolveDispute(context);
    default:
      return;
  }
};
