// Menu: settle, attest and cancel.
//
// SPDX-License-Identifier: Apache-2.0

import { sha256, toHex } from '@quietbooks/contract';

import type { AppContext } from '../context.js';
import { heading, out } from '../format.js';
import { confirmRole, selectInvoice } from '../select.js';

// ---------------------------------------------------------------------------
// 6. Settle with a shielded note
// ---------------------------------------------------------------------------

export const settleWithNote = async (context: AppContext): Promise<void> => {
  out(heading('Settle an invoice with a shielded transfer'));
  out('  The buyer pays the seller directly, then binds that payment to the invoice.');
  out('  The amount stays hidden: the chain never learns it.');
  out('');
  out('  Read this before you type a commitment. The circuit calls');
  out('  claimZswapCoinReceive, so the ledger accepts this call only if that exact');
  out('  note commitment is an output of the very transaction carrying the call. This');
  out('  CLI submits the contract call alone .. it does not build the payment output');
  out('  for you. Unless your wallet has put that output into the same transaction,');
  out('  the ledger will refuse this, and it is meant to: the alternative would be a');
  out('  settlement that is only the payer\'s word.');
  out('');

  const view = await selectInvoice(context, '  Settle which invoice?');
  if (view === undefined) {
    return;
  }
  if (!(await confirmRole(context, view, 'buyer', 'settle it'))) {
    out('  Nothing was sent.');
    return;
  }

  const note = await context.ask.hex32('  Note commitment of the payment output (64 hex)');
  if (note === undefined) {
    return;
  }

  out('  Proving and submitting.');
  await context.api.settleWithNote(view.invoiceId, note);
  out(`  Settled ${view.invoiceId} against note ${toHex(note)}.`);
};

// ---------------------------------------------------------------------------
// 7. Attest a settlement
// ---------------------------------------------------------------------------

export const settleAttested = async (context: AppContext): Promise<void> => {
  out(heading('Attest a settlement'));
  out('  For payments made outside Midnight .. a bank transfer, a stablecoin on');
  out('  another chain. The seller states the invoice was paid and anchors a digest');
  out('  of the receipt. This is weaker than a shielded transfer: the chain records');
  out('  the seller\'s word, not the payment.');
  out('');

  const view = await selectInvoice(context, '  Attest which invoice?');
  if (view === undefined) {
    return;
  }
  if (!(await confirmRole(context, view, 'seller', 'attest it'))) {
    out('  Nothing was sent.');
    return;
  }

  const mode = await context.ask.choice(
    '  Supply the receipt digest as',
    ['hex', 'text'],
  );

  let receiptDigest: Uint8Array;
  if (mode === 'hex') {
    const supplied = await context.ask.hex32('  Receipt digest (64 hex)');
    if (supplied === undefined) {
      return;
    }
    receiptDigest = supplied;
  } else {
    // Hashing here rather than asking for a digest keeps a bank reference usable
    // without a separate tool, and the digest is reproducible by anyone later
    // given the same text.
    const text = await context.ask.line('  Receipt reference text');
    receiptDigest = await sha256(text);
    out(`    sha256 = ${toHex(receiptDigest)}`);
  }

  out('  Proving and submitting.');
  await context.api.settleAttested(view.invoiceId, receiptDigest);
  out(`  Attested settlement recorded for ${view.invoiceId}.`);
};

// ---------------------------------------------------------------------------
// 8. Cancel
// ---------------------------------------------------------------------------

export const cancelInvoice = async (context: AppContext): Promise<void> => {
  out(heading('Cancel an invoice'));

  const view = await selectInvoice(context, '  Cancel which invoice?');
  if (view === undefined) {
    return;
  }
  if (!(await confirmRole(context, view, 'seller', 'cancel it'))) {
    out('  Nothing was sent.');
    return;
  }

  out('  Cancelling counts against this wallet\'s reliability record, and cannot be');
  out('  undone.');
  if (!(await context.ask.confirmExactly(`  Cancel invoice ${view.invoiceId}?`, 'cancel'))) {
    out('  Nothing was sent.');
    return;
  }

  await context.api.cancelInvoice(view.invoiceId);
  out(`  Cancelled ${view.invoiceId}.`);
};
