// One thing you can do to an invoice.
//
// SPDX-License-Identifier: Apache-2.0
//
// Every action on the detail screen has the same anatomy: a name, a sentence
// saying what it will actually do, whatever it needs typed in, and a button that
// either asks for confirmation first or does not. Keeping that in one component
// is what stops "Cancel invoice" from looking like a different kind of button
// from "Release escrow" when they are both irreversible.

import { useState, type ReactNode } from 'react';

import { ConfirmDialog } from './Dialog';
import { ActionFeedback } from './Form';
import type { ActionState } from '../state/useAction';

export type Confirmation = {
  readonly title: string;
  readonly body: ReactNode;
  readonly confirmLabel: string;
  readonly acknowledgement?: string;
  readonly tone?: 'normal' | 'danger';
};

type ActionCardProps<T> = {
  readonly title: string;
  readonly description: ReactNode;
  readonly buttonLabel: string;
  readonly onRun: () => void;
  readonly state: ActionState<T>;
  readonly busy: boolean;
  readonly tone?: 'normal' | 'danger' | 'primary';
  readonly confirm?: Confirmation;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly children?: ReactNode;
  readonly success?: (value: T) => ReactNode;
  /** Shown when the call returns and the card has nothing else to say. */
  readonly successNote?: string;
};

const buttonClass = (tone: ActionCardProps<unknown>['tone']): string => {
  if (tone === 'danger') {
    return 'button button-danger';
  }
  if (tone === 'primary') {
    return 'button button-primary';
  }
  return 'button';
};

export const ActionCard = <T,>({
  title,
  description,
  buttonLabel,
  onRun,
  state,
  busy,
  tone = 'normal',
  confirm,
  disabled = false,
  disabledReason,
  children,
  success,
  successNote = 'Done. The record above has been re-read from the ledger.',
}: ActionCardProps<T>): JSX.Element => {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="panel-body stack">
      <div>
        <h2>{title}</h2>
        <p className="note" style={{ marginTop: 4 }}>
          {description}
        </p>
      </div>

      {children}

      <div className="row-wrap">
        <button
          type="button"
          className={buttonClass(tone)}
          disabled={disabled || busy}
          title={disabled ? disabledReason : undefined}
          onClick={() => (confirm === undefined ? onRun() : setConfirming(true))}
        >
          {buttonLabel}
        </button>
        {disabled && disabledReason !== undefined && (
          <span className="small quiet">{disabledReason}</span>
        )}
        <ActionFeedback
          state={state}
          success={
            success ?? (() => <span style={{ color: 'var(--ok)', fontSize: 13 }}>{successNote}</span>)
          }
        />
      </div>

      {confirming && confirm !== undefined && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.confirmLabel}
          tone={confirm.tone ?? (tone === 'danger' ? 'danger' : 'normal')}
          acknowledgement={confirm.acknowledgement}
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            onRun();
          }}
        >
          {confirm.body}
        </ConfirmDialog>
      )}
    </div>
  );
};
