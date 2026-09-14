// Menu: list, issue, show, export and import invoices.
//
// SPDX-License-Identifier: Apache-2.0

import { encodeCoinPublicKey } from '@midnight-ntwrk/compact-runtime';

import {
  DisputeOutcome,
  settlementLabel,
  statusLabel,
  type InvoiceView,
  type StoredInvoice,
} from '@quietbooks/api';
import {
  daysFromNow,
  lineItemsTotal,
  nowSeconds,
  scopeNames,
  toHex,
  type InvoiceDraft,
  type LineItem,
} from '@quietbooks/contract';

import type { AppContext } from '../context.js';
import {
  currencyOf,
  formatTimestamp,
  heading,
  keyOrNone,
  money,
  out,
  renderFields,
  renderTable,
} from '../format.js';
import { loadState, renderInvoiceTable, selectInvoice } from '../select.js';

// ---------------------------------------------------------------------------
// 1. List
// ---------------------------------------------------------------------------

export const listInvoices = async (context: AppContext): Promise<void> => {
  const state = await loadState(context);
  out(heading('Invoices'));
  if (state.invoices.length === 0) {
    out('  Nothing has been issued on this contract yet.');
  } else {
    out(renderInvoiceTable(state));
  }
  out('');
  out(
    renderFields([
      ['Issued', state.issuedCount.toString()],
      ['Settled', state.settledCount.toString()],
      ['Cancelled', state.cancelledCount.toString()],
      ['Disputed', state.disputedCount.toString()],
      ['Contract', state.paused ? 'paused by the administrator' : 'accepting calls'],
    ]),
  );
};

// ---------------------------------------------------------------------------
// 2. Issue
// ---------------------------------------------------------------------------

const collectLineItems = async (context: AppContext, currency: string): Promise<LineItem[]> => {
  out('  Line items. Quantities and prices are whole numbers in the smallest unit');
  out(`  of ${currency}. Leave a description blank to finish the list.`);
  const items: LineItem[] = [];

  for (;;) {
    const description = await context.ask.optional(`  Line ${items.length + 1} description`);
    if (description.length === 0) {
      if (items.length === 0) {
        out('    (an invoice needs at least one line)');
        continue;
      }
      return items;
    }
    const quantity = await context.ask.bigint(`  Line ${items.length + 1} quantity`, { min: 1n });
    const unitPrice = await context.ask.bigint(`  Line ${items.length + 1} unit price`, { min: 1n });
    items.push({ description, quantity, unitPrice });
    out(`    line total ${money(quantity * unitPrice, currency)}`);
  }
};

export const issueInvoice = async (context: AppContext): Promise<void> => {
  out(heading('Issue an invoice'));

  const currency = (await context.ask.line('  Currency code', { fallback: 'USD' }))
    .trim()
    .toUpperCase();
  // Measured in bytes, not characters: the code is padded into a Bytes<32> and a
  // non-ASCII code can exceed that well before it reaches 32 characters.
  if (new TextEncoder().encode(currency).length > 32) {
    out('  A currency code has to fit in 32 bytes. Nothing was issued.');
    return;
  }

  const lineItems = await collectLineItems(context, currency);
  const subtotal = lineItemsTotal(lineItems);
  out(`  Subtotal: ${money(subtotal, currency)}`);

  // The contract refuses tax above the subtotal, so the ceiling is applied at
  // the prompt: a rejected proof five steps later teaches the operator nothing.
  const taxAmount = await context.ask.bigint('  Tax on top of the subtotal', {
    min: 0n,
    max: subtotal,
    fallback: 0n,
  });

  const memo = await context.ask.optional('  Memo (optional, hashed .. never published)');
  const orderRef = await context.ask.optional('  Order reference (optional, hashed)');
  const dueDays = await context.ask.days('  Due in how many days?', 30);

  const buyerKey = await context.ask.hex32('  Buyer party key (64 hex)');
  if (buyerKey === undefined) {
    return;
  }
  const arbiterKey = await context.ask.hex32('  Arbiter party key (64 hex)', { optional: true });

  const dueDate = daysFromNow(dueDays);
  const total = subtotal + taxAmount;

  out('');
  out(
    renderTable(
      ['Description', 'Qty', 'Unit', 'Line total'],
      lineItems.map((item) => [
        item.description,
        item.quantity.toString(),
        item.unitPrice.toString(),
        money(item.quantity * item.unitPrice, currency),
      ]),
      ['left', 'right', 'right', 'right'],
    ),
  );
  out('');
  out(
    renderFields([
      ['Subtotal', money(subtotal, currency)],
      ['Tax', money(taxAmount, currency)],
      ['Total payable', money(total, currency)],
      ['Due', formatTimestamp(dueDate)],
      ['Buyer', toHex(buyerKey)],
      ['Arbiter', arbiterKey === undefined ? 'none' : toHex(arbiterKey)],
      ['Memo', memo.length === 0 ? 'none' : memo],
      ['Order reference', orderRef.length === 0 ? 'none' : orderRef],
    ]),
  );
  out('');
  out('  Only commitments to these figures go on chain. The figures themselves stay');
  out('  in this wallet until you export the record to the buyer.');

  if (!(await context.ask.yesNo('  Issue this invoice?', false))) {
    out('  Nothing was issued.');
    return;
  }

  // Where each side gets paid. Not the party keys above: a party key is a hash
  // and nothing can be paid to it. The seller's is this wallet's own; the
  // buyer's has to come from them, and is only needed if an arbiter might rule
  // in their favour.
  const sellerPayout = encodeCoinPublicKey(context.wallet.getCoinPublicKey());
  out('');
  out(`  Paying you at ${toHex(sellerPayout)}.`);
  const buyerPayoutTyped = await context.ask.line(
    arbiterKey === undefined
      ? "  Buyer's coin public key (blank: no arbiter, so nothing can pay them)"
      : "  Buyer's coin public key (required, this invoice has an arbiter)",
    { allowEmpty: arbiterKey === undefined },
  );
  let buyerPayout: Uint8Array | undefined;
  if (buyerPayoutTyped !== undefined && buyerPayoutTyped.trim().length > 0) {
    try {
      buyerPayout = encodeCoinPublicKey(buyerPayoutTyped.trim());
    } catch {
      out('  That is not a coin public key. Nothing was issued.');
      return;
    }
  }

  // The contract refuses both of these at issuance, and both are easy to do
  // without noticing. `resolveDispute` pays the address the terms name for
  // whichever side wins, so an invoice with an arbiter and no buyer address
  // burns the escrow on a ruling for the buyer, and one carrying this wallet's
  // key for both sides pays the seller either way. The arbiter would be unable
  // to rule against the party who named them.
  if (arbiterKey !== undefined && buyerPayout === undefined) {
    out('  An invoice with an arbiter needs the buyer’s payout key: without one');
    out('  a ruling in their favour has nowhere to send the money. Nothing was issued.');
    return;
  }
  if (buyerPayout !== undefined && toHex(buyerPayout) === toHex(sellerPayout)) {
    out('  That is this wallet’s own payout key. The buyer’s has to be theirs, or');
    out('  a ruling in their favour would pay you. Nothing was issued.');
    return;
  }

  const draft: InvoiceDraft = {
    currency,
    lineItems,
    taxAmount,
    memo,
    orderRef,
    dueDate,
    sellerPayout,
    buyerPayout,
  };
  out('  Proving and submitting. This takes a while on a local proof server.');

  const { invoiceId } = await context.api.issueInvoice(
    draft,
    buyerKey,
    arbiterKey === undefined ? {} : { arbiterKey },
  );

  out('');
  out(`  Issued. Invoice id: ${invoiceId}`);
  out('  The buyer cannot settle it until they hold the record: export it (menu 4)');
  out('  and send them the JSON.');
};

// ---------------------------------------------------------------------------
// 3. Show
// ---------------------------------------------------------------------------

const termsFields = (stored: StoredInvoice): (readonly [string, string])[] => {
  const currency = currencyOf(stored.terms.currency);
  return [
    ['Currency', currency],
    ['Amount', money(stored.terms.amount, currency)],
    ['Tax', money(stored.terms.taxAmount, currency)],
    ['Total payable', money(stored.terms.amount + stored.terms.taxAmount, currency)],
    ['Line items digest', toHex(stored.terms.itemsHash)],
    ['Memo digest', keyOrNone(toHex(stored.terms.memoHash))],
    ['Order ref digest', keyOrNone(toHex(stored.terms.orderRef))],
    ['Terms salt', toHex(stored.termsSalt)],
    ['Invoice nonce', toHex(stored.nonce)],
    ['Held as', stored.role],
  ];
};

export const showInvoice = async (context: AppContext): Promise<void> => {
  const view = await selectInvoice(context, '  Show which invoice?');
  if (view === undefined) {
    return;
  }
  printInvoice(view);
};

export const printInvoice = (view: InvoiceView): void => {
  const anchor = view.anchor;

  out(heading(`Invoice ${view.invoiceId}`));
  out(
    renderFields([
      ['Status', statusLabel(anchor.status) + (view.overdue ? '  (past its due date)' : '')],
      ['Your role', view.role],
      ['Issued', formatTimestamp(anchor.issuedAt)],
      ['Due', formatTimestamp(anchor.dueDate)],
      ['Settled', formatTimestamp(anchor.settledAt)],
      ['Escrow deadline', formatTimestamp(anchor.escrowDeadline)],
      ['Rules version', anchor.rulesVersion.toString()],
    ]),
  );

  out('\n  Anchor (public, on chain)');
  out(
    renderFields(
      [
        ['Terms commitment', toHex(anchor.terms)],
        ['Field root', toHex(anchor.fieldRoot)],
        ['Seller key', toHex(anchor.sellerKey)],
        ['Buyer key', toHex(anchor.buyerKey)],
        ['Arbiter key', keyOrNone(toHex(anchor.arbiterKey))],
      ],
      4,
    ),
  );

  out('\n  Terms (private, this wallet only)');
  if (view.stored === undefined) {
    out('    This wallet holds no opening for these terms, so the amount, currency and');
    out('    references cannot be read. That is what the chain looks like to everyone');
    out('    who is not a party to the invoice.');
  } else {
    out(renderFields(termsFields(view.stored), 4));
    out('    Line-item text is not stored here .. only its digest. The text travels in');
    out('    the audit envelope, to auditors granted the items field.');
  }

  out('\n  Settlement');
  if (view.settlement === undefined) {
    out('    Not settled.');
  } else {
    out(
      renderFields(
        [
          ['Mode', settlementLabel(view.settlement.mode)],
          ['Note / coin commitment', toHex(view.settlement.note)],
          ['Receipt commitment', toHex(view.settlement.receipt)],
          ['Settled at', formatTimestamp(view.settlement.settledAt)],
          ['On time', view.settlement.onTime ? 'yes' : 'no'],
        ],
        4,
      ),
    );
  }

  out('\n  Audit grant');
  if (view.auditGrant === undefined) {
    out('    No auditor has been authorised for this invoice.');
  } else {
    const grant = view.auditGrant;
    const names = scopeNames(grant.scopes);
    const now = nowSeconds();
    out(
      renderFields(
        [
          ['Audit key hash', toHex(grant.auditKeyHash)],
          ['Fields', names.length === 0 ? 'none' : names.join(', ')],
          ['Granted', formatTimestamp(grant.grantedAt)],
          ['Expires', formatTimestamp(grant.expiresAt)],
          [
            'State',
            grant.revoked ? 'revoked' : now >= grant.expiresAt ? 'expired' : 'in force',
          ],
        ],
        4,
      ),
    );
  }

  out('\n  Dispute');
  out(view.dispute === undefined ? '    None.' : `    ${disputeLabel(view.dispute)}.`);
};

/** The enum reads as a number otherwise, which tells an operator nothing. */
const disputeLabel = (outcome: DisputeOutcome): string => {
  switch (outcome) {
    case DisputeOutcome.forSeller:
      return 'Resolved in favour of the seller';
    case DisputeOutcome.forBuyer:
      return 'Resolved in favour of the buyer';
    case DisputeOutcome.undecided:
      return 'Open, awaiting the arbiter';
    default:
      return 'Unknown outcome';
  }
};

// ---------------------------------------------------------------------------
// 4. Export
// ---------------------------------------------------------------------------

export const exportInvoice = async (context: AppContext): Promise<void> => {
  const view = await selectInvoice(context, '  Export which invoice?');
  if (view === undefined) {
    return;
  }

  const payload = await context.api.exportInvoice(view.invoiceId);

  out(heading(`Invoice record ${view.invoiceId}`));
  out(payload);
  out('');
  out('  Send this to the counterparty over a channel you already trust with your');
  out('  commercial terms. It carries the openings behind the on-chain commitments:');
  out('  without it they cannot settle the invoice, and no auditor can check it.');
  out('  It is not a secret the chain protects .. anyone you send it to can read the');
  out('  amount.');
};

// ---------------------------------------------------------------------------
// 5. Import
// ---------------------------------------------------------------------------

export const importInvoice = async (context: AppContext): Promise<void> => {
  out(heading('Import an invoice record'));
  const payload = await context.ask.jsonBlock('  Paste the JSON the counterparty exported.');
  if (payload === undefined) {
    out('  Nothing was imported.');
    return;
  }

  const role = (await context.ask.choice(
    '  Your role in this invoice',
    ['buyer', 'seller', 'arbiter'],
  )) as StoredInvoice['role'];

  const stored = await context.api.importInvoice(payload, role);
  const currency = currencyOf(stored.terms.currency);

  out('');
  out(`  Imported invoice ${stored.invoiceId}`);
  out(
    renderFields([
      ['Total payable', money(stored.terms.amount + stored.terms.taxAmount, currency)],
      ['Due', formatTimestamp(stored.dueDate)],
      ['Seller key', stored.sellerKey],
      ['Buyer key', stored.buyerKey],
      ['Held as', stored.role],
    ]),
  );
  out('');
  out('  The record is stored, not verified against the chain by this step. Open the');
  out('  invoice (menu 3) to see the anchor it belongs to.');
};
