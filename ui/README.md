# QuietBooks interface

The web client for QuietBooks: issue an invoice whose terms never touch the chain, settle it,
and disclose exactly the fields an auditor needs and nothing else.

This is a Vite + React + TypeScript application. It talks to a Midnight Lace wallet for
balancing and submitting transactions, to a proof server for every write, and to an indexer
for reading the ledger.

---

## What the chain can and cannot see

This is the part worth reading before anything else, because the whole product depends on it
and the interface is built to state it rather than imply it.

**The chain does not hold your commercial terms.** For each invoice the ledger stores a
commitment to the terms, nine per-field commitments, the seller and buyer party keys, an
optional arbiter key, an issue date, a due date and a status. No circuit in the contract
writes an amount to public state.

**The chain cannot show you somebody else's invoice.** The list shows every invoice on the
deployment, including the ones this wallet cannot open, with the amount column locked. That
is not a permission failure; it is what the ledger actually contains from the outside.

**Settlement in the private mode routes through the contract without being held by it.**
Midnight's `receiveShielded` requires the coin it takes to be disclosed, and a contract that
*holds* a coin publishes what it holds. So the contract does not hold it: it receives the coin
and forwards it to the seller in the same call, leaving its balance unchanged. Zswap hides the
value on both legs. The payment and the settlement record are one transaction, so either both
land or neither does, and the chain learns that the invoice was settled without learning the
amount. The circuit also checks the coin against the terms you hold and refuses anything but
the exact total.

**Escrow is the honest exception, and it publishes the amount.** If you want funds held by the
contract, the contract has to be shown the coin, and its value is then readable by anyone.
The interface says so on the escrow action and asks you to acknowledge it before it will
proceed. There is no mode that gives custody and privacy at once.

**Your identity lives in this browser.** Every party key is derived from a 32-byte secret held
in `localStorage`, not from the wallet and not from the chain — the contract deliberately does
not trust `ownPublicKey()`, which is prover-claimed and not bound to the transaction signer.
Clear this site's data and that secret is gone: the invoices stay on chain, and nobody can open
them again. The connect screen offers the secret for backup, and accepts one carried over from
another browser.

**An invoice's openings live in this browser too.** They are written to `localStorage` before
the issuing transaction is submitted, so a transaction that lands is always openable. They are
what lets anyone ever prove anything about that invoice. Back the browser profile up, or
export each invoice record and keep it somewhere durable.

**The line-item text, the memo and the order reference are kept by this browser only.** The
chain holds their digests. An audit envelope that discloses those fields has to carry the text
itself, so only the wallet that wrote an invoice can disclose them. The audit screen disables
those fields, with the reason, when the text is not here.

---

## Running it

```
npm install                 # from the repository root: this is a workspace
npm run compact -w @quietbooks/contract   # compiles the contract and its proving keys
npm run dev -w @quietbooks/ui             # http://localhost:5173
```

You also need:

* **Midnight Lace**, installed in the browser and on the same network as `VITE_NETWORK_ID`.
* **A proof server.** Every write is a zero-knowledge proof and it is built there, not in
  the browser. It sees the witness values, so run your own unless you control the remote
  host. `../localnet` runs one alongside a node and an indexer; alone it is:

  ```
  docker run -p 6300:6300 midnightntwrk/proof-server:8.1.0 midnight-proof-server -v
  ```

* **The compiled proving keys**, in `../contract/build/keys` and `../contract/build/zkir`.
  The dev server streams them from there, and `npm run build` copies them next to the bundle,
  because `FetchZkConfigProvider` fetches them over HTTP from this application's own origin.
  They are about 128 MB; set `QUIETBOOKS_SKIP_ZK_COPY=1` to skip the copy while iterating on
  the interface alone.

Copy `.env.example` to `.env.local` to point at your own indexer or proof server. Every value
is optional: unset, the interface uses what the connected wallet reports.

### Building

```
npm run build -w @quietbooks/ui    # bundle into dist/, with keys/ and zkir/ beside it
npm run typecheck -w @quietbooks/ui
```

---

## The four screens

### Invoices

Every invoice on the deployment, newest first, filterable by role and status. Each row shows
the status as the contract names it, which side we are on, the due date, and the amount —
where the amount column is dashed, this wallet does not hold the terms and the chain does not
carry them. The footer says how many rows are sealed, because that number is the product
working, not failing.

### New invoice

The seller's screen. A line-item editor with a running subtotal, a tax field the contract will
refuse if it exceeds the subtotal, a currency, a memo, an order reference, a due date, the
buyer's party key and an optional arbiter's.

Amounts are whole numbers in the currency's smallest unit — the contract has no notion of
decimal places. The decimal position you choose is recorded by this browser so the invoice
reads back the same way, and the raw integer stays visible on the detail screen.

After issuing, the screen's main action is **Share record**: the buyer cannot settle, and no
auditor can check anything, without the JSON it produces. The chain does not carry it.

### Invoice detail

Everything about one invoice. The terms if this wallet can open them; the public anchor with
every digest truncated and copyable; the settlement record; the audit grant.

The actions appear only when the contract would accept them from us in the current state:

| Action | Who | When |
| --- | --- | --- |
| Settle | Buyer | Awaiting payment |
| Attest settlement | Seller | Awaiting payment |
| Cancel | Seller | Awaiting payment |
| Fund escrow | Buyer | Awaiting payment |
| Release escrow | Buyer | In escrow |
| Refund escrow | Buyer | In escrow, after the deadline |
| Open dispute | Seller or buyer | In escrow, and an arbiter was named at issuance |
| Resolve dispute | Arbiter | Disputed |
| Grant audit | Seller | Any time |
| Revoke audit | Seller | While a grant stands |

Everything irreversible asks for confirmation first. Funding escrow additionally requires you
to acknowledge that it makes the amount public.

Some of these need values this interface cannot invent. A payout key comes from the person
being paid, and it is not the party key shown on the invoice: a party key is a hash and
nothing can be paid to it. The fields say where each value comes from rather than pretending
otherwise.

### Audit

Two halves that never meet on chain.

**Seller.** Pick an invoice, tick which of the nine disclosable fields to open, set an expiry,
and grant. A fresh audit key is generated, its hash goes on chain with the scope vector and the
deadline, and the key itself is shown once — it is not stored anywhere and cannot be recovered.
The encrypted envelope is built in the same step, after the grant lands.

**Auditor.** Paste an envelope and a key. The envelope is opened and checked against the grant
and the anchor on chain: format, revocation, expiry, key binding, scope containment, payload
integrity, the per-field commitments, and the field root. Every check is reported PASS or FAIL
with the reason, and none of it is taken on the envelope's word.

---

## Notes on the build

* `node:crypto` and `node:buffer` are aliased to small browser shims in `src/shims`, because
  `@quietbooks/contract` is shared with a Node CLI. The shims forward to WebCrypto and to
  `btoa`/`atob`; no cryptography is reimplemented anywhere in this package.
* WASM and top-level await are kept, not transpiled: the compact runtime awaits its WASM module
  at module scope.
* `@swc/core` is pinned to 1.15.47 in `devDependencies`. It is not used directly — it is what
  `vite-plugin-top-level-await` compiles with, and 1.16 changed an AST shape the plugin has not
  caught up with, so an unpinned install fails the build with `missing field 'type'`. Unpin it
  when the plugin supports 1.16.
* `tsconfig.json` and `vite.config.ts` both carry a `@quietbooks/contract` mapping pointing at
  that workspace's sources. It is there only because the package's published entry points do
  not currently resolve, and each carries a comment saying so. Delete both once they do.
* This interface acts as PIN 1. The contract supports rotating a party key to a fresh PIN,
  which breaks linkability with the old key at the cost of that key's settlement history;
  nothing here exposes that yet.
