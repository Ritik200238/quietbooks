// Shared types for the QuietBooks API.
//
// SPDX-License-Identifier: Apache-2.0

import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import type { FoundContract } from '@midnight-ntwrk/midnight-js-contracts';
import type {
  Contract,
  Witnesses,
  QuietBooksPrivateState,
  InvoiceAnchor,
  Settlement,
  AuditGrant,
  Reliability,
  StoredInvoice,
} from '@quietbooks/contract';
import { InvoiceStatus, SettlementMode, DisputeOutcome } from '@quietbooks/contract';

/**
 * Key under which the wallet's QuietBooks private state is stored.
 *
 * One wallet holds one QuietBooks state, shared across every deployment it
 * interacts with, because the root secret that derives its identity is the same
 * in all of them. Per-deployment separation comes from `instanceSalt` inside the
 * contract, not from keeping several copies of the state here.
 */
export const quietBooksPrivateStateKey = 'quietBooksPrivateState';
export type PrivateStateId = typeof quietBooksPrivateStateKey;

export type PrivateStates = {
  readonly quietBooksPrivateState: QuietBooksPrivateState;
};

export type QuietBooksContract = Contract<QuietBooksPrivateState, Witnesses<QuietBooksPrivateState>>;

export type QuietBooksCircuitKeys = Exclude<
  keyof QuietBooksContract['impureCircuits'],
  number | symbol
>;

export type QuietBooksProviders = MidnightProviders<
  QuietBooksCircuitKeys,
  PrivateStateId,
  QuietBooksPrivateState
>;

export type DeployedQuietBooksContract = FoundContract<QuietBooksContract>;

// ---------------------------------------------------------------------------
// Derived, view-ready state
// ---------------------------------------------------------------------------

/**
 * One invoice as the interface needs it: the public anchor, whatever settlement
 * and audit records exist, and .. only when this wallet can open it .. the
 * private terms.
 *
 * `terms` being `undefined` is the normal case for an invoice belonging to
 * somebody else. The interface renders those rows as opaque rather than hiding
 * them, because seeing that an invoice exists and cannot be read is exactly what
 * a privacy-preserving ledger should look like from outside.
 */
export type InvoiceView = {
  readonly invoiceId: string;
  readonly anchor: InvoiceAnchor;
  readonly settlement: Settlement | undefined;
  readonly auditGrant: AuditGrant | undefined;
  readonly dispute: DisputeOutcome | undefined;
  readonly stored: StoredInvoice | undefined;
  /** Our role in this invoice, or 'observer' when it is not ours. */
  readonly role: 'seller' | 'buyer' | 'arbiter' | 'observer';
  /** Principal plus tax, when this wallet can open the terms. */
  readonly payable: bigint | undefined;
  /** True once the due date has passed and the invoice is still unsettled. */
  readonly overdue: boolean;
};

export type QuietBooksDerivedState = {
  readonly invoices: readonly InvoiceView[];
  readonly issuedCount: bigint;
  readonly settledCount: bigint;
  readonly cancelledCount: bigint;
  readonly disputedCount: bigint;
  readonly paused: boolean;
  /** This wallet's party key at its current PIN. */
  readonly partyKey: string;
  readonly isAdmin: boolean;
  readonly reliability: Reliability;
};

export { InvoiceStatus, SettlementMode, DisputeOutcome };

/** Human-readable status, used by the interface and the CLI alike. */
export const statusLabel = (status: InvoiceStatus): string => {
  switch (status) {
    case InvoiceStatus.nonexistent:
      return 'Unknown';
    case InvoiceStatus.issued:
      return 'Awaiting payment';
    case InvoiceStatus.settled:
      return 'Settled';
    case InvoiceStatus.cancelled:
      return 'Cancelled';
    case InvoiceStatus.escrowFunded:
      return 'In escrow';
    case InvoiceStatus.disputed:
      return 'Disputed';
    case InvoiceStatus.resolved:
      return 'Resolved';
    case InvoiceStatus.refunded:
      return 'Refunded';
    default:
      return 'Unknown';
  }
};

export const settlementLabel = (mode: SettlementMode): string => {
  switch (mode) {
    case SettlementMode.privateNote:
      return 'Shielded transfer';
    case SettlementMode.attested:
      return 'Attested by seller';
    case SettlementMode.escrow:
      return 'Released from escrow';
    default:
      return 'Not settled';
  }
};
