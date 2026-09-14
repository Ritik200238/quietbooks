// Menu: escrow .. fund, release, refund.
//
// SPDX-License-Identifier: Apache-2.0
//
// Escrow is the one mode in this product that publishes an amount. The circuit
// hands the coin to `receiveShielded`, which requires the coin to be disclosed,
// and the vault entry keeps the value readable for as long as it is held. That
// is a platform constraint, not an oversight, and an operator must not be able
// to reach `fundEscrow` without having been told.

import { coinPublicKeyBytes } from '@quietbooks/api';
import { daysFromNow, randomBytes32, toHex } from '@quietbooks/contract';

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
  if (view.stored === undefined) {
    out('  This wallet cannot open that invoice, so it cannot know which token to lock.');
    out('  Ask the seller to share its record first.');
    return;
  }

  if (view.payable === undefined) {
    out('  This wallet cannot open that invoice, so it cannot know what to lock.');
    return;
  }

  // The amount is not asked for, for the same reason the token is not: the
  // circuit asserts the coin equals the invoiced total, so every answer but one
  // was a minute of proving followed by a refusal, and the one right answer was
  // already in the record. The comment below this used to give exactly that
  // reasoning for the token and stop short of applying it here.
  const value = view.payable;
  out(`  Locking ${groupDigits(value)}, the invoice total.`);

  const deadlineDays = await context.ask.days('  Escrow deadline in how many days?', 14);
  const deadline = daysFromNow(deadlineDays);

  // The nonce is generated rather than asked for: it identifies this particular
  // coin, and reusing one would name a coin the ledger already knows about.
  //
  // The token is not asked for either. An escrow has to hold the token its
  // invoice is payable in, because releasing it settles that invoice and the
  // circuit refuses anything else, so a prompt would only offer a way to be
  // refused.
  const coin = { nonce: randomBytes32(), color: view.stored.terms.tokenType, value };

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

  if (view.stored === undefined) {
    out('  This wallet cannot open that invoice, so it cannot know who to pay.');
    out('  Ask the seller to share its record first.');
    return;
  }

  // Not asked for. The seller's address is inside the terms commitment and the
  // circuit refuses a release addressed anywhere else, so a prompt here offered
  // one right answer -- already sitting in the record this wallet holds -- and
  // an unbounded number of ways to spend a minute proving a transaction the
  // contract would reject.
  const payout = view.stored.terms.sellerPayout;
  out(`  Paying the seller at ${toHex(payout)}, the address on the invoice.`);

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

  // Asked for here, and only here. A refund is the buyer's own money going back
  // to the buyer, and the caller has already proven they are the buyer, so the
  // contract leaves the address free -- binding it would mean an invoice issued
  // without a buyer address could never be refunded, which turns a deadline into
  // a trap. Blank takes this wallet's own key, which is what almost everyone
  // wants and what removes the transcription error.
  const own = coinPublicKeyBytes(context.wallet.getCoinPublicKey());
  const typed = await context.ask.line(
    `  Where to refund (blank for this wallet, ${toHex(own).slice(0, 12)}...)`,
    { allowEmpty: true },
  );
  let payout: Uint8Array;
  if (typed === undefined || typed.trim().length === 0) {
    payout = own;
  } else {
    try {
      payout = coinPublicKeyBytes(typed.trim());
    } catch {
      out('  That is not a coin public key. Nothing was sent.');
      return;
    }
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
