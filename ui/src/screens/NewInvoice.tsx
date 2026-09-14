// Writing an invoice.
//
// SPDX-License-Identifier: Apache-2.0
//
// The seller fills this in, and almost none of it reaches the chain. What goes on
// chain is a commitment to the terms, nine per-field commitments, the two party
// keys, the due date and a status. The line items, the memo, the order reference,
// the currency and both amounts stay in this browser and in whatever the seller
// sends the buyer afterwards .. which is why the share step at the end is not an
// afterthought but the thing that makes the invoice payable.

import { useCallback, useMemo, useState, type FormEvent } from 'react';

import type { InvoiceDraft, LineItem } from '@quietbooks/contract';
import { coinPublicKeyBytes as parseCoinPublicKey } from '@quietbooks/api';
import { daysFromNow, fromHex, lineItemsTotal, toHex } from '@quietbooks/contract';

import { CopyButton, Digest } from '../components/Copyable';
import { ActionFeedback, SelectField, TextAreaField, TextField } from '../components/Form';
import { toArchivedLineItems, writeArchive } from '../lib/archive';
import {
  formatAmount,
  fromLocalInputValue,
  isHex32,
  isZeroHex,
  messageOf,
  normaliseHex,
  parseAmount,
  parseCount,
  todayInputValue,
} from '../lib/format';
import { PAUSED_REASON, blockedBy } from '../lib/guards';
import { routePath, navigate } from '../state/router';
import { useConnected, useSession } from '../state/session';
import { useAction } from '../state/useAction';

type LineDraft = {
  readonly key: number;
  readonly description: string;
  readonly quantity: string;
  readonly unitPrice: string;
};

const emptyLine = (key: number): LineDraft => ({
  key,
  description: '',
  quantity: '1',
  unitPrice: '',
});

const NOT_A_COIN_KEY =
  'This is not a coin public key. Ask the buyer for the one their wallet gives out.';

const DECIMALS = [
  { value: '2', label: '2 — cents, pence' },
  { value: '0', label: '0 — whole units' },
  { value: '3', label: '3' },
  { value: '6', label: '6' },
  { value: '8', label: '8' },
] as const;

/** A line that parses, or the reason it does not. */
const readLine = (
  line: LineDraft,
  decimals: number,
): { item: LineItem } | { error: string } => {
  if (line.description.trim().length === 0) {
    return { error: 'this line has no description' };
  }
  let quantity: bigint;
  let unitPrice: bigint;
  try {
    quantity = parseCount(line.quantity);
  } catch (error) {
    return { error: messageOf(error) };
  }
  try {
    unitPrice = parseAmount(line.unitPrice, decimals);
  } catch (error) {
    return { error: messageOf(error) };
  }
  if (quantity <= 0n) {
    return { error: 'a quantity has to be at least 1' };
  }
  if (unitPrice <= 0n) {
    return { error: 'a unit price has to be more than zero' };
  }
  return { item: { description: line.description.trim(), quantity, unitPrice } };
};

export const NewInvoice = (): JSX.Element => {
  const { api, contractAddress, coinPublicKey, coinPublicKeyBytes } = useConnected();
  const { state, refresh } = useSession();

  const [lines, setLines] = useState<readonly LineDraft[]>([emptyLine(0)]);
  const [nextKey, setNextKey] = useState(1);
  const [currency, setCurrency] = useState('USD');
  const [decimalsText, setDecimalsText] = useState<string>('2');
  const [tax, setTax] = useState('0');
  const [memo, setMemo] = useState('');
  const [orderRef, setOrderRef] = useState('');
  const [dueDate, setDueDate] = useState(todayInputValue(30));
  const [buyerKey, setBuyerKey] = useState('');
  const [buyerPayout, setBuyerPayout] = useState('');
  const [arbiterKey, setArbiterKey] = useState('');
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [shared, setShared] = useState<string | undefined>(undefined);

  const decimals = Number.parseInt(decimalsText, 10);

  const parsedLines = useMemo(
    () => lines.map((line) => readLine(line, decimals)),
    [lines, decimals],
  );

  const items = useMemo(
    () =>
      parsedLines
        .filter((parsed): parsed is { item: LineItem } => 'item' in parsed)
        .map((parsed) => parsed.item),
    [parsedLines],
  );

  const subtotal = useMemo(() => lineItemsTotal(items), [items]);

  const parsedTax = useMemo<{ value: bigint } | { error: string }>(() => {
    try {
      return { value: parseAmount(tax.trim().length === 0 ? '0' : tax, decimals) };
    } catch (error) {
      return { error: messageOf(error) };
    }
  }, [tax, decimals]);

  const taxValue = 'value' in parsedTax ? parsedTax.value : 0n;
  const total = subtotal + taxValue;

  // `issueInvoice` opens with `assertNotPaused()`, and `assertTermsValid` then
  // requires a buyer key that is set and is not the seller's own. Each of those
  // costs a minute of proving before the contract refuses the call, so the form
  // refuses first and says which one it is.
  const ownPartyKey = state?.partyKey;
  const buyerIsUs =
    ownPartyKey !== undefined &&
    isHex32(buyerKey) &&
    normaliseHex(buyerKey) === normaliseHex(ownPartyKey);

  const buyerKeyChecks: readonly (readonly [boolean, string])[] = [
    [!isHex32(buyerKey), 'A party key is 64 hexadecimal characters.'],
    [isZeroHex(buyerKey), 'A key of all zeroes belongs to nobody. The contract refuses it.'],
    [buyerIsUs, 'That is your own party key. The buyer has a different one.'],
  ];

  // The field stays quiet about an empty box, which is not a mistake until the
  // invoice is submitted. The submit button says that part.
  const buyerKeyProblem = buyerKey.trim().length === 0 ? undefined : blockedBy(buyerKeyChecks);

  // A coin public key has two spellings and a buyer will paste whichever their
  // wallet gave them: Bech32m from a browser wallet, 64 hex characters from a
  // locally built one. `parseCoinPublicKey` reads both and checks the length;
  // the earlier code here called `encodeCoinPublicKey`, which reads only hex and
  // therefore rejected every browser wallet's key outright.
  //
  // It runs on every keystroke, including the half-typed states, so what it
  // rejects has to arrive as a sentence beside the field rather than as an
  // exception on submit.
  const parsedBuyerPayout = useMemo<{ value: Uint8Array } | { error: string } | undefined>(() => {
    const typed = buyerPayout.trim();
    if (typed.length === 0) {
      return undefined;
    }
    try {
      return { value: parseCoinPublicKey(typed) };
    } catch {
      return { error: NOT_A_COIN_KEY };
    }
  }, [buyerPayout]);

  const buyerPayoutProblem =
    parsedBuyerPayout !== undefined && 'error' in parsedBuyerPayout
      ? parsedBuyerPayout.error
      : undefined;

  const hasArbiter = arbiterKey.trim().length > 0;
  const buyerPayoutBytes =
    parsedBuyerPayout !== undefined && 'value' in parsedBuyerPayout
      ? parsedBuyerPayout.value
      : undefined;

  // Both of these are refused by the contract at issuance, and both are easy to
  // do by accident: leave the field blank, or paste your own key into it because
  // it is the one on screen. Catching them here costs nothing. Letting them
  // through costs a proof, a failed transaction and a message written for a
  // circuit rather than for a person.
  //
  // The rule exists because the seller writes the terms and `resolveDispute`
  // pays the address those terms name. With no buyer address a ruling for the
  // buyer burns the escrow; with the seller's own address it pays the seller.
  // Either way the arbiter cannot actually rule against the party who named
  // them.
  const arbiterNeedsBuyerPayout = hasArbiter && buyerPayoutBytes === undefined;
  const buyerPayoutIsOurs =
    buyerPayoutBytes !== undefined && toHex(buyerPayoutBytes) === toHex(coinPublicKeyBytes);

  const blocked = blockedBy([
    [state?.paused === true, PAUSED_REASON],
    [buyerKey.trim().length === 0, 'Ask the buyer for their party key and paste it below.'],
    ...buyerKeyChecks,
    [
      buyerPayoutProblem !== undefined,
      'The buyer payout is the key their wallet gives out, or leave it empty.',
    ],
    [
      arbiterNeedsBuyerPayout,
      'An invoice with an arbiter needs the buyer’s payout key, or the arbiter has nowhere to send the money if they rule the buyer’s way.',
    ],
    [
      buyerPayoutIsOurs,
      'That is this wallet’s own payout key. The buyer’s has to be theirs, or a ruling in their favour would pay you.',
    ],
    [
      hasArbiter && !isHex32(arbiterKey),
      'The arbiter key is 64 hexadecimal characters, or leave it empty.',
    ],
  ]);

  const issue = useAction(
    async () => {
      // Both payouts go inside the terms commitment, so they are fixed here and
      // nowhere else. The seller's is this wallet's own; the buyer's only ever
      // matters if an arbiter rules their way, and an invoice without one simply
      // cannot be ruled that way.
      const draft: InvoiceDraft = {
        currency: currency.trim(),
        lineItems: items,
        taxAmount: taxValue,
        memo,
        orderRef,
        dueDate: fromLocalInputValue(dueDate),
        sellerPayout: coinPublicKeyBytes,
        ...(buyerPayoutBytes !== undefined ? { buyerPayout: buyerPayoutBytes } : {}),
      };
      const result = await api.issueInvoice(draft, fromHex(normaliseHex(buyerKey)), {
        ...(arbiterKey.trim().length > 0
          ? { arbiterKey: fromHex(normaliseHex(arbiterKey)) }
          : {}),
      });

      // Recorded only after the call returned: an invoice that was refused has
      // no id to file this under, and a stale archive entry would later be
      // offered to an auditor as if it described something real.
      writeArchive(contractAddress, result.invoiceId, {
        currency: draft.currency.toUpperCase(),
        lineItems: toArchivedLineItems(items),
        memo,
        orderRef,
        decimals,
      });

      await refresh();
      return result;
    },
    'Building the proof and submitting. This can take a minute.',
  );

  const share = useAction(async (invoiceId: string) => {
    const payload = await api.exportInvoice(invoiceId);
    setShared(payload);
    return payload;
  }, 'Assembling the record');

  const validate = useCallback((): string | undefined => {
    if (blocked !== undefined) {
      return blocked;
    }
    if (items.length === 0) {
      return 'An invoice needs at least one line that parses.';
    }
    if (items.length !== lines.length) {
      return 'One of the lines is incomplete. Fix it or remove it.';
    }
    if ('error' in parsedTax) {
      return parsedTax.error;
    }
    if (taxValue > subtotal) {
      return 'The contract refuses a tax larger than the line-item subtotal.';
    }
    if (currency.trim().length === 0) {
      return 'A currency code is required.';
    }
    try {
      const due = fromLocalInputValue(dueDate);
      if (due <= daysFromNow(0)) {
        return 'The contract refuses a due date that is not after the moment of issuance.';
      }
    } catch (error) {
      return messageOf(error);
    }
    return undefined;
  }, [blocked, items, lines, parsedTax, taxValue, subtotal, currency, dueDate]);

  const onSubmit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const problem = validate();
      setFormError(problem);
      if (problem === undefined) {
        void issue.run();
      }
    },
    [validate, issue],
  );

  const download = useCallback((invoiceId: string, payload: string) => {
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `quietbooks-invoice-${invoiceId.slice(0, 12)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  if (issue.state.status === 'done') {
    const { invoiceId } = issue.state.value;
    return (
      <div className="stack-lg" style={{ maxWidth: 820 }}>
        <div className="page-head">
          <div>
            <h1>Invoice issued</h1>
            <p className="note">
              The anchor is on chain. The terms are not: they are in this browser, and in
              whatever you send the buyer next.
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-body stack">
            <dl className="facts">
              <dt>Invoice id</dt>
              <dd>
                <Digest value={invoiceId} label="the invoice id" lead={20} tail={12} />
              </dd>
              <dt>Amount due</dt>
              <dd className="figure">
                {formatAmount(total, decimals)} {currency.trim().toUpperCase()}
              </dd>
              <dt>Buyer key</dt>
              <dd>
                <Digest value={normaliseHex(buyerKey)} label="the buyer key" />
              </dd>
            </dl>
          </div>

          <div className="panel-body stack">
            <div className="callout callout-accent">
              <span className="callout-title">The buyer needs this record to pay you</span>
              It carries the terms and the openings that prove them. Without it the buyer
              cannot settle, and no auditor can check anything about this invoice. The chain
              does not carry it and never will: send it over whatever channel you already
              trust with your commercial terms.
            </div>

            <div className="row-wrap">
              <button
                type="button"
                className="button button-primary"
                disabled={share.busy}
                onClick={() => void share.run(invoiceId)}
              >
                Share record
              </button>
              {shared !== undefined && (
                <>
                  <CopyButton value={shared} label="the invoice record" />
                  <button
                    type="button"
                    className="button"
                    onClick={() => download(invoiceId, shared)}
                  >
                    Download JSON
                  </button>
                </>
              )}
            </div>

            <ActionFeedback state={share.state} />

            {shared !== undefined && (
              <TextAreaField
                label="Invoice record"
                value={shared}
                onChange={() => undefined}
                rows={14}
                hint="Plain JSON, so it survives an email, a ticket, or a shared drive."
              />
            )}
          </div>

          <div className="panel-foot">
            <a className="button" href={routePath({ name: 'invoice', invoiceId })}>
              Open this invoice
            </a>
            <button
              type="button"
              className="button button-quiet"
              onClick={() => {
                issue.reset();
                share.reset();
                setShared(undefined);
                setLines([emptyLine(nextKey)]);
                setNextKey((key) => key + 1);
                setBuyerKey('');
                // Cleared with the rest of the counterparty: a payout key left
                // over from the last invoice would name the wrong buyer on this
                // one, and only a dispute would reveal it.
                setBuyerPayout('');
                setArbiterKey('');
                setMemo('');
                setOrderRef('');
                setTax('0');
              }}
            >
              Write another
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form className="stack-lg" onSubmit={onSubmit} style={{ maxWidth: 900 }}>
      <div className="page-head">
        <div>
          <h1>New invoice</h1>
          <p className="note">
            You are the seller. Everything below stays off the chain except the buyer key, the
            due date and the commitments derived from the rest.
          </p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Lines</h2>
          <span className="small quiet">
            Amounts are whole numbers in the currency’s smallest unit. The decimal position is
            a property of this invoice, recorded by this browser.
          </span>
        </div>
        <div className="panel-body stack">
          <table className="line-items">
            <thead>
              <tr>
                <th scope="col">Description</th>
                <th scope="col" style={{ width: 110 }}>
                  Quantity
                </th>
                <th scope="col" style={{ width: 150 }}>
                  Unit price
                </th>
                <th scope="col" className="right" style={{ width: 150 }}>
                  Line total
                </th>
                <th scope="col">
                  <span className="visually-hidden">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, index) => {
                const parsed = parsedLines[index];
                const lineTotal = 'item' in parsed ? parsed.item.quantity * parsed.item.unitPrice : undefined;
                return (
                  <tr key={line.key}>
                    <td>
                      <label className="visually-hidden" htmlFor={`line-${line.key}-description`}>
                        Description of line {index + 1}
                      </label>
                      <input
                        id={`line-${line.key}-description`}
                        type="text"
                        value={line.description}
                        placeholder="What was supplied"
                        onChange={(event) =>
                          setLines((current) =>
                            current.map((item, position) =>
                              position === index
                                ? { ...item, description: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="field-figure">
                      <label className="visually-hidden" htmlFor={`line-${line.key}-quantity`}>
                        Quantity on line {index + 1}
                      </label>
                      <input
                        id={`line-${line.key}-quantity`}
                        type="text"
                        inputMode="numeric"
                        value={line.quantity}
                        onChange={(event) =>
                          setLines((current) =>
                            current.map((item, position) =>
                              position === index
                                ? { ...item, quantity: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="field-figure">
                      <label className="visually-hidden" htmlFor={`line-${line.key}-price`}>
                        Unit price on line {index + 1}
                      </label>
                      <input
                        id={`line-${line.key}-price`}
                        type="text"
                        inputMode="decimal"
                        value={line.unitPrice}
                        placeholder={decimals === 0 ? '0' : `0.${'0'.repeat(decimals)}`}
                        onChange={(event) =>
                          setLines((current) =>
                            current.map((item, position) =>
                              position === index
                                ? { ...item, unitPrice: event.target.value }
                                : item,
                            ),
                          )
                        }
                      />
                    </td>
                    <td className="right">
                      {lineTotal === undefined ? (
                        <span className="line-total field-error">
                          {'error' in parsed ? parsed.error : ''}
                        </span>
                      ) : (
                        <span className="line-total">{formatAmount(lineTotal, decimals)}</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button button-quiet button-small"
                        style={{ marginTop: 4 }}
                        disabled={lines.length === 1}
                        title={
                          lines.length === 1
                            ? 'An invoice needs at least one line'
                            : `Remove line ${index + 1}`
                        }
                        onClick={() =>
                          setLines((current) =>
                            current.filter((_, position) => position !== index),
                          )
                        }
                      >
                        Remove
                        <span className="visually-hidden"> line {index + 1}</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="row">
            <button
              type="button"
              className="button button-small"
              onClick={() => {
                setLines((current) => [...current, emptyLine(nextKey)]);
                setNextKey((key) => key + 1);
              }}
            >
              Add a line
            </button>
          </div>

          <dl className="totals">
            <dt>Subtotal</dt>
            <dd>{formatAmount(subtotal, decimals)}</dd>
            <dt>Tax</dt>
            <dd>{formatAmount(taxValue, decimals)}</dd>
            <div style={{ display: 'contents' }} className="grand">
              <dt>Total due</dt>
              <dd>
                {formatAmount(total, decimals)} {currency.trim().toUpperCase()}
              </dd>
            </div>
          </dl>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Terms</h2>
        </div>
        <div className="panel-body stack">
          <div className="field-row">
            <TextField
              label="Currency"
              value={currency}
              onChange={setCurrency}
              placeholder="USD"
              hint="Any code, up to 32 characters. Held as text, so a token the contract has never heard of still works."
            />
            <SelectField
              label="Decimal places"
              value={decimalsText}
              options={DECIMALS.map((option) => ({ value: option.value, label: option.label }))}
              onChange={setDecimalsText}
              hint="How this invoice’s amounts are written. The contract only ever sees the integer."
            />
            <TextField
              label="Tax"
              value={tax}
              onChange={setTax}
              inputMode="decimal"
              error={'error' in parsedTax ? parsedTax.error : undefined}
              hint="On top of the subtotal. The contract refuses a tax larger than it."
            />
          </div>

          <div className="field-row">
            <TextField
              label="Due date"
              type="date"
              value={dueDate}
              onChange={setDueDate}
              hint="Public on the anchor. It has to be after the moment of issuance."
            />
            <TextField
              label="Order reference"
              value={orderRef}
              onChange={setOrderRef}
              placeholder="PO-4471"
              hint="Only its digest reaches the chain. Optional."
            />
          </div>

          <TextAreaField
            label="Memo"
            value={memo}
            onChange={setMemo}
            rows={3}
            placeholder="Anything the buyer should read with this invoice"
            hint="Only its digest reaches the chain. Optional."
          />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Parties</h2>
        </div>
        <div className="panel-body stack">
          <div className="field">
            <span className="field-label">Where you will be paid</span>
            <Digest value={coinPublicKey} label="your coin public key" lead={24} tail={10} />
            <span className="field-hint">
              The coin public key of the wallet connected here. It goes into the terms
              commitment at issuance, and every circuit that pays this invoice compares its
              recipient against it, so the money can only ever arrive here.
            </span>
          </div>
          <TextField
            label="Buyer party key"
            value={buyerKey}
            onChange={setBuyerKey}
            mono
            placeholder="64 hexadecimal characters"
            hint="Ask the buyer for the key on their header, not the one on yours. It is derived from their secret and this deployment’s salt, so it is theirs alone and only here."
            error={buyerKeyProblem}
          />
          <TextField
            label="Buyer’s coin public key (optional)"
            value={buyerPayout}
            onChange={setBuyerPayout}
            mono
            placeholder="Required if you name an arbiter below"
            hint="Where the buyer is paid if an arbiter rules a dispute their way. Required once you name an arbiter below, and it has to be theirs rather than yours. Ask them for it: it is not their party key, which is a hash and cannot receive anything."
            error={
              buyerPayoutProblem ??
              (buyerPayoutIsOurs
                ? 'This is your own payout key, not the buyer’s.'
                : arbiterNeedsBuyerPayout
                  ? 'Needed, because this invoice names an arbiter.'
                  : undefined)
            }
          />
          <TextField
            label="Arbiter party key (optional)"
            value={arbiterKey}
            onChange={setArbiterKey}
            mono
            placeholder="Leave empty for no arbiter"
            hint="Name one now or not at all. A dispute can only be resolved by an arbiter named at issuance, so neither side can appoint one later."
            error={
              arbiterKey.trim().length > 0 && !isHex32(arbiterKey)
                ? 'A party key is 64 hexadecimal characters.'
                : undefined
            }
          />
          {arbiterKey.trim().length > 0 && buyerPayout.trim().length === 0 && (
            <div className="callout callout-warn">
              <span className="callout-title">
                This invoice names an arbiter but nowhere to pay the buyer
              </span>
              A ruling in the buyer’s favour has to send the escrowed coin somewhere, and that
              address is fixed at issuance like the rest of the terms. Issue it as it stands and
              the arbiter will only be able to rule for you.
            </div>
          )}
        </div>
        <div className="panel-foot">
          <button
            type="submit"
            className="button button-primary"
            disabled={issue.busy || blocked !== undefined}
            title={blocked}
          >
            Issue invoice
          </button>
          <button
            type="button"
            className="button"
            disabled={issue.busy}
            onClick={() => navigate({ name: 'invoices' })}
          >
            Discard
          </button>
          {blocked !== undefined && <span className="small quiet">{blocked}</span>}
          <ActionFeedback state={issue.state} />
          {formError !== undefined && issue.state.status !== 'working' && (
            <span className="field-error" role="alert">
              {formError}
            </span>
          )}
        </div>
      </div>
    </form>
  );
};
