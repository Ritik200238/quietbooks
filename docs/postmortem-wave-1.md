# Wave 1 postmortem

Written 2026-10-16. Wave 1 closed on 2026-09-16 and QuietBooks was unplaced; Wave 2 closes
2026-10-17 and Wave 3 on 2026-11-16 (`DECISIONS.md:165`).

This document answers one question: a judge had roughly twenty minutes per entry, and in those
twenty minutes QuietBooks lost to [PollPower](https://github.com/PollPower/contracts). Why.

The short answer is that we built the better contract and they built the better case. Every claim
below is checked against the two repositories; file paths and line numbers are given so anyone can
disagree with the evidence rather than the conclusion.

---

## Correction, 2026-10-19: Wave 1 was never judged

Everything below was written before anyone read the judging record, and its central premise is
wrong. QuietBooks did not lose a comparison with PollPower. It was not in the comparison.

AKINDO publishes every submission and every judge's vote through its public API
(`https://api.akindo.io/public/wave-hacks/jaMZjqPOBsLXvjdG/waves/93kamlaZdFzG7oaA/submissions`).
For our Wave 1 entry it records:

| Field | Value |
|---|---|
| `product.name` | `Quietbook` |
| `product.isPublic` | `false` |
| `product.githubRepositoryName` | `null` |
| `product.deliverableUrl` | `null` |
| `votes` | `[]` |

Of 159 Wave 1 submissions, 7 received a vote, and all 7 were public with a repository entered in
the repository field. Ours was private, and its links existed only as text inside the description.
Being public with a linked repository is not sufficient — 105 entries were public and 99 had one
— so what else the judges filtered on is unknown. It is plainly necessary.

The votes themselves are worth reading, because they are the rubric as it is actually applied.
Each Engineering note opens with whether the contract "compiled cleanly" and how many circuits it
"defines", then whether there is "genuine private state with a `witnesses.ts` and a
commitment/hash". QA asks whether tests "exercise the contract through a simulator and assert
real state". UX asks whether "a react frontend is present", whether it "sets up the full wallet
provider stack", and whether it "calls the contract and reads on-chain state back". PollPower
placed first with the note "No runnable frontend was detected" and "Test files exist but don't
drive the contract through a simulator". QuietBooks has both, and no judge saw either.

The diagnosis below — that a judge could check nothing — still holds for the day the entry is
read, so it stays as written. But the first fix is not engineering and not evidence. It is
filling in the submission form.

---

## 1. What a judge can actually check

A judge does not clone the repository, install WSL2, start Docker, bring up a four-container local
Midnight network and run our end-to-end suite. A judge opens the README, watches the video, clicks
the live link, and skims the file tree.

Measured against that, here is what the two entries offered.

| | QuietBooks | PollPower |
|---|---|---|
| Public transaction hashes a judge can paste into an explorer | **0** | **6**, dated 2026-08-05 |
| Deployed contract addresses published | 0 | 13 across 6 contract families |
| Contract deployed on a network a judge can reach | no | Midnight Preview |
| Self-audit published with findings | no | 11 findings, severity-rated, with fix status |
| Dated milestone history | no | 6 dated milestones, 2026-06-10 to 2026-08-05 |
| Demo video | **broken** — see §4 | working |
| Lines of Compact (current contracts) | 1,271 | 11,353 |
| Lines of design documentation | ~420 (README) | 20,674 across 40+ files |
| Commits | 91 | 73 |

Everything we built ran on `localnet/standalone.yml`, on this laptop, behind WSL2. It was real —
real proofs, real Zswap transfers, real settlement — and it was invisible. Nobody outside this
machine has ever been able to verify a single thing QuietBooks does.

PollPower's `ebt/ceremony-artifacts/settle-flow-e2e-preview.json` is the artifact that beat us. It
is 50 lines of JSON listing six Preview transaction hashes, each with the circuit it called and the
state change it produced:

```
step C  circuit settle  contract ebt
txHash  16f160947b7302cb377e77ba610b20fe892b1fd0fa7eba2cfa5d8125724eb020
effect  _totalSupply 0 -> 100000 (real HAT sig)
```

A judge can check that in thirty seconds without trusting anyone.

---

## 2. Where QuietBooks is genuinely ahead

This is not a story about being outbuilt on engineering. On the parts of the rubric that ask whether
you understood Midnight, we are ahead, and it is worth recording precisely how, because Wave 3 has
to make these visible rather than abandon them.

**They do not use shielded tokens at all.** PollPower's EBT is an unshielded, contract-minted ledger
token. Supply, every policy slice and every log entry is public. On a privacy chain, their settlement
publishes `_totalSupply 0 -> 100000` and the five slice amounts (`producer: 46430, ops: 20000,
dividend: 15720, dao: 0, statutoryLane: 17850`) straight into public state. QuietBooks never writes
an amount to public state in any circuit, and settles buyer → contract → seller inside one
transaction using `receiveShielded` followed by `sendImmediateShielded`, so the contract's balance
change is zero and Zswap hides the value on both legs. The reasoning, including why contract custody
and a hidden amount are mutually exclusive on Midnight today, is in the header of
`contract/src/quietbooks.compact`.

**Their core authorization gate is a prover-supplied witness.** `ebt/ebt-v8.compact:118` declares:

```compact
witness signature_valid(
  pubkey: Bytes<32>,
  messageHash: Bytes<32>,
  signature: Bytes<64>,
): Boolean;
```

A witness is supplied by whoever builds the proof. Line 983 uses it as the only signature check on
the mint path:

```compact
assert(disclose(signature_valid(disclose(hatPubkey), payloadHash, disclose(hatSig))),
       "Bad HAT signature");
```

Nothing in any `.compact` file in that repository verifies an Ed25519 signature in-circuit; a grep
for `ed25519` returns only comments, and their own comment at `ebt/ebt-v5.1.compact:61` says
verification "happens in the prover via @noble/ed25519". So a party building their own proof can
return `true` and mint. The same pattern gates every multisig operation
(`multisig_signature_valid`, used at lines 609, 620, 632, 657, 678) and the escrow attestation
(line 1268). The receipt artifact's `"inCircuitVerify": true` describes a check that is not in the
circuit.

QuietBooks derives identity from a witness secret bound to a commitment that is already on the
ledger (`derivePartyKeyWith`, `callerKey`, `assertAdmin` in `contract/src/quietbooks.compact`), so a
forged witness fails the commitment comparison.

**They use `ownPublicKey()` for authorization.** `community-poll/community-poll-v2.compact:113-152`
sets `owner` and `pollAuthority` from `ownPublicKey()` and compares callers against them. That is the
anti-pattern documented in `reference/midnight-docs/docs/compact/smart-contract-security.mdx`. Their
README marks that contract "✅ PRODUCTION — deployed 2026-06-12".

**Their tests do not run the compiled contract.** `ebt/tests/lib.mjs` is an offline JavaScript mirror
of the contract logic. Ours run the compiled artifact.

None of this made any difference, because no judge read either contract.

---

## 3. Where they are genuinely ahead

Three things, and only one of them is about code.

**Receipts.** Covered above. This is the whole game.

**They publish their own weaknesses, loudly.** Their README, above the fold, says their Preview admin
set is "1 real Tangem ring + 4 pilot-mock keys, all held by Garrett" and that "external attackers can
derive the four pilot-mock private keys from public seeds". It labels their own v1 poll contract "No
real ZK guarantees despite comments claiming otherwise". An audit on 2026-06-10 is published with 2
critical, 2 high, 4 medium and 3 low findings and the fix status of each.

This is not modesty, it is a scoring weapon. It makes every other claim in the document credible,
and it pre-empts the judge: any flaw they find is already in the table, dated, with a fix plan. We
published no such table, so a judge had no way to tell a careful builder from a lucky one.

**Scale signals.** 230 files, 40-plus design documents with names like `NATIONAL-ESCROW-DESIGN.md`
and `STATUTORY-LANES.md`, contracts versioned v5 through v8, a separate whitepaper repository. Some
of this is inflation — ten near-copies of one EBT contract account for 7,171 of their Compact lines —
but the effect on a twenty-minute skim is real, and the dated version progression reads as a team
shipping over four months.

---

## 4. What we did to ourselves

The competitive gap is only half the story. Four self-inflicted problems cost more than PollPower did.

**The demo video was broken.** `docs/quietbooks-demo.mp4` and
`docs/quietbooks-demo-presentation.mp4` are 154 seconds long. Five of the seven slides are product
screenshots, and all five show Chrome's XML parse error page — *"This page contains the following
errors: error on line 20 at column 160: Entity 'middot' not defined"* — above an empty black
rectangle with a fabricated address bar. The source frames are still in `video/shots/`. The cause:
the "screenshots" were never screenshots. They were hand-drawn SVGs that used `&middot;` without
declaring the entity, which makes them invalid XML, so the browser refused to render them and
screenshotted its own error instead.

A judge watching that concludes nothing works, and then discounts the README too. This alone can
explain the result.

**The video narration is AI slop.** `video/scenes.json` contains "Issuing an invoice is seamless",
"Privacy is the default, not an afterthought", "Zero plaintext touches the mempool". That is exactly
what `CLAUDE.md` forbids, and it reads as generated to anyone who has seen a hundred of these.

**The live site cannot be used by anyone who visits it.** `ui/.env.example` defaults
`VITE_NETWORK_ID=undeployed`, which points at `localhost:9944`, `localhost:8088` and `localhost:6300`.
No contract address is committed anywhere in the repository. A judge opening
`https://quietbooks.vercel.app` with Lace on Preview can connect nothing and do nothing. The page
loads, and that is all it does.

**The deck has no pictures.** `docs/pitch.html` is 40 KB of clean, honest text with zero images.
Correct and unmemorable.

---

## 5. The actual diagnosis

We optimized for being right. They optimized for being checkable.

Both matter, but only one of them survives contact with a judge who has twenty minutes and twelve
other entries to get through. A correct contract nobody can run scores lower than a flawed contract
with six transaction hashes next to it, and that is not unfair — unverifiable work is
indistinguishable from work that was never done.

The second-order lesson is about trust. Our README made strong claims (no amount in public state,
atomic shielded forwarding, eight audit checks) and offered a video of a browser error page as
proof. PollPower made weaker claims and offered hashes. Claims without receipts cost credibility
rather than earning it.

---

## 6. What changes next

Priority order, highest first. Nothing below the line starts before the thing above it is finished.

1. **Deploy to Midnight Preview and publish the transaction hashes.** One artifact,
   `docs/receipts/preview.json`, with the same shape as PollPower's: deploy, issue, settle and audit,
   each with its circuit, transaction hash, date and state effect. This is the single highest-value
   item in the project and it is blocked on faucet tokens, which need a human to request them.
   `npm run preview:fund --workspace @quietbooks/e2e` prints the address to fund. (This first named
   a specific address; the wallet behind it has been regenerated since, and the seed never belongs
   in the repository, so the command is the durable reference.)
2. **Point the live site at that deployment.** A visitor with Lace on Preview must be able to open
   `quietbooks.vercel.app`, connect, and read a real invoice without installing anything.
3. **Delete the three broken videos and record a real one** against the deployed contract, narrated
   in plain language with no generated prose.
4. **Publish a self-audit of our own contract**, severity-rated, with fix status, including the four
   bugs the green test suite could not see that are already documented in the README.
5. **Rewrite the README around the receipts**, with dated milestones and a status column per circuit.
6. **Put real screenshots in the deck.**

The engineering is not the problem. The evidence is.

---

## 7. Wave 2 progress, scored on 2026-10-18

This section first said Wave 2 had closed on 2026-10-17. It had not: the wave record says
submissions close at **2026-10-19 15:00:34 UTC** (`activeWave.submissionDeadline` from
`https://api.akindo.io/public/wave-hacks/jaMZjqPOBsLXvjdG`), and as of 2026-10-18 QuietBooks had
not been submitted to it at all.

Four of the six items above landed. The first one did not, and it is the one that matters: the
section above calls it "the single highest-value item in the project". There are still no public
transaction hashes.

| # | Item | Wave 2 outcome |
|---|---|---|
| 1 | Deploy to Preview, publish receipts | **Not done.** Script written and reviewed (`e2e/src/preview-deploy.ts`), never run against the network. |
| 2 | Point the live site at the deployment | **Not done**, and cannot be until 1 is. |
| 3 | Delete the broken videos; record a real one | **Half.** The three broken videos are gone. No replacement was recorded, so the entry now has no demo video at all. |
| 4 | Publish a self-audit | **Done**, `docs/audit-2026-10-16.md`, three findings, severity-rated. All three fixed on 2026-10-18. |
| 5 | Rewrite the README around the receipts | **Not done**, because there are no receipts to rewrite it around. |
| 6 | Real screenshots in the deck | **Done.** Captures of the running product replaced the drawings. |

### Why item 1 did not happen

Two reasons, and only one of them is a real constraint.

**The faucet is gated on a Cloudflare Turnstile captcha.** A request carrying the placeholder token
that `testkit-js` sends is answered `403 {"error":"Captcha verification failed"}`. Worse, testkit's
`FaucetClient` posts to the faucet's base URL, which serves the single-page app: the response is
`200 OK` with an HTML body and the client reports success, so the original run waited indefinitely
for money nobody had sent. That is fixed — `preview-fund.ts` calls the real endpoint and says
plainly when it cannot ask — but the gate itself is deliberate and is not ours to route around. It
needs a person at a browser for about thirty seconds.

**The machine ran out of memory.** Proving needs the proof server, and the host has 8 GB with a
browser on it. Two runs were killed by the operating system at roughly 1.2 GB free. A
proof-server-only compose file now exists so the node and indexer are not also resident, but this
is an ordinary resource problem, not a technical obstacle, and it should not be described as one.

### What this means for Wave 3, closing 2026-11-16

The ranking of work does not change, because the diagnosis in §5 has not changed and is now
supported by a second data point: a wave spent improving the contract, the audit and the deck moved
nothing, because none of it is checkable by someone who will not clone the repository.

1. Fund the wallet and deploy. Thirty seconds of human attention stands between this project and
   the thing it has twice been beaten on.
2. Record the demo video against that deployment. The entry currently has none, and the buildathon
   asks for one, so this is an eligibility question and not a presentation one.
3. Then the engineering, which is in good shape and getting better.
