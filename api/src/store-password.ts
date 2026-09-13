// The passphrase that encrypts the local private-state store.
//
// SPDX-License-Identifier: Apache-2.0
//
// `levelPrivateStateProvider` encrypts its LevelDB store and enforces a policy
// on the passphrase: at least sixteen characters, drawn from at least three of
// uppercase, lowercase, digits and punctuation. It does not check at
// construction time. It checks on the first write, which for a deploy means
// after the proof has been generated and the transaction has already been
// accepted by the node -- the contract is live, and the caller sees
// `PasswordValidationError` with no way to tell that anything landed.
//
// So the rule lives here and is applied before any of that happens.

/** Minimum length `levelPrivateStateProvider` accepts. */
const MIN_LENGTH = 16;

/** Minimum number of distinct character classes it accepts. */
const MIN_CLASSES = 3;

const CLASSES: readonly RegExp[] = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/];

/**
 * The default for a store that sits on the operator's own disk under their own
 * account, where the passphrase is not the thing protecting the data.
 *
 * It is not a secret and is not treated as one. Anywhere the store does need a
 * real passphrase, supply one.
 */
export const DEFAULT_STORE_PASSWORD = 'QuietBooks-local-store-1';

export class StorePasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorePasswordError';
  }
}

/** Why `password` is unacceptable, or `undefined` if it is fine. */
export const storePasswordProblem = (password: string): string | undefined => {
  if (password.length < MIN_LENGTH) {
    return `it is ${password.length} characters; the store requires at least ${MIN_LENGTH}`;
  }
  const classes = CLASSES.filter((pattern) => pattern.test(password)).length;
  if (classes < MIN_CLASSES) {
    return (
      `it uses ${classes} of uppercase, lowercase, digits and punctuation; ` +
      `the store requires at least ${MIN_CLASSES}`
    );
  }
  return undefined;
};

/**
 * Check a passphrase now rather than letting the store reject it mid-deploy.
 *
 * @param source Where the value came from, so the message says what to change.
 */
export const assertStorePassword = (password: string, source: string): string => {
  const problem = storePasswordProblem(password);
  if (problem !== undefined) {
    throw new StorePasswordError(`${source} cannot be used to encrypt the private state store: ${problem}.`);
  }
  return password;
};
