// Entry point.
//
// SPDX-License-Identifier: Apache-2.0

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles/theme.css';
import './styles/components.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html has no #root element to mount into');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
