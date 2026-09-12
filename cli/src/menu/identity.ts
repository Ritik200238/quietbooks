// Menu: who this wallet is on this deployment.
//
// SPDX-License-Identifier: Apache-2.0
//
// The party key is the single most-copied value in the whole product .. a seller
// cannot issue an invoice without the buyer's .. so it is printed in full, on
// its own line, with nothing else on it.

import { toHex } from '@quietbooks/contract';

import type { AppContext } from '../context.js';
import { heading, out, renderFields } from '../format.js';
import { loadState } from '../select.js';

/**
 * A coin public key as text.
 *
 * The wallet SDK's representation has changed shape between releases, so this
 * asks the value to describe itself rather than reaching into a field that may
 * not be there. A key that cannot be rendered is reported as such instead of
 * printing "[object Object]" and sending the operator off to paste it somewhere.
 */
const coinPublicKeyText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }
  if (value !== null && typeof value === 'object' && 'toString' in value) {
    const text = String(value);
    return text === '[object Object]' ? 'not printable in this SDK version' : text;
  }
  return 'unavailable';
};

export const identity = async (context: AppContext): Promise<void> => {
  const [state, partyKey, adminKey] = await Promise.all([
    loadState(context),
    context.api.partyKey(),
    context.api.adminKey(),
  ]);

  out(heading('This wallet'));
  out('  Party key (give this to counterparties so they can invoice you):');
  out(`  ${toHex(partyKey)}`);
  out('');
  out(
    renderFields([
      ['Administrative key', toHex(adminKey)],
      ['Is the administrator', state.isAdmin ? 'yes' : 'no'],
      ['Contract', context.api.deployedContractAddress],
      ['Network', context.config.networkName],
      ['Shielded address', context.wallet.shieldedAddress],
      ['Coin public key', coinPublicKeyText(context.wallet.getCoinPublicKey())],
      ['Wallet seed', context.wallet.seed],
      ['Private state store', context.config.privateStateStoreName],
    ]),
  );
  out('');
  out('  The party key is derived from this wallet\'s root secret and the deployment\'s');
  out('  instance salt, so the same wallet has a different key on every deployment and');
  out('  the two cannot be linked from the ledger.');
  out('  The administrative key exists whether or not this wallet holds the role; only');
  out('  the deployer\'s matches the one sealed on chain.');
};
