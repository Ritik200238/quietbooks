# QuietBooks CLI

A terminal client for the QuietBooks contract. Everything the product does is
reachable from here, with no browser and no wallet extension: deploy or join an
instance, issue an invoice whose amount never reaches the chain, hand the record
to the counterparty, settle it, escrow it, dispute it, grant an auditor a named
set of fields, and prove a settlement record clears a threshold without opening
a single invoice.

The CLI is a thin layer. Every operation goes through `@quietbooks/api`, which is
the same module the web interface uses, so what a judge verifies here is the
product and not a demo path built beside it.

---

## Prerequisites

| Requirement | Why |
| --- | --- |
| Node 22 or newer | The workspace targets Node 22 ESM. `node --version` |
| Docker, running | The testkit starts containers. `standalone` runs a node, an indexer and a proof server from `compose.yml` in this directory; `preview-remote` and `preprod-remote` run the proof server only, from `proof-server.yml`, and talk to the public chain. Both file names are fixed by the testkit, which looks for them in the working directory. |
| A proof server | Started for you as a container. You do not launch it yourself, and the URL it picks is printed at startup. It runs locally rather than as a hosted service because proving needs the invoice openings, and those are what this product keeps off other people's machines. |
| The compiled contract | `../contract/build` must hold `keys/` and `zkir/`. That directory is this CLI's `zkConfigPath`. If it is missing, compile it: `npm run compact --workspace @quietbooks/contract` (needs the `compact` toolchain on PATH). |
| Funds | `standalone` uses the local genesis wallet, which is already funded. `preview-remote` and `preprod-remote` ask the network faucet on startup and then wait until NIGHT arrives. |

Docker must be reachable by the user running the CLI. On Windows that means
Docker Desktop started and the WSL integration enabled; on Linux, membership of
the `docker` group.

---

## Install and build

From the repository root:

```bash
npm install
npm run build          # builds contract, then api, then this CLI
```

The launchers run the TypeScript sources directly, so `npm run build` is not
required to start the CLI. It is required for `dist/`, and it is the fastest way
to find out whether the whole workspace still compiles.

---

## Running

From the repository root:

```bash
npm run standalone      --workspace @quietbooks/cli
npm run preview-remote  --workspace @quietbooks/cli
npm run preprod-remote  --workspace @quietbooks/cli
```

or from this directory:

```bash
npm run standalone
```

### Options

| Option | Effect |
| --- | --- |
| `--verbose`, `-v`, or `QUIETBOOKS_VERBOSE=1` | Full stack traces instead of one-line messages, and the network log on screen. |
| `--identity <label>` or `QUIETBOOKS_IDENTITY=<label>` | Runs as a separate QuietBooks party: its own private state store (`quietbooks-private-state-<label>`) and its own root secret, and therefore its own party key. Needed whenever two parties share a machine, because LevelDB locks its directory. |
| `DEBUG_LEVEL=debug` | Sets the on-screen log level directly. |
| `QUIETBOOKS_STORE_PASSWORD=…` | Passphrase for the private state store. Defaults to a fixed value: the store already sits on your own disk under your own account. |

Pass options through npm with `--`:

```bash
npm run preview-remote --workspace @quietbooks/cli -- --identity seller --verbose
```

A full log of every run is written to `cli/logs/<launcher>/<timestamp>.log`
regardless of the console level. Log output goes to stderr, so `... > session.txt`
captures a clean transcript of just what the CLI printed on purpose.

---

## What happens when it starts

1. The testkit starts the environment. On `standalone` this pulls and runs
   containers, which takes a few minutes the first time.
2. The wallet is built. `standalone` uses the local genesis seed. The remote
   launchers offer a fresh wallet or one restored from a seed.
3. The seed and the shielded address are printed. **Write the seed down.** It is
   the only way back to this wallet, and the QuietBooks root secret is derived
   from it, so losing it loses the ability to open every invoice this wallet
   holds.
4. The unshielded address is printed and the CLI waits until NIGHT arrives. The
   remote launchers ask the faucet first.
5. On the remote networks, NIGHT is registered for dust generation. Without that
   step nothing can pay a fee.
6. Providers are assembled: `levelPrivateStateProvider` (store
   `quietbooks-private-state`), `indexerPublicDataProvider`,
   `NodeZkConfigProvider` over `../contract/build`, and
   `httpClientProofProvider`.
7. You are asked to deploy a new instance or join one by contract address.
8. The menu opens.

Ctrl-C at any point closes the prompt, releases the private state store, stops
the wallet and tears the containers down.

---

## The menu

| # | Entry | Notes |
| --- | --- | --- |
| 1 | List invoices | Short id, status, role, due date, amount. `—` in the amount column means this wallet holds no opening for that invoice. |
| 2 | Issue an invoice | Currency, line items, tax, memo, order reference, due date, buyer key, optional arbiter. Shows the subtotal, tax and total, and asks before submitting. |
| 3 | Show an invoice | Everything: anchor digests, terms if you can open them, settlement, audit grant, dispute. |
| 4 | Export an invoice record | The JSON the counterparty needs. |
| 5 | Import an invoice record | Paste the JSON; the paste ends as soon as it parses. |
| 6 | Settle with a shielded note | See "Settlement paths" below. |
| 7 | Attest settlement | Seller only. For payments made off chain. |
| 8 | Cancel an invoice | Seller only, and it counts against the seller's record. |
| 9 | Escrow | Fund, release, refund. Funding prints a warning first: it publishes the amount. |
| 10 | Dispute | Open, and resolve as the arbiter. |
| 11 | Audit | Grant a named set of fields with an expiry, or revoke. The audit key is generated and printed once. |
| 12 | Reliability | The contract's own counters, and a threshold proof against them. |
| 13 | My identity | Party key, administrative key, whether this wallet is the administrator. |
| 0 | Exit | Stops the wallet and closes the store. |

Anything the contract refuses comes back as one line, in the words the assertion
itself uses, and the menu reappears. `--verbose` turns the stack back on.

---

## Settlement paths, and what each one costs you in privacy

| Path | Who calls it | What the chain learns | Status |
| --- | --- | --- | --- |
| Shielded note (menu 6) | Buyer | That the invoice settled, and a 32-byte commitment. Not the amount, not the recipient. | **Known not to work from this CLI alone.** The circuit calls `kernel.claimZswapCoinReceive`, so the ledger accepts the call only when that note commitment is an output of the same transaction. This CLI submits the contract call on its own and does not build the payment output, so the ledger refuses it unless your wallet put the output there. The CLI says so at the prompt rather than letting you find out after a proof. |
| Attested (menu 7) | Seller | That the invoice settled, and a receipt digest. | Implemented; the circuit needs nothing but the call. Weaker by design: the chain records the seller's statement, not the payment. The seller is the party who loses by lying, which is why only they can call it. |
| Escrow (menu 9) | Buyer funds, buyer releases | **The amount, in the clear**, plus the token and the deadline. | Implemented. The contract takes custody through `receiveShielded`, which relies on the transaction carrying an output to the contract for the coin passed in; that part is the midnight-js balancer's job rather than this CLI's. Pick escrow only when a locked balance is worth more than a hidden one. |

Neither of the last two has been exercised against a live chain from this machine — see **Verification status**.

---

## A worked two-party walkthrough

Two terminals, two wallets, one chain. Use `preview-remote`: it gives each side a
real wallet of its own and the contract survives, whereas `standalone` runs its
own throwaway containers per process, so two standalone CLIs cannot see each
other's chain.

Throughout, **A** is the seller and **B** is the buyer.

### 1. A starts and deploys

```bash
npm run preview-remote --workspace @quietbooks/cli -- --identity seller
```

* Wallet menu: `1` for a fresh wallet. Save the seed it prints.
* Wait for the faucet. The NIGHT balance is printed when it lands.
* Contract menu: `1` to deploy. **Copy the contract address.**
* Menu `13`. **Copy A's party key** (the 64-hex value on its own line).

### 2. B starts and joins

```bash
npm run preview-remote --workspace @quietbooks/cli -- --identity buyer
```

* Wallet menu: `1`. Save this seed too.
* Contract menu: `2`, then paste A's contract address.
* Menu `13`. **Copy B's party key** and send it to A.

`--identity` matters here: without it both processes would open the same LevelDB
directory and the second would fail on the lock.

### 3. A issues the invoice

Menu `2`, then:

```
Currency code [USD]: USD
Line 1 description: Design retainer, September
Line 1 quantity: 1
Line 1 unit price: 480000
Line 2 description:            <- blank ends the list
Tax on top of the subtotal: 91200
Memo (optional): PO 4471, net 30
Order reference (optional): PO-4471
Due in how many days? [30]: 30
Buyer party key (64 hex): <B's party key>
Arbiter party key (64 hex) (blank for none):
```

The summary shows `Subtotal 480,000 USD`, `Tax 91,200 USD`,
`Total payable 571,200 USD`. Answer `y`. **Copy the invoice id.**

Only commitments to those figures went on chain.

### 4. B sees the invoice, and cannot read it

Menu `1` in B's terminal. The invoice is listed — status, role `buyer`, due date
— and the amount column shows `—`. B is a named party and still cannot open the
terms, because the openings never left A's wallet. That is the product working,
not a gap in it.

### 5. A exports the record, B imports it

* A: menu `4`, pick the invoice, copy the whole JSON block.
* B: menu `5`, paste it, answer `buyer` when asked for the role.
* B: menu `1` again. The amount now reads `571,200 USD`.

The record travelled between the two parties, not through the chain. Menu `3` in
B's terminal now shows the terms alongside the anchor they open.

### 6. B settles

Pick a path from the table above.

* **Escrow, the buyer-side path this CLI implements in full.** B: menu `9`, then
  `1`. Read the warning: this publishes the amount. Lock `571200` — the figure is
  in the escrowed token's smallest unit, not in the invoice's currency, and the
  contract does not check the two against each other. Leave the token colour
  blank for the native shielded token, take the default deadline and type
  `escrow` to confirm. Then `9`, `2` to release it to A, pasting A's Zswap coin
  public key. The invoice moves to settled with mode `Released from escrow`.
* **Attested.** B pays A by bank transfer. A: menu `7`, choose `text`, and type
  the payment reference; the CLI hashes it and anchors the digest.
* **Shielded note.** Menu `6` is there and takes the commitment, but see the
  table: the ledger refuses it unless the payment output is in the same
  transaction, which this CLI does not construct.

Either way, menu `1` in both terminals now shows the invoice as settled, and
menu `12` in A's terminal shows the settled counter at 1 — maintained by the
contract, not by the wallet.

### 7. A grants an auditor three fields

Menu `11`, then `1`:

```
Grant on which invoice? 1
Fields: 1, 2, 6            <- amount, tax, currency
Grant expires in how many days? [30]: 30
```

The summary confirms what goes on chain: the key hash, the field list and the
expiry. Answer `y`. The CLI prints:

```
AUDIT KEY: 4f1c… (64 hex)
```

once, and never again. It is not stored. The chain holds only its hash, so
nobody reading the ledger can open anything with what is published there. Send
the key to the auditor with the audit envelope, over a channel you trust.

Menu `3` on that invoice now shows the grant: the fields by name, the expiry, and
that it is in force. Menu `11`, `2` revokes it, and revocation beats the expiry.

The auditor receives three fields. The line items, the memo, the order reference,
the buyer's and seller's keys and the due date stay closed, and the field root on
the anchor still proves the disclosed values belong to this invoice and no other.

---

## Verification status

What has actually been run, so nothing here is taken on trust:

* **Checked.** `npx tsc --noEmit` in this directory, with the workspace packages
  resolved from source. Startup through to the container launch, on a machine
  with no Docker: the header renders, the failure is reported as one line, and
  the session shuts down cleanly. `--verbose` restores the stack. `--identity`
  rejects an unusable label with a single line. The interactive layer driven
  against a stub API: the invoice table with openable, opaque and settled rows;
  the detail view in all three states; the whole issue flow including the
  running subtotal, the tax ceiling and the confirmation; and every prompt's
  rejection path (empty, non-numeric, negative, short hex, non-hex, odd-length
  hex, out-of-range day counts).
* **Not checked.** Anything that needs a chain. No container runtime was
  available on the machine this was written on, so no deployment, no proof, no
  transaction and no settlement has been run end to end. The walkthrough above
  describes what the code does, not a session someone watched.
* **Known broken upstream.** `@quietbooks/api` calls `deployContract` and
  `findDeployedContract` with a `contract:` property; `@midnight-ntwrk/midnight-js-contracts`
  4.1.1 names it `compiledContract:`. Until that is fixed in the api package,
  deploying and joining will fail, and with them everything downstream. The
  typecheck reports it as the only two errors it finds, both in `../api/src/index.ts`.

## What this CLI does not do

Stated plainly, because a judge should not have to find these out by hitting
them.

* **It does not build the shielded payment for menu 6.** See the settlement table.
* **It does not build or validate audit envelopes.** Menu 11 publishes the grant
  and prints the key, which is the on-chain half. The envelope that carries the
  disclosed fields, and the validator that checks it against the anchor, live in
  `contract/src/audit.ts` and are not re-exported from the contract package's
  entry point, so the CLI cannot reach them without changing that package.
* **It does not administer the contract.** `setPaused` exists on the API and has
  no menu entry.
* **It does not act on more than one PIN.** Every call uses PIN 1. The API takes a
  PIN on every method, so a second identity within one wallet is possible; the
  CLI does not expose it, and `--identity` covers the two-party case instead.
* **Standalone is single-party.** Each standalone process starts its own
  containers, so two of them are two separate chains. Use `preview-remote` or
  `preprod-remote` for anything involving two wallets.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `Cannot find module '@quietbooks/contract'` | The workspace has not been installed. Run `npm install` at the repository root. |
| Deploying or joining fails on the options object, or `compiledContract` is reported as missing | `@quietbooks/api` calls `deployContract`/`findDeployedContract` with a `contract:` property. In `@midnight-ntwrk/midnight-js-contracts` 4.1.1 that property is named `compiledContract`. It is in the api package and has to be fixed there; the CLI cannot work around it. `npx tsc --noEmit` in this directory reports it. |
| The zk config provider cannot find a circuit | `../contract/build` is missing or was compiled with `--skip-zk`. Recompile with `npm run compact --workspace @quietbooks/contract`. |
| The CLI hangs after printing the unshielded address | It is waiting for NIGHT. On the remote networks the faucet can be slow; the address is on screen, so it can also be funded by hand. |
| `this wallet cannot open invoice …` | The record was never imported. Ask the counterparty for the export (menu 4) and import it (menu 5). |
| The private state store will not open | Another CLI already holds the lock. Give the second one `--identity <label>`. |
| Everything fails at balancing with a fee error | On a remote network, dust registration did not complete. Restart the CLI; it registers on startup. |
