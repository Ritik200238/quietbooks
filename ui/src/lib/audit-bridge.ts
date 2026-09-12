// The audit envelope, as this interface uses it.
//
// SPDX-License-Identifier: Apache-2.0
//
// Nothing cryptographic happens in this file. The envelope is built, opened and
// checked by `@quietbooks/contract`, whose implementation recomputes the nine
// field commitments through the compiled circuits themselves .. reimplementing
// any of that here would be a second source of truth that could drift from the
// contract and produce envelopes no auditor could verify.
//
// What this file does is name the narrow slice of that module the interface
// depends on, and fail with a sentence a person can act on if the contract
// package in the tree does not export it, instead of a blank screen.

import * as contractPackage from '@quietbooks/contract';
import type { PreparedInvoice, ScopeName, TermsFrame } from '@quietbooks/contract';

/** One field an envelope discloses, with everything needed to check it. */
export type DisclosedField = {
  readonly value: string;
  readonly salt: string;
  readonly plaintext: string | null;
};

/** The envelope as it travels: JSON, safe to attach to an email. */
export type AuditEnvelope = {
  readonly version: string;
  readonly invoiceId: string;
  readonly network: string;
  readonly contractAddress: string;
  readonly scopeMask: number;
  readonly expiresAt: string;
  readonly auditKeyHash: string;
  readonly encryption: {
    readonly algorithm: string;
    readonly iv: string;
    readonly authTag: string;
    readonly ciphertext: string;
  };
  readonly integrity: { readonly payloadHash: string };
};

/** The parts of the on-chain anchor an auditor checks an envelope against. */
export type AuditAnchor = {
  readonly fieldRoot: Uint8Array;
  readonly terms: Uint8Array;
};

/** The on-chain grant, as the validator needs it. */
export type AuditGrantView = {
  readonly auditKeyHash: Uint8Array;
  readonly scopes: readonly boolean[];
  readonly expiresAt: bigint;
  readonly revoked: boolean;
};

export type Check = {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
};

export type ValidationReport = {
  readonly ok: boolean;
  readonly checks: readonly Check[];
};

export type BuildAuditEnvelopeArgs = {
  readonly invoiceId: Uint8Array;
  readonly frame: TermsFrame;
  readonly prepared: PreparedInvoice;
  readonly scopes: readonly boolean[];
  readonly expiresAt: bigint;
  readonly auditKey: Uint8Array;
  readonly network: string;
  readonly contractAddress: string;
};

export type ValidateAuditEnvelopeArgs = {
  readonly envelope: AuditEnvelope;
  readonly auditKey: Uint8Array;
  readonly anchor: AuditAnchor;
  readonly grant: AuditGrantView;
  readonly now: bigint;
};

/** Exactly the surface this interface calls. */
type AuditModule = {
  readonly buildAuditEnvelope: (args: BuildAuditEnvelopeArgs) => Promise<AuditEnvelope>;
  readonly validateAuditEnvelope: (
    args: ValidateAuditEnvelopeArgs,
  ) => Promise<ValidationReport>;
  readonly formatValidationReport: (report: ValidationReport) => string;
  readonly deriveAuditKey: () => Uint8Array;
  readonly auditKeyHash: (key: Uint8Array) => Promise<Uint8Array>;
};

const available = contractPackage as unknown as Partial<AuditModule>;

const required = <K extends keyof AuditModule>(name: K): AuditModule[K] => {
  const fn = available[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `The installed @quietbooks/contract does not export ${name}. Audit envelopes are ` +
        'built and checked there, never here, so this screen cannot run until the ' +
        'contract package exports its audit module.',
    );
  }
  return fn as AuditModule[K];
};

export const buildAuditEnvelope = (args: BuildAuditEnvelopeArgs): Promise<AuditEnvelope> =>
  required('buildAuditEnvelope')(args);

export const validateAuditEnvelope = (
  args: ValidateAuditEnvelopeArgs,
): Promise<ValidationReport> => required('validateAuditEnvelope')(args);

export const formatValidationReport = (report: ValidationReport): string =>
  required('formatValidationReport')(report);

export const deriveAuditKey = (): Uint8Array => required('deriveAuditKey')();

export const auditKeyHash = (key: Uint8Array): Promise<Uint8Array> =>
  required('auditKeyHash')(key);

/** True when the contract package in this tree can build and check envelopes. */
export const auditModuleAvailable = (): boolean =>
  typeof available.buildAuditEnvelope === 'function' &&
  typeof available.validateAuditEnvelope === 'function';

/**
 * A plain-language name for each of the nine disclosable fields.
 *
 * The scope names are the contract's, and they are what an auditor sees in the
 * envelope, so both are shown: the label to choose by, the name to check against.
 */
export const SCOPE_LABELS: Readonly<Record<ScopeName, { title: string; detail: string }>> = {
  amount: {
    title: 'Amount',
    detail: 'The invoice principal, before tax.',
  },
  tax: {
    title: 'Tax',
    detail: 'The tax charged on top of the principal.',
  },
  dueDate: {
    title: 'Due date',
    detail: 'Already public on the anchor. Disclosing it lets the auditor tie it to the terms.',
  },
  buyer: {
    title: 'Buyer key',
    detail: 'The buyer party key. Already public on the anchor.',
  },
  seller: {
    title: 'Seller key',
    detail: 'The seller party key. Already public on the anchor.',
  },
  currency: {
    title: 'Currency',
    detail: 'The currency code the amounts are denominated in.',
  },
  items: {
    title: 'Line items',
    detail: 'Every line: description, quantity and unit price.',
  },
  memo: {
    title: 'Memo',
    detail: 'The free-text note on the invoice.',
  },
  orderRef: {
    title: 'Order reference',
    detail: 'The seller’s own reference, such as a purchase-order number.',
  },
};

/** The scopes whose disclosure needs text this browser only has if it issued the invoice. */
export const TEXT_SCOPES: readonly ScopeName[] = ['currency', 'items', 'memo', 'orderRef'];
