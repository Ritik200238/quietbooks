// Menu: selective-disclosure audit grants.
//
// SPDX-License-Identifier: Apache-2.0
//
// The audit key is generated here and printed once. It is deliberately not
// written to private state: the chain records only its hash, and a key sitting
// in a wallet store next to the invoice it opens would undo the separation the
// design is built on. If the operator loses it, the grant is revoked and a new
// one is issued .. which is the intended failure mode.

import { daysFromNow, randomBytes32, SCOPES, sha256, toHex, type ScopeVector } from '@quietbooks/contract';

import type { AppContext } from '../context.js';
import { formatTimestamp, heading, out, renderFields } from '../format.js';
import { confirmRole, selectInvoice } from '../select.js';

/** What each slot actually discloses, so the choice is made knowingly. */
const SCOPE_DESCRIPTIONS: Readonly<Record<(typeof SCOPES)[number], string>> = {
  amount: 'the principal, in the smallest unit',
  tax: 'the tax charged on top of the principal',
  dueDate: 'the payment deadline',
  buyer: "the buyer's party key",
  seller: "the seller's party key",
  currency: 'the currency code',
  items: 'the full line-item list, as text',
  memo: 'the memo text',
  orderRef: 'the order reference text',
};

const askScopes = async (context: AppContext): Promise<ScopeVector | undefined> => {
  out('  Fields the auditor will be able to open:');
  SCOPES.forEach((scope, index) => {
    out(`    ${index + 1}. ${scope.padEnd(9)} ${SCOPE_DESCRIPTIONS[scope]}`);
  });
  out('  Enter the numbers to disclose, separated by commas, or "all".');

  for (;;) {
    const answer = (await context.ask.line('  Fields')).trim().toLowerCase();
    if (answer === 'all') {
      return SCOPES.map(() => true);
    }

    const parts = answer.split(/[,\s]+/).filter((part) => part.length > 0);
    const chosen = new Set<number>();
    let bad = false;
    for (const part of parts) {
      const value = Number(part);
      if (!Number.isInteger(value) || value < 1 || value > SCOPES.length) {
        out(`    ("${part}" is not one of 1-${SCOPES.length})`);
        bad = true;
        break;
      }
      chosen.add(value - 1);
    }
    if (bad) {
      continue;
    }
    if (chosen.size === 0) {
      // The circuit refuses an empty grant, and it should: a grant that
      // discloses nothing is an on-chain record of an authorisation that could
      // never be used.
      out('    (a grant has to cover at least one field)');
      continue;
    }
    return SCOPES.map((_, index) => chosen.has(index));
  }
};

const grantAudit = async (context: AppContext): Promise<void> => {
  out(heading('Grant an auditor access to specific fields'));

  const view = await selectInvoice(context, '  Grant on which invoice?');
  if (view === undefined) {
    return;
  }
  if (!(await confirmRole(context, view, 'seller', 'grant an audit'))) {
    out('  Nothing was sent.');
    return;
  }

  const scopes = await askScopes(context);
  if (scopes === undefined) {
    return;
  }
  const expiryDays = await context.ask.days('  Grant expires in how many days?', 30);
  const expiresAt = daysFromNow(expiryDays);

  // sha256 of the key is exactly what `auditKeyHash` in the contract package's
  // audit module computes, and what `validateAuditEnvelope` checks a key against.
  // That module is not re-exported from the package entry point, so the same
  // derivation is spelled out here rather than reached for across a package
  // boundary that is not open.
  const auditKey = randomBytes32();
  const keyHash = await sha256(auditKey);
  const disclosed = SCOPES.filter((_, index) => scopes[index]);

  out('');
  out(
    renderFields([
      ['Invoice', view.invoiceId],
      ['Fields disclosed', disclosed.join(', ')],
      ['Expires', formatTimestamp(expiresAt)],
      ['Audit key hash', toHex(keyHash)],
      ['On chain', 'the hash, the field list and the expiry .. never the key'],
    ]),
  );
  out('');

  if (!(await context.ask.yesNo('  Publish this grant?', false))) {
    out('  Nothing was sent, and the key just generated is discarded.');
    return;
  }

  out('  Proving and submitting.');
  await context.api.grantAudit(view.invoiceId, keyHash, scopes, expiresAt);

  out('');
  out('  Grant published.');
  out('');
  out(`  AUDIT KEY: ${toHex(auditKey)}`);
  out('');
  out('  This is shown once and is stored nowhere. Send it to the auditor with the');
  out('  audit envelope, over a channel you trust. The chain holds only its hash, so');
  out('  nobody reading the ledger can open anything with what is published there.');
  out('  Lose it and the remedy is to revoke this grant and issue a new one.');
};

const revokeAudit = async (context: AppContext): Promise<void> => {
  out(heading('Revoke an audit grant'));
  out('  Revocation takes effect immediately and beats the expiry date. An auditor');
  out('  who already decrypted the envelope still has what they read .. revocation');
  out('  withdraws the authorisation, it does not unsee anything.');
  out('');

  const view = await selectInvoice(context, '  Revoke the grant on which invoice?');
  if (view === undefined) {
    return;
  }
  if (view.auditGrant === undefined) {
    out('  That invoice has no audit grant to revoke.');
    return;
  }
  if (!(await confirmRole(context, view, 'seller', 'revoke the grant'))) {
    out('  Nothing was sent.');
    return;
  }

  if (!(await context.ask.yesNo('  Revoke it?', false))) {
    out('  Nothing was sent.');
    return;
  }

  await context.api.revokeAudit(view.invoiceId);
  out(`  Grant on ${view.invoiceId} revoked.`);
};

const AUDIT_MENU = `
  Audit
    1. Grant an auditor access to specific fields
    2. Revoke a grant
    0. Back`;

export const auditMenu = async (context: AppContext): Promise<void> => {
  const choice = await context.ask.menu(AUDIT_MENU, ['1', '2', '0']);
  switch (choice) {
    case '1':
      return grantAudit(context);
    case '2':
      return revokeAudit(context);
    default:
      return;
  }
};
