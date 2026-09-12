// Which QuietBooks identity this process is acting as.
//
// SPDX-License-Identifier: Apache-2.0
//
// Two parties are the whole point of an invoice, and demonstrating one needs two
// wallets that do not share a private state store: LevelDB takes a directory
// lock, so a second CLI pointed at the same store would simply fail to open it.
//
// `--identity <label>` (or QUIETBOOKS_IDENTITY) gives each side its own store and
// its own root secret, and therefore its own party key. With no label the store
// name is exactly `quietbooks-private-state` and the root secret depends on the
// wallet seed alone, so the default single-wallet behaviour is unchanged.

const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/i;

export const identityLabel = (): string | undefined => {
  const flagIndex = process.argv.indexOf('--identity');
  const fromFlag = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  const raw = (fromFlag ?? process.env.QUIETBOOKS_IDENTITY ?? '').trim();
  if (raw.length === 0) {
    return undefined;
  }
  if (!LABEL_PATTERN.test(raw)) {
    // The label becomes part of a directory name, so anything that could escape
    // it is refused rather than quietly sanitised into a different store than
    // the operator asked for.
    //
    // This is the one place the CLI exits directly instead of raising: the
    // check runs while the configuration module is still being imported, before
    // there is a logger to report through or a wallet to shut down, and a stack
    // trace here would bury a one-line typo.
    process.stderr.write(
      `--identity "${raw}" is not usable: letters, digits and hyphens only, 32 characters at most\n`,
    );
    process.exit(1);
  }
  return raw.toLowerCase();
};

/** The private state store for this identity. Unsuffixed when there is none. */
export const storeNameFor = (base: string): string => {
  const label = identityLabel();
  return label === undefined ? base : `${base}-${label}`;
};
