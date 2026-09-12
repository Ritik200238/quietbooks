// The shell: header, route, and the gate in front of everything.
//
// SPDX-License-Identifier: Apache-2.0

import { Header } from './components/Header';
import { Audit } from './screens/Audit';
import { Connect } from './screens/Connect';
import { InvoiceDetail } from './screens/InvoiceDetail';
import { Invoices } from './screens/Invoices';
import { NewInvoice } from './screens/NewInvoice';
import { useRoute } from './state/router';
import { SessionProvider, useSession } from './state/session';

const Screen = (): JSX.Element => {
  const { connection } = useSession();
  const route = useRoute();

  // Every screen below needs a deployment, so there is no point rendering one
  // that then has to explain it cannot do anything.
  if (connection.status !== 'connected') {
    return <Connect />;
  }

  switch (route.name) {
    case 'new-invoice':
      return <NewInvoice />;
    case 'invoice':
      return <InvoiceDetail invoiceId={route.invoiceId} />;
    case 'audit':
      return <Audit invoiceId={route.invoiceId} />;
    case 'invoices':
      return <Invoices />;
  }
};

export const App = (): JSX.Element => (
  <SessionProvider>
    <div className="shell">
      <Header />
      <main className="shell-main">
        <Screen />
      </main>
    </div>
  </SessionProvider>
);
