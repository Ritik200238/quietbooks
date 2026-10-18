// The network table, which every tool that talks to a public chain reads.
//
// SPDX-License-Identifier: Apache-2.0
//
// The failure this guards against already happened once: three copies of the
// Preprod endpoints went dead on the same day and nothing noticed, because
// nothing exercised them. These tests cannot reach the network either. What
// they can do is pin the table to what the docs say it is, and make sure a
// missing or misplaced Blockfrost token is a sentence rather than a 403.

import { describe, expect, it } from 'vitest';

import {
  EndpointError,
  contractLinks,
  publicEndpoints,
  redactToken,
  transactionLinks,
} from '../src/endpoints.js';

const PREPROD_TOKEN = 'nightpreprodAbC123';
const MAINNET_TOKEN = 'nightmainnetXyZ789';
// A real Preview transaction, block 1,354,587, used to check the link shapes.
const TX = '3f7a3e6e78cde99b33c231051ee831640075bbfee771bf6be90327963925f942';

describe('publicEndpoints', () => {
  it('serves Preview from Midnight, with no token', () => {
    const e = publicEndpoints('preview');
    expect(e.indexer).toBe('https://indexer.preview.midnight.network/api/v4/graphql');
    expect(e.node).toBe('https://rpc.preview.midnight.network');
    expect(e.faucet).toBe('https://midnight-tmnight-preview.nethermind.dev/');
    expect(JSON.stringify(e)).not.toContain('project_id');
  });

  it('never returns the Midnight-hosted Preprod endpoints, which were shut down', () => {
    const e = publicEndpoints('preprod', PREPROD_TOKEN);
    expect(JSON.stringify(e)).not.toContain('preprod.midnight.network');
    expect(e.indexer).toBe(`https://midnight-preprod.blockfrost.io/api/v0?project_id=${PREPROD_TOKEN}`);
    expect(e.indexerWS).toBe(`wss://midnight-preprod.blockfrost.io/api/v0/ws?project_id=${PREPROD_TOKEN}`);
    expect(e.node).toBe(`https://rpc.midnight-preprod.blockfrost.io?project_id=${PREPROD_TOKEN}`);
    expect(e.nodeWS).toBe(`wss://rpc.midnight-preprod.blockfrost.io?project_id=${PREPROD_TOKEN}`);
    expect(e.faucet).toBe('https://midnight-tmnight-preprod.nethermind.dev/');
  });

  it('gives mainnet no faucet', () => {
    expect(publicEndpoints('mainnet', MAINNET_TOKEN).faucet).toBeUndefined();
  });

  it('explains a missing token instead of letting Blockfrost answer 403', () => {
    expect(() => publicEndpoints('preprod')).toThrow(EndpointError);
    expect(() => publicEndpoints('preprod', '  ')).toThrow(/BLOCKFROST_PROJECT_ID/);
  });

  it('refuses a token issued for the other network', () => {
    expect(() => publicEndpoints('mainnet', PREPROD_TOKEN)).toThrow(/start with "nightmainnet"/);
    expect(() => publicEndpoints('preprod', MAINNET_TOKEN)).toThrow(/start with "nightpreprod"/);
  });
});

describe('redactToken', () => {
  it('strips the credential from every endpoint before it is written down', () => {
    const e = publicEndpoints('preprod', PREPROD_TOKEN);
    for (const url of [e.indexer, e.indexerWS, e.node, e.nodeWS]) {
      expect(redactToken(url)).not.toContain(PREPROD_TOKEN);
      expect(redactToken(url)).toContain('project_id=<redacted>');
    }
  });

  it('leaves a tokenless URL alone', () => {
    expect(redactToken('https://rpc.preview.midnight.network')).toBe('https://rpc.preview.midnight.network');
  });
});

describe('explorer links', () => {
  it('uses the shapes checked against a real Preview transaction', () => {
    expect(transactionLinks('preview', TX).map((l) => l.url)).toEqual([
      `https://preview.midnightexplorer.com/transactions/${TX}`,
      `https://midnight-preview.subscan.io/tx/${TX}`,
      `https://explorer.1am.xyz/tx/${TX}?network=preview`,
    ]);
  });

  it('drops the network name on mainnet, where every explorer uses its bare host', () => {
    expect(transactionLinks('mainnet', TX).map((l) => l.url)).toEqual([
      `https://midnightexplorer.com/transactions/${TX}`,
      `https://midnight.subscan.io/tx/${TX}`,
      `https://explorer.1am.xyz/tx/${TX}`,
    ]);
  });

  it('refuses anything that is not a hex hash, so a receipt cannot carry a broken link', () => {
    expect(() => transactionLinks('preview', 'not-a-hash')).toThrow(EndpointError);
    expect(() => contractLinks('preview', '')).toThrow(EndpointError);
  });

  it('normalises case so one hash has one link', () => {
    expect(transactionLinks('preview', TX.toUpperCase())).toEqual(transactionLinks('preview', TX));
  });
});
