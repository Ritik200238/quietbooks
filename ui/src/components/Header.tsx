// The persistent header: who we are, what we are connected to, and what the
// ledger says in public.
//
// SPDX-License-Identifier: Apache-2.0
//
// Everything in this bar is already public on chain .. the contract address, the
// four counters, our own party key .. so showing it costs nothing and it answers
// the question people ask first, which is whether this screen is current.

import { useMemo } from 'react';

import { toHex } from '@quietbooks/contract';

import { Digest } from './Copyable';
import { routePath, useRoute, type Route } from '../state/router';
import { useSession } from '../state/session';

const NAV: readonly { readonly route: Route; readonly label: string }[] = [
  { route: { name: 'invoices' }, label: 'Invoices' },
  { route: { name: 'new-invoice' }, label: 'New invoice' },
  { route: { name: 'audit' }, label: 'Audit' },
];

const Connection = (): JSX.Element => {
  const { connection, streamError, refreshing } = useSession();

  if (connection.status === 'connecting') {
    return (
      <span className="connection">
        <span className="connection-dot is-busy" aria-hidden="true" />
        Connecting
      </span>
    );
  }
  if (connection.status === 'failed') {
    return (
      <span className="connection">
        <span className="connection-dot is-down" aria-hidden="true" />
        Not connected
      </span>
    );
  }
  if (connection.status === 'idle') {
    return (
      <span className="connection">
        <span className="connection-dot" aria-hidden="true" />
        Not connected
      </span>
    );
  }
  if (streamError !== undefined) {
    return (
      <span className="connection" title={streamError}>
        <span className="connection-dot is-down" aria-hidden="true" />
        Ledger feed interrupted
      </span>
    );
  }
  return (
    <span className="connection">
      <span className="connection-dot is-live" aria-hidden="true" />
      {refreshing ? 'Reading the ledger' : `Live on ${connection.endpoints.networkId}`}
    </span>
  );
};

export const Header = (): JSX.Element => {
  const { connection, state, refresh, refreshing, disconnect } = useSession();
  const route = useRoute();
  const connected = connection.status === 'connected';

  const reliability = useMemo(() => {
    if (state === undefined) {
      return undefined;
    }
    const { settled, settledOnTime, cancelled, disputesOpened, disputesLost } = state.reliability;
    if (
      settled === 0n &&
      cancelled === 0n &&
      disputesOpened === 0n &&
      disputesLost === 0n
    ) {
      return 'No settlement history yet';
    }
    const parts = [`${settled} settled`, `${settledOnTime} on time`];
    if (cancelled > 0n) {
      parts.push(`${cancelled} cancelled`);
    }
    if (disputesOpened > 0n) {
      parts.push(`${disputesLost} of ${disputesOpened} disputes lost`);
    }
    return parts.join(' · ');
  }, [state]);

  return (
    <header className="header">
      <div className="header-inner">
        <div className="header-top">
          <a href={routePath({ name: 'invoices' })} className="wordmark">
            QuietBooks<span>Private invoicing on Midnight</span>
          </a>

          <div className="header-facts">
            <div className="fact">
              <span className="fact-label">Connection</span>
              <span className="fact-value">
                <Connection />
              </span>
            </div>

            {connected && (
              <div className="fact">
                <span className="fact-label">Contract</span>
                <span className="fact-value">
                  <Digest
                    value={connection.contractAddress}
                    label="the contract address"
                    lead={8}
                    tail={6}
                  />
                </span>
              </div>
            )}

            {state !== undefined && (
              <>
                <div className="fact">
                  <span className="fact-label">Our party key</span>
                  <span className="fact-value">
                    <Digest value={state.partyKey} label="our party key" lead={8} tail={6} />
                  </span>
                </div>

                {connection.status === 'connected' && (
                <div className="fact">
                  <span className="fact-label">Where we get paid</span>
                  <span className="fact-value">
                    <Digest
                      value={toHex(connection.coinPublicKeyBytes)}
                      label="our coin public key"
                      lead={8}
                      tail={6}
                    />
                  </span>
                  {/* A seller issuing an invoice needs the buyer's copy of this,
                      and until now the interface showed a buyer only their party
                      key -- which is a hash, and which nobody can pay. */}
                  <span className="fact-note small quiet">
                    Send this to anyone invoicing you. Not the party key above: that is a hash,
                    and nothing can be paid to it.
                  </span>
                </div>
                )}

                <div className="fact">
                  <span className="fact-label">On chain</span>
                  <span className="fact-value">
                    <span className="counters">
                      <span className="counter">
                        <span className="counter-value">{state.issuedCount.toString()}</span>
                        <span className="counter-label">issued</span>
                      </span>
                      <span className="counter">
                        <span className="counter-value">{state.settledCount.toString()}</span>
                        <span className="counter-label">settled</span>
                      </span>
                      <span className="counter">
                        <span className="counter-value">{state.cancelledCount.toString()}</span>
                        <span className="counter-label">cancelled</span>
                      </span>
                      <span className="counter">
                        <span className="counter-value">{state.disputedCount.toString()}</span>
                        <span className="counter-label">disputed</span>
                      </span>
                    </span>
                  </span>
                </div>

                <div className="fact">
                  <span className="fact-label">Our record</span>
                  <span className="fact-value small muted">{reliability}</span>
                </div>
              </>
            )}

            {connected && (
              <div className="fact">
                <span className="fact-label">Session</span>
                <span className="fact-value">
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    onClick={() => void refresh()}
                    disabled={refreshing}
                  >
                    {refreshing ? 'Reading…' : 'Refresh'}
                  </button>
                  <button
                    type="button"
                    className="button button-quiet button-small"
                    onClick={disconnect}
                  >
                    Close
                  </button>
                </span>
              </div>
            )}
          </div>
        </div>

        {connected && (
          <nav className="nav" aria-label="Sections">
            {NAV.map((item) => (
              <a
                key={item.label}
                href={routePath(item.route)}
                aria-current={route.name === item.route.name ? 'page' : undefined}
              >
                {item.label}
              </a>
            ))}
          </nav>
        )}
      </div>

      {state?.paused === true && (
        <div className="header-inner header-banner">
          <div className="callout callout-warn">
            <span className="callout-title">This deployment is paused</span>
            The administrator has stopped every state-advancing call. Reading records and
            revoking an audit grant still work; issuing, settling and escrow do not.
            {state?.isAdmin === true && (
              <>
                {' '}
                You are that administrator: the switch that lifts it is at the foot of the{' '}
                <a href={routePath({ name: 'invoices' })}>invoice list</a>.
              </>
            )}
          </div>
        </div>
      )}
    </header>
  );
};
