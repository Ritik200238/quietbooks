// A durable private-state provider for the browser.
//
// SPDX-License-Identifier: Apache-2.0
//
// The bulletin-board example keeps private state in memory, which is fine for a
// board where the only secret is a password you can retype. It is not fine here.
// An invoice's openings .. the terms, the terms salt and the nine field salts ..
// are the only way anyone will ever prove anything about that invoice again.
// Losing them on a page reload would leave an invoice on chain that nobody can
// open and no auditor can check, and there is no recovery path from that.
//
// So state is written to `localStorage`, synchronously, keyed by contract
// address. `localStorage` is the right store for this despite its size limit: it
// is synchronous (no window between "the write returned" and "the write
// happened"), it survives a reload and a browser restart, and the records are
// small. It is *not* a backup .. clearing site data destroys it .. and the
// interface says so where the user can act on it.

import type { ContractAddress, SigningKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import type {
  ExportPrivateStatesOptions,
  ExportSigningKeysOptions,
  ImportPrivateStatesOptions,
  ImportPrivateStatesResult,
  ImportSigningKeysOptions,
  ImportSigningKeysResult,
  PrivateStateExport,
  PrivateStateId,
  PrivateStateProvider,
  SigningKeyExport,
} from '@midnight-ntwrk/midnight-js-types';

import { decodeState, encodeState } from './codec';

const NAMESPACE = 'quietbooks/v1';

const stateKey = (address: ContractAddress, id: string): string =>
  `${NAMESPACE}/private-state/${address}/${id}`;

const signingKeyKey = (address: ContractAddress): string => `${NAMESPACE}/signing-key/${address}`;

/** Raised when the browser will not keep what we just tried to store. */
export class PrivateStateStorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'PrivateStateStorageError';
  }
}

const write = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    // A quota failure here means an invoice's openings were not kept. That has
    // to stop the operation, not warn in a console nobody is reading.
    throw new PrivateStateStorageError(
      'this browser refused to store the invoice record, so the openings that ' +
        'prove its terms would be lost. Free up site storage and try again.',
      error,
    );
  }
};

export const createBrowserPrivateStateProvider = <
  PSI extends PrivateStateId = PrivateStateId,
  PS = unknown,
>(): PrivateStateProvider<PSI, PS> => {
  let contractAddress: ContractAddress | null = null;

  const requireAddress = (): ContractAddress => {
    if (contractAddress === null) {
      throw new PrivateStateStorageError(
        'no contract address is set on the private state store yet',
      );
    }
    return contractAddress;
  };

  /** Every private-state key currently held for one contract. */
  const keysFor = (address: ContractAddress): string[] => {
    const prefix = `${NAMESPACE}/private-state/${address}/`;
    const found: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key !== null && key.startsWith(prefix)) {
        found.push(key);
      }
    }
    return found;
  };

  return {
    setContractAddress(address: ContractAddress): void {
      contractAddress = address;
    },

    set(privateStateId: PSI, state: PS): Promise<void> {
      write(stateKey(requireAddress(), privateStateId), encodeState(state));
      return Promise.resolve();
    },

    get(privateStateId: PSI): Promise<PS | null> {
      const raw = window.localStorage.getItem(stateKey(requireAddress(), privateStateId));
      if (raw === null) {
        return Promise.resolve(null);
      }
      try {
        return Promise.resolve(decodeState<PS>(raw));
      } catch (error) {
        // Returning null would look like "no invoices yet" and invite the user
        // to issue new ones over the top of records that are still there.
        return Promise.reject(
          new PrivateStateStorageError(
            'the stored QuietBooks private state could not be read back. It may ' +
              'have been written by a different version of this application.',
            error,
          ),
        );
      }
    },

    remove(privateStateId: PSI): Promise<void> {
      window.localStorage.removeItem(stateKey(requireAddress(), privateStateId));
      return Promise.resolve();
    },

    clear(): Promise<void> {
      for (const key of keysFor(requireAddress())) {
        window.localStorage.removeItem(key);
      }
      return Promise.resolve();
    },

    setSigningKey(address: ContractAddress, signingKey: SigningKey): Promise<void> {
      write(signingKeyKey(address), signingKey);
      return Promise.resolve();
    },

    getSigningKey(address: ContractAddress): Promise<SigningKey | null> {
      return Promise.resolve(
        (window.localStorage.getItem(signingKeyKey(address)) as SigningKey | null) ?? null,
      );
    },

    removeSigningKey(address: ContractAddress): Promise<void> {
      window.localStorage.removeItem(signingKeyKey(address));
      return Promise.resolve();
    },

    clearSigningKeys(): Promise<void> {
      const prefix = `${NAMESPACE}/signing-key/`;
      const found: string[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key !== null && key.startsWith(prefix)) {
          found.push(key);
        }
      }
      for (const key of found) {
        window.localStorage.removeItem(key);
      }
      return Promise.resolve();
    },

    // The export pair is part of the provider contract. It is implemented
    // honestly .. the payload really is every state held for this contract ..
    // but it is not encrypted, and the name of the field it travels in says
    // otherwise, so nothing in this interface offers it as a backup.
    exportPrivateStates(options?: ExportPrivateStatesOptions): Promise<PrivateStateExport> {
      void options;
      const address = requireAddress();
      const states: Record<string, string> = {};
      for (const key of keysFor(address)) {
        states[key.slice(key.lastIndexOf('/') + 1)] = window.localStorage.getItem(key) ?? '';
      }
      return Promise.resolve({
        format: 'midnight-private-state-export',
        encryptedPayload: JSON.stringify({ contractAddress: address, states }),
        salt: 'quietbooks-browser-private-state',
      });
    },

    importPrivateStates(
      exportData: PrivateStateExport,
      options?: ImportPrivateStatesOptions,
    ): Promise<ImportPrivateStatesResult> {
      const address = requireAddress();
      const strategy = options?.conflictStrategy ?? 'error';
      const payload = JSON.parse(exportData.encryptedPayload) as {
        states?: Record<string, string>;
      };
      let imported = 0;
      let skipped = 0;
      let overwritten = 0;

      for (const [id, value] of Object.entries(payload.states ?? {})) {
        const key = stateKey(address, id);
        const exists = window.localStorage.getItem(key) !== null;
        if (exists) {
          if (strategy === 'skip') {
            skipped += 1;
            continue;
          }
          if (strategy === 'error') {
            return Promise.reject(
              new PrivateStateStorageError(`private state "${id}" is already stored here`),
            );
          }
          overwritten += 1;
        } else {
          imported += 1;
        }
        write(key, value);
      }

      return Promise.resolve({ imported, skipped, overwritten });
    },

    exportSigningKeys(options?: ExportSigningKeysOptions): Promise<SigningKeyExport> {
      void options;
      const keys: Record<string, string> = {};
      const prefix = `${NAMESPACE}/signing-key/`;
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key !== null && key.startsWith(prefix)) {
          keys[key.slice(prefix.length)] = window.localStorage.getItem(key) ?? '';
        }
      }
      return Promise.resolve({
        format: 'midnight-signing-key-export',
        encryptedPayload: JSON.stringify({ keys }),
        salt: 'quietbooks-browser-signing-keys',
      });
    },

    importSigningKeys(
      exportData: SigningKeyExport,
      options?: ImportSigningKeysOptions,
    ): Promise<ImportSigningKeysResult> {
      const strategy = options?.conflictStrategy ?? 'error';
      const payload = JSON.parse(exportData.encryptedPayload) as {
        keys?: Record<string, string>;
      };
      let imported = 0;
      let skipped = 0;
      let overwritten = 0;

      for (const [address, signingKey] of Object.entries(payload.keys ?? {})) {
        const key = signingKeyKey(address);
        const exists = window.localStorage.getItem(key) !== null;
        if (exists) {
          if (strategy === 'skip') {
            skipped += 1;
            continue;
          }
          if (strategy === 'error') {
            return Promise.reject(
              new PrivateStateStorageError(`a signing key for ${address} is already stored here`),
            );
          }
          overwritten += 1;
        } else {
          imported += 1;
        }
        write(key, signingKey);
      }

      return Promise.resolve({ imported, skipped, overwritten });
    },
  };
};
