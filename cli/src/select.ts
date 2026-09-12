// Listing invoices and choosing one.
//
// SPDX-License-Identifier: Apache-2.0
//
// Every action after the first works on an invoice, and an invoice id is 64
// hex characters. Asking an operator to retype one at each prompt would make the
// product unusable in a terminal, so the list is numbered and the number is what
// gets typed. The full id is still printed everywhere it matters, because it is
// what the counterparty will quote back.

import { InvoiceStatus, statusLabel, type InvoiceView, type QuietBooksDerivedState } from '@quietbooks/api';

import type { AppContext } from './context.js';
import { currencyOf, formatDate, money, out, renderTable, shortId, type Alignment } from './format.js';

/** The footnote is only printed when a row actually needed it. */
export const OPAQUE_MARK = '—';

const ALIGNMENTS: readonly Alignment[] = ['right', 'left', 'left', 'left', 'left', 'right'];

export const amountCell = (view: InvoiceView): string => {
  if (view.payable === undefined || view.stored === undefined) {
    return OPAQUE_MARK;
  }
  return money(view.payable, currencyOf(view.stored.terms.currency));
};

const statusCell = (view: InvoiceView): string => {
  const label = statusLabel(view.anchor.status);
  return view.overdue && view.anchor.status === InvoiceStatus.issued ? `${label} (overdue)` : label;
};

/**
 * The invoice table.
 *
 * Invoices this wallet cannot open are listed too. Hiding them would flatter the
 * interface and misrepresent the ledger: an observer genuinely can see that an
 * invoice exists and genuinely cannot read its terms, and that is the product.
 */
export const renderInvoiceTable = (state: QuietBooksDerivedState): string => {
  const rows = state.invoices.map((view, index) => [
    String(index + 1),
    shortId(view.invoiceId),
    statusCell(view),
    view.role,
    formatDate(view.anchor.dueDate),
    amountCell(view),
  ]);

  const table = renderTable(
    ['#', 'Invoice', 'Status', 'Role', 'Due', 'Amount'],
    rows,
    ALIGNMENTS,
  );

  const anyOpaque = state.invoices.some((view) => view.stored === undefined);
  const notes = anyOpaque
    ? [
        '',
        `${OPAQUE_MARK} this wallet holds no opening for that invoice, so its amount stays hidden.`,
        '  Ask the counterparty to export the record and import it here (menu 5).',
      ]
    : [];

  return [table, ...notes].join('\n');
};

export const loadState = (context: AppContext): Promise<QuietBooksDerivedState> =>
  context.api.snapshot();

/**
 * Show the list and let the operator pick a row.
 *
 * Returns undefined when there is nothing to pick, so callers can print their
 * own explanation rather than all repeating the same empty-state message.
 */
export const selectInvoice = async (
  context: AppContext,
  purpose: string,
): Promise<InvoiceView | undefined> => {
  const state = await loadState(context);
  if (state.invoices.length === 0) {
    out('  No invoices exist on this contract yet.');
    return undefined;
  }

  out('');
  out(renderInvoiceTable(state));
  out('');
  const index = await context.ask.index(purpose, state.invoices.length);
  return state.invoices[index];
};

/**
 * Warn when the wallet's role does not match what the operation needs.
 *
 * The contract will refuse the call anyway; this just turns a failed proof and a
 * wasted minute into a question. It warns rather than blocks, because the role
 * shown here is derived from the anchor and an operator may know something the
 * anchor does not .. a second PIN, for instance.
 */
export const confirmRole = async (
  context: AppContext,
  view: InvoiceView,
  required: InvoiceView['role'],
  operation: string,
): Promise<boolean> => {
  if (view.role === required) {
    return true;
  }
  out(`  This wallet is the ${view.role} on that invoice, and only the ${required} can ${operation}.`);
  return context.ask.yesNo('  Send the call anyway?', false);
};
