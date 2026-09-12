# QuietBooks

Private B2B invoicing, settlement and selective audit on [Midnight](https://midnight.network).

A supplier issues an invoice. The amount, the tax, the line items and the memo
never touch the chain. The buyer pays. Months later an auditor asks to see the
amount and the tax on that one invoice, and the supplier can show exactly those
two fields, to exactly that auditor, until exactly a date they choose, and prove
the numbers are the ones the chain has been holding a commitment to since the day
it was issued.

That last part is the point. Hiding data is easy: keep it off the chain. The hard
part is being able to prove, later, that what you are showing somebody is the
truth you committed to at the time, without having published it in the meantime.

---

## What the chain can and cannot see

This is the first thing to understand about the project, and it is stated here
rather than buried because the honest answer is more interesting than a
marketing one.

**Public, for every invoice:** that it exists, who the parties are as rotatable
pseudonyms, when it was issued, when it is due, its status, and four 32-byte
digests. Aggregate counters for issued, settled, cancelled and disputed.

**Private, never written to the ledger by any circuit in this project:** the
amount, the tax, the currency, the line items, the memo, the order reference,
and every commitment opening.

**Where amounts do become public:** the optional escrow path. See below. The
interface says so before you use it.

### Why settlement is not custodial by default

We wanted the contract to hold the money and hide the amount. It cannot, and
finding out why drove the whole design.

- `receiveShielded` requires its argument to be disclosed. Midnight's own
  token-transfer example writes `receiveShielded(disclose(coin))`, and a
  `ShieldedCoinInfo` carries a plaintext `value`. The moment a contract takes
  custody of a shielded coin, that coin's value is public.
- OpenZeppelin's `ShieldedTreasury` says the same thing in its own header: *"This
  treasury's HOLDINGS ARE PUBLIC."*
- There is no standard-library circuit that derives a Zswap note commitment from
  coin data, so a contract cannot re-derive a commitment in-circuit and bind it
  to a private amount.

So contract custody and hidden amounts are mutually exclusive on Midnight today.

What *is* possible is better than a workaround. `claimZswapCoinReceive(note)`
makes the ledger refuse a transaction unless a specific Zswap output is present
in it, using only the 32-byte note commitment. The commitment reveals nothing
about value or recipient.

QuietBooks therefore settles **peer to peer**: the buyer's wallet makes an
ordinary shielded transfer, where Zswap hides the amount, and the contract binds
that transfer to the invoice atomically through its note commitment. The chain
learns that invoice X was settled by a real shielded output. It never learns for
how much. An auditor holding the opening can verify the amount exactly.

Escrow is offered as the honest alternative for parties who want funds actually
locked by the contract. It takes custody, so it publishes the amount, and it is
labelled as such everywhere it appears. Offering both, and being explicit about
the trade, is the design.

---

## The three settlement paths

| Path | Who calls it | Amount on chain | Binding |
|---|---|---|---|
| `settleWithNote` | Buyer | Hidden | The ledger refuses the call unless the Zswap output named by the note commitment exists in the same transaction |
| `settleAttested` | Seller | Hidden | The seller vouches for receipt. Used for bank transfers and any rail the contract cannot observe. Only the seller may call it, because the seller is the party who loses by lying |
| `fundEscrow` → `releaseEscrow` | Buyer | **Public** | The contract holds the coin and releases it on confirmation, refunds after a deadline, or moves it on an arbiter's ruling |

---

## Selective audit

An auditor is granted specific fields of one invoice, until a deadline.

The nine disclosable fields, in a fixed order used by the circuit, the envelope
and the validator alike: `amount`, `tax`, `dueDate`, `buyer`, `seller`,
`currency`, `items`, `memo`, `orderRef`.

What goes on chain is the **hash** of an audit key, the set of fields, and an
expiry. The key itself and the data travel out of band in an encrypted envelope.
The auditor decrypts, recomputes the per-field commitments for the fields they
were granted, takes the rest from the envelope as opaque digests, folds all nine
into a root, and checks that root against the one the chain has held since
issuance.

The validator runs eight checks in order and reports each one individually:

1. the envelope version is recognised
2. the grant is not revoked
3. the grant has not expired
4. the key hash matches the grant, and the supplied key hashes to it
5. **the envelope does not disclose any field outside the grant** — an envelope
   claiming more than it was granted fails here
6. the ciphertext decrypts and its payload hash matches
7. every disclosed field's commitment recomputes from its plaintext and salt
8. all nine commitments fold back into the on-chain field root

A validator reports; it never throws on a failed check.

---

## Reliability without disclosure

The contract keeps counts, and only counts, against each party key: settled,
settled on time, cancelled, disputes opened, disputes lost. No amounts.

`proveReliability(minSettled, minOnTime, maxDisputesLost)` returns a single
boolean. A supplier can show a prospective customer that they have settled at
least twenty invoices, at least eighteen of them on time, and lost no disputes,
and the customer learns nothing else. Not the counterparties, not the amounts,
not which invoices are being counted.

The counters are read from ledger state, not supplied by the prover. That is the
difference between this and a claim on a website.

---

## Identity

Every identity is a domain-separated hash of a 32-byte secret held in the
wallet's private state:

```
partyKey = persistentHash([tag, instanceSalt, pin, secret])
```

`ownPublicKey()` is never used for authorisation anywhere in this contract. It
returns a prover-claimed value with no cryptographic binding to the transaction
signer, so any assertion resting on it is bypassable. Midnight's own `zkloan`
example says so, and this project follows that rule.

Keys are PIN-rotatable. Changing the PIN yields an unrelated key and breaks
linkability with the old one. The honest cost, stated plainly: reliability
counters are keyed by party key, so rotating a PIN also resets the visible
history. The test suite asserts this rather than leaving it to be discovered.

`instanceSalt` is sealed at deployment, so the same wallet secret produces
different identities on different deployments and cannot be correlated across
them.

---

## Repository layout

```
contract/     The Compact contract, its witnesses, the domain model,
              the audit envelope, and the test suite
api/          QuietBooksAPI: deploy, join, and drive a deployment
ui/           Vite + React interface
cli/          Interactive Node CLI
e2e/          End-to-end run against a real network
localnet/     A self-contained Midnight network (Docker Compose)
```

`contract/src/quietbooks.compact` is the place to start reading. Its header
explains the privacy model and why settlement works the way it does.

---

## Running it

### Prerequisites

- Node 22
- Docker, for the local network and the proof server
- The Compact toolchain, **pinned**:

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/download/compact-v0.5.1/compact-installer.sh | sh
export PATH="$HOME/.local/bin:$PATH"
compact update 0.31.1
compact compile --version   # expect 0.31.1
```

`compact update` with no version installs a toolchain whose language version has
moved past the 0.23 this contract declares. It will not compile, and the error
does not mention versions.

Midnight development is not supported on native Windows. Use WSL2.

### Build and test

```bash
npm install
npm run compact     # compiles the contract; produces proving and verifying keys
npm run build
npm test            # the contract test suite
```

The test suite runs entirely in process against the compiled contract. No
Docker, no node, no proof server, no network.

### The local network

```bash
cd localnet
docker compose -f standalone.yml up -d
docker compose -f standalone.yml ps
```

| Service | URL |
|---|---|
| Node | http://localhost:9944 |
| Indexer | http://localhost:8088/api/v4/graphql |
| Proof server | http://localhost:6300 |

### End to end

With the network up:

```bash
npm run e2e --workspace @quietbooks/e2e
```

This deploys the contract with real ZK proofs and runs the whole business flow
against the live node and indexer, asserting every step against state read back
through the indexer rather than against the local result of the call.

---

## Testing

| Suite | What it proves |
|---|---|
| `derivation.test.ts` | The off-chain helpers produce byte-identical results to the compiled circuit |
| `lifecycle.test.ts` | Issue, settle, cancel, and every authorisation rule |
| `escrow.test.ts` | Funding, release, refund deadlines, disputes, arbitration |
| `audit.test.ts` | Grants, scope coverage, expiry, revocation, reliability, admin |
| `audit-envelope.test.ts` | Envelope crypto and all eight validator checks |

One test is worth calling out. An earlier version of the derivation suite
compared an encoding helper against itself, and passed while the helper encoded
integers in the wrong byte order — which would have shipped audit envelopes no
auditor could verify. It now folds our own field commitments independently and
compares the result to the compiled circuit's root, so it cannot pass vacuously.
Reintroducing the bug fails seven tests.

---

## What is not built yet

Stated plainly, because a roadmap that only lists wins is not a roadmap.

- The buyer's wallet has to produce a Zswap note commitment for
  `settleWithNote`. The contract's side of that binding is implemented and
  tested; wiring it to the wallet's coin-commitment tracking is not finished, so
  the end-to-end run currently exercises `settleAttested`.
- Every user needs a locally running proof server. That is true of every Midnight
  DApp today, and in-browser proving is the fix when it lands in the wallet.
- Reliability counters are per party key, so they reset on PIN rotation. An
  accumulator that survives rotation without re-linking the old identity is
  possible and is not built.
- Recurring invoices, multi-currency netting and partial payments are not
  modelled. Every invoice settles once, in full.

---

## Licence and attribution

Apache-2.0. See [`LICENSE`](./LICENSE).

[`NOTICE`](./NOTICE) records what this project owes to the Midnight examples,
OpenZeppelin's Compact contracts, and several independent ecosystem projects —
architectural debts as well as code. Every Compact circuit and every line of the
application is original; Compact is neither Solidity nor Leo, so nothing could
have been copied even where we wanted to. What was borrowed is design, and it is
listed so a reader can check the originals.
