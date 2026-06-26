# DACS-Pay — Klarna-style Financing & Subscriptions for Agent-Commerce on L2PS

> Codename **DACS-Pay**. Buy-now-pay-later (BNPL), subscriptions, and deferred
> settlement for autonomous agent-to-agent commerce, built on the DACS-3 / SR-4
> private-channel substrate and the existing agent-commerce settlement rails.
> The credit relationship lives **privately inside an L2PS subnet**; the public
> chain sees only an anchored proof and the settlement transactions.

Status: **draft / for discussion.** Nothing here is committed. This document is
the long-form plan; the short pitch is in the team thread.

Related: `docs/l2ps-sr4-implementation-brief.md`, `docs/dacs-progress.md`,
the SDK channel substrate (`@kynesyslabs/demosdk` → `channel.*`: SR-4 WI-A/B/C),
and the agent-commerce demo settlement handlers (x402 + cross-chain HTLC).

---

## Table of contents

1. [Motivation](#1-motivation)
2. [What already exists (and what we reuse)](#2-what-already-exists-and-what-we-reuse)
3. [The model: actors and roles](#3-the-model-actors-and-roles)
4. [Core primitives](#4-core-primitives)
5. [Why L2PS — the privacy model](#5-why-l2ps--the-privacy-model)
6. [End-to-end flows](#6-end-to-end-flows)
7. [Technical architecture](#7-technical-architecture)
8. [Data model / schemas](#8-data-model--schemas)
9. [Channel protocol extensions](#9-channel-protocol-extensions)
10. [Settlement mechanics](#10-settlement-mechanics)
11. [Underwriting from CCI + reputation](#11-underwriting-from-cci--reputation)
12. [The "pay with your dust" UX](#12-the-pay-with-your-dust-ux)
13. [Default handling & risk](#13-default-handling--risk)
14. [Security & privacy considerations](#14-security--privacy-considerations)
15. [Regulatory considerations](#15-regulatory-considerations)
16. [Phased roadmap (work items)](#16-phased-roadmap-work-items)
17. [Open questions / decisions needed](#17-open-questions--decisions-needed)
18. [Glossary](#18-glossary)

---

## 1. Motivation

Two observations from the team, generalised:

- **People spend more with "magic internet money."** A one-click "pay with
  whatever is in your wallet" experience removes the friction that otherwise
  caps on-chain spending. The same psychology that made Klarna/Afterpay work in
  e-commerce applies — deferring and splitting payment increases conversion.
- **Wallets are full of dust and dead tokens.** Letting a buyer settle a
  purchase by sweeping up tokens they will never use again ("get rid of the dust
  and shitcoins") is both a feature and a reason to transact.

Agent-commerce makes this sharper: agents negotiate and settle autonomously, at
machine speed, potentially many small deals. A native **credit + recurring
settlement rail** lets agents:

- buy now and repay over a schedule (BNPL),
- subscribe to a service with recurring pulls,
- defer payment (net-30-style) against reputation,

…without exposing the commercial and credit terms to the public chain or to
competitors. That privacy is exactly what L2PS provides, and the SR-4 channel
substrate already gives us signed, verifiable, private negotiation between
parties. DACS-Pay is the financing layer on top.

> **One-liner.** Add a third agent — the **Financier** ("the Klarna") — to the
> private deal channel. It pays the seller now and collects from the buyer on a
> signed schedule. The whole credit agreement is encrypted in the L2PS subnet;
> the chain only ever sees a proof and the payments.

---

## 2. What already exists (and what we reuse)

DACS-Pay is deliberately **mostly integration**, not green-field. The building
blocks already shipped or in flight:

| Capability | Where it lives | Reused for |
| --- | --- | --- |
| SR-4 private channel (CCI-signed envelopes, sequence/channelId, transcript) | SDK `channel.*` (WI-A/B/C) | The financed deal channel |
| `negotiate-rfq` state machine (offer/counter/accept) | SDK `channel.RfqSession` (WI-B) | The commercial negotiation step |
| Transcript anchor on terminal (`finalizeRfq`) | SDK `channel.finalizeRfq` (WI-C) | Anchoring the financed agreement |
| Co-signed `AgreementDocument` | DACS-3 §8.5.1 / SR-4 **WI-D** (designed, not built) | The financed agreement (3-party co-sign) |
| L2PS subnet + encrypted-tx anchoring | node `l2ps` subsystem | Confidentiality of credit terms |
| L2PS instant-messaging transport | node `features/l2ps-messaging` + SDK `L2PSMessagingPeer` | Moving channel envelopes between agents |
| x402 USDC payment | agent-commerce demo (`paymentRequired`/x402 endpoint) | Disbursement + repayment legs |
| Cross-chain HTLC swap (USDC↔EURC, EVM↔Solana) | agent-commerce demo (`crossChainSwap` in the agreement) | Dust→settlement-currency conversion |
| CCI (cross-context identity) + reputation scores | incentives app (ON-CHAIN / IDENTITY / COMMUNITY / REACH / TECHNICAL) | Underwriting / credit limit |

What is **new** in DACS-Pay:

- the **Financier** role and its place in the channel,
- the **FinancedAgreement** (a specialisation of the WI-D AgreementDocument),
- the **PaymentMandate** primitive (a signed standing authorization),
- the **repayment scheduler/executor**,
- **underwriting** wired to CCI/reputation,
- **default handling** via reputation + optional collateral.

---

## 3. The model: actors and roles

```
            ┌─────────────────── L2PS subnet (encrypted) ───────────────────┐
            │                                                               │
   Buyer ───┤  negotiate ──▶ finance ──▶ co-sign ──▶ mandate                │
   Agent    │     ▲              │            │           │                 │
            │     │              ▼            ▼           ▼                 │
   Seller ──┤  Seller       Financier    3-party     buyer-signed          │
   Agent    │  Agent        Agent        agreement   PaymentMandate        │
            │                                                               │
            └───────────────────────┬───────────────────────────────────────┘
                                     │  anchor (hash only) + settlement txs
                                     ▼
                              Demos chain (public)
```

- **Buyer Agent** — wants goods/service; wants to pay later / in installments /
  recurring; holds a wallet (often with dust).
- **Seller Agent** — wants to be paid **now**, in a currency it chooses, with
  certainty.
- **Financier Agent ("the Klarna")** — underwrites the buyer, fronts the payment
  to the seller, and collects from the buyer over time. May be:
  - a first-party Demos service agent (we run it),
  - a third-party financier that subscribes to a marketplace of financing
    requests, or
  - a **liquidity pool** with an automated underwriting policy.
- **Swap/Liquidity provider** (optional, may be the same as Financier) —
  converts the buyer's dust to the settlement currency at repayment time.
- **Demos node operator** — hosts the L2PS subnet, relays channel messages, and
  anchors the encrypted transcript/agreement.

For **subscriptions** and **deferred (net-N)** the Financier is optional: the
buyer can grant a mandate directly to the seller. The Financier only appears
when capital is being **fronted** (true BNPL).

---

## 4. Core primitives

DACS-Pay reduces to four primitives. Klarna, subscriptions, and net-30 are just
different parameterisations of the same machinery.

1. **Financed Channel** — an SR-4 channel with **N ≥ 3** members. The Financier
   is a full channel member: it receives every CCI-signed envelope and signs its
   own. Confidentiality is the subnet AES key (CH-2); authenticity is the CCI
   signature (CH-3).

2. **FinancedAgreement** — a co-signed `AgreementDocument` (WI-D) that binds: the
   underlying deal (what/price), the financing terms (principal, schedule, fee/
   APR, currency), and a reference to the mandate. Signed by **all three**
   parties. Anchored (hash only) on terminal.

3. **PaymentMandate** — a **buyer-signed standing authorization**: "party X may
   pull up to `amount` of currency `C` from my wallet, on schedule `S`, up to a
   total of `cap`, until `expiry` or until revoked." This is the heart of both
   installments and subscriptions. Implementable two ways (see §10):
   - **on-chain**: an allowance / escrow / session-key the executor draws against;
   - **off-chain**: a signed mandate executed by a relayer that submits the pull
     as a normal transfer, gated by the signature.

4. **Settlement executor** — the component that, on each scheduled date, executes
   a pull against the mandate (with an optional dust→`C` swap) and emits a signed
   **repayment receipt** into the channel. On the disbursement side it runs the
   Financier→Seller payment once, up front.

```
Klarna pay-in-4   = Financier fronts + Mandate{ 4 pulls, weekly }
Subscription      = (no Financier) + Mandate{ recurring, monthly, until revoked }
Net-30 deferred   = Financier optional + Mandate{ 1 pull, +30d }
```

---

## 5. Why L2PS — the privacy model

The commercial and credit terms of a deal are **sensitive**: the price a buyer
negotiated, whether they needed financing, their APR, their credit limit, their
underwriting data. On a transparent chain all of this would be public. L2PS lets
us keep it private while still producing a **public, verifiable proof** that a
financed agreement existed at time T.

**Inside the L2PS subnet (encrypted, members-only):**

- the negotiation transcript (offer/counter/accept),
- the financing offer: principal, schedule, fee/APR, currency,
- the underwriting decision and any data behind it,
- the PaymentMandate details (amounts, dates, cap),
- per-installment repayment receipts.

**On the public chain:**

- a single **anchor**: `hash(FinancedAgreement)` as an `l2psEncryptedTx` — proves
  "these parties committed to *something* at block N" without revealing content
  (same pattern the demo already uses for the negotiation transcript),
- the **disbursement tx** (Financier → Seller) — an amount moved, no terms,
- the **repayment txs** (Buyer → Financier) — amounts and timing visible, but not
  the "why," the APR, or the BNPL relationship.

**Threat model / what privacy buys us:**

- Competitors and the public cannot see a buyer's credit terms or that they used
  BNPL at all.
- The **Seller need not see the buyer's financial profile** — the Financier
  mediates underwriting; the seller only sees "you'll be paid now."
- The Financier's **risk model and pricing** stay private to the parties.
- Optionally, repayment legs can be routed/aggregated to reduce on-chain
  linkability between the buyer and the financed deal.

What L2PS does **not** hide by itself: the existence of payment transactions and
their amounts. Linkability reduction (mixing, aggregation, stealth addresses) is
a later, optional hardening — see §14.

---

## 6. End-to-end flows

### 6.1 BNPL — "pay in 4"

```
Buyer            Seller           Financier         Chain
  │   negotiate    │                  │               │
  ├───────────────▶│  (SR-4 channel, CCI-signed)      │
  │◀───────────────┤                  │               │
  │  accept price P │                 │               │
  │                                   │               │
  │  request financing ──────────────▶│               │
  │                                   │  underwrite   │
  │                                   │  (reads CCI   │
  │                                   │   score)      │
  │◀────── offer: 4 × P/4, weekly, fee F ─────────────│
  │  co-sign FinancedAgreement (all 3)                │
  │  sign PaymentMandate{4 pulls}                      │
  │                                   │  anchor hash ─▶│ (l2psEncryptedTx)
  │                                   │  pay seller P ─▶│ (x402 / HTLC)
  │◀──── goods/service delivered ─────┤               │
  │                                   │               │
  │  ⏲ on D1..D4: executor pulls P/4 (dust-swap) ────▶│ (repayment tx)
  │                                   │               │
  │  ✓ completed → finalize + anchor terminal ───────▶│
```

1. **Negotiate** (buyer ↔ seller) over the SR-4 channel → agreed price `P`.
2. **Request financing**: the buyer invites the Financier into the channel
   (membership extends to 3).
3. **Underwrite**: the Financier reads the buyer's CCI reputation (§11), decides
   a limit/APR, and proposes a plan (`4 × P/4` over 6 weeks, fee `F`).
4. **Co-sign**: all three sign the `FinancedAgreement`. The buyer signs a
   `PaymentMandate` authorizing 4 pulls.
5. **Anchor + disburse**: the Financier anchors `hash(FinancedAgreement)` and
   pays the seller `P` (minus merchant fee) **now** via x402/HTLC. The seller
   fulfils.
6. **Repay**: on `D1..D4`, the executor pulls `P/4` from the buyer; the buyer's
   wallet auto-swaps dust → settlement currency to cover (§12). Each pull emits a
   signed repayment receipt into the channel.
7. **Close**: on the final repayment the agreement is finalised and the terminal
   transcript is anchored. On default, see §13.

### 6.2 Subscription

Same channel + mandate machinery, **no upfront disbursement and (usually) no
Financier**:

1. Buyer ↔ Seller agree on a plan (e.g. `9.99 USDC / month`).
2. Buyer signs a **recurring** `PaymentMandate` (monthly, until revoked, optional
   cap).
3. On each cycle the executor pulls the amount (dust-swap allowed) and emits a
   receipt. Seller delivers the service for the period.
4. Buyer can **revoke** the mandate at any time (a signed revocation into the
   channel + on-chain allowance reset).

### 6.3 Deferred (net-N)

Single-pull mandate at `T + N days`. Financier optional — used when the seller
wants payment certainty now while the buyer pays later. Behaves like BNPL with
one installment.

---

## 7. Technical architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Agent runtime (buyer / seller / financier)                            │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────────────────┐ │
│  │ ChannelSession│  │ RfqSession   │  │ FinanceSession (NEW)         │ │
│  │ (SR-4 WI-A/B) │  │ (negotiate)  │  │  - financing offer/accept    │ │
│  └───────┬───────┘  └──────┬───────┘  │  - mandate grant/revoke      │ │
│          │                 │          │  - disbursement/repayment    │ │
│          └────────┬────────┴──────────┴──────────────┬───────────────┘ │
│                   │ L2PSChannelTransport (WI-A)       │                 │
└───────────────────┼───────────────────────────────────┼─────────────────┘
                    │                                   │
            L2PS messaging server                Settlement layer
            (encrypted relay)              ┌───────────┴────────────┐
                    │                      │ x402 │ HTLC swap │ Mandate│
              Demos node / L2PS            │      │           │ executor│
              (anchor, encrypted tx)       └────────────────────────────┘
                                                   │
                                            Demos chain + EVM/Solana
```

Layers:

- **Channel layer** — SR-4 substrate, extended to N-party (financier as a member)
  and with a new **`FinanceSession`** alongside `RfqSession` for the financing
  sub-protocol (offer/accept/mandate/receipts).
- **Agreement layer** — the WI-D `AgreementDocument`, specialised to
  `FinancedAgreement`, co-signed by all members, anchored.
- **Mandate layer** — issue / store / execute / revoke `PaymentMandate`.
- **Settlement layer** — disbursement (x402/HTLC) and repayment (mandate pull +
  dust swap), both reusing the demo's existing rails.
- **Underwriting layer** — reads CCI reputation; optionally via a ZK/TLSN proof
  of "score ≥ threshold" so the financier learns the minimum, not the data.

---

## 8. Data model / schemas

Illustrative TypeScript-ish shapes (not final). All amounts are integers in the
smallest unit of `currency`. All `*Ref` are CCI primary claims (`demos:0x…`).

```ts
/** The financing terms attached to a deal. */
interface FinancingTerms {
  principal: bigint;          // amount financed (the deal price, net of any down payment)
  currency: string;           // settlement currency, e.g. "USDC"
  schedule: InstallmentSchedule;
  feeBps?: number;            // financier fee in basis points (flat) ...
  aprBps?: number;            // ... or APR in basis points (interest-bearing)
  downPayment?: bigint;       // optional upfront amount paid by buyer at t0
  graceDays?: number;         // late tolerance before default logic kicks in
}

interface InstallmentSchedule {
  kind: "installments" | "recurring" | "deferred";
  installments?: Installment[];        // for "installments" / "deferred"
  recurring?: { everyDays: number; amount: bigint; cap?: bigint; until?: number };
}

interface Installment { sequence: number; dueAt: number; amount: bigint; }

/** Co-signed by buyer + seller + financier. A WI-D AgreementDocument. */
interface FinancedAgreement {
  schemaVersion: "0.1.0";
  channelId: string;
  parties: { buyer: ClaimRef; seller: ClaimRef; financier: ClaimRef };
  deal: { description: string; price: bigint; currency: string; dealHash: string };
  financing: FinancingTerms;
  mandateRef: string;          // hash of the PaymentMandate the buyer signed
  disbursement: { to: ClaimRef; amount: bigint; rail: "x402" | "htlc" };
  createdAt: number;
  // signatures collected separately (one TranscriptSignature per party)
}

/** Buyer-signed standing authorization. The heart of BNPL + subscriptions. */
interface PaymentMandate {
  schemaVersion: "0.1.0";
  mandateId: string;
  channelId: string;
  payer: ClaimRef;             // buyer
  payee: ClaimRef;             // financier (BNPL) or seller (subscription)
  currency: string;
  maxPerPull: bigint;          // ceiling per execution
  totalCap: bigint;            // lifetime ceiling
  schedule: InstallmentSchedule;
  allowDustSwap: boolean;      // may the executor source funds by swapping dust?
  expiry: number;
  revocable: true;             // always revocable by a signed revocation
  // signed over canonical bytes with the payer's CCI key
}

/** Emitted into the channel after each successful pull. */
interface RepaymentReceipt {
  mandateId: string;
  sequence: number;            // which installment
  amount: bigint;
  txHash: string;             // on-chain repayment tx
  swappedFrom?: { token: string; amount: bigint }[];  // dust consumed, if any
  remainingCap: bigint;
  paidAt: number;
}

interface UnderwritingDecision {
  approved: boolean;
  creditLimit: bigint;
  aprBps?: number;
  basis: { scoreRef: string; method: "plain" | "zk-threshold" | "tlsn" };
  // never carries the buyer's raw financial data on the wire
}
```

---

## 9. Channel protocol extensions

The SR-4 channel message type union is **closed** (`offer | counter | accept |
reject | sealed-envelope-commit | sealed-envelope-reveal | abort`). DACS-Pay
financing messages ride as **application bodies** — preferably inside
`sealed-envelope-*` (already spec-locked) so we don't fork the substrate's
conformance set. A `FinanceSession` interprets these bodies, exactly as
`RfqSession` interprets proposal bodies today.

Proposed body kinds (carried in the envelope `body`, discriminated by a `kind`):

| `kind` | Direction | Meaning |
| --- | --- | --- |
| `financing-request` | buyer → channel | "I want financing for this deal" |
| `financing-offer` | financier → channel | terms (principal, schedule, fee/APR) |
| `financing-accept` | buyer → channel | accept a specific offer sequence |
| `mandate-grant` | buyer → channel | the signed `PaymentMandate` |
| `mandate-revoke` | buyer → channel | signed revocation |
| `disbursement-receipt` | financier → channel | proof seller was paid |
| `repayment-receipt` | executor → channel | proof of an installment pull |
| `default-notice` | financier → channel | missed installment past grace |

`FinanceSession` is a pure state machine (like `RfqSession`): it validates legal
transitions (no `mandate-grant` before an accepted offer; no `repayment-receipt`
without a live mandate), resolves the agreed terms by the accepted offer
sequence, and surfaces state to the agent runtime. The channel layer still
guarantees CCI-signature, membership, channelId, and monotonic sequence before
the session ever sees a message — so `FinanceSession` only enforces
finance-protocol rules.

---

## 10. Settlement mechanics

Two legs: **disbursement** (once) and **repayment** (scheduled). Both reuse the
demo's existing rails.

### 10.1 Disbursement (Financier → Seller, immediate)

- **x402 USDC** for same-chain settlement (already in the demo's
  `paymentRequired` / x402 endpoint).
- **Cross-chain HTLC swap** when the seller wants a different chain/currency than
  the financier holds (already in the demo's `crossChainSwap`: hashlock,
  EVM/Solana legs, expiries).
- The disbursement amount may be `price − merchantFee` (the financier's revenue
  can come from the buyer's fee/APR, the merchant discount, or both).

### 10.2 Repayment (Buyer → Financier, scheduled)

This is the new piece. The **mandate** must let an executor pull on schedule
**without** a fresh buyer signature each time. Options, in rough order of
preference:

1. **On-chain allowance / escrow (preferred where supported).** The buyer
   pre-authorizes a contract (or a Demos-native standing authorization) to pull
   up to `maxPerPull` on/after each `dueAt`, capped at `totalCap`. The executor
   calls `pull(installment)`; the contract enforces ceilings, dates, and
   revocation. Closest analogues: ERC-20 allowance + a subscription contract, or
   account-abstraction **session keys** scoped to (payee, amount, schedule).
2. **Off-chain mandate + relayer.** The buyer signs the `PaymentMandate` once.
   An executor/relayer submits each installment as a normal transfer, presenting
   the signed mandate; the chain (or a verifier contract) checks the signature,
   the per-pull ceiling, the cap, and that this `sequence` hasn't been pulled
   before. Simpler on-chain, but the executor must be trusted to only pull what
   the mandate allows (mitigated by the on-chain checks).
3. **Pre-funded escrow.** Buyer locks the full amount up front into escrow that
   releases to the financier on schedule. Removes default risk but defeats much
   of the BNPL value (the buyer's capital is locked) — useful for trustless
   subscriptions, not for true "pay later."

> **Decision needed (§17):** what does Demos natively support for recurring /
> standing authorizations? If there is a native mandate/session-key tx type, (1)
> is the path. If not, (2) with a small verifier is the MVP, and a native
> primitive is a follow-up.

### 10.3 Idempotency & ordering

Every pull is keyed by `(mandateId, sequence)` and is **idempotent** — a retried
executor cannot double-pull. Repayment receipts are appended to the channel in
sequence; the L2PS transcript is the source of truth for "what has been paid."

---

## 11. Underwriting from CCI + reputation

The Financier needs a creditworthiness signal **without** a centralized credit
bureau. Demos already has the ingredients: the **CCI** aggregates a buyer's
on-chain history and verified identities, and the incentives app already scores
agents across **ON-CHAIN, IDENTITY, COMMUNITY, REACH, TECHNICAL**.

- **Plain read.** The financier reads the buyer's public CCI score and sets a
  `creditLimit` / `aprBps` from a policy curve. Simple; the score is already
  public.
- **ZK / threshold proof.** The buyer proves "my score ≥ T" (or "my on-chain
  age ≥ N", "I hold ≥ X") without revealing the full profile. The financier
  learns only the minimum it needs. Fits the privacy posture of the rest of the
  rail.
- **TLSN attestation.** For off-Demos signals (e.g. a verified Web2 reputation),
  reuse the node's TLSN flow to attest a claim into the buyer's CCI, then
  underwrite against it.

The underwriting **decision** is private (in L2PS); only the approval + limit +
APR end up in the `FinancedAgreement`, and even those are encrypted to the
members.

**Reputation as collateral.** Because the buyer's identity carries an on-chain
reputation, *default can be made to cost reputation* (§13). This is the
crypto-native substitute for legal collections — the buyer stakes their standing,
not (only) capital.

---

## 12. The "pay with your dust" UX

Jacob's point: people will transact to *clean out* dust and dead tokens. DACS-Pay
makes the buyer's messy wallet a feature.

- At each repayment, the buyer owes `amount` of the **settlement currency**
  (`USDC`). Their wallet may hold neither — just dust across many tokens.
- If the mandate has `allowDustSwap`, the executor sources the installment by
  **swapping the cheapest-to-liquidate dust → settlement currency** via the
  existing cross-chain swap/router, then pays. The repayment receipt records
  exactly which dust was consumed (`swappedFrom`).
- UX: one button — *"settle this installment with what you have."* The agent
  picks the optimal set of dust to burn down, the buyer approves once (or the
  mandate pre-approves swaps up to a slippage bound).
- Net effect: the buyer's portfolio gets *cleaner* as they pay, and otherwise
  un-spendable tokens become spendable.

Guardrails: a slippage ceiling in the mandate; the buyer can exclude specific
tokens from auto-swap; the executor never swaps more than the installment +
allowed slippage.

---

## 13. Default handling & risk

A missed installment past `graceDays` triggers `default-notice` in the channel.
Escalation ladder (policy, per-financier):

1. **Retry / dust-sweep.** Attempt the pull again, widening the dust set within
   the slippage bound.
2. **Reputation slashing.** Record the default against the buyer's CCI — its
   on-chain reputation score drops, raising future APRs or cutting off credit
   network-wide. This is the primary enforcement and the main reason an agent
   repays.
3. **Collateral liquidation** (if the deal used optional collateral). The buyer
   may lock a small collateral that the financier can claim on default.
4. **Channel termination + anchored default proof.** The terminal transcript,
   including the `default-notice`, is anchored — a portable, verifiable record
   other financiers can read (privacy-preserving: a proof of default without the
   terms).

Financier-side risk controls: per-buyer credit limit from the score curve;
portfolio caps; pricing (APR/fee) that reflects the score; optional first-loss
or pooled underwriting if the financier is a liquidity pool.

---

## 14. Security & privacy considerations

- **In-channel signer = on-chain party (CH-3 / §0).** Every financing message,
  the agreement, and the mandate are signed with the party's CCI key — the same
  key that controls the on-chain wallet that pays/receives. No empty signatures,
  no off-identity signers.
- **Mandate scope is hard-bounded.** `maxPerPull`, `totalCap`, `expiry`, and
  per-sequence idempotency cap the blast radius if an executor misbehaves. The
  on-chain check (or contract) enforces these, not just the executor.
- **Revocation is always available.** A signed `mandate-revoke` plus an on-chain
  allowance reset stops future pulls; in-flight installments already executed are
  final.
- **Confidentiality is the subnet key (CH-2).** Only channel members hold it.
  The node operator relays ciphertext and stores opaque blobs; it does not see
  terms unless it is itself a member.
- **Linkability (residual).** Payment amounts/timing are on-chain. Reducing the
  link between a buyer and a financed deal (aggregated repayments, stealth
  payee addresses, batching) is an **optional later hardening**, not MVP.
- **Underwriting minimisation.** Prefer ZK-threshold / TLSN proofs so the
  financier learns the minimum, not the buyer's full profile.

---

## 15. Regulatory considerations

BNPL is **regulated consumer credit** in the EU (Consumer Credit Directive),
UK (FCA, post-2025), and US (CFPB) — interest disclosure, affordability checks,
dispute rights. This matters and must be reviewed with counsel before any
human-facing deployment. Positioning that may reduce exposure (to be confirmed,
**not legal advice**):

- **Agent-to-agent / B2B settlement credit** rather than consumer lending —
  autonomous agents settling commercial obligations is a different category than
  a person buying a sofa.
- **Pay-in-N with no interest** (flat merchant-funded fee) is treated more
  leniently than interest-bearing credit in several regimes.
- **Disclosure built into the agreement** — the `FinancedAgreement` already
  carries APR/fee/schedule in a signed, auditable form.

Flag: jurisdictions, licensing, and the consumer-vs-B2B line are an **open
question for legal**, gating any production rollout. The technical design is
agnostic to which framing wins.

---

## 16. Phased roadmap (work items)

Mirrors the SR-4 WI-x style. Each WI is independently shippable and testable.

| WI | Title | Depends on | Output |
| --- | --- | --- | --- |
| **WI-K0** | N-party financed channel | SR-4 WI-A/B | `members ≥ 3`; financier joins; envelopes still CCI-signed/verified |
| **WI-K1** | FinancedAgreement + 3-party co-sign | WI-D, WI-K0 | co-signed agreement, anchored on terminal |
| **WI-K2** | PaymentMandate primitive | WI-K1 | mandate schema, signing, canonical bytes, revocation |
| **WI-K3** | Disbursement (financier → seller) | WI-K1 | one-shot pay via x402/HTLC + `disbursement-receipt` |
| **WI-K4** | Repayment scheduler + executor | WI-K2 | scheduled idempotent pulls + `repayment-receipt` |
| **WI-K5** | Dust → settlement swap | WI-K4, demo swap | source installments from dust within slippage bound |
| **WI-K6** | Underwriting from CCI/score | incentives score | credit limit/APR from reputation; optional ZK-threshold |
| **WI-K7** | Default handling | WI-K4, WI-K6 | grace, retry, reputation slash, optional collateral |
| **WI-K8** | Subscription mode | WI-K2, WI-K4 | recurring mandate, revoke, period delivery |
| **WI-K9** | On-chain mandate primitive | research (§17) | native standing-authorization / session-key path |
| **WI-K10** | Demo: BNPL checkout screen | WI-K1..K5 | agent-commerce UI: "pay in 4 / subscribe" with dust sweep |

Suggested sequencing for a **showable demo first**: WI-K0 → WI-K1 → WI-K2 →
WI-K3 → WI-K4 (mocked/relayer mandate) → WI-K10. Dust swap (K5), reputation
underwriting (K6), default (K7), and the native on-chain mandate (K9) follow.

---

## 17. Open questions / decisions needed

1. **Who is the Financier?** First-party Demos agent, third-party marketplace, or
   liquidity pool? Where does the default risk sit?
2. **Mandate execution path.** Does Demos have (or want) a **native standing-
   authorization / session-key** tx type (WI-K9)? If not, the MVP is an
   off-chain mandate + relayer + a small verifier — acceptable?
3. **Fee model.** Merchant-funded flat fee (Klarna-style, no buyer interest) vs
   buyer-paid APR vs both? This drives the regulatory framing.
4. **Underwriting source.** Use the existing incentives score directly, or define
   a dedicated credit score? Plain read vs ZK-threshold for MVP?
5. **Settlement currency policy.** Single canonical currency (USDC) or
   per-deal? How aggressive is the dust-swap by default?
6. **Subscription vs BNPL priority.** Subscriptions are simpler (no fronted
   capital, no underwriting) — ship them first as the wedge?
7. **Legal.** Consumer-credit licensing and the agent-vs-consumer line — gating
   for production, needs counsel.

---

## 18. Glossary

- **DACS-Pay** — this feature: BNPL/subscriptions/deferred settlement on L2PS.
- **BNPL** — buy now, pay later; split a purchase into scheduled installments.
- **Financier** — the agent that fronts payment to the seller and collects from
  the buyer (the "Klarna" role).
- **FinancedAgreement** — the 3-party co-signed agreement (a WI-D
  `AgreementDocument`) encoding the deal + financing terms.
- **PaymentMandate** — a buyer-signed standing authorization to pull funds on a
  schedule; underlies both installments and subscriptions.
- **Disbursement** — the up-front Financier → Seller payment.
- **Repayment** — a scheduled Buyer → Financier installment pull.
- **CCI** — Cross-Context Identity; the buyer's primary claim and reputation
  carrier, used for signing and underwriting.
- **L2PS** — Demos parallel-network subnet providing encrypted, members-only
  messaging and on-chain encrypted-tx anchoring.
- **SR-4 channel** — the DACS-3 private negotiation substrate (CCI-signed
  envelopes, sequence/channelId, transcript) DACS-Pay builds on.
- **Anchor** — an `l2psEncryptedTx` carrying only a hash: a public, verifiable
  proof that an agreement existed at a block, without revealing its content.
