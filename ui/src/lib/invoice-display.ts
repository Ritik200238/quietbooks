// Turning one invoice into the handful of strings a screen shows.
//
// SPDX-License-Identifier: Apache-2.0

import type { InvoiceView } from '@quietbooks/api';
import { unpadBytes32 } from '@quietbooks/contract';

import { readArchive } from './archive';
import { ASSUMED_DECIMALS, formatAmount } from './format';

export type OpenedInvoice = {
  readonly currency: string;
  readonly decimals: number;
  /** True when the decimal position is this wallet's record, not an assumption. */
  readonly decimalsKnown: boolean;
  readonly amount: bigint;
  readonly tax: bigint;
  readonly payable: bigint;
  readonly formattedPayable: string;
};

/**
 * The commercial terms, when this wallet holds the openings for them.
 *
 * Returns undefined for every invoice the wallet cannot open, which is the
 * normal case for somebody else's invoice and is not an error.
 */
export const openedInvoice = (
  view: InvoiceView,
  contractAddress: string,
): OpenedInvoice | undefined => {
  if (view.stored === undefined || view.payable === undefined) {
    return undefined;
  }
  const archive = readArchive(contractAddress, view.invoiceId);
  const decimals = archive?.decimals ?? ASSUMED_DECIMALS;
  const currency = unpadBytes32(view.stored.terms.currency);

  return {
    currency,
    decimals,
    decimalsKnown: archive !== undefined,
    amount: view.stored.terms.amount,
    tax: view.stored.terms.taxAmount,
    payable: view.payable,
    formattedPayable: formatAmount(view.payable, decimals),
  };
};

/** Why a row's amount column is empty, in words the reader can act on. */
export const LOCKED_AMOUNT_REASON =
  'The terms of this invoice are held by the counterparty. The chain does not carry them, ' +
  'so no amount can be shown here until they share the invoice record.';
