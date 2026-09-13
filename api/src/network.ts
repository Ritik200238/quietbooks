// Which Midnight network this process is talking to.
//
// SPDX-License-Identifier: Apache-2.0
//
// `@midnight-ntwrk/midnight-js-network-id` keeps the network id in a
// module-level variable and throws when it is read before being set. That is
// workable inside one module instance and a trap across several, because the
// setter only ever writes the copy the caller imported.
//
// npm gives every workspace here its own copy of that package -- four of them,
// all 4.1.1 -- so a consumer that imported the setter directly configured its
// own copy and left this package's copy unset. Everything that only reads the
// chain worked; the first circuit call died with a message telling the caller to
// do the thing they had already done.
//
// So the setting belongs to this package, next to the code that depends on it.
// Call `configureNetwork` before deploying or joining. A consumer that also
// calls midnight-js directly has to set its own copy as well, which is why the
// setter is re-exported rather than hidden.

import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

/**
 * Point this package at a network.
 *
 * @param id One of `undeployed`, `preview`, `preprod` or `mainnet`.
 */
export const configureNetwork = (id: string): void => {
  setNetworkId(id);
};

/** The configured network, or `undefined` if nothing has configured one yet. */
export const currentNetwork = (): string | undefined => {
  try {
    return getNetworkId();
  } catch {
    return undefined;
  }
};

export { setNetworkId };
