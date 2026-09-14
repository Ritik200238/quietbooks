// Display formatting.
//
// SPDX-License-Identifier: Apache-2.0
//
// Every amount in QuietBooks is an integer in the currency's smallest unit .. the
// contract has no notion of decimal places, and inventing one silently would be
// a way to show a number that is off by a factor of a hundred. So the decimal
// position is a display setting, it is recorded per invoice by the wallet that
// issued it, and the raw integer stays visible wherever it matters.

const GROUPER = new Intl.NumberFormat('en-US');

/** Decimal places assumed for an invoice whose issuing wallet is not this one. */
export const ASSUMED_DECIMALS = 2;

/**
 * An integer in minor units, rendered with a decimal point.
 *
 * The split is done on the digit string rather than by dividing, because the
 * amounts are `bigint` and a divide would drop the remainder.
 */
export const formatAmount = (minorUnits: bigint, decimals: number): string => {
  const negative = minorUnits < 0n;
  const digits = (negative ? -minorUnits : minorUnits).toString();

  if (decimals <= 0) {
    return `${negative ? '-' : ''}${GROUPER.format(BigInt(digits))}`;
  }

  const padded = digits.padStart(decimals + 1, '0');
  const major = padded.slice(0, padded.length - decimals);
  const minor = padded.slice(padded.length - decimals);
  return `${negative ? '-' : ''}${GROUPER.format(BigInt(major))}.${minor}`;
};

export const formatMoney = (minorUnits: bigint, currency: string, decimals: number): string =>
  `${formatAmount(minorUnits, decimals)} ${currency}`;

/**
 * Read a typed amount back into minor units.
 *
 * Rejects rather than rounds: "10.005" at two decimal places is a typo or a
 * misunderstanding about the unit, and quietly turning it into 10.01 would put a
 * number on an invoice that the person never typed.
 */
export const parseAmount = (text: string, decimals: number): bigint => {
  const trimmed = text.trim().replace(/,/g, '');
  if (trimmed.length === 0) {
    throw new Error('enter an amount');
  }
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error('amounts are digits, with an optional decimal point');
  }
  const [major, minor = ''] = trimmed.split('.');
  if (minor.length > decimals) {
    throw new Error(
      `this invoice uses ${decimals} decimal place${decimals === 1 ? '' : 's'}, so "${trimmed}" cannot be represented exactly`,
    );
  }
  return BigInt(major + minor.padEnd(decimals, '0'));
};

/** Digits only, for quantities. */
export const parseCount = (text: string): bigint => {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('enter a quantity');
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('quantities are whole numbers');
  }
  return BigInt(trimmed);
};

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

export const isHex32 = (text: string): boolean => /^(0x)?[0-9a-fA-F]{64}$/.test(text.trim());

export const normaliseHex = (text: string): string => {
  const trimmed = text.trim();
  return (trimmed.startsWith('0x') ? trimmed.slice(2) : trimmed).toLowerCase();
};

/**
 * A digest as a person can carry it in their eye: enough of the head and tail to
 * compare two of them, never enough to retype by hand. Every place this is used
 * puts a copy button beside it.
 */
export const truncateHex = (hex: string, lead = 10, tail = 8): string => {
  const clean = normaliseHex(hex);
  if (clean.length <= lead + tail + 1) {
    return clean;
  }
  return `${clean.slice(0, lead)}…${clean.slice(-tail)}`;
};

export const isZeroHex = (hex: string): boolean => /^(0x)?0*$/.test(hex.trim());

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** ISO-style, because a B2B invoice crosses locales and 03/04 is ambiguous. */
export const formatDate = (unixSeconds: bigint): string => {
  if (unixSeconds === 0n) {
    return '—';
  }
  const date = new Date(Number(unixSeconds) * 1000);
  return date.toISOString().slice(0, 10);
};

/**
 * Date and time, both in UTC, and labelled.
 *
 * This used to compose `formatDate`, which is `toISOString` and therefore UTC,
 * with `toTimeString`, which is local. For a reader at UTC+5:30 a settlement at
 * 02:00 their time rendered as the previous day's date beside the right clock
 * time, with nothing on screen saying which half was in which zone. It is used
 * for the escrow deadline the refund card reads out and for audit grant
 * expiries, where a reader being a day out about a deadline matters.
 *
 * UTC throughout, because these are chain timestamps and the chain has no
 * locale, and marked so nobody has to guess which one they are looking at.
 */
export const formatDateTime = (unixSeconds: bigint): string => {
  if (unixSeconds === 0n) {
    return '—';
  }
  const iso = new Date(Number(unixSeconds) * 1000).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
};

/** "in 14 days" / "9 days ago" / "today", for a due date column. */
export const relativeDays = (unixSeconds: bigint, now: bigint): string => {
  const days = Math.round(Number(unixSeconds - now) / 86_400);
  if (days === 0) {
    return 'today';
  }
  if (days > 0) {
    return `in ${days} day${days === 1 ? '' : 's'}`;
  }
  return `${-days} day${days === -1 ? '' : 's'} ago`;
};

/** The value a `datetime-local` input wants, from unix seconds. */
export const toLocalInputValue = (unixSeconds: bigint): string => {
  const date = new Date(Number(unixSeconds) * 1000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};

/** Unix seconds from a `date` or `datetime-local` input value. */
export const fromLocalInputValue = (value: string): bigint => {
  const parsed = Date.parse(value.length === 10 ? `${value}T23:59:59` : value);
  if (Number.isNaN(parsed)) {
    throw new Error('that is not a date this browser understands');
  }
  return BigInt(Math.floor(parsed / 1000));
};

export const todayInputValue = (daysAhead: number): string => {
  const date = new Date(Date.now() + daysAhead * 86_400_000);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** The message a person should see for anything thrown. */
export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
