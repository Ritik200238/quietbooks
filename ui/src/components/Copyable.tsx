// Copy-to-clipboard, and the truncated digest that usually sits beside it.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from 'react';

import { truncateHex } from '../lib/format';

type CopyButtonProps = {
  readonly value: string;
  /** What is being copied, for the screen reader and the title. */
  readonly label: string;
  readonly className?: string;
};

export const CopyButton = ({ value, label, className }: CopyButtonProps): JSX.Element => {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(() => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setFailed(false);
        setCopied(true);
      })
      .catch(() => {
        // Clipboard access is denied often enough .. an insecure origin, a
        // permission prompt the user dismissed .. that silently doing nothing
        // would look like a broken button.
        setCopied(false);
        setFailed(true);
      })
      .finally(() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          setCopied(false);
          setFailed(false);
        }, 2000);
      });
  }, [value]);

  return (
    <button
      type="button"
      className={`button button-quiet button-small ${className ?? ''}`}
      onClick={copy}
      title={failed ? `Could not copy ${label}` : `Copy ${label}`}
    >
      {copied ? 'Copied' : failed ? 'Blocked' : 'Copy'}
      <span className="visually-hidden">{` ${label}`}</span>
    </button>
  );
};

type DigestProps = {
  readonly value: string;
  readonly label: string;
  readonly lead?: number;
  readonly tail?: number;
};

/** A 32-byte value shown short, with the whole of it a click away. */
export const Digest = ({ value, label, lead, tail }: DigestProps): JSX.Element => (
  <span className="digest">
    <code title={value}>{truncateHex(value, lead, tail)}</code>
    <CopyButton value={value} label={label} />
  </span>
);
