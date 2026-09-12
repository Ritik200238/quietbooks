// Plain-text formatting: money, dates, identifiers and aligned tables.
//
// SPDX-License-Identifier: Apache-2.0
//
// No colour and no box drawing. A terminal that renders one of them badly
// renders all of them badly, and an invoice table that a judge cannot read on
// their own machine is worse than a plain one that they can.

import { unpadBytes32 } from '@quietbooks/contract';

/** Everything the CLI shows the operator goes through here, never console.log. */
export const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * Group an integer with thousands separators.
 *
 * Amounts are bigints in the currency's smallest unit, so this never touches
 * floating point: a cent lost to a rounding error in a formatter is still a cent
 * that disagrees with the commitment on chain.
 */
export const groupDigits = (value: bigint): string => {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) {
      out += ',';
    }
    out += digits[i];
  }
  return negative ? `-${out}` : out;
};

/** `1,234,500 USD`. The code is always present so no figure is unit-less. */
export const money = (value: bigint, currency: string): string =>
  `${groupDigits(value)} ${currency}`;

/** Read a currency back out of the 32-byte padded form the ledger commits to. */
export const currencyOf = (currency: Uint8Array): string => {
  const code = unpadBytes32(currency).trim();
  return code.length === 0 ? '???' : code;
};

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

const toDate = (unixSeconds: bigint): Date => new Date(Number(unixSeconds) * 1000);

/** `2026-09-20`, UTC. Short enough for a table column. */
export const formatDate = (unixSeconds: bigint): string => {
  if (unixSeconds === 0n) {
    return '—';
  }
  return toDate(unixSeconds).toISOString().slice(0, 10);
};

/** `2026-09-20 14:03:00 UTC`. For detail views, where precision matters. */
export const formatTimestamp = (unixSeconds: bigint): string => {
  if (unixSeconds === 0n) {
    return '—';
  }
  return `${toDate(unixSeconds).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
};

export const daysBetween = (from: bigint, to: bigint): number =>
  Math.round(Number(to - from) / 86_400);

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/** Enough of an invoice id to pick it out of a list, and to retype. */
export const shortId = (invoiceId: string): string => invoiceId.slice(0, 12);

/** Digests are shown in full in detail views and abbreviated everywhere else. */
export const shortHex = (hex: string, keep = 16): string =>
  hex.length <= keep ? hex : `${hex.slice(0, keep)}…`;

/** A 32-byte key that has never been set reads as absent, not as a real key. */
export const isZeroHex = (hex: string): boolean => /^0*$/.test(hex);

export const keyOrNone = (hex: string): string => (isZeroHex(hex) ? 'none' : hex);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export type Alignment = 'left' | 'right';

/**
 * A column-aligned table with a rule under the header.
 *
 * Column widths come from the content, so a single long currency code or an
 * eight-figure amount widens its own column instead of wrapping into the next
 * one.
 */
export const renderTable = (
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  alignments: readonly Alignment[] = [],
): string => {
  const widths = headers.map((header, column) =>
    rows.reduce((widest, row) => Math.max(widest, (row[column] ?? '').length), header.length),
  );

  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => {
        const width = widths[column] ?? cell.length;
        return (alignments[column] ?? 'left') === 'right'
          ? cell.padStart(width)
          : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();

  return [line(headers), widths.map((width) => '-'.repeat(width)).join('  '), ...rows.map(line)].join(
    '\n',
  );
};

/**
 * `label: value` blocks, with the labels aligned to one another.
 *
 * `indent` exists so a block can sit visibly underneath a section heading
 * rather than level with it, which is the difference between a detail view that
 * reads as a structure and one that reads as a wall.
 */
export const renderFields = (
  fields: readonly (readonly [string, string])[],
  indent = 2,
): string => {
  const width = fields.reduce((widest, [label]) => Math.max(widest, label.length), 0);
  const pad = ' '.repeat(indent);
  return fields.map(([label, value]) => `${pad}${label.padEnd(width)}  ${value}`).join('\n');
};

export const heading = (title: string): string => `\n${title}\n${'='.repeat(title.length)}`;
