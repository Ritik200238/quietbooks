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
  `ShieldedCoinInfo` carries a plaintext `value`.
- A contract that *holds* a coin publishes what it holds: `ContractState.balance`
  is documented as the contract's public balances.
- OpenZeppelin's `ShieldedTreasury` says the same thing in its own header: *"This
  treasury's HOLDINGS ARE PUBLIC."*

So contract custody and hidden amounts are mutually exclusive on Midnight today.

But a contract can **route** a payment without holding it. `receiveShielded`
followed by `sendImmediateShielded` in the same call takes the coin and passes it
straight on: the contract's balance changes by zero, nothing is ever in its
custody, and Zswap hides the value on both legs. This is the shape OpenZeppelin's
`ForwarderShielded` uses, and `settleWithNote` is that pattern applied to an
invoice.

The buyer pays the seller *inside the transaction that records the settlement*.
Either both happen or neither does. The chain learns that invoice X was settled
and when; it never learns for how much.

The circuit also proves the payment is the right one. It compares the coin
against the terms the payer has just proven open the commitment the chain has
held since issuance, and refuses anything but the exact total — so a buyer cannot
mark an invoice settled by underpaying it, and neither the payment nor the
invoiced figure reaches public state.

#### The version of this that did not work

Worth recording, because it survived a full test suite.

The first design took a bare 32-byte note commitment as an argument and called
`kernel.claimZswapCoinReceive(note)` on it, binding an ordinary buyer-to-seller
transfer. Every circuit test passed. It could never have produced a valid
transaction: the ledger requires each contract-associated commitment to be
claimed by the contract that owns it, so a receive claim only ever accepts the
commitment of an output addressed to **this** contract. A payment addressed to
the seller is not, and the node refuses the whole transaction as malformed.

In-process circuit tests cannot catch this, because they never build a
transaction. The end-to-end run against a real node is what does, and this is the
argument for having one.

---

## The three settlement paths

| Path | Who calls it | Amount on chain | Binding |
|---|---|---|---|
| `settleWithNote` | Buyer | Hidden | The buyer's coin is received and forwarded to the seller in the same call, so the payment and the record are one transaction. The circuit proves the coin is the invoiced total, in the invoiced token, addressed to the seller the invoice names |
| `settleAttested` | Seller | Hidden | The seller vouches for receipt. Used for bank transfers and any rail the contract cannot observe. Only the seller may call it, because the seller is the party who loses by lying |
| `fundEscrow` → `releaseEscrow` | Buyer | **Public** | The contract holds the coin and releases it on confirmation, refunds after a deadline, or moves it on an arbiter's ruling |

An escrow has exactly three exits and none of them depends on one party staying
reachable: the buyer releases it, the buyer refunds it after the deadline, or the
arbiter rules. A dispute nobody resolves falls through to the refund once the
deadline passes, so no combination of silence leaves the money stuck. See
**[Paying the wrong person](#paying-the-wrong-person)** for what binds each exit
to an address.

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

## The reliability record

The contract keeps counts, and only counts, against each party key: settled,
settled on time, cancelled, disputes opened, disputes lost. No amounts, and no
link from a count back to an individual invoice.

The counters are written by the contract as invoices move, never supplied by the
party they describe. That is the difference between a payment record and a claim
on a website. They are public ledger state, so anyone can read them for any
party key.

Getting there took two passes. Every settlement path originally set the on-time
flag from a `settledAt` the caller passed in — which in `settleAttested` means
the seller marked their own punctuality, and in the others means the payer marked
the seller's. All four paths now read the block clock instead. The dispute path
was the last holdout, and subtler: it wrote the public settlement record from the
block and the counter beside it from the date the arbiter typed, so the two could
disagree about the same settlement and the number a counterparty is actually
shown was the one a caller chose.

### What the counters still cannot tell you

They count invoices, and an invoice needs two party keys. A party key is a
domain-separated hash of a wallet secret and a PIN, and one wallet can make as
many as it likes. So one person can issue an invoice from key A to key B and
attest it settled, and A's record gains a settled invoice that nothing in the
world was paid for.

The contract cannot detect this and no amount of care in the circuit would fix
it, because both keys are genuine and every rule holds. It is the same shape as
any pseudonymous reputation system: counts are only worth what the identities
behind them cost, and here they cost nothing. What makes the record useful is a
counterparty who already knows which key belongs to whom — which for B2B
invoicing is the normal case, since you know who you are trading with. Reading it
as a public credit score is the use it does not support.

A circuit that proves a threshold over them — "at least twenty settled, at least
eighteen on time, no disputes lost" — while disclosing none of the counts is
built but not deployed, and is Wave 2 work. Every entry point costs a verifier
key in the deploy transaction, a deploy has to fit inside one block's write
budget, and this contract is at that budget. See **[Why twelve entry
points](#why-twelve-entry-points)**. The record is accumulated now so the proof
has something to run against later.

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
docs/         The Wave 1 pitch deck, as a single self-contained page
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

Twenty-one steps, all passing as of the last run:

```
PASS  build wallet from the genesis seed
PASS  wallet syncs with the chain
PASS  wallet holds NIGHT
PASS  NIGHT is registered and DUST is spendable
PASS  deploy the contract with real ZK proofs                  (20.9s)
PASS  indexer returns the deployed state
PASS  issue an invoice                                         (102.5s)
PASS  the chain shows the invoice and hides its amount
PASS  the buyer pays the seller and settles in one transaction (95.0s)
PASS  the chain shows the settlement and still hides the amount
PASS  grant an auditor three fields                            (23.2s)
PASS  the chain records the grant exactly as given
PASS  revoke the audit grant                                   (25.1s)
PASS  the chain shows the grant revoked
PASS  issue a second invoice to be escrowed                    (113.8s)
PASS  the buyer funds escrow with a real shielded coin         (71.9s)
PASS  the contract holds the coin, and its value is public
PASS  the buyer opens the deployment through the API
PASS  the buyer releases the escrow to the seller              (59.2s)
PASS  the chain shows the escrow paid out and the vault emptied
PASS  a party who has never seen this deployment can join it

21/21 steps passed
```

The times are real, from one run on an ordinary laptop with nothing else
competing for it. They are not a benchmark — an earlier run with a compile going
alongside was two to three times slower throughout. What they are useful for is
the shape: proving dominates everything else, and a settlement costs about what
an issuance does.
Each transaction also prints its cost against every block limit before it is
submitted, because a transaction that exceeds one is refused by the node with a
message that names neither the limit nor the margin. See **[Why twelve entry
points](#why-twelve-entry-points)**.

### The web interface

```bash
npm run dev --workspace @quietbooks/ui
```

It needs a Midnight Lace wallet in the browser to balance and submit, a proof
server for every write, and an indexer to read. Unset, it uses the connected
wallet's own endpoints, which is the right default for TestNet; `ui/.env.example`
documents every variable and [`ui/README.md`](./ui/README.md) covers the
interface itself.

Verified here: it builds, serves and renders its connect screen with no console
errors. A wallet-connected run needs Lace on TestNet, which is not something the
end-to-end harness can stand in for — the harness drives the contract through a
headless wallet against the local network instead.

### The CLI

```bash
npm run dev --workspace @quietbooks/cli
```

Same contract, same API, no browser or extension. [`cli/README.md`](./cli/README.md)
lists what it does and, as usefully, what it does not.

---

## Why twelve entry points

A Midnight deploy transaction carries one verifier key for every entry point —
every top-level `export circuit` that touches the public ledger. Those keys are
the bulk of the transaction, and the transaction has to fit inside one block.

The ledger's limits are per block and multi-dimensional
(`reference/midnight-docs/api-reference/overview/usage-limits.mdx`): 200,000
bytes of blockspace, **50,000 bytes of persistent writes**, 1,000,000 bytes
churned, and a second each of read and compute time. For a contract deploy the
binding dimension is persistent writes, because that is where the verifier keys
land. A transaction is allowed less than a whole block, and how much less is not
documented, so we measured it rather than guessed.

`e2e/probe/` generates a contract with N entry points, compiles it, and deploys
it against the local node, reporting the cost against every limit alongside the
outcome. The circuits it generates are deliberately different from one another:
N copies of one circuit produce N identical verifier keys, which the transaction
encoding compresses away — eighteen identical entry points serialize to 6 KB
where eighteen distinct ones serialize to 41 KB.

| Contract | Persistent writes | Share of the block limit | Node |
|---|---|---|---|
| `example-counter`, 1 entry point | 7,250 | 14.5% | accepted |
| probe, 12 entry points | 30,700 | 61.4% | accepted |
| QuietBooks, 12 entry points | 30,797 | 61.6% | accepted |
| QuietBooks, 14 entry points | 35,858 | 71.7% | **rejected** |
| probe, 16 entry points | 40,284 | 80.6% | **rejected** |
| QuietBooks, 18 entry points | 44,964 | 89.9% | **rejected** |

So a single transaction gets roughly two thirds of a block, not all of it —
consistent with Substrate's own `maxExtrinsic`, which this node reports as 65%
of `maxBlock`. The node's answer either way is the same opaque line:

```
1010: Invalid Transaction: Transaction would exhaust the block limits
```

It names neither the dimension nor the margin, and the wallet's Effect runtime
buries even that behind `SubmissionError: Transaction submission error`. Two
pieces of the harness exist because of this. `e2e/src/wallet.ts` measures every
transaction against every limit before submitting and refuses locally with the
dimension named — it recovers the limits by feeding `normalizeFullness` a unit
vector per dimension until it throws, rather than hardcoding five numbers that
governance can change. `e2e/src/run.ts` unwraps Effect's `Cause` so the node's
real answer reaches the report.

Six circuits were removed to fit. Four were entry points no application code
ever called:

| Removed | Why it was safe |
|---|---|
| `derivePartyKey`, `deriveAdminKey` | Thin impure wrappers that read `instanceSalt` and called the pure `derivePartyKeyWith` / `deriveAdminKeyWith`. Callers read the salt from ledger state and call the pure form, which costs nothing on chain |
| `auditGrantCovers` | Duplicated the grant rule that the envelope validator already applies off chain, where opening actually happens. The rule now has one implementation, `grantCovers` in `contract/src/audit.ts` |
| `readReliabilityOf` | Read counters that are public ledger state and already served by the indexer |

Two were real features, deferred rather than deleted:

| Deferred | Consequence |
|---|---|
| `proveReliability` | The counters are still written by the contract and readable by anyone; the threshold proof over them is Wave 2 |
| `rotateAdmin` | The administrator is fixed at deploy. `setPaused` still works, so the emergency stop is intact |

Both are recorded in [`DECISIONS.md`](./DECISIONS.md) with the measurement that
forced the choice. The alternative — splitting escrow and disputes into a second
contract — was rejected because Midnight has no cross-contract calls
(`reference/midnight-docs/docs/concepts/how-midnight-works/building-blocks.mdx`),
so releasing an escrow and marking its invoice settled would stop being one
atomic transaction. Losing atomicity over money is a worse trade than deferring
a proof.

---

## Paying in the wrong token

Worth its own section, because the first version of this contract got it wrong in
a way that a reader should be able to check rather than take on trust.

Every settlement path compares the coin a buyer hands over against the invoice.
Until recently that comparison was only of the **value**. The token type —
Zswap's coin colour — was hashed into the settlement digest and never checked
against anything.

So an invoice for USD 1,250.00 could be settled with 1,250,000,000 units of any
token at all, including one the buyer minted themselves and that nobody else
would take. The contract would mark the invoice settled, write a settlement
record, and credit the seller's reliability counters. The seller would have been
paid in confetti and the chain would say otherwise.

The invoice terms now carry the token the invoice is payable in:

```compact
tokenType: Bytes<32>,
```

It sits inside the terms commitment, so it is fixed at issuance and cannot be
changed afterwards by either party, and it stays private — which token an invoice
is denominated in is nobody else's business. `settleWithNote` and `fundEscrow`
both compare the incoming coin against it, and the caller has already proven they
hold terms that open the commitment the chain has held since issuance, so there
is nothing to forge.

Two things follow, and the second is the honest half:

- **The value check and the token check are independent.** The right number of
  the wrong token is refused, and so is the wrong number of the right one. Both
  are tested, in both the settlement and the escrow paths.
- **Neither interface lets a seller choose that token yet.** They issue in the
  native shielded token, which is what the local network has. The binding follows
  whatever the invoice says rather than a constant, and a test issues an invoice
  in a non-native token and settles it, so the mechanism is not native-only — the
  interface is.

One question this raises, since it is the sort of thing a careful reader asks:
the token is **not** one of the nine disclosable fields, so an auditor granted
every scope still cannot read it off the invoice. That is deliberate, and it does
not cost them anything. The settlement record commits to the coin that paid —
nonce, token and value — so an auditor holding that coin recomputes the digest
and confirms the token along with the amount. The nine scopes describe what was
*invoiced*; the settlement digest describes what was *paid*. The token belongs to
the second question.

---

## Paying the wrong person

The same shape of bug, one layer down, and the one that took longest to see.

Every paying circuit took the recipient as an argument. The value was checked,
the token was checked, and where the money actually went was whatever the caller
typed. `settleWithNote` is called by the buyer; `releaseEscrow` is called by the
buyer; `resolveDispute` is called by the arbiter. In each case the person
choosing the address is not the person being paid.

So a buyer could settle an invoice by paying themselves and the contract would
record it as settled, increment the seller's reliability, and write a settlement
digest an auditor could verify. Every number in that record was true. The money
had gone the wrong way.

The invoice now names both addresses, inside the terms commitment:

```compact
sellerPayout: Bytes<32>,   // where the seller is paid
buyerPayout: Bytes<32>,    // where the buyer is paid on a dispute
```

`settleWithNote` and `releaseEscrow` refuse any recipient but `sellerPayout`.
`resolveDispute` binds the address to the ruling — a verdict for the seller can
only pay `sellerPayout`, a verdict for the buyer only `buyerPayout` — so an
arbiter can no longer rule for one party and send the money to a third.

`refundEscrow` is the deliberate exception. The caller has proven they are the
buyer and the money is going back to the buyer, so the only person a free choice
of address can hurt is the person making it. Binding it would also mean an
invoice issued without a buyer address could never be refunded, which turns a
deadline into a trap.

### The rule that followed from it

Binding the arbiter's payment made a second problem visible. The seller writes
the terms. So a seller could name an arbiter and leave the buyer's address
empty, and a ruling for the buyer would send the escrow to the zero key, where it
is gone; or name their own address for both sides, and a ruling for the buyer
would pay the seller. Either way the arbiter is unable to rule against the party
who appointed them, which is the one thing an arbiter exists to do.

`issueInvoice` now refuses an invoice that names an arbiter without a distinct,
non-empty buyer address. Both front ends check the same rule in the form, so it
costs a sentence rather than a failed proof.

### Does the payout address end up on the chain?

No, and this is worth stating because the natural assumption is yes.

A `disclose()` is required to pass the address to `sendShielded`, and a reader
who knows what `disclose()` means will reasonably expect the address to appear in
the transaction. It does not. In the compiled contract the recipient reaches
`createZswapOutput`, which pushes to `privateTranscriptOutputs`; what lands in
the public transcript is `coinCommitment(output, recipient)` — a hash. The
address is an input to something public, not a public output.

So binding the payout costs no privacy. What it costs is that an arbiter now has
to hold the invoice openings to prove the binding, which means the arbiter sees
the amount. That is a disclosure to one named party the seller chose, not to the
chain, and it buys a dispute process whose outcome cannot be redirected.

---

## Testing

| Suite | What it proves |
|---|---|
| `derivation.test.ts` | The off-chain helpers produce byte-identical results to the compiled circuit |
| `lifecycle.test.ts` | Issue, settle, cancel, and every authorisation rule |
| `escrow.test.ts` | Funding, release, refund deadlines, disputes, arbitration |
| `audit.test.ts` | Grants, scope coverage, expiry, revocation, the reliability record, admin |
| `audit-envelope.test.ts` | Envelope crypto and all eight validator checks |
| `hostile-witness.test.ts` | What the contract does when the prover lies |

234 tests, all passing, no Docker required: they drive the compiled contract
in-process through `@midnight-ntwrk/compact-runtime`, so a full run takes about
eleven seconds.

### Tests that pass for the wrong reason

Two are worth calling out, because in both cases a green suite was hiding a real
defect.

An earlier version of the derivation suite compared an encoding helper against
itself. It passed while the helper encoded integers in the wrong byte order,
which would have shipped audit envelopes no auditor could verify. It now folds
our own field commitments independently and compares the result to the compiled
circuit's root, so it cannot pass vacuously. Reintroducing the bug fails seven
tests.

The second was worse, and it is why `hostile-witness.test.ts` exists. Every
other suite runs the honest witness implementation from `contract/src/witnesses.ts`
— so every value the contract saw came from software trying to be correct, even
in the tests that assert a refusal. A witness is not like that. It is a private
input the caller's own machine produces, the chain never validates it, and an
attacker ships their own. Reverting the most serious fix in the contract, the
one that stopped `settleWithNote` reading the terms witness twice, left all 215
tests of the time green. The attack it reopens settles a six-million invoice for
one unit.

### Mutation testing

The way that was found, and the way the rest are kept honest: revert a fix,
recompile, and check the suite actually goes red.

`compact compile --skip-zk` produces a `contract/index.js` byte-identical to the
shipped build, so a mutant compiles in eight seconds and the whole sweep runs in
minutes. Sixteen reverted fixes, sixteen failing tests — including the double
witness read, which now fails on a test that asserts the prover is asked exactly
once, rather than on one consequence of asking twice.

One mutant can no longer be written at all: `fundEscrow` used to compare its
deadline against a `fundedAt` the same caller supplied, and that argument has
been deleted rather than checked. A bug you cannot express is better than a bug
you test for.

---

## What is not built yet

Stated plainly, because a roadmap that only lists wins is not a roadmap.

- **Nothing issues in a token other than the native shielded one.** The contract
  now binds each invoice to the token it is payable in and refuses a payment in
  any other, but neither interface offers a way to pick that token at issue time,
  so every invoice they create is denominated in the native token. The
  enforcement is real and tested; the choice is not yet offered. See **[Paying in
  the wrong token](#paying-in-the-wrong-token)**.
- **The end-to-end run uses one wallet for every role.** Seller, buyer and
  arbiter are three PINs of the same wallet, which is a real test of the
  authorisation rules and a poor test of payment: a payment to the wrong party is
  structurally invisible when every party is you. The circuit tests cover the
  binding and the mutation sweep confirms they bite, but a genuine two-wallet run
  against the local node is not built.
- The threshold proof over the reliability counters is written and was deployed
  in an earlier build, but does not fit in the current deploy alongside escrow
  and disputes. The counters are still kept. See **[Why twelve entry
  points](#why-twelve-entry-points)**.
- The administrator is fixed at deploy. `rotateAdmin` was removed for the same
  reason; `setPaused` remains, so the emergency stop works.
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
