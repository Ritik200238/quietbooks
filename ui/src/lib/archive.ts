// What the wallet keeps that the private state does not.
//
// SPDX-License-Identifier: Apache-2.0
//
// The contract's stored record holds the *digests* of the line items, the memo
// and the order reference .. not their text. That is correct for the protocol:
// the chain commits to a fixed 32 bytes however long an invoice is. But an audit
// envelope that discloses the `items` scope has to carry the line items
// themselves, so the auditor can recompute the digest and see that it matches.
//
// So the wallet that issues an invoice keeps the plaintext here, beside the
// private state. Two consequences, both of which the interface states plainly
// rather than hiding:
//
//  * only the browser that issued an invoice can build an envelope disclosing
//    its text fields; and
//  * a buyer who imported a shared record can never build one, which is fine,
//    because only the seller can grant an audit in the first place.
//
// The display decimal position lives here too. The contract has no notion of
// decimal places .. an amount is an integer in the currency's smallest unit ..
// so the position is a property of how one invoice is written, recorded by the
// wallet that wrote it.

import type { LineItem } from '@quietbooks/contract';

const NAMESPACE = 'quietbooks/v1/archive';

export type ArchivedLineItem = {
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
};

/** The plaintext behind one invoice's digests, as this browser wrote it. */
export type InvoiceArchive = {
  readonly currency: string;
  readonly lineItems: readonly ArchivedLineItem[];
  readonly memo: string;
  readonly orderRef: string;
  /** How many decimal places this invoice's amounts are written with. */
  readonly decimals: number;
};

const key = (contractAddress: string, invoiceId: string): string =>
  `${NAMESPACE}/${contractAddress}/${invoiceId}`;

export const readArchive = (
  contractAddress: string,
  invoiceId: string,
): InvoiceArchive | undefined => {
  const raw = window.localStorage.getItem(key(contractAddress, invoiceId));
  if (raw === null) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as InvoiceArchive;
  } catch {
    // A corrupt entry is not worth an error page: the invoice still opens, the
    // text fields simply cannot be disclosed to an auditor. The audit screen
    // says exactly that when it finds nothing here.
    return undefined;
  }
};

export const writeArchive = (
  contractAddress: string,
  invoiceId: string,
  archive: InvoiceArchive,
): void => {
  window.localStorage.setItem(key(contractAddress, invoiceId), JSON.stringify(archive));
};

/** The archived line items in the shape the contract package expects. */
export const archivedLineItems = (archive: InvoiceArchive): LineItem[] =>
  archive.lineItems.map((item) => ({
    description: item.description,
    quantity: BigInt(item.quantity),
    unitPrice: BigInt(item.unitPrice),
  }));

export const toArchivedLineItems = (items: readonly LineItem[]): ArchivedLineItem[] =>
  items.map((item) => ({
    description: item.description,
    quantity: item.quantity.toString(),
    unitPrice: item.unitPrice.toString(),
  }));
