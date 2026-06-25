# Consensus Hardening (epic #21, phase 2) — scaffold / plan

Date: 2026-06-26
Branch: `feat/consensus-hardening-ep21` (off `stabilisation`, after PR #948 merged)
Status: SCAFFOLD — not started. Plan + verified facts for the next session.

> Phase 1 (stability) is DONE and merged in #948: P-ORDER, #204 derive-at-apply
> fee flow, P-MINSHARD, + Greptile hardening. The chain commits txs cross-node
> with nodes byte-identical. This phase 2 is the remaining epic #21 tasks.

## Scope (the 4 remaining tasks — ONE coupled change)

| Task | Goal |
|---|---|
| **P-TRIM** #193 | Honest block header: `ordered_transactions == applied == persisted` |
| **P-DETECT** #194 | Vote on the POST-apply GCRMain state root (not the pre-exec re-forge hash); fork detection |
| **P-CLOCK** #195 | Full execution determinism (gates P-DETECT — a state-root vote over non-det exec stalls every block) |
| **P-ADMIT** #196 | Future-nonce bounded admission `[committed+1, committed+CAP]` (colleague's literal ask; depends on P-TRIM gap exclusion) |

These are coupled: P-TRIM needs the forge-after-apply / state-root-vote restructure (P-DETECT); P-DETECT needs determinism (P-CLOCK); P-ADMIT needs P-TRIM. Treat as one redesign delivered in stages.

## Verified facts (from phase-1 investigation — do NOT re-derive)

- **Vote binds the PRE-execution block hash.** `voteOnBlock`→`broadcastBlockHash` (PoRBFT.ts) compares the hash of the forged block BEFORE apply; peers re-forge from their own mempool and compare hashes (they do NOT apply). `verifyBlock.ts` recomputes that hash from content + checks sigs against it on sync. → trimming `ordered_transactions` after the vote breaks sig verification. Honest header REQUIRES sealing the block after apply and voting on the post-apply hash.
- **Spectators/sync nodes DO execute** (`Sync.ts` → `syncGCRTables` → `applyTransactions`), so a state-root recompute is implementable on every node.
- **GCRMain is NOT currently hashed.** `hashPublicKeyTable` (hashGCR.ts) exists but is UNUSED; `native_gcr` is the literal `"placeholder"`. Wiring it canonically is P-DETECT's state root.
- **Execution is NON-deterministic** (P-CLOCK targets): state-writing `Date.now()`/`new Date()` at handleNativeOperations.ts:251, identityManager.ts:485, handleGCR.ts:1438/1450/1451; + network fetches in ethos/humanpassport/zk/rewards/tlsn routines. Audit: "unbounded tail — needs a structural guard + replay-gate exit test, not a per-site patch." (getShard localeCompare→byte sort already fixed in #948.)
- **isBlockValid** has the MIN_SHARD=2 floor (#948). MIN_SHARD + the eventual P-ADMIT CAP should become genesis/fork parameters for mainnet.

## Recommended sequencing (converged plan, re-confirm before building)

1. **P-CLOCK first** — make exec deterministic. Structural guard: inject `{blockTimestamp, blockHeight}` into the apply path; replace root-covered wall-clock with it; move root-bound external fetches to pre-signing (carried in the signed tx); add a path-scoped lint/AST ban (Date.now/new Date/Math.random/fetch/localeCompare under the GCR apply subtree). **Exit criterion: an N-node replay test re-executes the last K blocks and asserts byte-identical GCRMain roots** (NOT "banlist complete").
2. **P-DETECT (state root)** — wire `hashPublicKeyTable` into a real GCRMain root; ship it as a SIGNED block-content field that also binds `hash(ordered_transactions)+appliedCount`. Restructure: forge provisional → apply → seal post-apply (ordered_transactions=successful + root) → vote on the sealed hash → collect sigs → finalize. Change `voteOnBlock`/`manageProposeBlockHash` so peers apply before voting; update `verifyBlock` to the new hash basis. **Ship FLAG-GATED log-only first**; graduate to HALT-on-mismatch only after the P-CLOCK replay gate is green AND a clean log-only soak on the live fleet.
3. **P-TRIM** — falls out of P-DETECT (block sealed post-apply → header == applied). Add the assertion `ordered_transactions === successfulTxs`.
4. **P-ADMIT** — `assignNonce` → bounded range `[committed+1, committed+CAP]`; CAP a genesis/fork constant; gapped txs excluded by P-TRIM at forge; per-sender CAP to bound the mempool-spam surface.

## Forward-compat / mainnet follow-ups noted in phase 1
- **rpc-operator fee routing**: phase-1 folds the rpc-fee share to treasury (rpc_address=null). Mainnet: a BFT-committed fee envelope (proposer-stamped `rpc_address`, signed by the claiming RPC node, committed in the block — Ethereum `feeRecipient` model). Mimo + adversarial review converged on this ("Opt B").
- **Partition guard / auto-reorg**: phase-1 posture is detect+halt. Mainnet: equivocation guard + reorg engine (height-indexed inverse-edit journal + side-effect compensation). Tracked as backlog tasks #198/#199/#200.

## First step tomorrow
Re-confirm the sequencing with a fresh adversarial pass on the P-DETECT vote restructure (highest blast radius), THEN start P-CLOCK with the replay-gate test as the definition of done. No code before that plan check (per workflow).

Ref: `docs/discoveries/nonce-multirpc-fork-2026-06-25.md` (phase-1 full record).
