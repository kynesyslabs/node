---
type: spec
title: Audit-Sweep Batch C — Nonce-based Replay Protection
date: 2026-05-30
status: draft
related: docs/specs/active-feature-test-addition-proposal.md, .ccb/bug-hunt-2026-05-28/FINAL_REPORT.md
---

# Audit-Sweep Batch C — Nonce-based Replay Protection

## Context

The 2026-05-28 bug-hunt audit ([FINAL_REPORT.md §CRITICAL #1]) flagged
`assignNonce()` in `src/libs/blockchain/routines/validateTransaction.ts:362`
as a hardcoded stub returning `true`, with the comment
`// TODO Override for testing`. The audit caveat noted the function is
not currently on a hot path (its single caller at line 78 is commented
out), which limits immediate exploit risk but does not reduce the
urgency of fixing it before any path activation.

Investigation during PR scoping (2026-05-30) revealed the nonce gap is
deeper than a single-function stub:

1. **`assignNonce` is dead code** — sole caller commented out
   (`validateTransaction.ts:77-86`).
2. **No tx-level nonce comparison anywhere** in `src/libs/`. The SDK
   reads `account.nonce` via the `getAddressNonce` RPC, sets
   `tx.content.nonce = currentNonce + 1`, signs, and broadcasts. The
   node persists `tx.content.nonce` (mempool, exec) but never
   compares it to the sender's `account.nonce`.
3. **No nonce-edit emission** — `GCRNonceRoutines.ts` exists and
   correctly applies `nonce`-typed `GCREdit`s, but **no code path
   emits one**. Account nonce stays at `0` for every account, forever.
4. **No consensus-time nonce validation** — `handleGCR.ts:910`
   delegates `nonce` edits to `GCRNonceRoutines.apply` which blindly
   adds the edit's `amount` to the account. If two blocks-included
   txs from the same sender both carry `tx.content.nonce = N+1` and
   both emit a `+1` nonce edit, the account jumps from `N` to `N+2`
   and both txs succeed. **Double-spend window**.

Mempool hash-dedup (`mempool.ts:96`, `checkTxExists`) blocks identical
re-broadcasts only — signature is part of the tx hash. It does not
block semantically distinct txs with the same nonce, nor cross-RPC
replays where a captured tx is rebroadcast through a different RPC
before block inclusion.

## Goal

Close the replay-protection gap end-to-end:

- Reject txs at RPC ingress when `tx.content.nonce !== account.nonce + 1 + (pending txs from sender in mempool)`.
- Emit a `nonce` `GCREdit` of `+1` for every native tx so
  `account.nonce` actually increments on tx application.
- Reject `nonce` edits at GCR-application time when the edit's
  `expectedPrior` does not match the account's current nonce, so two
  txs with the same nonce bundled into the same block from different
  RPCs cannot both succeed at consensus.

## Non-goals

- Wider replay protection (e.g. chain ID, timestamp windows) — out of
  scope; this is the nonce fix only.
- L2PS internal nonce semantics — `L2PSHashService` already does its
  own current-nonce-plus-one normalisation at line 343, unchanged.
- `awardPoints` and other node-internal txs — bypass
  `confirmTransaction` entirely; bypass new validation by construction.

## Design

### Semantics

Strict sequential per-sender:

```text
incoming tx is valid iff
  tx.content.nonce === account.nonce + 1 + pending_count(sender_in_mempool)
```

Replay-protected: a captured signed tx cannot be re-broadcast because
the account nonce has already advanced. Cross-RPC replay through a
different node fails the consensus-time check (see §Consensus rule
change).

### GCREdit shape change

Extend the `nonce`-typed `GCREdit` variant with an optional
`expectedPrior: number` field. The legacy shape stays valid for
backwards-compat (rolled-up snapshots, pre-fork blocks); the new
field is consulted only when present.

```ts
// SDK: @kynesyslabs/demosdk/types/blockchain/GCREdit
type NonceGCREdit = {
    type: "nonce"
    operation: "add" | "remove"
    account: string
    amount: number
    txhash: string
    isRollback?: boolean
    /** PR 3 / nonceEnforcement fork: account.nonce expected at apply-time. */
    expectedPrior?: number
}
```

### Fork activation

Introduce a new fork: `nonceEnforcement`, gated by genesis
`forks.nonceEnforcement.activationHeight`. Behaviour:

- **Pre-fork (legacy)**: `assignNonce` accepts any nonce.
  `HandleNativeOperations` does not emit a `nonce` edit.
  `GCRNonceRoutines` ignores `expectedPrior`. Bit-identical to today
  for re-sync.
- **Post-fork**: `assignNonce` enforces sequential semantics.
  `HandleNativeOperations` emits a `+1` `nonce` edit with
  `expectedPrior = account.nonce` populated by reading GCR at
  emit-time. `GCRNonceRoutines` rejects the edit when
  `expectedPrior !== undefined && account.nonce !== expectedPrior`.

Devnet sets `activationHeight: 0` like other forks so local testing
exercises the post-fork path from genesis. Production fork height is
set by governance before deployment.

### PR breakdown

| PR | Scope | Files | Risk |
|----|-------|-------|------|
| 1 | Fork registration + validation infra (caller still commented) | `forkConfig.ts`, `loadForkConfig.ts`, `validateTransaction.ts`, `testing/devnet/genesis.devnet.json` | Med — registers the fork (default `activationHeight: null`) + ships the fork-gated `assignNonce` implementation. Caller remains commented so live behaviour is unchanged on pre-fork chains; devnet boots post-fork from block 0. |
| 2 | Mempool-aware lookahead | `mempool.ts` (new `countPendingByAddress`), `assignNonce` consumer in `validateTransaction.ts`, tests | Med — touches mempool query API. |
| 3 | Consensus rule + caller wire-up | `GCRNonceRoutines.ts`, `HandleNativeOperations.ts` emit-side, `validateTransaction.ts` uncomment caller, e2e test | High — consensus rule change; rollout coordination across validators. The fork itself is already registered in PR 1; this PR ships the apply-time rejection and emits the increment edit. |

### SDK change

Single SDK publish before PR 3 lands:

- `@kynesyslabs/demosdk/types/blockchain/GCREdit` — add optional
  `expectedPrior: number` to the `nonce` variant.
- No SDK runtime change. SDKs continue calling
  `getAddressNonce` → `currentNonce + 1` exactly as today.

PRs 1 and 2 do not require SDK changes; they consume the existing
type. PR 3 requires the new SDK version pinned via overrides (matches
the existing demosdk pinning pattern in `package.json`).

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| In-flight txs with stale nonces after fork activation | SDK already reads nonce live per tx; only stuck txs in custom integrations are at risk. Document in fork-activation runbook. |
| Mempool count diverges from on-chain state (race) | Single-writer mempool; `countPendingByAddress` reads the same Postgres txn boundary as the validation path. PR 2 includes a stress test. |
| Cross-RPC double-spend before block inclusion | Consensus rule (PR 3) is the safety net. Different RPCs may briefly accept the same nonce; only one survives consensus. |
| Block-formation order matters when one block contains two same-sender txs with N+1 and N+2 | Block formation already orders by hash (stable); apply order is deterministic. `expectedPrior` rejects out-of-order application. |
| Rollback semantics | `GCRNonceRoutines` already inverts add↔remove on `isRollback`. New `expectedPrior` check is skipped on rollback (we are unwinding, not validating forward progress). |

## Test plan

PR 1: unit tests for `assignNonce` happy path + rejection. Unit test
for nonce-edit emission in `HandleNativeOperations`.

PR 2: unit tests for `countPendingByAddress`. Integration test:
back-to-back submission of 3 txs from one sender — all 3 accepted at
RPC, all 3 land in the next block, account nonce advances by 3.

PR 3: e2e test via existing `testing/devnet` fixture — two RPCs
receive the same signed tx; both broadcast; only one survives the
block (the other's `nonce` edit fails at GCR apply-time, the rest of
the tx is rolled back).

## Open questions

- Does the `nonce` field need to allow gaps (e.g. N+5 when account is
  at N) for future fee-bump semantics? **Decision: no.** Strict
  sequential. If a tx is dropped, the user re-broadcasts with the
  same nonce; out-of-order future-nonce txs are not supported.
- Should `expectedPrior` be required (not optional) post-fork? Optional
  for backwards-compat with rolled-up pre-fork snapshots. Post-fork
  emission always populates it.
- Linear ticket? File one referencing this doc before starting PR 1.
