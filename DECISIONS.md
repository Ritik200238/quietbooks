# Decision log — what to build for the Midnight Buildathon

Method: accept → attack from every angle → kill or refine → iterate. Only survivors of two attack rounds are recommended.
Started 2026-09-02. Research inputs: `research/01-pain-points.md`, `research/02-midnight-capabilities.md`, `research/03-funding-landscape.md`.

## The frame

**Decision:** which single dApp to build for the Midnight Buildathon (one idea, one wave, iterated in later waves).

**Success criteria, ranked:**
1. **Real PMF** — an urgent pain felt now, where *prove-without-revealing* is the must-have. Evidence of demand required.
2. **Deep Midnight fit** — the contract must genuinely need both ledgers: public state + private witness state + `disclose()`. This is the 40% Engineering row.
3. **Buildable and demoable** by a solo developer in weeks, plug-and-play on `midnight-local-dev`, with a test suite.
4. **Original** — not in Midnight's tutorial set and not already in `midnightntwrk/midnight-awesome-dapps`.

**Hard constraints (verified in `research/02`):** Compact must compile (compiler 0.31.1). No cross-contract calls. No oracles. Bounded loops only. No on-chain randomness. `ownPublicKey()` is not auth. Lace needs a local proof server. Apache-2.0, public repo, `midnightntwrk` topic, deck + video.

**Assumptions:** solo developer plus Claude; several weeks per wave; no paid infra.

## Candidates considered (round 1)

| # | Candidate | Round 1 result |
|---|---|---|
| A | Private compensation rails: payroll + vesting streams in USDM/NIGHT with selective disclosure to auditors | **Survived** (wounded) |
| B | Compliance-ready shielded pool with proof-of-clean-funds (Privacy Pools for Midnight) | **Survived** (wounded ×2) |
| C | Shielded-balance-weighted private governance for Midnight tokens | Wounded |
| D | Proof-of-personhood / passport ZK | **Died** |
| E | Age verification for the Android/web gap | **Died** |
| F | EUDR/CBAM supplier confidentiality | **Died** |
| G | Private crowdfunding with hidden donation amounts | Wounded |
| H | Private prediction market / ZK gaming / lottery | **Died** |
| I | Baseline: polish a tutorial-adjacent idea (private voting) | **Died** |

## Causes of death (running list)

- **D** — World ID (18M+) and Self (2.2B Aadhaar auths/month) own it; ZIP already on Midnight; passport signature verification has no Compact stdlib primitive; biometrics banned in 4 countries.
- **E** — Apple iOS 26.4, Google longfellow-zk, and the EU blueprint ship the credential in the OS; the verifier is a web server, no contract needed; Proof-of-Age Gate already on Midnight.
- **F** — needs a geodata oracle (Midnight has none); buyer is a compliance team on 12-month cycles; the Commission owns the registry.
- **H** — prediction markets need an oracle; Midnight Prediction Market App already exists; ZK gaming has ~600 players industry-wide; no on-chain randomness.
- **I** — "election" is a Midnight tutorial; Shutter is free on 600+ Snapshot spaces; research shows privacy does not stop delegation-renting.
- **C (round 2)** — zero usage evidence for private governance anywhere in the industry; no live Midnight-native tokens or DAOs to govern yet; tutorial proximity caps Product Fit.
- **G (round 2)** — FundAGoal already does crowdfunding on Midnight; nobody pays for donation privacy at the platform level; political donors need fiat rails.

**Recurring kill pattern:** everything consumer-facing dies to the OS vendors or to fake pain; everything enterprise dies to 12-month sales cycles and "a server does this". What survives is **crypto-native money movement where the public ledger itself creates the pain** — the only cases where a shielded chain is the fix, not a feature.

## Round 2 attacks on the survivors

### A — Private compensation rails (payroll now, vesting next)
- *Demand analog:* Coinbase acquired Liquifi (Jul 2025; Uniswap Foundation, OP Labs, Ethena, Zora, 0x as clients). Kraken acquired Magna (Feb 2026; peak TVL $60B, 160+ clients). Sablier: 534K streams, ~297K users. Toku/Aleo launched private stablecoin payroll Jan 2026. Two exchange acquisitions in 8 months = strategic category. Survivable.
- *Shape:* 5/5. Salaries leak only because the chain is public; only a shielded chain fixes it. Survivable.
- *Midnight competition:* none — awesome-dapps has zero vesting/payroll/cap-table entries. Selkie (USDM escrow) proves contract custody of USDM works. Survivable.
- *Stablecoin dependency:* **USDM live on Midnight 14 Aug 2026** via VIA Labs messaging. Payroll in a regulated stablecoin is possible now. Survivable.
- *Feasibility:* verified in stdlib — `receiveShielded`, `sendShielded` with change, `mergeCoin`, kernel `blockTimeGreaterThan/LessThan`. Bounded loop = batch N payees per tx. Auth via witness secret. Unit tests without Docker. Survivable; coin-handling is the hardest part, prototype first.
- *Wound 1 — onboarding:* payees need a local proof server to claim (Lace). Shared by every Midnight dApp; mitigations: WASM proving via Wallet SDK 2.0, Kuira on mobile later. Serious but not fatal.
- *Wound 2 — thin Midnight employer base today:* few Midnight-native teams pay salaries yet; Toku has no named external customers after 7 months. Mitigation: wedge is Midnight-ecosystem teams and Foundation/Catalyst grants, who self-selected for privacy. Serious but not fatal.
- *Regulatory:* selective disclosure to auditor/tax is the product, not a risk — it reconciles DAC8/CARF disclosure with privacy (the open gap in `research/03`). Strength.
- *Innovation angle:* aggregate-public / individual-private (total payroll, headcount, and pay-band compliance provable without any salary revealed). Pay-equity proof circuit ties to EU Pay Transparency Directive (Jun 2026). Nothing like it exists on any chain with a regulated stablecoin.
- **Verdict: survives two rounds. Recommended.** Biggest risk: proof-server onboarding friction. Mitigation: demo on local-dev, ship WASM proving in wave 2.

### B — Compliance-ready shielded pool (proof-of-clean-funds)
- *Shape:* 5/5. *Engineering:* richest — HistoricMerkleTree (unused primitive), nullifiers, shielded mint/burn. *Theme:* exactly Midnight's "rational privacy" narrative. *Competition on Midnight:* none.
- *Wound 1 — buyer unclear:* no evidence NIGHT faces exchange/MiCA compliance pressure (NOT VERIFIED). 0xbow: $6M volume, 1,500 users after 18 months. Zero users at hackathon time.
- *Wound 2 — curator:* a solo dev cannot legitimately curate a sanctions association set. Mitigation: curator-agnostic design (anyone publishes a root; verifiers pick whose to trust).
- *Wound 3 — redundancy:* Midnight already shields natively; value is the attestation only.
- *Legal:* Privacy Pools is the explicitly compliant design; Tornado precedent (Mar 2025 delisting) is favorable.
- **Verdict: survives, wounded. Rank 2.** High Engineering and Vision scores, weak PMF-now.

### C — Shielded-weighted governance (refined: for NIGHT holders)
- *Refinement to dodge killer:* target NIGHT itself (24B supply, 4.5B community-claimed, "governs" per docs) rather than nonexistent ecosystem DAOs; vote weight proven by locking shielded coins in the contract for the vote period.
- *Still wounded:* the Foundation chooses its own governance tooling on its own timeline; industry-wide private-voting usage is zero; "election" tutorial proximity.
- **Verdict: weakest survivor. Rank 3, only because the Midnight-specific gap (Snapshot cannot read shielded balances) is real.**

## Current survivors (after round 2, 2026-09-02)
1. **A — Private compensation rails** (payroll wedge now, vesting/cap-table in wave 2). Recommended.
2. **B — Compliance-ready shielded pool.** Strong engineering/theme, weak demand-now.
3. **C — Shielded-weighted governance for NIGHT.** Real gap, unproven demand.

---

## Round 3 — competition check (2026-09-05 → 09-10). Source: `research/04-competition.md`

New facts that change the picture:
- **ShadowPayroll is already submitted in Wave 1.** Merkle allowlist + nullifier claims. But: **no token custody, amounts are public**, preview-only, solo dev. Their own roadmap ("real token custody and settlement… stronger amount-hiding") is our core.
- **Candor is already submitted.** Comp benchmarking (Levels.fyi with ZK). Adjacent, not a payouts product.
- **Midnight's own Request for Startups lists our idea twice:** Finance #6 "Confidential Payrolling dApp" and Finance #30 "Confidential Token Vesting Manager", plus Governance #22 comp-band stats. Judges want this category; that is also why two teams are already in it.
- **Aleo winners pattern:** money that actually moves wins (Veiled Markets $7,135, ZKPerp $6,010, Alpaca Invoice $2,429). Identity/eligibility proofs land in the $178 minimum tier, and 9 of Midnight's 23 entries are in that cluster. A plain payroll entry on Aleo (StealthPay) also scored minimum: **payroll alone is not enough; the settlement and disclosure design is what scores.**
- **Grants are proportional to points**, not winner-take-all. A same-category competitor lowers our share but does not zero it.
- Deadline: **Wave 1 closes Sep 16, 20:30 JST (17:00 IST).** 6 days from 2026-09-10. Machine still has no WSL distro and no Docker.

### Attack on A with the new facts
- *"Exact incumbent shipped it in the same wave."* Partially. ShadowPayroll shipped a claim registry, not payroll: nothing is paid and amounts are visible. The two hardest, most valuable pieces (shielded custody + hidden amounts) are exactly what Midnight's stdlib already provides (`receiveShielded`, `sendShielded` with change) and they did not use it. **Serious wound, not fatal.** Mitigation: do not present as "a payroll dApp". Present the primitive.
- *"Judges see two payroll entries and split the credit."* Real. Mitigation: lead with the stream primitive and the vesting face (RFS #30, zero competitors), with payroll and contractor payouts as two more faces of the same object.
- *"Plain payroll scored minimum on Aleo."* Confirms the framing risk. Mitigation: settlement is real, amounts hidden, auditor disclosure is a first-class circuit (the Alpaca "audit-ready records" pattern that scored highest on practicality).
- *"6 days, solo, toolchain not installed."* The real killer. Mitigation: the Wave 1 scope below is deliberately small and gated on getting the compiler working on day 0.

### Refined pick: **Private payout streams on Midnight**
One contract object, a *stream*: `(recipient commitment, total, token, unlock schedule)`. Funded with shielded USDM or NIGHT held by the contract. Claimed by proving entitlement and that block time passed the unlock, paid out as a shielded coin (amount and recipient hidden on-chain), one nullifier per unlock. Public ledger: number of streams, total funded, total released, schedule roots, solvency (`released <= funded`). Disclosure circuits: employer proves aggregates (total payroll, headcount, all within band) to an auditor without any single amount.
Three faces of the same object: **vesting** (RFS #30, no competitor), **payroll** (RFS #6, ShadowPayroll without settlement), **contractor payouts with audit-ready records** (the Aleo Alpaca pattern).
Positioning line against ShadowPayroll: *they prove who is on the list; we hide who and how much, and actually move the money.*

### Wave 1 scope (Sep 10 → Sep 16)
- **Day 0 (today):** WSL2 Ubuntu + Docker Desktop + Compact toolchain + `midnight-local-dev` running. Compile a hello contract. Nothing else matters until this passes.
- **Days 1–2:** Contract v1: `createStream` (employer auth from a witness secret, commitments on ledger, `receiveShielded` funding), `claim` (membership + block-time unlock, `sendShielded` to recipient, nullifier), public aggregates. Vitest unit tests without Docker. Apply the `onchain-runtime-v3` 3.0.0 override gotcha up front.
- **Days 3–4:** Frontend: employer page (create + fund), recipient page (claim), public audit page (aggregates). midnight.js 4.1.1, Lace, local proof server. End-to-end on local-dev.
- **Day 5:** README (setup, architecture, dual-ledger explanation, how judges test), deck, demo video, `midnightntwrk` topic, Apache-2.0, submit. Buffer.
- **Cut first if behind:** the auditor disclosure circuit (move to Wave 2). Linear vesting math (use a bounded list of unlock times instead).
- **Do not attempt in Wave 1:** preprod deployment (2-hour wallet sync, OOM reports), Kuira mobile, in-browser WASM proving.

### Causes of death added this round
- Any identity / eligibility / credential proof idea — 9 of 23 Midnight entries and the Aleo minimum tier. Saturated and low-scoring.
- "Payroll dApp" as the headline — StealthPay on Aleo; ShadowPayroll here. The headline must be the settlement primitive.

---

## Round 4 — constraint removed (2026-09-10). "No build limit, no time limit, no effort limit. Highest PMF, proven demand, something that wins and that the Midnight team praises."

### What does NOT change when time is unlimited

**Every killed idea stays dead.** They died for structural reasons, not effort:
- Proof-of-personhood — World ID (18M humans) and Self (2.21B Aadhaar auths/month) own it. More effort does not buy distribution.
- Age verification — Apple iOS 26.4, Google longfellow-zk, EU blueprint ship it in the OS. Cannot out-build a platform vendor.
- EUDR/CBAM, prediction markets, lending, perps — all need an **oracle**. Midnight has none (`troubleshoot/faq.mdx:54-57`). This is a chain limitation; infinite time cannot fix it. Note the two biggest Aleo winners (Veiled Markets $7,135, ZKPerp $6,010) are both oracle-dependent and therefore **not rebuildable on Midnight**.
- Private voting, crowdfunding — saturated on Midnight, zero usage evidence industry-wide.

**Breadth still loses.** This is the key evidence and it survives the constraint change:
- OBSCURA: 38 contracts, 3 products, 77 Solidity files, 317 commits, 3 people, 5 waves → **could not be found in 276 AKINDO Fhenix entries. No verifiable win.**
- Veiled Markets: **one** product, 800+ LOC → $7,135, top score on all five axes.
- ZKPerp: **one** product → $6,010. Alpaca Invoice: **one** flow → $2,429, highest practicality of 244.
Removing the time limit does not make breadth score. It makes **depth on one thing** possible.

### What DOES change: the target moves from "a dApp" to "the primitive"

Build the **private money-movement layer for Midnight**. Not a payroll app. The thing every other Midnight dApp needs and nobody has built.

Justification that this is a real gap, not a story:
- Midnight has **no finalized token standard** (pending MIP; `tokens/overview.mdx`). Payments are unclaimed ground.
- **No cross-contract calls** means composability cannot come from calling other contracts — it has to come from one contract being general enough. That argues *for* a single deep primitive with many faces, and *against* an OBSCURA-style multi-contract ecosystem. The chain's biggest limitation is an argument for this exact shape.
- Zero of the 23 Wave 1 entries do settlement. Nine do eligibility proofs (the Aleo $178 minimum tier).

Scope at full depth:
- **Core:** shielded stream object — fund (`receiveShielded`), schedule (kernel `blockTimeGreaterThan`), claim (`sendShielded` with change), nullifier per unlock, solvency invariant, `HistoricMerkleTree` for time-boxed claims, maintenance authority for verifier-key rotation.
- **Faces of the same object:** invoice (one unlock), payroll (recurring), vesting (cliff + linear), escrow (conditional), grant milestones.
- **Disclosure layer:** circuits proving aggregates to a named auditor — total disbursed, headcount, all-within-band — revealing no individual. This is the Alpaca "audit-ready records" pattern that scored highest on practicality.
- **SDK** so other Midnight teams embed it.
- First real consumer of **USDM**, live on Midnight since 14 Aug 2026.

### The angle that makes the Midnight team praise it

**The Midnight Foundation is itself the first customer.** It runs grant programs, Catalyst funding, and this Buildathon — it disburses money to teams on milestones, publicly. A private, auditable, milestone-based disbursement tool is something the judges' own organisation would use. The pitch line is "you could run Wave 2 payouts on this."

Serves four items on Midnight's own Request for Startups verbatim: Finance #6 Confidential Payrolling, Finance #30 Confidential Token Vesting Manager, Finance #28 Private Escrow, Finance #25 Confidential Dividend Distribution. Plus Governance #22 comp-band stats via the disclosure layer.

### Round 4 attacks

- *"Streaming is commoditized — Sablier, Superfluid, Magna, Liquifi."* **Survivable, and it is the strongest point.** All of them run on public chains, so the schedule leaks. That is precisely why Liquifi and Magna are centralized SaaS wrappers: the privacy lives in their off-chain database, not the chain. Cap tables and vesting schedules are the most confidential documents a startup owns. Midnight makes the chain itself private, which removes the reason those products must be custodial middlemen. Structural advantage, not a feature.
- *"Proven demand?"* Coinbase acquired Liquifi (Jul 2025; Uniswap Foundation, OP Labs, Ethena, Zora, 0x as clients). Kraken acquired Magna (Feb 2026; peak TVL $60B, 160+ clients). Sablier: 534K streams, ~297K users. **Two exchange acquisitions in eight months.** Strongest demand evidence in the whole research set.
- *"Who is user #1?"* The real wound, and the answer above resolves it: Midnight Foundation grant disbursement, Buildathon payouts, Catalyst. Self-selected for privacy, already disbursing, reachable in the judges' own Discord.
- *"ShadowPayroll is in the same wave."* They built a claim registry: no custody, amounts public, preview-only, solo, 46 commits. Their stated roadmap is our starting point.
- *"Enough for 40% Engineering?"* Shielded custody, change handling, coin merging, nullifiers, historic Merkle proofs, block-time gating, aggregate disclosure circuits, verifier-key rotation. Yes.

**Verdict: survives round 4. This is the build.** Positioning: *the private payments layer for Midnight.* Never "a payroll dApp."

### The one limit that is NOT removable

The user removed their own effort ceiling; AKINDO's clock is external and real. Wave 1 closes **16 Sep 2026 17:00 IST**, Wave 2 **17 Oct**, Wave 3 **16 Nov**. Grants are proportional to points **per wave**, and the Build Club / Accelerator selection reads the whole arc. So the plan is not "build everything then submit" — it is **build the deep thing across all three waves and submit the honest state at each gate**. Missing Wave 1 forfeits $3,500 and the iteration narrative the program explicitly rewards.

---

## DECISION CONFIRMED (2026-09-12): build Alpaca Invoice's feature set, ported to Compact

User confirmed: build the Alpaca Invoice concept as our Midnight Buildathon submission. Global rules
now say no build/effort/token limit — pick the most complete, correct approach regardless of cost. So
scope is the FULL feature parity with `reference/alpaca-invoice` (not a stripped MVP), mapped honestly
onto what Compact can actually do (verified in `research/02-midnight-capabilities.md`):

| Alpaca (Leo/Aleo) feature | Compact/Midnight port |
|---|---|
| Private `record` per invoice | Witness state (off-chain, held by each party) + a ledger `Map<InvoiceId, Commitment>` as the public anchor |
| Dual records — seller AND buyer each hold one | Two independently-derivable commitments/witness secrets on the same ledger entry; needs real design (Aleo's per-party record model has no direct Compact equivalent, this is the one genuine invention needed) |
| `pay_invoice_credits_private` (credits.aleo transfer bundled with state update) | One circuit calling `sendShielded`/`receiveShielded` (returns change) + ledger status update in the same transaction — Compact's stdlib fits this directly, arguably cleaner than Aleo's |
| Audit authorization (`set_audit_authorization`, shareable expiring audit keys) | A `grantAuditAccess(auditorId, scope, expiry)` circuit writing a public authorization entry; enforced by kernel `blockTimeLessThan` for expiry |
| Selective disclosure audit package | Compact's `disclose()` — compiler-enforced, arguably stronger than Aleo's off-chain wallet-signed package approach |
| Chain anchors / commitment_root fallback | `HistoricMerkleTree` — a Midnight primitive with **zero existing example dApp** (flagged in research/02); this is a direct, strong fit |
| `zk_credit_v1` companion (prove payment reliability without revealing transactions) | A second circuit over the same ledger: aggregate stats (on-time count, total paid, disputes) disclosed only as a threshold claim ("reliability >= X") — this is exactly Midnight's own RFS "Confidential Payroll/Comp Band Governance" pattern, reapplied to credit |

**The one real invention required:** Aleo's per-party `record` model (both buyer and seller independently
hold private proof of the same invoice) has no direct Compact primitive. This needs original circuit design,
not translation — the single hardest and most valuable piece of the whole build.

**Still blocked on:** WSL2 + Docker + compiling Compact toolchain (user has taken ownership of this step).
Nothing above can be verified as real until `compact compile` runs.

**Not changing:** the earlier concern about eligibility rules ("mere copies... not eligible") is resolved
by construction — every line of Compact is necessarily new, since Leo code cannot run on Midnight. The
audit-disclosure and dual-visibility mechanics are being reinvented, not copied.

---

## Round 5 — the deploy did not fit (2026-09-13)

The contract compiled, proved and balanced, and the node refused the deploy:

```
1010: Invalid Transaction: Transaction would exhaust the block limits
```

### What was actually wrong

A deploy transaction carries one verifier key per entry point, and it has to fit
inside a single block. The ledger's limits are per block and multi-dimensional
(`reference/midnight-docs/api-reference/overview/usage-limits.mdx`); the binding
one for a deploy is **persistent writes, 50,000 bytes**, because that is where
the verifier keys land.

Measured against the local node, one transaction at a time:

| Contract | Persistent writes | Share | Node |
|---|---|---|---|
| `example-counter`, 1 entry point | 7,250 | 14.5% | accepted |
| probe, 12 entry points | 30,700 | 61.4% | accepted |
| QuietBooks, 12 entry points | 30,797 | 61.6% | accepted |
| QuietBooks, 14 entry points | 35,858 | 71.7% | rejected |
| probe, 16 entry points | 40,284 | 80.6% | rejected |
| QuietBooks, 18 entry points | 44,964 | 89.9% | rejected |

A single transaction gets roughly two thirds of a block, matching this node's
`maxExtrinsic`, which it reports as 65% of `maxBlock`. That share is not
documented, so it was measured: `e2e/probe/` generates a contract with N entry
points, compiles it and deploys it.

Two pieces of diagnosis had to come first, and both stayed in the repository
because they are worth having. The wallet runs on Effect, which reported every
failure as `SubmissionError: Transaction submission error` with the real cause
on a symbol-keyed property; and nothing measured a transaction against the
limits before submitting it.

### Options considered

**A. Split escrow and disputes into a second contract.** Keeps every feature.
Rejected: Midnight has no cross-contract calls
(`reference/midnight-docs/docs/concepts/how-midnight-works/building-blocks.mdx`),
so releasing an escrow and marking its invoice settled would become two
transactions with no atomicity between them. Losing atomicity over money is worse
than deferring a proof. It would also have been a substantial redesign three days
before the wave closes.

**B. Shrink the circuits so their verifier keys shrink.** Keys across every
contract in `reference/` are 1,351, 2,119 or 2,311 bytes; ours are all 2,119 and
the floor is not far below. Not enough of a lever on its own.

**C. Remove entry points.** Taken.

### What was removed, and why each was safe

Four had no caller anywhere in the application:

- `derivePartyKey`, `deriveAdminKey` — impure wrappers that read `instanceSalt`
  and called the pure `derivePartyKeyWith` / `deriveAdminKeyWith`. A caller
  holding a deployment reads the salt from ledger state and calls the pure form,
  which costs nothing on chain.
- `auditGrantCovers` — a second implementation of a rule the envelope validator
  already applies off chain, which is where opening actually happens. Now
  `grantCovers` in `contract/src/audit.ts`, in one place.
- `readReliabilityOf` — read public ledger state the indexer already serves.

Two were real features, deferred:

- `proveReliability` — the threshold proof. The contract still writes the
  counters, so the Wave 2 proof has a record to run against.
- `rotateAdmin` — the administrator is now fixed at deploy. `setPaused` remains,
  so the emergency stop is intact.

`settleAttested` was considered for removal and kept: it is the settlement path
the end-to-end run exercises, and cutting it would have left the suite unable to
settle an invoice at all until the wallet's note-commitment work is finished.

### Result

12 entry points, 30,797 bytes of persistent writes, 61.6% of the block limit.
The deploy lands and all sixteen end-to-end steps pass against the local network
with real ZK proofs.
