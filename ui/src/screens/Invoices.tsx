// The invoice list.
//
// SPDX-License-Identifier: Apache-2.0
//
// Every invoice on the deployment appears here, including the ones this wallet
// cannot open. That is deliberate. Hiding other people's rows would make the
// interface look like it knows more than the ledger does; showing them with a
// locked amount column is an honest picture of what a privacy-preserving ledger
// looks like from the outside.

import { useMemo, useState } from 'react';

import { InvoiceStatus, statusLabel, type InvoiceView } from '@quietbooks/api';
import { nowSeconds } from '@quietbooks/contract';

import { ActionCard } from '../components/ActionCard';
import { OverduePill, StatusPill } from '../components/Pills';
import { formatDate, relativeDays, truncateHex } from '../lib/format';
import { LOCKED_AMOUNT_REASON, openedInvoice } from '../lib/invoice-display';
import { routePath } from '../state/router';
import { useConnected, useSession } from '../state/session';
import { useAction } from '../state/useAction';

type RoleFilter = 'all' | 'seller' | 'buyer' | 'arbiter' | 'observer';
type StatusFilter = 'all' | 'open' | 'overdue' | 'settled' | 'escrow' | 'disputed' | 'closed';

const ROLE_OPTIONS: readonly { value: RoleFilter; label: string }[] = [
  { value: 'all', label: 'Every role' },
  { value: 'seller', label: 'We are the seller' },
  { value: 'buyer', label: 'We are the buyer' },
  { value: 'arbiter', label: 'We are the arbiter' },
  { value: 'observer', label: 'Not ours' },
];

const STATUS_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'Every status' },
  { value: 'open', label: 'Awaiting payment' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'escrow', label: 'In escrow' },
  { value: 'disputed', label: 'Disputed' },
  { value: 'settled', label: 'Settled or resolved' },
  { value: 'closed', label: 'Cancelled or refunded' },
];

const matchesStatus = (view: InvoiceView, filter: StatusFilter): boolean => {
  switch (filter) {
    case 'all':
      return true;
    case 'open':
      return view.anchor.status === InvoiceStatus.issued;
    case 'overdue':
      return view.overdue;
    case 'escrow':
      return view.anchor.status === InvoiceStatus.escrowFunded;
    case 'disputed':
      return view.anchor.status === InvoiceStatus.disputed;
    case 'settled':
      return (
        view.anchor.status === InvoiceStatus.settled ||
        view.anchor.status === InvoiceStatus.resolved
      );
    case 'closed':
      return (
        view.anchor.status === InvoiceStatus.cancelled ||
        view.anchor.status === InvoiceStatus.refunded
      );
  }
};

/**
 * The pause switch, for the one wallet that holds the administrator key.
 *
 * It lives at the foot of this screen rather than on a screen of its own,
 * because the pause is a property of the deployment and this is the screen that
 * shows the deployment. `setPaused` is the only administrative circuit the
 * contract has: the role cannot move funds, read terms, or be handed on.
 */
const Administration = ({ paused }: { readonly paused: boolean }): JSX.Element => {
  const { api } = useConnected();
  const { refresh } = useSession();

  const action = useAction(async () => {
    await api.setPaused(!paused);
    await refresh();
  }, 'Building the proof and submitting. This can take a minute.');

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Administration</h2>
        <span className="tag">Admin</span>
      </div>
      <ActionCard
        title={paused ? 'Resume this deployment' : 'Pause this deployment'}
        description={
          paused
            ? 'Let the contract accept state-advancing calls again. Issuing, settling, escrow, disputes and new audit grants all start working the moment this lands.'
            : 'Stop the contract accepting state-advancing calls: issuing, settling, escrow, disputes and new audit grants. Reading records and revoking an audit grant are not affected, so nobody is shut out of their own invoices.'
        }
        buttonLabel={paused ? 'Resume' : 'Pause'}
        tone={paused ? 'primary' : 'danger'}
        state={action.state}
        busy={action.busy}
        successNote="Done. The ledger has been re-read."
        confirm={{
          title: paused ? 'Resume this deployment?' : 'Pause this deployment?',
          confirmLabel: paused ? 'Resume' : 'Pause',
          tone: paused ? 'normal' : 'danger',
          body: paused ? (
            <p>
              Everyone on this deployment can issue, settle, escrow and dispute again as soon as
              this transaction lands.
            </p>
          ) : (
            <>
              <p>
                Every party on this deployment stops where they are: no invoice can be issued,
                paid, escrowed, released or disputed until you resume it.
              </p>
              <p>
                Two calls carry on regardless, and deliberately: a buyer whose escrow deadline
                has passed can still take their own money back, and a seller can still revoke an
                auditor&rsquo;s access. An emergency stop on new business must not trap money
                somebody is already owed, or lock a seller out of withdrawing a disclosure.
              </p>
              <p>You are the only wallet that can lift it.</p>
            </>
          ),
        }}
        onRun={() => void action.run()}
      />
    </div>
  );
};

const LockedAmount = (): JSX.Element => (
  <span className="locked-amount" title={LOCKED_AMOUNT_REASON} tabIndex={0}>
    — — —
    <span className="visually-hidden">{LOCKED_AMOUNT_REASON}</span>
  </span>
);

export const Invoices = (): JSX.Element => {
  const { connection, state, streamError } = useSession();
  const [role, setRole] = useState<RoleFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');

  const contractAddress = connection.status === 'connected' ? connection.contractAddress : '';
  const now = useMemo(() => nowSeconds(), [state]);

  const rows = useMemo(() => {
    if (state === undefined) {
      return [];
    }
    return state.invoices.filter(
      (view) => (role === 'all' || view.role === role) && matchesStatus(view, status),
    );
  }, [state, role, status]);

  if (state === undefined) {
    return (
      <div className="panel">
        <div className="panel-body">
          <span className="working">
            <span className="spinner" aria-hidden="true" />
            Reading the ledger
          </span>
        </div>
      </div>
    );
  }

  const total = state.invoices.length;

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Invoices</h1>
          <p className="note">
            Every invoice on this deployment, newest first. An amount appears only where this
            wallet holds the openings for it.
          </p>
        </div>
        <a className="button button-primary" href={routePath({ name: 'new-invoice' })}>
          New invoice
        </a>
      </div>

      {streamError !== undefined && (
        <div className="callout callout-warn">
          <span className="callout-title">The ledger feed dropped</span>
          What is below was correct when it last arrived. {streamError}
        </div>
      )}

      {total === 0 ? (
        <div className="panel">
          <div className="empty">
            <h2>No invoices on this deployment yet</h2>
            <p>
              Issue one as a seller, or ask a counterparty for the record of an invoice they
              addressed to you. An invoice you were sent shows up here as soon as it is on
              chain, but you cannot pay it until they share the record: the amount and the
              terms never touch the ledger.
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <a className="button button-primary" href={routePath({ name: 'new-invoice' })}>
                Write the first invoice
              </a>
            </div>
          </div>
        </div>
      ) : (
        <div className="panel">
          <div className="panel-head">
            <div className="filters">
              <div className="filter">
                <label htmlFor="filter-role">Role</label>
                <select
                  id="filter-role"
                  value={role}
                  onChange={(event) => setRole(event.target.value as RoleFilter)}
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="filter">
                <label htmlFor="filter-status">Status</label>
                <select
                  id="filter-status"
                  value={status}
                  onChange={(event) => setStatus(event.target.value as StatusFilter)}
                >
                  {STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <span className="result-count">
                {rows.length === total
                  ? `${total} invoice${total === 1 ? '' : 's'}`
                  : `${rows.length} of ${total}`}
              </span>
            </div>
          </div>

          {rows.length === 0 ? (
            <div className="empty">
              <h2>Nothing matches those filters</h2>
              <p>
                None of the {total} invoice{total === 1 ? '' : 's'} on this deployment matches.
                Widen the role or the status and they come back.
              </p>
              <div className="row" style={{ justifyContent: 'center' }}>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setRole('all');
                    setStatus('all');
                  }}
                >
                  Clear the filters
                </button>
              </div>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="ledger">
                <thead>
                  <tr>
                    <th scope="col">Invoice</th>
                    <th scope="col">Status</th>
                    <th scope="col">Our role</th>
                    <th scope="col">Issued</th>
                    <th scope="col">Due</th>
                    <th scope="col" className="figure-column">
                      Amount due
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((view) => {
                    const opened = openedInvoice(view, contractAddress);
                    return (
                      <tr key={view.invoiceId}>
                        <td>
                          <a
                            className="row-link mono"
                            href={routePath({ name: 'invoice', invoiceId: view.invoiceId })}
                          >
                            {truncateHex(view.invoiceId, 10, 6)}
                          </a>
                        </td>
                        <td>
                          <span className="row-wrap" style={{ gap: 6 }}>
                            <StatusPill status={view.anchor.status} />
                            {view.overdue && <OverduePill />}
                          </span>
                        </td>
                        <td>
                          {view.role === 'observer' ? (
                            <span className="quiet">Not ours</span>
                          ) : (
                            <span style={{ textTransform: 'capitalize' }}>{view.role}</span>
                          )}
                        </td>
                        <td className="figure muted nowrap">
                          {formatDate(view.anchor.issuedAt)}
                        </td>
                        <td className="nowrap">
                          <span className="figure">{formatDate(view.anchor.dueDate)}</span>
                          {view.anchor.status === InvoiceStatus.issued && (
                            <span className="small quiet">
                              {' '}
                              {relativeDays(view.anchor.dueDate, now)}
                            </span>
                          )}
                        </td>
                        <td className="figure-column">
                          {opened === undefined ? (
                            <LockedAmount />
                          ) : (
                            <span className="figure nowrap">
                              {opened.formattedPayable}{' '}
                              <span className="quiet">{opened.currency}</span>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="panel-foot">
            <span className="small quiet">
              {state.invoices.filter((view) => view.stored === undefined).length} of {total}{' '}
              {total === 1 ? 'invoice is' : 'invoices are'} sealed to this wallet. Seeing that an
              invoice exists, and not what it says, is what the ledger looks like from outside.
            </span>
          </div>
        </div>
      )}

      <p className="small quiet">
        Status names come from the contract: {statusLabel(InvoiceStatus.issued)},{' '}
        {statusLabel(InvoiceStatus.escrowFunded)}, {statusLabel(InvoiceStatus.settled)},{' '}
        {statusLabel(InvoiceStatus.disputed)}, {statusLabel(InvoiceStatus.resolved)},{' '}
        {statusLabel(InvoiceStatus.cancelled)}, {statusLabel(InvoiceStatus.refunded)}.
      </p>

      {state.isAdmin && <Administration paused={state.paused} />}
    </div>
  );
};
