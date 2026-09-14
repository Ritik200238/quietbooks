// The connection to one QuietBooks deployment, and the state it produces.
//
// SPDX-License-Identifier: Apache-2.0

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { QuietBooksAPI, type QuietBooksDerivedState } from '@quietbooks/api';

import { messageOf } from '../lib/format';
import { loadOrCreateRootSecret } from '../lib/identity';
import { logger } from '../lib/logger';
import { buildProviders, networkId, type Endpoints } from '../lib/providers';
import { connectToWallet } from '../lib/wallet';

const LAST_CONTRACT_KEY = 'quietbooks/v1/last-contract';

export type ConnectTarget =
  | { readonly kind: 'join'; readonly contractAddress: string }
  | { readonly kind: 'deploy' };

export type Connection =
  | { readonly status: 'idle' }
  | { readonly status: 'connecting'; readonly step: string }
  | { readonly status: 'failed'; readonly error: string }
  | {
      readonly status: 'connected';
      readonly api: QuietBooksAPI;
      readonly contractAddress: string;
      readonly endpoints: Endpoints;
      readonly coinPublicKey: string;
      /** The same key as the 32 bytes a circuit wants. */
      readonly coinPublicKeyBytes: Uint8Array;
    };

export type Session = {
  readonly connection: Connection;
  /** Derived ledger plus private state, or undefined before the first tick. */
  readonly state: QuietBooksDerivedState | undefined;
  /** A live-stream failure. The last good state stays on screen beside it. */
  readonly streamError: string | undefined;
  readonly lastContractAddress: string | undefined;
  readonly connect: (target: ConnectTarget) => Promise<void>;
  readonly disconnect: () => void;
  /** Re-read the ledger and the private state now, without waiting for a tick. */
  readonly refresh: () => Promise<void>;
  readonly refreshing: boolean;
};

const SessionContext = createContext<Session | undefined>(undefined);

export const useSession = (): Session => {
  const session = useContext(SessionContext);
  if (session === undefined) {
    throw new Error('useSession was called outside the session provider');
  }
  return session;
};

/** The connected API, for the screens that only render when there is one. */
export const useConnected = (): Extract<Connection, { status: 'connected' }> => {
  const { connection } = useSession();
  if (connection.status !== 'connected') {
    throw new Error('this screen requires a connected deployment');
  }
  return connection;
};

export const SessionProvider = ({ children }: { children: ReactNode }): JSX.Element => {
  const [connection, setConnection] = useState<Connection>({ status: 'idle' });
  const [state, setState] = useState<QuietBooksDerivedState | undefined>(undefined);
  const [streamError, setStreamError] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  // Bumping this resubscribes to `state$`.
  //
  // The API re-reads private state on every ledger tick, so a new invoice
  // becomes readable on the next tick without this. What it is actually for is
  // the moment a tick is not coming: after an action that changes nothing on
  // chain, or while the indexer is between blocks, resubscribing gets the
  // current answer immediately rather than leaving the screen a tick behind.
  const [epoch, setEpoch] = useState(0);
  const connecting = useRef(false);

  const lastContractAddress = useMemo(
    () => window.localStorage.getItem(LAST_CONTRACT_KEY) ?? undefined,
    [],
  );

  const connect = useCallback(async (target: ConnectTarget): Promise<void> => {
    if (connecting.current) {
      return;
    }
    connecting.current = true;
    setState(undefined);
    setStreamError(undefined);

    try {
      setConnection({ status: 'connecting', step: 'Waiting for the Lace wallet' });
      const wallet = await connectToWallet(networkId());

      setConnection({ status: 'connecting', step: 'Setting up indexer and proof server' });
      const { providers, endpoints, shieldedCoinPublicKey, shieldedCoinPublicKeyBytes } =
        await buildProviders(wallet);

      const secret = loadOrCreateRootSecret();

      setConnection({
        status: 'connecting',
        step:
          target.kind === 'deploy'
            ? 'Deploying a new QuietBooks contract. This builds a proof and can take a minute.'
            : 'Opening the contract and reading its ledger',
      });

      const api =
        target.kind === 'deploy'
          ? await QuietBooksAPI.deploy(providers, secret, logger)
          : await QuietBooksAPI.join(providers, target.contractAddress, secret, logger);

      const contractAddress = api.deployedContractAddress;
      window.localStorage.setItem(LAST_CONTRACT_KEY, contractAddress);

      setConnection({
        status: 'connected',
        api,
        contractAddress,
        endpoints,
        coinPublicKey: shieldedCoinPublicKey,
        coinPublicKeyBytes: shieldedCoinPublicKeyBytes,
      });
      setEpoch((value) => value + 1);
    } catch (error) {
      logger.error({ error }, 'could not open the deployment');
      setConnection({ status: 'failed', error: messageOf(error) });
    } finally {
      connecting.current = false;
    }
  }, []);

  const disconnect = useCallback(() => {
    setConnection({ status: 'idle' });
    setState(undefined);
    setStreamError(undefined);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (connection.status !== 'connected') {
      return;
    }
    setRefreshing(true);
    try {
      const snapshot = await connection.api.snapshot();
      setState(snapshot);
      setStreamError(undefined);
      setEpoch((value) => value + 1);
    } catch (error) {
      setStreamError(messageOf(error));
    } finally {
      setRefreshing(false);
    }
  }, [connection]);

  useEffect(() => {
    if (connection.status !== 'connected') {
      return;
    }
    const subscription = connection.api.state$.subscribe({
      next: (next) => {
        setState(next);
        setStreamError(undefined);
      },
      error: (error: unknown) => {
        // The last good state stays on screen: a dropped indexer socket should
        // not empty an invoice list that was correct a second ago.
        setStreamError(messageOf(error));
      },
    });
    return () => subscription.unsubscribe();
  }, [connection, epoch]);

  const value = useMemo<Session>(
    () => ({
      connection,
      state,
      streamError,
      lastContractAddress,
      connect,
      disconnect,
      refresh,
      refreshing,
    }),
    [connection, state, streamError, lastContractAddress, connect, disconnect, refresh, refreshing],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
};
