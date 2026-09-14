// One invoice, in full.
//
// SPDX-License-Identifier: Apache-2.0
//
// The top of this screen is what the chain holds: digests, keys, timestamps and a
// status. The middle is what this wallet can open, which for somebody else's
// invoice is nothing. The bottom is what we are allowed to do next, and an action
// only appears when the contract would actually accept it from us in this state ..
// showing a button that is certain to be refused is a way of teaching people to
// ignore error messages.

import { useCallback, useMemo, useState } from 'react';

import {
  DisputeOutcome,
  InvoiceStatus,
  SettlementMode,
  settlementLabel,
  statusLabel,
  type InvoiceView,
  type QuietBooksAPI,
} from '@quietbooks/api';
import {
  fromHex,
  nowSeconds,
  randomBytes32,
  scopeNames,
  sha256,
  toHex,
} from '@quietbooks/contract';

import { ActionCard } from '../components/ActionCard';
import { CopyButton, Digest } from '../components/Copyable';
import { SelectField, TextAreaField, TextField } from '../components/Form';
import { OverduePill, StatusPill, TonePill } from '../components/Pills';
import { archivedLineItems, readArchive } from '../lib/archive';
import { SCOPE_LABELS } from '../lib/audit-bridge';
import {
  formatAmount,
  formatDate,
  formatDateTime,
  fromLocalInputValue,
  isHex32,
  isZeroHex,
  messageOf,
  normaliseHex,
  relativeDays,
  toLocalInputValue,
  truncateHex,
} from '../lib/format';
import { PAUSED_REASON, blockedBy } from '../lib/guards';
import { LOCKED_AMOUNT_REASON, openedInvoice } from '../lib/invoice-display';
import { routePath } from '../state/router';
import { useConnected, useSession } from '../state/session';
import { useAction } from '../state/useAction';

type ActionProps = {
  readonly api: QuietBooksAPI;
  readonly view: InvoiceView;
  readonly paused: boolean;
  readonly onDone: () => Promise<void>;
};

const PROVING_NOTE = 'Building the proof and submitting. This can take a minute.';

const SEALED_REASON =
  'This wallet does not hold the openings for this invoice, and the call proves them. ' +
  'Import the record from the counterparty first.';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const SettleWithNote = ({ api, view, paused, onDone }: ActionProps): JSX.Element => {
  const action = useAction(async () => {
    // The nonce identifies this one coin. Fresh every time: reusing one names a
    // coin the ledger already knows about.
    // The token comes from the invoice. The circuit refuses a coin of any other
    // colour, so paying in a default would simply fail for invoices that are not
    // denominated in it.
    const coin = {
      nonce: randomBytes32(),
      color: view.stored!.terms.tokenType,
      value: view.payable!,
    };
    await api.settleWithNote(view.invoiceId, coin, view.stored!.terms.sellerPayout);
    await onDone();
  }, PROVING_NOTE);

  const blocked = blockedBy([
    [view.stored === undefined, SEALED_REASON],
    [paused, PAUSED_REASON],
    [view.payable === undefined, 'This wallet cannot open the invoice, so it cannot know what to pay.'],
  ]);

  return (
    <ActionCard
      title="Settle"
      description={
        <>
          Pay the seller inside the same transaction that records the settlement. The contract
          takes the coin and forwards it on in one call, so it never holds your money and its
          balance does not move. Zswap hides the value on both legs: the chain learns that this
          invoice was paid, not what it was paid.
        </>
      }
      buttonLabel="Pay and settle"
      tone="primary"
      state={action.state}
      busy={action.busy}
      disabled={blocked !== undefined}
      disabledReason={blocked}
      confirm={{
        title: 'Pay this invoice and settle it?',
        confirmLabel: 'Pay and settle',
        body: (
          <>
            <p>
              This sends the full invoice total for {truncateHex(view.invoiceId, 10, 6)} and writes
              the settlement record. Both happen in one transaction, so either both land or
              neither does. It cannot be undone.
            </p>
            <p>
              The circuit compares the payment against the terms you hold and refuses anything
              but the exact total, to the address the invoice names. You cannot underpay by
              mistake, and you cannot pay the wrong person.
            </p>
          </>
        ),
      }}
      onRun={() => void action.run()}
    >
      <div className="callout">
        <span className="callout-title">The destination is not yours to choose</span>
        The coin goes to the address this invoice names. That address sits inside the terms
        commitment, so it was fixed when the invoice was issued, and the circuit refuses a
        payment addressed anywhere else rather than recording it as a settlement.
      </div>
    </ActionCard>
  );
};

const AttestSettlement = ({ api, view, paused, onDone }: ActionProps): JSX.Element => {
  const [reference, setReference] = useState('');
  const [mode, setMode] = useState<'text' | 'digest'>('text');

  const action = useAction(async () => {
    const digest =
      mode === 'digest'
        ? fromHex(normaliseHex(reference))
        : await sha256(reference.trim());
    await api.settleAttested(view.invoiceId, digest);
    await onDone();
  }, PROVING_NOTE);

  const blocked = blockedBy([
    [view.stored === undefined, SEALED_REASON],
    [paused, PAUSED_REASON],
    [reference.trim().length === 0, 'Give the payment a reference, or paste its digest.'],
    [
      mode === 'digest' && !isHex32(reference),
      'A receipt digest is 64 hexadecimal characters.',
    ],
  ]);

  return (
    <ActionCard
      title="Attest settlement"
      description={
        <>
          Record that you were paid outside this contract .. a bank transfer, a rail the chain
          cannot see. Nothing is verified by the contract here: it stores your word, your key
          and a receipt digest. Use it when the payment genuinely happened elsewhere.
        </>
      }
      buttonLabel="Attest that this is paid"
      state={action.state}
      busy={action.busy}
      disabled={blocked !== undefined}
      disabledReason={blocked}
      confirm={{
        title: 'Attest that this invoice is paid?',
        confirmLabel: 'Attest',
        body: (
          <p>
            This marks the invoice settled on your word alone and cannot be undone. It also
            counts towards your settlement record, which counterparties can check.
          </p>
        ),
      }}
      onRun={() => void action.run()}
    >
      <SelectField
        label="Receipt"
        value={mode}
        options={[
          { value: 'text', label: 'Hash a reference for me' },
          { value: 'digest', label: 'I have the digest already' },
        ]}
        onChange={(value) => {
          setMode(value);
          setReference('');
        }}
      />
      <TextField
        label={mode === 'text' ? 'Payment reference' : 'Receipt digest'}
        value={reference}
        onChange={setReference}
        mono={mode === 'digest'}
        placeholder={mode === 'text' ? 'Bank reference, remittance number…' : '64 hexadecimal characters'}
        hint={
          mode === 'text'
            ? 'Hashed here with SHA-256. Only the digest goes on chain, so the reference itself stays between you and the buyer.'
            : 'Stored as given. 32 bytes.'
        }
      />
    </ActionCard>
  );
};

const CancelInvoice = ({ api, view, paused, onDone }: ActionProps): JSX.Element => {
  const action = useAction(async () => {
    await api.cancelInvoice(view.invoiceId);
    await onDone();
  }, PROVING_NOTE);

  return (
    <ActionCard
      title="Cancel"
      description="Withdraw the invoice. Only an invoice still awaiting payment can be cancelled, and a cancellation is counted against your settlement record."
      buttonLabel="Cancel this invoice"
      tone="danger"
      state={action.state}
      busy={action.busy}
      disabled={paused}
      disabledReason={paused ? PAUSED_REASON : undefined}
      confirm={{
        title: 'Cancel this invoice?',
        confirmLabel: 'Cancel the invoice',
        tone: 'danger',
        body: (
          <p>
            The invoice cannot be reopened afterwards, and the cancellation appears in the
            public record a counterparty checks before dealing with you.
          </p>
        ),
      }}
      onRun={() => void action.run()}
    />
  );
};

const FundEscrow = ({ api, view, paused, onDone }: ActionProps): JSX.Element => {
  const [nonce, setNonce] = useState('');
  const [color, setColor] = useState('');
  const [value, setValue] = useState('');
  const [deadline, setDeadline] = useState(toLocalInputValue(nowSeconds() + 14n * 86_400n));

  // The circuit is handed the deadline and the funding time in the same call and
  // asserts the first is after the second, so a deadline already behind us costs
  // a minute of proving and then fails. `fromLocalInputValue` throws on a
  // half-typed field, which is a state this form passes through on every
  // keystroke, so the parse is kept apart from the check.
  const now = nowSeconds();
  const deadlineAt = useMemo((): bigint | undefined => {
    try {
      return fromLocalInputValue(deadline);
    } catch {
      return undefined;
    }
  }, [deadline]);

  const action = useAction(async () => {
    await api.fundEscrow(
      view.invoiceId,
      {
        nonce: fromHex(normaliseHex(nonce)),
        color: fromHex(normaliseHex(color)),
        value: BigInt(value.trim()),
      },
      fromLocalInputValue(deadline),
    );
    await onDone();
  }, PROVING_NOTE);

  const blocked = blockedBy([
    [view.stored === undefined, SEALED_REASON],
    [paused, PAUSED_REASON],
    [!isHex32(nonce), 'The coin nonce is 64 hexadecimal characters.'],
    [!isHex32(color), 'The token type is 64 hexadecimal characters.'],
    [!/^\d+$/.test(value.trim()), 'The value is a whole number.'],
    [
      /^\d+$/.test(value.trim()) && BigInt(value.trim()) === 0n,
      'The contract refuses an escrow of zero.',
    ],
    [deadlineAt === undefined, 'Give a refund deadline this browser can read as a date and time.'],
    [
      deadlineAt !== undefined && deadlineAt <= now,
      'The refund deadline has to be later than now. Pick one further out.',
    ],
  ]);

  return (
    <ActionCard
      title="Fund escrow"
      description={
        <>
          Hand the payment to the contract instead of the seller, to be released when you say
          so or refunded to you after the deadline.
        </>
      }
      buttonLabel="Fund escrow"
      tone="danger"
      state={action.state}
      busy={action.busy}
      disabled={blocked !== undefined}
      disabledReason={blocked}
      confirm={{
        title: 'Escrow makes this amount public',
        confirmLabel: 'Fund escrow anyway',
        tone: 'danger',
        acknowledgement:
          'I understand that the escrowed amount will be readable by anyone looking at this contract.',
        body: (
          <>
            <p>
              A contract can only take custody of a coin it has been shown, so the coin’s value
              is disclosed when the contract receives it and stays readable in the escrow vault
              afterwards. Everyone can see how much this invoice is worth from that moment on.
            </p>
            <p>
              Settling privately does not do this: a peer-to-peer shielded transfer keeps the
              amount hidden and the contract binds it to this invoice through its note
              commitment. Escrow buys you contract-held funds and a refund deadline, and it
              costs you the privacy of the amount. That is the trade; there is no mode that
              gives both.
            </p>
          </>
        ),
      }}
      onRun={() => void action.run()}
    >
      <div className="callout callout-warn">
        <span className="callout-title">This is the one call that publishes an amount</span>
        Everything else in QuietBooks keeps the figures off the chain. Escrow cannot: the
        contract has to be shown the coin to hold it.
      </div>

      <div className="field-row">
        <TextField
          label="Coin nonce"
          value={nonce}
          onChange={setNonce}
          mono
          placeholder="64 hexadecimal characters"
          hint="From the coin your wallet is putting up."
        />
        <TextField
          label="Token type"
          value={color}
          onChange={setColor}
          mono
          placeholder="64 hexadecimal characters"
          hint="The coin’s type. 32 bytes."
        />
      </div>
      <div className="field-row">
        <TextField
          label="Value"
          value={value}
          onChange={setValue}
          inputMode="numeric"
          hint="In the token’s own smallest unit, as the ledger records it."
        />
        <TextField
          label="Refund deadline"
          type="datetime-local"
          value={deadline}
          onChange={setDeadline}
          hint="After this, and only after it, you can refund yourself. It has to be in the future. Public on the anchor."
        />
      </div>
    </ActionCard>
  );
};

const ReleaseEscrow = ({ api, view, paused, onDone }: ActionProps): JSX.Element => {
  const action = useAction(async () => {
    await api.releaseEscrow(view.invoiceId, view.stored!.terms.sellerPayout);
    await onDone();
  }, PROVING_NOTE);

  // The circuit proves the terms open the chain's commitment before it compares
  // the recipient against them, so a wallet without the openings cannot release
  // even though it is the buyer and the money is sitting there.
  const blocked = blockedBy([
    [view.stored === undefined, SEALED_REASON],
    [paused, PAUSED_REASON],
  ]);

  return (
    <ActionCard
      title="Release escrow"
      description="Pay the seller out of the escrow, at the address this invoice names. There is nothing to type: the address was fixed when the invoice was issued and the circuit refuses any other. This settles the invoice."
      buttonLabel="Release to the seller"
      tone="primary"
      state={action.state}
      busy={action.busy}
      disabled={blocked !== undefined}
      disabledReason={blocked}
      confirm={{
        title: 'Release the escrowed funds?',
        confirmLabel: 'Release',
        body: (
          <p>
            The coin leaves the contract, goes to the seller on this invoice, and the invoice
            is recorded as settled. It cannot be recalled.
          </p>
        ),
      }}
      onRun={() => void action.run()}
    />
  );
};

const RefundEscrow = ({ api, view, onDone }: ActionProps): JSX.Element => {
  // The refund is the buyer's own money coming back to the buyer, and this
  // wallet is the only caller the circuit accepts. Its own key is therefore the
  // only sensible destination, and typing it out by hand only opens the door to
  // a transcription error that sends the coin to a key nobody controls.
  const { coinPublicKeyBytes } = useConnected();
  const now = nowSeconds();
  const passed = view.anchor.escrowDeadline < now;

  const action = useAction(async () => {
    await api.refundEscrow(view.invoiceId, coinPublicKeyBytes);
    await onDone();
  }, PROVING_NOTE);

  // Deliberately not blocked on `paused`. The circuit exempts a refund from the
  // pause for a reason -- an emergency stop on new business must not trap money
  // somebody is already owed back -- and a button disabled here would reimpose
  // exactly what the contract went out of its way to allow.
  const blocked = blockedBy([
    [!passed, 'The contract refuses a refund before the deadline.'],
  ]);

  return (
    <ActionCard
      title="Refund escrow"
      description={
        passed
          ? 'Take the escrowed coin back. The deadline has passed, so the contract allows it. It returns to the wallet connected here.'
          : `Available only after the escrow deadline, ${formatDateTime(view.anchor.escrowDeadline)} (${relativeDays(view.anchor.escrowDeadline, now)}).`
      }
      buttonLabel="Refund to me"
      state={action.state}
      busy={action.busy}
      disabled={blocked !== undefined}
      disabledReason={blocked}
      confirm={{
        title: 'Refund the escrow to yourself?',
        confirmLabel: 'Refund',
        body: (
          <p>
            The coin comes back to the wallet connected here. The seller is not paid, and the
            invoice ends as refunded.
          </p>
        ),
      }}
      onRun={() => void action.run()}
    />
  );
};

const OpenDispute = ({ api, view, paused, onDone }: ActionProps): JSX.Element => {
  const action = useAction(async () => {
    await api.openDispute(view.invoiceId);
    await onDone();
  }, PROVING_NOTE);

  return (
    <ActionCard
      title="Open a dispute"
      description="Hand the escrowed funds to the arbiter named when the invoice was issued. Neither side can move them afterwards; only the arbiter can."
      buttonLabel="Open a dispute"
      tone="danger"
      state={action.state}
      busy={action.busy}
      disabled={paused}
      disabledReason={paused ? PAUSED_REASON : undefined}
      confirm={{
        title: 'Open a dispute?',
        confirmLabel: 'Open the dispute',
        tone: 'danger',
        body: (
          <p>
            The escrow is frozen until the arbiter rules. Opening a dispute is recorded in your
            public settlement record whichever way it goes.
          </p>
        ),
      }}
      onRun={() => void action.run()}
    />
  );
};

const ResolveDispute = ({ api, view, paused, onDone }: ActionProps): JSX.Element => {
  const [forSeller, setForSeller] = useState<'seller' | 'buyer'>('seller');

  const action = useAction(async () => {
    const { terms } = view.stored!;
    await api.resolveDispute(
      view.invoiceId,
      forSeller === 'seller',
      forSeller === 'seller' ? terms.sellerPayout : terms.buyerPayout,
    );
    await onDone();
  }, PROVING_NOTE);

  // A buyer payout is optional at issuance, and an invoice issued without one
  // carries zero here. Zero is a syntactically valid key that nothing controls:
  // the circuit would compare the argument against it, find them equal, and send
  // the coin somewhere nobody can spend it from. The contract cannot catch this,
  // so the screen does.
  const buyerPayoutMissing =
    view.stored !== undefined && isZeroHex(toHex(view.stored.terms.buyerPayout));

  const blocked = blockedBy([
    [view.stored === undefined, SEALED_REASON],
    [paused, PAUSED_REASON],
    [
      forSeller === 'buyer' && buyerPayoutMissing,
      'This invoice was issued without an address to pay the buyer, so a ruling their way has ' +
        'nowhere to send the coin. Only a ruling for the seller can be recorded.',
    ],
  ]);

  return (
    <ActionCard
      title="Resolve the dispute"
      description="You were named as the arbiter when this invoice was issued. Your ruling moves the escrowed coin and is final. The ruling also decides where the coin goes: both addresses are inside the terms, and you cannot send it anywhere else."
      buttonLabel="Record the ruling"
      tone="danger"
      state={action.state}
      busy={action.busy}
      disabled={blocked !== undefined}
      disabledReason={blocked}
      confirm={{
        title: 'Record this ruling?',
        confirmLabel: 'Rule',
        tone: 'danger',
        body: (
          <p>
            The escrowed coin goes to the side you have named here and the dispute is closed.
            The losing side’s public record carries the loss.
          </p>
        ),
      }}
      onRun={() => void action.run()}
    >
      <SelectField
        label="In favour of"
        value={forSeller}
        options={[
          { value: 'seller', label: 'The seller' },
          { value: 'buyer', label: 'The buyer' },
        ]}
        onChange={setForSeller}
      />
      <p className="small quiet">
        {forSeller === 'seller'
          ? 'Pays the seller at the address this invoice names.'
          : buyerPayoutMissing
            ? 'This invoice names no address for the buyer, so this ruling cannot be recorded.'
            : 'Pays the buyer at the address this invoice names.'}
      </p>
    </ActionCard>
  );
};

const RevokeAudit = ({ api, view, onDone }: ActionProps): JSX.Element => {
  const action = useAction(async () => {
    await api.revokeAudit(view.invoiceId);
    await onDone();
  }, PROVING_NOTE);

  return (
    <ActionCard
      title="Revoke the audit grant"
      description="Withdraw the auditor's permission. Revocation is immediate on chain and beats anything else the grant says. It cannot claw back an envelope they already opened."
      buttonLabel="Revoke the grant"
      tone="danger"
      state={action.state}
      busy={action.busy}
      confirm={{
        title: 'Revoke this grant?',
        confirmLabel: 'Revoke',
        tone: 'danger',
        body: (
          <p>
            Any envelope the auditor checks from now on fails its revocation check. To grant
            access again you issue a new key and a new grant.
          </p>
        ),
      }}
      onRun={() => void action.run()}
    />
  );
};

const ImportRecord = ({ api, view, onDone }: ActionProps): JSX.Element => {
  const [payload, setPayload] = useState('');
  const action = useAction(async () => {
    await api.importInvoice(payload, view.role === 'observer' ? 'buyer' : view.role);
    await onDone();
  }, 'Reading the record');

  return (
    <ActionCard
      title="Import the invoice record"
      description={
        <>
          Paste the JSON the counterparty sent you. It carries the terms and the openings that
          prove them against the commitments already on chain. Until it is here, this invoice
          cannot be settled or audited by you.
        </>
      }
      buttonLabel="Import"
      tone="primary"
      state={action.state}
      busy={action.busy}
      disabled={payload.trim().length === 0}
      onRun={() => void action.run()}
    >
      <TextAreaField
        label="Invoice record"
        value={payload}
        onChange={setPayload}
        rows={10}
        placeholder='{ "invoiceId": "…", "terms": { … } }'
        hint="Stored in this browser, never sent anywhere."
      />
    </ActionCard>
  );
};

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export const InvoiceDetail = ({ invoiceId }: { readonly invoiceId: string }): JSX.Element => {
  const { api, contractAddress } = useConnected();
  const { state, refresh } = useSession();

  const view = useMemo(
    () => state?.invoices.find((candidate) => candidate.invoiceId === invoiceId),
    [state, invoiceId],
  );

  const onDone = useCallback(async () => {
    await refresh();
  }, [refresh]);

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

  if (view === undefined) {
    return (
      <div className="panel">
        <div className="empty">
          <h2>No invoice with that id on this deployment</h2>
          <p>
            The id <code className="mono">{truncateHex(invoiceId, 12, 8)}</code> is not in this
            contract’s ledger. It may belong to a different deployment, or the issuing
            transaction may not have landed yet.
          </p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <a className="button" href={routePath({ name: 'invoices' })}>
              Back to invoices
            </a>
          </div>
        </div>
      </div>
    );
  }

  const { anchor, settlement, auditGrant, dispute, role, stored } = view;
  const paused = state.paused;
  const now = nowSeconds();
  const opened = openedInvoice(view, contractAddress);
  const archive = readArchive(contractAddress, invoiceId);
  const actionProps: ActionProps = { api, view, paused, onDone };

  const hasArbiter = !isZeroHex(toHex(anchor.arbiterKey));
  const status = anchor.status;

  // `resolveDispute` writes a zero receipt deliberately, and it is the only
  // circuit that does: a receipt commits to the payer under a salt only that
  // payer holds, and the arbiter is neither party. Every other settlement path
  // commits one, so a zero here means this invoice was ruled, not paid.
  const ruledByArbiter = settlement !== undefined && isZeroHex(toHex(settlement.receipt));

  const canSettle = role === 'buyer' && status === InvoiceStatus.issued;
  const canAttest = role === 'seller' && status === InvoiceStatus.issued;
  const canCancel = role === 'seller' && status === InvoiceStatus.issued;
  const canFund = role === 'buyer' && status === InvoiceStatus.issued;
  const canRelease = role === 'buyer' && status === InvoiceStatus.escrowFunded;
  const canRefund = role === 'buyer' && status === InvoiceStatus.escrowFunded;
  const canDispute =
    (role === 'buyer' || role === 'seller') &&
    status === InvoiceStatus.escrowFunded &&
    hasArbiter;
  const canResolve = role === 'arbiter' && status === InvoiceStatus.disputed;
  const canRevoke = role === 'seller' && auditGrant !== undefined && !auditGrant.revoked;
  const anyAction =
    canSettle || canAttest || canCancel || canFund || canRelease || canRefund || canDispute || canResolve || canRevoke;

  return (
    <div className="stack-lg">
      <div className="page-head">
        <div className="stack">
          <a className="small quiet" href={routePath({ name: 'invoices' })}>
            ← All invoices
          </a>
          <h1 className="mono" style={{ fontSize: 18 }}>
            {truncateHex(invoiceId, 16, 10)}
          </h1>
          <div className="row-wrap">
            <StatusPill status={status} />
            {view.overdue && <OverduePill />}
            {role === 'observer' ? (
              <TonePill tone="neutral" title="Neither party key on this invoice is ours">
                Not ours
              </TonePill>
            ) : (
              <TonePill tone="accent">We are the {role}</TonePill>
            )}
            {auditGrant !== undefined && !auditGrant.revoked && (
              <TonePill tone="warn" title="An auditor is authorised to see some of this invoice">
                Audit granted
              </TonePill>
            )}
            <CopyButton value={invoiceId} label="the invoice id" />
          </div>
        </div>
      </div>

      <div className="split-wide">
        <div className="stack-lg">
          {/* ------------------------------------------------------------- */}
          <div className="panel">
            <div className="panel-head">
              <h2>Terms</h2>
              <span className="tag">Off chain</span>
            </div>

            {opened === undefined || stored === undefined ? (
              <div className="panel-body stack">
                <div className="callout">
                  <span className="callout-title">Sealed to this wallet</span>
                  {LOCKED_AMOUNT_REASON}
                </div>
              </div>
            ) : (
              <>
                <div className="panel-body">
                  <dl className="totals" style={{ marginLeft: 0, maxWidth: 360 }}>
                    <dt>Principal</dt>
                    <dd>{formatAmount(opened.amount, opened.decimals)}</dd>
                    <dt>Tax</dt>
                    <dd>{formatAmount(opened.tax, opened.decimals)}</dd>
                    <div style={{ display: 'contents' }} className="grand">
                      <dt>Due</dt>
                      <dd>
                        {opened.formattedPayable} {opened.currency}
                      </dd>
                    </div>
                  </dl>
                  <p className="small quiet" style={{ marginTop: 12 }}>
                    The chain holds {opened.payable.toString()} as an integer in the currency’s
                    smallest unit and nothing about where the decimal point goes.
                    {opened.decimalsKnown
                      ? ''
                      : ' This browser did not issue this invoice, so the point is shown at two places by assumption.'}
                  </p>
                </div>

                {archive !== undefined && archive.lineItems.length > 0 && (
                  <div className="panel-body">
                    <h3 style={{ marginBottom: 10 }}>Lines</h3>
                    <div className="table-scroll">
                      <table className="ledger">
                        <thead>
                          <tr>
                            <th scope="col">Description</th>
                            <th scope="col" className="figure-column">
                              Quantity
                            </th>
                            <th scope="col" className="figure-column">
                              Unit price
                            </th>
                            <th scope="col" className="figure-column">
                              Total
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {archivedLineItems(archive).map((item, index) => (
                            <tr key={`${item.description}-${index}`}>
                              <td>{item.description}</td>
                              <td className="figure figure-column">{item.quantity.toString()}</td>
                              <td className="figure figure-column">
                                {formatAmount(item.unitPrice, opened.decimals)}
                              </td>
                              <td className="figure figure-column">
                                {formatAmount(item.quantity * item.unitPrice, opened.decimals)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="small quiet" style={{ marginTop: 10 }}>
                      The lines are in this browser only. The chain holds their digest.
                    </p>
                  </div>
                )}

                <div className="panel-body">
                  <dl className="facts">
                    <dt>Order reference</dt>
                    <dd>
                      {archive?.orderRef !== undefined && archive.orderRef.length > 0 ? (
                        archive.orderRef
                      ) : isZeroHex(toHex(stored.terms.orderRef)) ? (
                        <span className="quiet">None</span>
                      ) : (
                        <Digest
                          value={toHex(stored.terms.orderRef)}
                          label="the order reference digest"
                        />
                      )}
                    </dd>
                    <dt>Memo</dt>
                    <dd>
                      {archive?.memo !== undefined && archive.memo.length > 0 ? (
                        archive.memo
                      ) : isZeroHex(toHex(stored.terms.memoHash)) ? (
                        <span className="quiet">None</span>
                      ) : (
                        <Digest value={toHex(stored.terms.memoHash)} label="the memo digest" />
                      )}
                    </dd>
                    <dt>Line-item digest</dt>
                    <dd>
                      <Digest value={toHex(stored.terms.itemsHash)} label="the line-item digest" />
                    </dd>
                  </dl>
                </div>
              </>
            )}
          </div>

          {/* ------------------------------------------------------------- */}
          {settlement !== undefined && (
            <div className="panel">
              <div className="panel-head">
                <h2>Settlement</h2>
                <span className="tag">On chain</span>
              </div>
              <div className="panel-body">
                <dl className="facts">
                  <dt>Mode</dt>
                  <dd>{settlementLabel(settlement.mode)}</dd>
                  <dt>Settled</dt>
                  <dd className="figure">{formatDateTime(settlement.settledAt)}</dd>
                  <dt>On time</dt>
                  <dd>
                    {settlement.onTime ? (
                      <TonePill tone="ok">On time</TonePill>
                    ) : (
                      <TonePill tone="warn">Late</TonePill>
                    )}
                  </dd>
                  <dt>
                    {settlement.mode === SettlementMode.attested ? 'Receipt digest' : 'Note commitment'}
                  </dt>
                  <dd>
                    <Digest value={toHex(settlement.note)} label="the settlement note" />
                  </dd>
                  {ruledByArbiter ? (
                    <>
                      <dt>Receipt</dt>
                      <dd>
                        <span className="quiet">None. The arbiter decided this one.</span>
                      </dd>
                    </>
                  ) : (
                    <>
                      <dt>Receipt commitment</dt>
                      <dd>
                        <Digest value={toHex(settlement.receipt)} label="the receipt commitment" />
                      </dd>
                    </>
                  )}
                </dl>
                <p className="small quiet" style={{ marginTop: 12 }}>
                  {ruledByArbiter
                    ? 'A receipt binds a settlement to the party who paid it, under a salt only that party holds. Nobody paid this one: the arbiter ruled and the contract moved the escrowed coin. The arbiter is not a party and holds no salt, so the contract writes an empty receipt rather than a digest that would bind nothing.'
                    : 'The receipt commitment binds this settlement to this invoice and this payer without either being recomputable from the digest alone.'}
                </p>
              </div>
            </div>
          )}

          {/* ------------------------------------------------------------- */}
          <div className="panel">
            <div className="panel-head">
              <h2>Public anchor</h2>
              <span className="tag">On chain</span>
            </div>
            <div className="panel-body">
              <dl className="facts">
                <dt>Status</dt>
                <dd>{statusLabel(status)}</dd>
                <dt>Issued</dt>
                <dd className="figure">{formatDateTime(anchor.issuedAt)}</dd>
                <dt>Due</dt>
                <dd className="figure">
                  {formatDate(anchor.dueDate)}{' '}
                  <span className="quiet small">{relativeDays(anchor.dueDate, now)}</span>
                </dd>
                {anchor.settledAt > 0n && (
                  <>
                    <dt>Settled</dt>
                    <dd className="figure">{formatDateTime(anchor.settledAt)}</dd>
                  </>
                )}
                {anchor.escrowDeadline > 0n && (
                  <>
                    <dt>Escrow deadline</dt>
                    <dd className="figure">{formatDateTime(anchor.escrowDeadline)}</dd>
                  </>
                )}
                <dt>Seller key</dt>
                <dd>
                  <Digest value={toHex(anchor.sellerKey)} label="the seller party key" />
                </dd>
                <dt>Buyer key</dt>
                <dd>
                  <Digest value={toHex(anchor.buyerKey)} label="the buyer party key" />
                </dd>
                <dt>Arbiter key</dt>
                <dd>
                  {hasArbiter ? (
                    <Digest value={toHex(anchor.arbiterKey)} label="the arbiter party key" />
                  ) : (
                    <span className="quiet">None named. A dispute cannot be opened.</span>
                  )}
                </dd>
                <dt>Terms commitment</dt>
                <dd>
                  <Digest value={toHex(anchor.terms)} label="the terms commitment" />
                </dd>
                <dt>Field root</dt>
                <dd>
                  <Digest value={toHex(anchor.fieldRoot)} label="the field root" />
                </dd>
                <dt>Rules version</dt>
                <dd className="figure">{anchor.rulesVersion.toString()}</dd>
              </dl>
              <p className="small quiet" style={{ marginTop: 12 }}>
                Every value here is a timestamp, a status or a 32-byte digest. No amount is
                written to public state by any circuit in this contract.
              </p>
            </div>
          </div>

          {/* ------------------------------------------------------------- */}
          {dispute !== undefined && (
            <div className="panel">
              <div className="panel-head">
                <h2>Dispute</h2>
                <span className="tag">On chain</span>
              </div>
              <div className="panel-body">
                <dl className="facts">
                  <dt>Outcome</dt>
                  <dd>
                    {dispute === DisputeOutcome.forSeller
                      ? 'Ruled for the seller'
                      : dispute === DisputeOutcome.forBuyer
                        ? 'Ruled for the buyer'
                        : 'Open, waiting on the arbiter'}
                  </dd>
                </dl>
              </div>
            </div>
          )}
        </div>

        {/* --------------------------------------------------------------- */}
        <div className="stack-lg">
          <div className="panel">
            <div className="panel-head">
              <h2>Audit</h2>
            </div>
            <div className="panel-body stack">
              {auditGrant === undefined ? (
                <p className="note">
                  No auditor is authorised on this invoice. The chain records who was
                  authorised and for what, never what they saw.
                </p>
              ) : (
                <dl className="facts">
                  <dt>Status</dt>
                  <dd>
                    {auditGrant.revoked ? (
                      <TonePill tone="danger">Revoked</TonePill>
                    ) : auditGrant.expiresAt <= now ? (
                      <TonePill tone="warn">Expired</TonePill>
                    ) : (
                      <TonePill tone="ok">In force</TonePill>
                    )}
                  </dd>
                  <dt>Discloses</dt>
                  <dd>
                    {scopeNames([...auditGrant.scopes])
                      .map((scope) => SCOPE_LABELS[scope].title)
                      .join(', ')}
                  </dd>
                  <dt>Granted</dt>
                  <dd className="figure">{formatDateTime(auditGrant.grantedAt)}</dd>
                  <dt>Expires</dt>
                  <dd className="figure">{formatDateTime(auditGrant.expiresAt)}</dd>
                  <dt>Key hash</dt>
                  <dd>
                    <Digest value={toHex(auditGrant.auditKeyHash)} label="the audit key hash" />
                  </dd>
                </dl>
              )}
              {role === 'seller' && (
                <div className="row">
                  <a
                    className="button button-small"
                    href={routePath({ name: 'audit', invoiceId })}
                  >
                    {auditGrant === undefined ? 'Grant an audit' : 'Replace this grant'}
                  </a>
                </div>
              )}
            </div>
          </div>

          {view.stored === undefined && role !== 'observer' && (
            <div className="panel">
              <ImportRecord {...actionProps} />
            </div>
          )}

          {anyAction ? (
            <div className="panel">
              <div className="panel-head">
                <h2>What you can do</h2>
              </div>
              {canSettle && <SettleWithNote {...actionProps} />}
              {canFund && <FundEscrow {...actionProps} />}
              {canAttest && <AttestSettlement {...actionProps} />}
              {canRelease && <ReleaseEscrow {...actionProps} />}
              {canRefund && <RefundEscrow {...actionProps} />}
              {canDispute && <OpenDispute {...actionProps} />}
              {canResolve && <ResolveDispute {...actionProps} />}
              {canCancel && <CancelInvoice {...actionProps} />}
              {canRevoke && <RevokeAudit {...actionProps} />}
            </div>
          ) : (
            <div className="panel">
              <div className="panel-body">
                <h2>Nothing to do here</h2>
                <p className="note" style={{ marginTop: 6 }}>
                  {role === 'observer'
                    ? 'This invoice is between two other parties. You can see that it exists and what state it is in, and nothing else.'
                    : `Nothing the contract would accept from the ${role} while this invoice is "${statusLabel(status)}".`}
                </p>
              </div>
            </div>
          )}

          {status === InvoiceStatus.issued && role === 'seller' && (
            <div className="panel">
              <div className="panel-body stack">
                <h2>Share the record</h2>
                <p className="note">
                  The buyer needs the invoice record before they can pay. If you have not sent
                  it yet, open it here and send it over a channel you already trust with your
                  commercial terms.
                </p>
                <ShareRecord api={api} invoiceId={invoiceId} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const ShareRecord = ({
  api,
  invoiceId,
}: {
  readonly api: QuietBooksAPI;
  readonly invoiceId: string;
}): JSX.Element => {
  const [payload, setPayload] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    try {
      setPayload(await api.exportInvoice(invoiceId));
      setError(undefined);
    } catch (problem) {
      setError(messageOf(problem));
    }
  }, [api, invoiceId]);

  return (
    <div className="stack">
      <div className="row-wrap">
        <button type="button" className="button" onClick={() => void load()}>
          {payload === undefined ? 'Show the record' : 'Refresh'}
        </button>
        {payload !== undefined && <CopyButton value={payload} label="the invoice record" />}
      </div>
      {error !== undefined && <p className="contract-message">{error}</p>}
      {payload !== undefined && (
        <TextAreaField
          label="Invoice record"
          value={payload}
          onChange={() => undefined}
          rows={10}
        />
      )}
    </div>
  );
};
