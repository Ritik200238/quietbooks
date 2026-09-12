// Finding and connecting to the Midnight Lace wallet.
//
// SPDX-License-Identifier: Apache-2.0
//
// Follows the connection pattern from the official example-bboard interface: the
// extension injects its connector onto `window.midnight` some time after the page
// loads, so the connector is polled for rather than read once, and every stage
// has its own timeout with its own message. A user whose extension is installed
// but locked needs to be told something different from a user who has no
// extension at all.

import { ConnectedAPI, type InitialAPI } from '@midnight-ntwrk/dapp-connector-api';
import semver from 'semver';
import {
  catchError,
  concatMap,
  filter,
  firstValueFrom,
  interval,
  map,
  take,
  throwError,
  timeout,
} from 'rxjs';

import { logger } from './logger';

/** The connector API version this interface is written against. */
export const COMPATIBLE_CONNECTOR_API_VERSION = '4.x';

type MidnightConnectors = Record<string, unknown> | undefined;

const connectors = (): MidnightConnectors =>
  (window as unknown as { midnight?: Record<string, unknown> }).midnight;

/** The first injected connector whose API version this interface understands. */
export const findWallet = (): InitialAPI | undefined => {
  const injected = connectors();
  if (injected === undefined) {
    return undefined;
  }
  return Object.values(injected).find(
    (candidate): candidate is InitialAPI =>
      !!candidate &&
      typeof candidate === 'object' &&
      'apiVersion' in candidate &&
      typeof (candidate as { apiVersion: unknown }).apiVersion === 'string' &&
      semver.satisfies(
        (candidate as { apiVersion: string }).apiVersion,
        COMPATIBLE_CONNECTOR_API_VERSION,
      ),
  );
};

/** True when some Midnight connector is present, compatible or not. */
export const anyWalletPresent = (): boolean => {
  const injected = connectors();
  return injected !== undefined && Object.keys(injected).length > 0;
};

/**
 * Wait for the connector, then ask it to connect to `networkId`.
 *
 * The wallet refuses if it is on a different network, and that refusal is worth
 * passing through verbatim: "connect to testnet" is actionable, a generic
 * failure is not.
 */
export const connectToWallet = (networkId: string): Promise<ConnectedAPI> =>
  firstValueFrom(
    interval(100).pipe(
      map(() => findWallet()),
      filter((connector): connector is InitialAPI => !!connector),
      take(1),
      timeout({
        first: 2_000,
        with: () =>
          throwError(
            () =>
              new Error(
                anyWalletPresent()
                  ? 'A Midnight wallet is installed, but it speaks a connector API this ' +
                    `interface does not (${COMPATIBLE_CONNECTOR_API_VERSION} is required).`
                  : 'No Midnight Lace wallet found in this browser. Install the extension, ' +
                    'then reload this page.',
              ),
          ),
      }),
      concatMap(async (connector) => {
        const connected = await connector.connect(networkId);
        const status = await connected.getConnectionStatus();
        logger.info({ status, networkId }, 'wallet connector enabled');
        return connected;
      }),
      timeout({
        first: 60_000,
        with: () =>
          throwError(
            () =>
              new Error(
                'The wallet did not answer. Open the Lace extension, unlock it, and allow ' +
                  'this site.',
              ),
          ),
      }),
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof Error
            ? error
            : new Error('The wallet refused the connection request.'),
        ),
      ),
    ),
  );
