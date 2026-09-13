// Entry point.
//
// SPDX-License-Identifier: Apache-2.0

import './globals';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { configureNetwork } from '@quietbooks/api';

import { App } from './App';
import { networkId } from './lib/providers';
import './styles/theme.css';
import './styles/components.css';

// The Midnight libraries keep the network id in a module-level global rather
// than passing it through every call, and reading it before it is set throws
// rather than defaulting. Nothing here touches it until a contract call is
// built, so getting this wrong produces a failure at the first deploy or join,
// long after the mistake, with a message about configuration rather than about
// the button that was pressed.
//
// It is set once, here, before anything renders, from the same accessor the
// providers use so the two can never disagree.
// Both, because there is no guarantee the bundler collapsed this package to a
// single instance: npm gives each workspace its own copy, the setter only
// writes the copy its caller imported, and the read happens deep inside a
// circuit call. Setting one and not the other fails at the first deploy with
// a message about configuration rather than about the button that was pressed.
setNetworkId(networkId());
configureNetwork(networkId());

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html has no #root element to mount into');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
