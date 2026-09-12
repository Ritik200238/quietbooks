// Confirmation for anything that cannot be taken back.
//
// SPDX-License-Identifier: Apache-2.0
//
// Two kinds of action get one of these: irreversible ones (cancelling an invoice,
// settling, resolving a dispute) and the one action that makes a private number
// public (funding escrow). The second kind also requires the acknowledgement to
// be ticked, because "I did not realise it would do that" is exactly the failure
// mode worth spending a click on.

import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';

type ConfirmDialogProps = {
  readonly title: string;
  readonly confirmLabel: string;
  readonly tone?: 'normal' | 'danger';
  /** When set, the confirm button stays disabled until this is ticked. */
  readonly acknowledgement?: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly children: ReactNode;
};

export const ConfirmDialog = ({
  title,
  confirmLabel,
  tone = 'normal',
  acknowledgement,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps): JSX.Element => {
  const [acknowledged, setAcknowledged] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  // Focus lands on Cancel, not Confirm: an accidental Enter should do nothing.
  useEffect(() => {
    cancelButton.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCancel();
        return;
      }
      if (event.key !== 'Tab' || dialog.current === null) {
        return;
      }
      // Keep Tab inside the dialog: behind it is a form the user has already
      // filled in, and tabbing into it while a confirmation is open is how
      // people lose their place.
      const focusable = dialog.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), a[href], select, textarea',
      );
      if (focusable.length === 0) {
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const onScrimClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) {
        onCancel();
      }
    },
    [onCancel],
  );

  const blocked = acknowledgement !== undefined && !acknowledged;

  return (
    <div className="scrim" onMouseDown={onScrimClick}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={dialog}>
        <div className="dialog-head">
          <h2>{title}</h2>
        </div>
        <div className="dialog-body">
          {children}
          {acknowledgement !== undefined && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span className="checkbox-text">{acknowledgement}</span>
            </label>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="button" onClick={onCancel} ref={cancelButton}>
            Cancel
          </button>
          <button
            type="button"
            className={tone === 'danger' ? 'button button-danger' : 'button button-primary'}
            disabled={blocked}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
