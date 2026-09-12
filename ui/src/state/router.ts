// A four-screen hash router.
//
// SPDX-License-Identifier: Apache-2.0
//
// Four routes do not justify a routing library, and the hash form means the
// built interface can be served from any static path without server rewrites.

import { useEffect, useState } from 'react';

export type Route =
  | { readonly name: 'invoices' }
  | { readonly name: 'new-invoice' }
  | { readonly name: 'invoice'; readonly invoiceId: string }
  /** With an invoice id when arriving from that invoice, so it is preselected. */
  | { readonly name: 'audit'; readonly invoiceId?: string };

export const routePath = (route: Route): string => {
  switch (route.name) {
    case 'invoices':
      return '#/invoices';
    case 'new-invoice':
      return '#/invoices/new';
    case 'invoice':
      return `#/invoices/${route.invoiceId}`;
    case 'audit':
      return route.invoiceId === undefined ? '#/audit' : `#/audit/${route.invoiceId}`;
  }
};

export const parseHash = (hash: string): Route => {
  const path = hash.replace(/^#/, '').replace(/^\//, '');
  const segments = path.split('/').filter((segment) => segment.length > 0);

  if (segments[0] === 'audit') {
    return segments[1] === undefined
      ? { name: 'audit' }
      : { name: 'audit', invoiceId: segments[1] };
  }
  if (segments[0] === 'invoices') {
    if (segments[1] === 'new') {
      return { name: 'new-invoice' };
    }
    if (segments[1] !== undefined) {
      return { name: 'invoice', invoiceId: segments[1] };
    }
  }
  return { name: 'invoices' };
};

export const navigate = (route: Route): void => {
  window.location.hash = routePath(route);
};

export const useRoute = (): Route => {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
};
