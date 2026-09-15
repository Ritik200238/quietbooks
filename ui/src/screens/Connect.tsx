// The gate: connect a wallet and open a deployment.
//
// SPDX-License-Identifier: Apache-2.0

import { useState } from 'react';

import { CopyButton } from '../components/Copyable';
import { ConfirmDialog } from '../components/Dialog';
import { TextField } from '../components/Form';
import { hasRootSecret, importRootSecret, rootSecretHex } from '../lib/identity';
import { messageOf } from '../lib/format';
import { networkId } from '../lib/providers';
import { useSession } from '../state/session';

const IdentityBackup = (): JSX.Element => {
  const [revealed, setRevealed] = useState(false);
  const [incoming, setIncoming] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [imported, setImported] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const existed = hasRootSecret();

  /**
   * Replace the secret this browser holds.
   *
   * Split out from the button because it is reached two ways: directly when
   * there is nothing to lose, and through a confirmation when there is.
   */
  const replaceIdentity = (): void => {
    try {
      importRootSecret(incoming);
      setIncoming('');
      setError(undefined);
      setImported(true);
      setConfirming(false);
    } catch (problem) {
      setError(messageOf(problem));
      setConfirming(false);
    }
  };

  return (
    <details className="stack">
      <summary className="small muted" style={{ cursor: 'pointer' }}>
        This browser holds your QuietBooks identity
      </summary>

      <div className="stack" style={{ marginTop: 12 }}>
        <p className="note">
          Your party key, your reliability record and every invoice you can open are derived
          from one 32-byte secret kept in this browser. It is not in the wallet and it is not
          on the chain. Clear this site’s data and the secret is gone: the invoices stay on
          chain, but nobody can open them again.
        </p>

        {revealed ? (
          <div className="stack">
            <p className="contract-message" style={{ borderColor: 'var(--border-strong)' }}>
              {rootSecretHex()}
            </p>
            <div className="row">
              <CopyButton value={rootSecretHex()} label="the identity secret" />
              <button
                type="button"
                className="button button-small"
                onClick={() => setRevealed(false)}
              >
                Hide
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button
              type="button"
              className="button button-small"
              onClick={() => setRevealed(true)}
            >
              {existed ? 'Show the secret to back it up' : 'Create and show a secret'}
            </button>
          </div>
        )}

        <TextField
          label="Or carry an identity over from another browser"
          value={incoming}
          onChange={(value) => {
            setIncoming(value);
            setError(undefined);
            setImported(false);
          }}
          mono
          placeholder="64 hexadecimal characters"
          error={error}
          hint="This replaces the secret above. Do it before you open a deployment."
        />
        <div className="row">
          <button
            type="button"
            className="button button-small"
            disabled={incoming.trim().length === 0}
            onClick={() => {
              // Confirmed only when there is something to lose. On a browser
              // that has never held a secret this is just setup, and a
              // confirmation would be noise; on one that has, it is the most
              // destructive thing in the product.
              if (existed) {
                setConfirming(true);
                return;
              }
              replaceIdentity();
            }}
          >
            Use this identity
          </button>
          {imported && <span className="small muted">Identity replaced.</span>}
        </div>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Replace the identity this browser holds?"
          confirmLabel="Replace my identity"
          tone="danger"
          acknowledgement="I have a copy of the current secret, or I accept losing what it opens."
          onConfirm={replaceIdentity}
          onCancel={() => setConfirming(false)}
        >
          <p>
            The secret below is overwritten and there is no copy of it anywhere else &mdash; not
            in your wallet, not on the chain, not on any server. Every invoice you can currently
            open is opened by it. Afterwards those invoices are still on chain and still yours,
            and nobody, including you, can read their terms or prove anything about them again.
          </p>
          <p className="contract-message" style={{ borderColor: 'var(--border-strong)' }}>
            {rootSecretHex()}
          </p>
          <div className="row">
            <CopyButton value={rootSecretHex()} label="the current identity secret" />
          </div>
          <p className="note">
            Copy it first if you are not certain. Carrying an identity between browsers is what
            this field is for, and in that case the secret you are pasting is the one you want to
            keep &mdash; but the one it replaces is gone the moment you confirm.
          </p>
        </ConfirmDialog>
      )}
    </details>
  );
};

export const Connect = (): JSX.Element => {
  const { connection, connect, lastContractAddress } = useSession();
  const [address, setAddress] = useState(lastContractAddress ?? '');
  const [deployConfirm, setDeployConfirm] = useState(false);

  const busy = connection.status === 'connecting';

  return (
    <div className="stack-lg" style={{ maxWidth: 760, margin: '0 auto' }}>
      <div>
        <h1>Open a QuietBooks deployment</h1>
        <p className="note" style={{ marginTop: 8 }}>
          QuietBooks keeps the commercial terms of an invoice off the chain. What the ledger
          holds is a commitment to those terms, the two party keys, a due date and a status.
          No amount is written to public state by any circuit in the contract. The one
          exception is escrow, which takes custody of a coin and therefore makes its value
          public; the interface says so at the point where you would choose it.
        </p>
      </div>

      {connection.status === 'failed' && (
        <div className="stack" role="alert">
          <span className="field-error">Could not open the deployment:</span>
          <p className="contract-message">{connection.error}</p>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Open an existing contract</h2>
        </div>
        <div className="panel-body stack">
          <TextField
            label="Contract address"
            value={address}
            onChange={setAddress}
            mono
            disabled={busy}
            placeholder="0200…"
            hint={
              lastContractAddress === undefined
                ? 'The counterparty who deployed it will have sent you this.'
                : 'This is the deployment this browser last opened.'
            }
          />
          <div className="row">
            <button
              type="button"
              className="button button-primary"
              disabled={busy || address.trim().length === 0}
              onClick={() => void connect({ kind: 'join', contractAddress: address.trim() })}
            >
              Open
            </button>
            {busy && connection.status === 'connecting' && (
              <span className="working">
                <span className="spinner" aria-hidden="true" />
                {connection.step}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Deploy a new one</h2>
        </div>
        <div className="panel-body stack">
          <p className="note">
            You become the administrator of the new deployment, and nobody else ever can: the
            role is fixed at deployment and cannot be handed on. The administrator can pause
            state-advancing calls and resume them again. It cannot move funds, read anybody’s
            terms, or change an invoice.
          </p>
          <p className="note">
            Deploying builds a zero-knowledge proof on your proof server and submits a
            transaction, so it takes a minute or so and costs fees on the network you are on.
          </p>
          {deployConfirm ? (
            <div className="row-wrap">
              <button
                type="button"
                className="button button-primary"
                disabled={busy}
                onClick={() => void connect({ kind: 'deploy' })}
              >
                Deploy now
              </button>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setDeployConfirm(false)}
              >
                Not yet
              </button>
            </div>
          ) : (
            <div className="row">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => setDeployConfirm(true)}
              >
                Deploy a new contract
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-body stack">
          <IdentityBackup />
          <p className="small quiet">
            Network: {networkId()}. The wallet refuses to connect if it is on another one.
          </p>
        </div>
      </div>
    </div>
  );
};
