// Selective disclosure: granting it, and checking it.
//
// SPDX-License-Identifier: Apache-2.0
//
// The two halves of this screen are the two sides of an audit and they never meet
// on chain. The seller authorises a key for specific fields until a deadline, and
// the ledger records that grant and nothing else .. not the fields, not the
// values. The auditor gets an encrypted envelope out of band and checks it
// against the grant and the anchor. The chain learns who was authorised and for
// what. It never learns what they saw.

import { useMemo, useState } from 'react';

import { InvoiceStatus, statusLabel, type InvoiceView } from '@quietbooks/api';
import { buildTermsFrame } from '@quietbooks/api';
import {
  SCOPES,
  fromHex,
  nowSeconds,
  noScopes,
  scopeNames,
  type ScopeName,
} from '@quietbooks/contract';

import { CopyButton } from '../components/Copyable';
import { ConfirmDialog } from '../components/Dialog';
import {
  ActionFeedback,
  Checkbox,
  SelectField,
  TextAreaField,
  TextField,
} from '../components/Form';
import { TonePill } from '../components/Pills';
import { archivedLineItems, readArchive } from '../lib/archive';
import {
  SCOPE_LABELS,
  TEXT_SCOPES,
  auditKeyHash,
  auditModuleAvailable,
  buildAuditEnvelope,
  deriveAuditKey,
  formatValidationReport,
  validateAuditEnvelope,
  type AuditEnvelope,
  type ValidationReport,
} from '../lib/audit-bridge';
import { bytesToHex } from '../lib/codec';
import {
  formatDateTime,
  fromLocalInputValue,
  isHex32,
  messageOf,
  normaliseHex,
  toLocalInputValue,
  truncateHex,
} from '../lib/format';
import { networkId } from '../lib/providers';
import { routePath } from '../state/router';
import { useConnected, useSession } from '../state/session';
import { useAction } from '../state/useAction';

// ---------------------------------------------------------------------------
// Seller: grant an audit
// ---------------------------------------------------------------------------

type GrantResult = {
  readonly auditKeyHex: string;
  readonly envelope: AuditEnvelope | undefined;
  readonly envelopeProblem: string | undefined;
};

const GrantAudit = ({
  invoices,
  initialInvoiceId,
}: {
  readonly invoices: readonly InvoiceView[];
  readonly initialInvoiceId: string | undefined;
}): JSX.Element => {
  const { api, contractAddress } = useConnected();
  const { refresh } = useSession();

  const [chosenId, setInvoiceId] = useState(initialInvoiceId ?? invoices[0]?.invoiceId ?? '');
  const [scopes, setScopes] = useState<Record<ScopeName, boolean>>(() => {
    const initial = {} as Record<ScopeName, boolean>;
    for (const scope of SCOPES) {
      initial[scope] = scope === 'amount' || scope === 'tax' || scope === 'currency';
    }
    return initial;
  });
  const [expiry, setExpiry] = useState(toLocalInputValue(nowSeconds() + 30n * 86_400n));
  const [confirming, setConfirming] = useState(false);

  // The list arrives after the first render, so the selection falls back to the
  // first row rather than sitting on an id that is not in the list.
  const invoiceId = invoices.some((view) => view.invoiceId === chosenId)
    ? chosenId
    : (invoices[0]?.invoiceId ?? '');

  const selected = invoices.find((view) => view.invoiceId === invoiceId);
  const archive = selected === undefined ? undefined : readArchive(contractAddress, invoiceId);
  const canDiscloseText = archive !== undefined;

  // A field whose text this browser does not hold cannot be disclosed from here,
  // so it is filtered out of the vector as well as unticked in the list. Sending
  // the contract a scope the envelope cannot honour would put a grant on chain
  // that no envelope could ever satisfy.
  const usable = (scope: ScopeName): boolean =>
    scopes[scope] && (canDiscloseText || !TEXT_SCOPES.includes(scope));

  const chosen = useMemo(
    () => SCOPES.filter((scope) => usable(scope)),
    [scopes, canDiscloseText],
  );
  const chosenVector = useMemo(
    () => SCOPES.map((scope) => usable(scope)),
    [scopes, canDiscloseText],
  );

  const grant = useAction(async (): Promise<GrantResult> => {
    if (selected === undefined || selected.stored === undefined) {
      throw new Error('this wallet does not hold the openings for that invoice');
    }
    const auditKey = deriveAuditKey();
    const keyHash = await auditKeyHash(auditKey);
    const expiresAt = fromLocalInputValue(expiry);

    await api.grantAudit(invoiceId, keyHash, chosenVector, expiresAt);

    // The envelope is built only after the grant landed. Handing somebody an
    // envelope for a grant that was refused would be handing them something no
    // validator will ever pass.
    let envelope: AuditEnvelope | undefined;
    let envelopeProblem: string | undefined;
    try {
      const stored = selected.stored;
      const frame = buildTermsFrame({
        invoiceId: fromHex(invoiceId),
        sellerKey: fromHex(stored.sellerKey),
        buyerKey: fromHex(stored.buyerKey),
        dueDate: stored.dueDate,
        terms: stored.terms,
      });
      envelope = await buildAuditEnvelope({
        invoiceId: fromHex(invoiceId),
        frame,
        prepared: {
          terms: stored.terms,
          termsSalt: stored.termsSalt,
          fieldSalts: [...stored.fieldSalts],
          nonce: stored.nonce,
          plaintext: {
            currency: archive?.currency ?? '',
            lineItems: archive === undefined ? [] : archivedLineItems(archive),
            memo: archive?.memo ?? '',
            orderRef: archive?.orderRef ?? '',
          },
        },
        scopes: chosenVector,
        expiresAt,
        auditKey,
        network: networkId(),
        contractAddress,
      });
    } catch (error) {
      envelopeProblem = messageOf(error);
    }

    await refresh();
    return { auditKeyHex: bytesToHex(auditKey), envelope, envelopeProblem };
  }, 'Building the proof and submitting the grant. This can take a minute.');

  if (invoices.length === 0) {
    return (
      <div className="panel-body">
        <div className="empty" style={{ padding: '28px 0' }}>
          <h2>No invoices to disclose</h2>
          <p>
            Only the seller can authorise an auditor, and only for an invoice this wallet
            issued and can still open. Write one first.
          </p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <a className="button" href={routePath({ name: 'new-invoice' })}>
              New invoice
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (grant.state.status === 'done') {
    const { auditKeyHex, envelope, envelopeProblem } = grant.state.value;
    return (
      <div className="panel-body stack">
        <div className="callout callout-danger">
          <span className="callout-title">This key is shown once</span>
          It is not stored anywhere, not by this interface and not by the chain, and it cannot
          be recovered. Only its hash was written on chain. If you lose it, revoke the grant
          and issue a new one.
        </div>

        <div className="stack">
          <span className="field-label">Audit key</span>
          <p className="contract-message" style={{ borderColor: 'var(--border-strong)' }}>
            {auditKeyHex}
          </p>
          <div className="row">
            <CopyButton value={auditKeyHex} label="the audit key" />
          </div>
        </div>

        {envelope !== undefined ? (
          <div className="stack">
            <div className="callout callout-accent">
              <span className="callout-title">Send the auditor both of these</span>
              The key above and the envelope below. The envelope is encrypted to that key and
              carries only the fields you ticked; the other fields travel as commitments, which
              is what lets the auditor rebuild the field root without seeing them.
            </div>
            <TextAreaField
              label="Audit envelope"
              value={JSON.stringify(envelope, null, 2)}
              onChange={() => undefined}
              rows={16}
            />
            <div className="row-wrap">
              <CopyButton value={JSON.stringify(envelope, null, 2)} label="the audit envelope" />
              <button
                type="button"
                className="button"
                onClick={() => {
                  const blob = new Blob([JSON.stringify(envelope, null, 2)], {
                    type: 'application/json',
                  });
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = `quietbooks-audit-${invoiceId.slice(0, 12)}.json`;
                  anchor.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Download envelope
              </button>
              <button type="button" className="button button-quiet" onClick={() => grant.reset()}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <div className="callout callout-warn">
              <span className="callout-title">The grant is on chain, but no envelope was built</span>
              {envelopeProblem}
            </div>
            <div className="row">
              <button type="button" className="button" onClick={() => grant.reset()}>
                Back
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="panel-body stack">
      <SelectField
        label="Invoice"
        value={invoiceId}
        options={invoices.map((view) => ({
          value: view.invoiceId,
          label: `${truncateHex(view.invoiceId, 10, 6)} · ${statusLabel(view.anchor.status)}`,
        }))}
        onChange={setInvoiceId}
        hint="Only invoices you issued and can still open."
      />

      <fieldset className="stack" style={{ gap: 2 }}>
        <legend className="field-label" style={{ marginBottom: 6 }}>
          Fields to disclose
        </legend>
        {SCOPES.map((scope) => {
          const needsText = TEXT_SCOPES.includes(scope);
          const blocked = needsText && !canDiscloseText;
          return (
            <Checkbox
              key={scope}
              checked={usable(scope)}
              disabled={blocked}
              onChange={(checked) => setScopes((current) => ({ ...current, [scope]: checked }))}
              title={
                <>
                  {SCOPE_LABELS[scope].title} <span className="quiet mono">{scope}</span>
                </>
              }
              detail={
                blocked
                  ? 'This browser does not hold the text behind this field, so it cannot be disclosed from here. Only the wallet that wrote the invoice can.'
                  : SCOPE_LABELS[scope].detail
              }
            />
          );
        })}
      </fieldset>

      <TextField
        label="Grant expires"
        type="datetime-local"
        value={expiry}
        onChange={setExpiry}
        hint="The contract refuses a grant that does not expire in the future, and an auditor reading after this moment gets a failed check."
      />

      <div className="callout">
        <span className="callout-title">What goes on chain</span>
        The hash of the audit key, the nine-slot scope vector, and the two timestamps. Not the
        key, not the values, not the envelope.
      </div>

      <div className="row-wrap">
        <button
          type="button"
          className="button button-primary"
          disabled={grant.busy || chosen.length === 0 || selected?.stored === undefined}
          onClick={() => setConfirming(true)}
        >
          Generate key and grant
        </button>
        {chosen.length === 0 && (
          <span className="small quiet">
            The contract refuses a grant that discloses nothing.
          </span>
        )}
        {selected?.stored === undefined && (
          <span className="small quiet">This wallet cannot open that invoice.</span>
        )}
        <ActionFeedback state={grant.state} />
      </div>

      {confirming && (
        <ConfirmDialog
          title="Authorise this auditor?"
          confirmLabel="Grant"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false);
            void grant.run();
          }}
        >
          <p>
            This puts a grant on chain for invoice {truncateHex(invoiceId, 10, 6)} covering{' '}
            {chosen.map((scope) => SCOPE_LABELS[scope].title).join(', ')}, valid until{' '}
            {formatDateTime(safeExpiry(expiry))}.
          </p>
          <p>
            Which fields you opened is public. What they contain is not, and neither is the
            key. You can revoke the grant later, but not unsee an envelope already opened.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
};

/** The expiry as a timestamp, or zero while the field is half-typed. */
const safeExpiry = (value: string): bigint => {
  try {
    return fromLocalInputValue(value);
  } catch {
    return 0n;
  }
};

// ---------------------------------------------------------------------------
// Auditor: check an envelope
// ---------------------------------------------------------------------------

const parseEnvelope = (text: string): AuditEnvelope => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('that is not JSON. Paste the whole envelope, braces included.');
  }
  const envelope = parsed as AuditEnvelope;
  if (typeof envelope?.invoiceId !== 'string' || typeof envelope?.encryption?.ciphertext !== 'string') {
    throw new Error('that JSON is not a QuietBooks audit envelope: it has no invoice id or no ciphertext.');
  }
  return envelope;
};

const CheckEnvelope = (): JSX.Element => {
  const { state } = useSession();
  const [envelopeText, setEnvelopeText] = useState('');
  const [keyText, setKeyText] = useState('');

  const check = useAction(async (): Promise<{
    report: ValidationReport;
    envelope: AuditEnvelope;
  }> => {
    const envelope = parseEnvelope(envelopeText);
    if (!isHex32(keyText)) {
      throw new Error('an audit key is 64 hexadecimal characters');
    }
    if (state === undefined) {
      throw new Error('the ledger has not been read yet');
    }

    const view = state.invoices.find(
      (candidate) => candidate.invoiceId === normaliseHex(envelope.invoiceId),
    );
    if (view === undefined) {
      throw new Error(
        `invoice ${truncateHex(envelope.invoiceId)} is not on the contract this interface is ` +
          'connected to. An envelope is checked against the chain, not against itself, so open ' +
          `the deployment it names (${truncateHex(envelope.contractAddress, 10, 6)}) first.`,
      );
    }
    if (view.auditGrant === undefined) {
      throw new Error(
        'that invoice has no audit grant on chain. Nothing authorises this envelope, so there ' +
          'is nothing to check it against.',
      );
    }

    const report = await validateAuditEnvelope({
      envelope,
      auditKey: fromHex(normaliseHex(keyText)),
      anchor: { fieldRoot: view.anchor.fieldRoot, terms: view.anchor.terms },
      grant: {
        auditKeyHash: view.auditGrant.auditKeyHash,
        scopes: [...view.auditGrant.scopes],
        expiresAt: view.auditGrant.expiresAt,
        revoked: view.auditGrant.revoked,
      },
      now: nowSeconds(),
    });
    return { report, envelope };
  }, 'Opening the envelope and checking it against the chain');

  return (
    <div className="panel-body stack">
      <TextAreaField
        label="Audit envelope"
        value={envelopeText}
        onChange={setEnvelopeText}
        rows={10}
        placeholder='{ "version": "quietbooks-audit/1", … }'
        hint="The JSON the seller sent you."
      />
      <TextField
        label="Audit key"
        value={keyText}
        onChange={setKeyText}
        mono
        placeholder="64 hexadecimal characters"
        hint="Sent separately from the envelope. Without it the envelope is ciphertext."
      />

      <div className="row-wrap">
        <button
          type="button"
          className="button button-primary"
          disabled={check.busy || envelopeText.trim().length === 0 || keyText.trim().length === 0}
          onClick={() => void check.run()}
        >
          Check this envelope
        </button>
        <ActionFeedback state={check.state} />
      </div>

      {check.state.status === 'done' && (
        <Report report={check.state.value.report} envelope={check.state.value.envelope} />
      )}
    </div>
  );
};

const Report = ({
  report,
  envelope,
}: {
  readonly report: ValidationReport;
  readonly envelope: AuditEnvelope;
}): JSX.Element => {
  const text = useMemo(() => {
    try {
      return formatValidationReport(report);
    } catch {
      return undefined;
    }
  }, [report]);

  const passed = report.checks.filter((item) => item.ok).length;

  return (
    <div className="stack">
      <div className={report.ok ? 'verdict verdict-pass' : 'verdict verdict-fail'}>
        <span className="verdict-mark">{report.ok ? 'PASS' : 'FAIL'}</span>
        {report.ok
          ? 'Every check passed.'
          : `${report.checks.length - passed} of ${report.checks.length} checks failed.`}
      </div>

      <div className="table-scroll">
        <table className="ledger checks">
          <thead>
            <tr>
              <th scope="col">Result</th>
              <th scope="col">Check</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {report.checks.map((item) => (
              <tr key={item.name}>
                <td className={item.ok ? 'check-mark is-ok' : 'check-mark is-fail'}>
                  {item.ok ? 'PASS' : 'FAIL'}
                </td>
                <td className="check-name">{item.name}</td>
                <td className="check-detail">{item.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="facts">
        <dt>Invoice</dt>
        <dd className="mono">{truncateHex(envelope.invoiceId, 16, 10)}</dd>
        <dt>Format</dt>
        <dd className="mono">{envelope.version}</dd>
        <dt>Declared expiry</dt>
        <dd className="figure">{formatDateTime(BigInt(envelope.expiresAt))}</dd>
        <dt>Scope mask</dt>
        <dd className="mono">{envelope.scopeMask}</dd>
      </dl>

      {text !== undefined && (
        <div className="row">
          <CopyButton value={text} label="the validation report" />
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export const Audit = ({
  invoiceId,
}: {
  readonly invoiceId?: string | undefined;
}): JSX.Element => {
  const { state } = useSession();
  const now = nowSeconds();

  const sellerInvoices = useMemo(
    () =>
      (state?.invoices ?? []).filter(
        (view) => view.role === 'seller' && view.stored !== undefined,
      ),
    [state],
  );

  const liveGrants = useMemo(
    () =>
      (state?.invoices ?? []).filter(
        (view) =>
          view.auditGrant !== undefined &&
          !view.auditGrant.revoked &&
          view.auditGrant.expiresAt > now,
      ),
    [state, now],
  );

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div>
          <h1>Audit</h1>
          <p className="note">
            An auditor never reads an invoice off the chain, because the chain does not hold
            one. They get an envelope from the seller and check it against the grant and the
            commitments that are on chain. Below: granting on the left, checking on the right.
          </p>
        </div>
      </div>

      {!auditModuleAvailable() && (
        <div className="callout callout-danger" role="alert">
          <span className="callout-title">
            The contract package does not export its audit module
          </span>
          Envelopes are built and checked by <code className="mono">@quietbooks/contract</code>,
          never here, because every field commitment has to be recomputed through the compiled
          circuits. <code className="mono">contract/src/audit.ts</code> exists in this tree but{' '}
          <code className="mono">contract/src/index.ts</code> does not re-export it, so neither
          half of this screen can run. Adding{' '}
          <code className="mono">export * from './audit.js';</code> to that index is the whole
          fix.
        </div>
      )}

      <div className="split">
        <div className="panel">
          <div className="panel-head">
            <h2>Authorise an auditor</h2>
            <span className="tag">Seller</span>
          </div>
          <GrantAudit invoices={sellerInvoices} initialInvoiceId={invoiceId} />
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Check an envelope</h2>
            <span className="tag">Auditor</span>
          </div>
          <CheckEnvelope />
        </div>
      </div>

      {liveGrants.length > 0 && (
        <div className="panel">
          <div className="panel-head">
            <h2>Grants in force on this deployment</h2>
          </div>
          <div className="table-scroll">
            <table className="ledger">
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">Status</th>
                  <th scope="col">Discloses</th>
                  <th scope="col">Expires</th>
                </tr>
              </thead>
              <tbody>
                {liveGrants.map((view) => (
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
                      {view.anchor.status === InvoiceStatus.issued ? (
                        <TonePill tone="accent">{statusLabel(view.anchor.status)}</TonePill>
                      ) : (
                        <TonePill tone="neutral">{statusLabel(view.anchor.status)}</TonePill>
                      )}
                    </td>
                    <td className="small">
                      {scopeNames([...(view.auditGrant?.scopes ?? noScopes())])
                        .map((scope) => SCOPE_LABELS[scope].title)
                        .join(', ')}
                    </td>
                    <td className="figure nowrap">
                      {formatDateTime(view.auditGrant?.expiresAt ?? 0n)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="panel-foot">
            <span className="small quiet">
              A grant is public: the ledger shows that an auditor was authorised, for which
              fields, and until when. What they were shown is not on the chain, and neither is
              the key.
            </span>
          </div>
        </div>
      )}
    </div>
  );
};
