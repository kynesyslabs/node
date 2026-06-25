# Nonce / Multi-RPC / Solo-Fork — assessment + converged fix (PLAN v3)

Date: 2026-06-25
Branch: `stabilisation`
Status: SHIPPED (stability fixes) + architectural follow-up scoped. See "Implementation status" below.

## Implementation status (2026-06-25)

**SHIPPED + verified on 2-node devnet (the testnet RC config), branch `fix/consensus-deterministic-ordering-ep21`:**
- ✅ **P-ORDER** (#189, commit c831ce0c8) — deterministic (sender,nonce,hash) mempool ordering, fork-gated.
- ✅ **#204 root cause** (commit b07f5e3bf) — the actual cross-RPC freeze. `confirmTransaction` mutated the SDK-signed tx (prepended fee edits + overwrote `transaction_fee`) → coherence failed on gossip → divergent blocks → no tx committed. Fix: derive-at-apply (node no longer mutates the signed tx; fee edits derived deterministically at apply from the shipped `transaction_fee`).
- ✅ **P-MINSHARD** (#197, commit fcf6feb6e) — `isBlockValid` refuses to finalize below MIN_SHARD=2 (kills 1-node self-certify / solo-fork). + getShard localeCompare→byte sort (determinism).

**Verified:** single tx commits (was frozen); 4 sequential cross-RPC txs land in nonce order; both nodes byte-identical; fees→treasury; no double-spend on replay; chain advances pro=2/con=0. The colleague's reported instability (txs accepted but never committing, chain stalling) is RESOLVED.

**NOT shipped — one coupled architectural change (its own plan + approval needed):**
- ⏳ **P-TRIM** (#193) + **P-DETECT** (#194) + **P-CLOCK** (#195) + **P-ADMIT** (#196) = a state-root-vote redesign. Verified blocker: the vote+signatures bind the PRE-execution block hash and `verifyBlock` recomputes that hash on sync, so an honest header (trim failed txs) requires sealing the block AFTER apply and voting on the post-apply hash — which restructures the consensus loop, the vote path (peers must apply before voting), and `verifyBlock`, AND requires full execution determinism first (P-CLOCK: ~9 Date.now/new Date + network-fetch sites in the apply path; unbounded tail per audit). High blast radius; not bounded. P-ADMIT (future-nonce) depends on P-TRIM (gap exclusion at forge). With #204+P-ORDER, sequential txs already commit fine, so these are hardening/throughput, not stability.

---

(original plan below — retained for reference)

Tracking: Mycelium Epic #21 (tasks #189–#202).
Target: testnet Release Candidate, **dozens of validators**, **min 2 nodes** operationally.

---

## 1. The three defects (plain English)

- **Bug A — multi-RPC nonce.** Acceptance = `nonce == account.nonce + 1 + localPendingCount`. `pendingCount` is per-node, so the same wallet hitting different RPCs gets conflicting txs all accepted, then all-but-first fail at execution.
- **Bug B — silent solo-fork.** A node forges a block alone (a 1-node shard self-certifies) and rejoins, diverging state. No fork-choice / reorg exists, so it can't self-heal.
- **Colleague's symptom — header lies.** Block `ordered_transactions` claims N txs, DB persists fewer. **This is the load-bearing one** and it has a precise cause (below).

## 2. The root cause almost everything traces to

`PoRBFT.ts:160` forges the block from the full mempool **before** `applyGCREditsFromMergedMempool` at `:184`. Failed txs are pruned from the mempool (`:196`) but **never removed from the already-sealed `block.content.ordered_transactions`**. So the header claims txs that never applied. A state-root comparator is **blind** to this (it hashes state, not the claimed tx list). Fixing this — **forge after apply** — is the keystone.

## 3. Verified facts (ground truth, from code)

| Fact | file:line |
|---|---|
| ordering = timestamp (node-variant) | `mempool.ts:50-68`, trusted end-to-end `PoRBFT.ts:444-505` |
| forge before apply; failed pruned from mempool only | `PoRBFT.ts:160,184,196` |
| 1-node shard self-certifies (`isBlockValid(1,1)=true`) | `PoRBFT.ts:669` |
| execution NON-deterministic (~9 `Date.now`/`new Date` + live fetches into state) | tlsn/rewards/zk/ethos/humanpassport routines; `handleGCR partitionIndependentTxs` |
| GCRMain NOT hashed (`native_gcr="placeholder"`, `hashPublicKeyTable` unused) | `hashGCR.ts`, `block.ts:46` |
| spectators DO execute on sync | `Sync.ts:362,596` → `syncGCRTables` → `applyTransactions` |
| no fork-choice / reorg / block-rollback | grep 0 hits; `rollback` is intra-tx in-memory pre-save only |
| only `shardSize` (~4) validators forge/vote; rest spectate | `getShard.ts:92`, `defaults.ts:33` |
| admission rejects future nonce at originating RPC before gossip | `validateTransaction.ts:527-685` |
| sender normalizer to reuse | `forgeToHex().toLowerCase()` `validateTransaction.ts:552-556` |
| fork-gate pattern | `isForkActive("nonceEnforcement", blockHeight)` |

## 4. Converged plan v3 (RC scope) — order matters

Ship strictly in this order; each lands on a safer base than the last.

1. **P-ORDER** (#189) — deterministic `(sender,nonce,hash)` ordering of the merged mempool before forge; fork-gated; plain hex compare (NOT `localeCompare` — locale-sensitive). Apply follows `ordered_transactions` on **both** forge and sync. Relieves the stall (kills timestamp-jitter vote divergence). ~15 lines.
2. **P-TRIM** (#193, keystone) — **forge AFTER apply.** Rebuild `ordered_transactions` from `successfulTxs` only; seal hash post-apply. Invariant: `ordered_transactions == applied == persisted`. Gapped/conflicting txs are **pre-apply excluded** (no rollback primitive exists, so never execute-and-fail). syncGCRTables must apply the sealed list, not local mempool.
3. **P-DETECT** (#194) — wire the unused `hashPublicKeyTable` into a real GCRMain state root; ship it as a **signed block-content field** that also binds `hash(ordered_transactions)+appliedCount`. Every node recomputes post-apply, compares at equal height, both-sides **HALT** on mismatch. **Ship flag-gated log-only.** Forward-compatible: same signed root + `validation_data.signatures` aggregation becomes the mainnet BFT vote (no rip-out).
4. **P-CLOCK** (#195) — inject `{blockTimestamp,blockHeight}` into apply (fully); replace **root-covered** wall-clock sites; move **root-bound** external fetches (Ethos, HumanPassport) to pre-signing carried in the signed tx; **path-scoped** lint ban on apply/root modules. **Exit = N-node replay of last K blocks yields byte-identical roots** (not "banlist complete"). Gates P-DETECT's HALT graduation.
5. **P-ADMIT** (#196, colleague's ask) — `assignNonce` → bounded range `[committed+1, committed+CAP]`; **CAP is a genesis/fork constant** (not env); `expectedPrior = txNonce-1`; reject local duplicate `(sender,nonce)`. Gaps handled by P-TRIM.
6. **P-MINSHARD** (#197) — `getShard` refuses to forge when online set `< MIN_SHARD`; `isBlockValid` rejects `totalVotes < MIN_SHARD`. **MIN_SHARD = one pinned genesis constant** (resolve to a single value, e.g. 3). Double-gates solo-fork.
7. **P-VERIFY** (#191) — 2-node + multi-validator devnet acceptance (see §6).

## 5. Why v3 fixes all three (simulation-confirmed, 7 scenarios)

- **Bug A:** P-ORDER lands cross-RPC nonces in deterministic order; same-nonce conflicts resolved by hex tie-break; both forger and spectators apply the **sealed** `ordered_transactions`, so roots match.
- **Bug B:** P-MINSHARD double-gates — a 1-node (or sub-`MIN_SHARD`) shard cannot finalize; partitions stall instead of silently forking. Legit shrink below MIN_SHARD → chain correctly **stalls** (safety over liveness).
- **Colleague's symptom:** P-TRIM makes `header == DB` an enforced invariant — correct *because* there's no rollback (move forge after apply rather than undo).

**No new logic bugs introduced.** The only halts are deliberate "page a human" safety stops.

## 6. Known residuals (tracked, NOT RC-blockers)

- **Mempool-bloat DoS** (#201): wallets × CAP gapped txs accumulate; CAP bounds per-sender depth, not wallet count. Pre-existing surface; needs eviction/TTL. Consensus stays safe.
- **Operational invariants for HALT graduation** (#202 runbook): (A) keep P-DETECT log-only across the entire P-TRIM→P-CLOCK window; (B) flip to HALT only after replay gate green **and** a clean log-only soak on the live fleet (replay proves only known nondeterminism; live soak surfaces unknown sources).

## 7. Mainnet backlog (correctly cut from RC)

- **B1** (#198) network-wide BFT state-root **vote** (closes "4-node shard certifies for 30 spectators"). Reuses P-DETECT's machinery.
- **B2** (#199) equivocation/partition **prevention** guard.
- **B3** (#200) **auto-reorg** engine (inverse-edit journal + side-effect compensation + fork-choice). Multi-week.

## 8. For the colleague
He's directionally right (future-nonce admission IS needed — P-ADMIT). But the CAP/parking-queue + mempool re-key he was reaching for is mostly YAGNI; the real fix is **forge-after-apply (P-TRIM)** + deterministic ordering, which he hadn't framed. Grant the temporary disable as a **fork-gated/env flag** (not code removal); permanent fix is far smaller than his plan. **Do not disable nonce checks outright** — replay footgun.
