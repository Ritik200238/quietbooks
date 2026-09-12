// Status vocabulary.
//
// SPDX-License-Identifier: Apache-2.0
//
// The labels come from the API's own `statusLabel`, so the interface and the CLI
// call the same state by the same name. Only the colour is decided here, and the
// mapping follows what the state means for money rather than what it means for
// the contract: escrow is amber not because it is a problem but because it is the
// one state in which the amount is public.

import type { ReactNode } from 'react';
import { InvoiceStatus, statusLabel, type InvoiceView } from '@quietbooks/api';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent';

const toneFor = (status: InvoiceStatus): Tone => {
  switch (status) {
    case InvoiceStatus.settled:
    case InvoiceStatus.resolved:
      return 'ok';
    case InvoiceStatus.escrowFunded:
    case InvoiceStatus.refunded:
      return 'warn';
    case InvoiceStatus.disputed:
      return 'danger';
    case InvoiceStatus.issued:
      return 'accent';
    default:
      return 'neutral';
  }
};

const classFor = (tone: Tone): string => (tone === 'neutral' ? 'pill' : `pill pill-${tone}`);

export const StatusPill = ({ status }: { status: InvoiceStatus }): JSX.Element => (
  <span className={classFor(toneFor(status))}>{statusLabel(status)}</span>
);

export const OverduePill = (): JSX.Element => (
  <span className="pill pill-danger" title="The due date has passed and the invoice is unsettled">
    Overdue
  </span>
);

const ROLE_LABEL: Record<InvoiceView['role'], string> = {
  seller: 'We are the seller',
  buyer: 'We are the buyer',
  arbiter: 'We are the arbiter',
  observer: 'Not ours',
};

export const RoleLabel = ({ role }: { role: InvoiceView['role'] }): JSX.Element => (
  <span className={role === 'observer' ? 'quiet' : undefined}>{ROLE_LABEL[role]}</span>
);

export const TonePill = ({
  tone,
  title,
  children,
}: {
  readonly tone: Tone;
  readonly title?: string;
  readonly children: ReactNode;
}): JSX.Element => (
  <span className={classFor(tone)} title={title}>
    {children}
  </span>
);
