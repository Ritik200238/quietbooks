// Menu: escrow .. fund, release, refund.
//
// SPDX-License-Identifier: Apache-2.0
//
// Escrow is the one mode in this product that publishes an amount. The circuit
// hands the coin to `receiveShielded`, which requires the coin to be disclosed,
// and the vault entry keeps the value readable for as long as it is held. That
// is a platform constraint, not an oversight, and an operator must not be able
// to reach `fundEscrow` without having been told.

import { daysFromNow, randomBytes32, toHex, ZERO32 } from '@quietbooks/contract';

import type { AppContext } from '../context.js';
import { formatTimestamp, groupDigits, heading, out, renderFields } from '../format.js';
import { confirmRole, selectInvoice } from '../select.js';

const ESCROW_WARNING = [
  '  WARNING: funding escrow publishes the amount.',
  '',
  '  Every other settlement path in QuietBooks keeps the figure off chain. This one',
  '  cannot: the contract has to take custody of a real coin, and a coin handed to a',
  '  contract is disclosed when it is received. The value then stays readable in the',
  '  escrow vault entry until the escrow is released or refunded, and the record of',
  '  it remains on a public ledger afterwards.',
  '',
  '  Choose this only when a locked balance is worth more to you than a hidden one.',
];

// ---------------------------------------------------------------------------
// Fund
// ---------------------------------------------------------------------------

const fundEscrow = async (context: AppContext): Promise<void> => {
  out(heading('Fund escrow'));
  for (const line of ESCROW_WARNING) {
    out(line);
  }
  out('');

  const view = await selectInvoice(context, '  Fund escrow on which invoice?');
  if (view === undefined) {
    return;
  }
  if (!(await confirmRole(context, view, 'buyer', 'fund escrow'))) {
    out('  Nothing was sent.');
    return;
  }

  const value = await context.ask.bigint('  Amount to lock, in the token\'s smallest unit', {
    min: 1n,
  });
  const color = await context.ask.hex32(
    '  Token colour (64 hex, blank for the native shielded token)',
    { optional: true, allowZero: true },
  );
  const deadlineDays = await context.ask.days('  Escrow deadline in how many days?', 14);
  const deadline = daysFromNow(deadlineDays);

  // The nonce is generated rather than asked for. It identifies this particular
  // coin, so reusing one from an earlier escrow would produce a coin the ledger
  // already knows about and the transaction would be refused.
  const coin = { nonce: randomBytes32(), color: color ?? ZERO32, value };

  out('');
  out(
    renderFields([
      ['Invoice', view.invoiceId],
      ['Amount locked', groupDigits(value)],
      ['Token colour', toHex(coin.color)],
      ['Deadline', formatTimestamp(deadline)],
      ['Visible on chain', 'the amount, the colour and the deadline'],
    ]),
  );
  out('');

  if (!(await context.ask.confirmExactly('  Publish this amount and lock the funds?', 'escrow'))) {
    out('  Nothing was sent. The amount stays private.');
    return;
  }

  out('  Proving and submitting.');
  await context.api.fundEscrow(view.invoiceId, coin, deadline);
  out(`  Escrow funded for ${view.invoiceId}.`);
  out(`  Coin nonce (keep it, it identifies the locked coin): ${toHex(coin.nonce)}`);
};

// ---------------------------------------------------------------------------
// Release and refund
// ---------------------------------------------------------------------------

const releaseEscrow = async (context: AppContext): Promise<void> => {
  out(heading('Release escrow to the seller'));
  out('  The buyer confirms delivery and the contract pays the seller from the vault.');
  out('');

  const view = await selectInvoice(context, '  Release escrow on which invoice?');
  if (view === undefined) {
    return;
  }
  if (!(await confirmRole(context, view, 'buyer', 'release the escrow'))) {
    out('  Nothing was sent.');
    return;
  }

  const payout = await context.ask.hex32('  Seller\'s Zswap coin public key (64 hex)');
  if (payout === undefined) {
    return;
  }

  out('  Proving and submitting.');
  await context.api.releaseEscrow(view.invoiceId, payout);
  out(`  Escrow on ${view.invoiceId} released to ${toHex(payout)}.`);
};

const refundEscrow = async (context: AppContext): Promise<void> => {
  out(heading('Refund escrow to the buyer'));
  out('  Available once the escrow deadline has passed without a release.');
  out('');

  const view = await selectInvoice(context, '  Refund escrow on which invoice?');
  if (view === undefined) {
    return;
  }
  if (!(await confirmRole(context, view, 'buyer', 'take the refund'))) {
    out('  Nothing was sent.');
    return;
  }

  const payout = await context.ask.hex32('  Buyer\'s Zswap coin public key (64 hex)');
  if (payout === undefined) {
    return;
  }

  out('  Proving and submitting.');
  await context.api.refundEscrow(view.invoiceId, payout);
  out(`  Escrow on ${view.invoiceId} refunded to ${toHex(payout)}.`);
};

// ---------------------------------------------------------------------------
// Submenu
// ---------------------------------------------------------------------------

const ESCROW_MENU = `
  Escrow
    1. Fund escrow (publishes the amount)
    2. Release escrow to the seller
    3. Refund escrow to the buyer
    0. Back`;

export const escrowMenu = async (context: AppContext): Promise<void> => {
  const choice = await context.ask.menu(ESCROW_MENU, ['1', '2', '3', '0']);
  switch (choice) {
    case '1':
      return fundEscrow(context);
    case '2':
      return releaseEscrow(context);
    case '3':
      return refundEscrow(context);
    default:
      return;
  }
};
