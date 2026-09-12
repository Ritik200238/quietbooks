// One place where "what is this button doing right now" lives.
//
// SPDX-License-Identifier: Apache-2.0
//
// Every write in QuietBooks builds a zero-knowledge proof, which takes tens of
// seconds on a local proof server and can take longer. A button that gives no
// sign of that is a button people press twice. So every action goes through this
// hook: it disables while it runs, keeps the contract's own failure message, and
// keeps whatever the call returned so the screen can show it.

import { useCallback, useRef, useState } from 'react';

import { messageOf } from '../lib/format';

export type ActionState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'working'; readonly note: string }
  | { readonly status: 'done'; readonly value: T }
  | { readonly status: 'failed'; readonly error: string };

export type Action<T, A extends unknown[]> = {
  readonly state: ActionState<T>;
  readonly busy: boolean;
  readonly run: (...args: A) => Promise<T | undefined>;
  readonly reset: () => void;
};

export const useAction = <T, A extends unknown[]>(
  body: (...args: A) => Promise<T>,
  workingNote = 'Working…',
): Action<T, A> => {
  const [state, setState] = useState<ActionState<T>>({ status: 'idle' });
  // Guards against a second press while the first proof is still being built:
  // the contract would reject the duplicate, but only after another minute.
  const inFlight = useRef(false);

  const run = useCallback(
    async (...args: A): Promise<T | undefined> => {
      if (inFlight.current) {
        return undefined;
      }
      inFlight.current = true;
      setState({ status: 'working', note: workingNote });
      try {
        const value = await body(...args);
        setState({ status: 'done', value });
        return value;
      } catch (error) {
        // The API has already stripped the contract's own "quietbooks:" prefix,
        // so this is the assertion text as the contract wrote it.
        setState({ status: 'failed', error: messageOf(error) });
        return undefined;
      } finally {
        inFlight.current = false;
      }
    },
    [body, workingNote],
  );

  const reset = useCallback(() => setState({ status: 'idle' }), []);

  return { state, busy: state.status === 'working', run, reset };
};
