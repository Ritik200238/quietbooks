// Menu: settle, attest and cancel.
//
// SPDX-License-Identifier: Apache-2.0

import { coinPublicKeyBytes } from '@quietbooks/api';

import { randomBytes32, sha256, toHex } from '@quietbooks/contract';

import type { AppContext } from '../context.js';
import { groupDigits, heading, out } from '../format.js';
import { confirmRole, selectInvoice } from '../select.js';

// ---------------------------------------------------------------------------
// 6. Settle with a shielded note
// ---------------------------------------------------------------------------

export const settleWithNote = async (context: AppContext): Promise<void> => {
  out(heading('Settle an invoice with a shielded transfer'));
  out('  The buyer pays the seller inside the same transaction that records the');
  out('  settlement. The contract takes the coin and forwards it on in one call, so');
  out('  it never holds the money and its balance does not move. Zswap hides the');
  out('  value on both legs: the chain learns that this invoice was paid, not what');
  out('  it was paid.');
  out('');

  const view = await selectInvoice(context, '  Settle which invoice?');
  if (view === undefined) {
    return;
  }
  if (!(await confirmRole(context, view, 'buyer', 'settle it'))) {
    out('  Nothing was sent.');
    return;
  }
  if (view.stored === undefined || view.payable === undefined) {
    out('  This wallet cannot open that invoice, so it cannot know what to pay,');
    out('  or in which token. Ask the seller to share its record first.');
    return;
  }

  // The circuit compares the coin against the terms the caller proves they hold
  // and refuses anything but the exact total, so there is nothing to ask here.
  out(`  Amount to pay: ${groupDigits(view.payable)} (the invoice total, checked by the circuit).`);

  // Nothing is asked here any more.
  //
  // This flow used to prompt for the seller's coin public key, with a blank
  // meaning "pay this wallet" .. which sent the full total back to the buyer and
  // still marked the invoice settled. Both the prompt and the default are gone:
  // the payout address is inside the terms commitment, the circuit refuses a
  // payment addressed anywhere else, so every answer but one produced a failed
  // proof and the one right answer was already sitting in the record.
  const sellerPayout = view.stored.terms.sellerPayout;
  out(`  Paying the address on the invoice: ${toHex(sellerPayout)}`);

  // The seller's encryption key rides along with the record they exported. A
  // shielded output carries a ciphertext built for exactly one encryption key,
  // and the seller's wallet finds the payment by decrypting it. Pay without it
  // and the coin lands where the contract said, belonging to the seller, and no
  // wallet in the world can see it.
  const ours = coinPublicKeyBytes(context.wallet.getCoinPublicKey());
  const payingOurselves = toHex(sellerPayout) === toHex(ours);
  if (view.stored.sellerEncryptionKey === undefined && !payingOurselves) {
    out('');
    out('  The record the seller shared does not carry their encryption key, so');
    out('  their wallet could not find this payment. Ask them to export the');
    out('  invoice again. Nothing was sent.');
    return;
  }

  // The nonce identifies this particular coin. A fresh one every time, because
  // reusing one names a coin the ledger already knows about.
  // The token comes from the invoice, not from a default. The circuit refuses a
  // coin of any other colour, which is what stops an invoice denominated in one
  // thing being settled with the right number of another.
  const coin = { nonce: randomBytes32(), color: view.stored.terms.tokenType, value: view.payable };

  out('');
  out('  Proving and submitting. This builds the payment and the contract call as');
  out('  one transaction, so either both happen or neither does.');
  await context.api.settleWithNote(
    view.invoiceId,
    coin,
    sellerPayout,
    view.stored.sellerEncryptionKey,
  );
  out(`  Settled ${view.invoiceId}.`);
  out(`  Coin nonce (keep it; an auditor needs it to verify the amount): ${toHex(coin.nonce)}`);
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
