# Stackable Genesis (Network Upgrade) System — v2

> This document incorporates all findings from a 3-round adversarial peer review.

## Prerequisites

**This system requires a functional staking lifecycle (Phase 0) before implementation
can begin.** The governance voting mechanism depends on:

- Validators having a queryable, dynamic staked amount
- Snapshot of validator set + stakes at a specific block height
- Unstake lock period to prevent vote-and-run attacks

See: `planning/adversarial_review/staking_research/01_lead_conclusions.md` for the
staking foundation design and `plan/plan.md` for the phased implementation plan.

---

## Context

The current genesis block (block 0) is a one-time initialization. Once loaded, the network
properties it defines (fees, block time, min stake, feature flags) are hardcoded and cannot be
changed without deploying a new chain. This limits upgradeability without coordination.

The goal is a **stackable genesis** system: a special on-chain transaction type that can redefine
network parameters — but only when approved by a supermajority of staked validators (weighted by
stake, not just headcount). This is effectively a lightweight on-chain governance mechanism.

### Governance Philosophy

This system is designed with **status-quo bias**. The 2/3 supermajority threshold, grace period,
and safety bounds all favor the current state. Changing the network should be hard.

---

## Design Decisions

### 1. Network Parameter Schema

Two separate types: tunable parameters and upgrade proposals.

```typescript
/** Tunable network parameters — the actual config values */
interface NetworkParameters {
  blockTimeMs: number           // Target block time in ms
  shardSize: number             // Default shard size for consensus
  minValidatorStake: bigint     // Min DEMOS to be a validator
  networkFee: number            // Default network fee basis points, range [0, 5000]
  rpcFee: number                // Default rpc fee basis points, range [0, 5000]
  featureFlags: Record<string, boolean>  // e.g. { "l2ps": true, "tlsn": true }
}

/** A proposal to change network parameters */
interface NetworkUpgradeProposal {
  version: number               // Auto-assigned at proposal time: highest existing + 1
  proposalId: string            // UUID for tracking
  proposerPublicKey: string     // Proposer's public key
  proposedParameters: Partial<NetworkParameters>  // Only changed fields
  effectiveAtBlock: number      // Must be >= tallyBlock + gracePeriodBlocks
  rationale: string             // Human-readable reason (max 1024 bytes)
  status: 'pending' | 'approved' | 'activating' | 'active' | 'rejected'
  snapshotBlock: number         // Block where proposal tx was confirmed
}
```

- **Storage:** DB table `network_upgrades` (sole source of truth, no local JSON cache)
- **At startup:** Load current parameters from DB (latest active version) or fall back to genesis defaults
- **Affected keys** are derived from `Object.keys(proposedParameters)` — never self-declared

---

### 2. Upgrade Transaction Type

New transaction type: `"networkUpgrade"`

```typescript
content: {
  type: "networkUpgrade"
  from: string                   // Proposer's public key
  data: ["networkUpgrade", {
    proposedParameters: Partial<NetworkParameters>
    proposalId: string           // UUID for tracking
    rationale: string            // Human-readable reason (max 1024 bytes)
    effectiveAtBlock: number
  }]
  gcr_edits: []                  // No balance changes
  amount: 0
  nonce: number
  timestamp: number
  transaction_fee: { ... }
}
```

---

### 3. Voting Mechanism (Stake-Weighted)

Reuse the existing **2/3 supermajority** threshold from PoRBFT but weight votes
by **staked amount** (not liquid balance) instead of headcount.

**Timeline:**

1. Proposer submits `networkUpgrade` tx to mempool
2. TX is included in a block normally — let this be block **P** (the **snapshot block**)
3. At block P, the **validator set AND their staked amounts** are snapshotted
4. **Voting window**: blocks P+1 through P+votingWindowBlocks (default 100)
   - Only validators in the snapshot may vote
   - Each validator broadcasts a signed `networkUpgradeVote` tx
   - Votes from non-snapshot validators are invalid and rejected
5. **Tally** occurs at block P+votingWindowBlocks:
   - Weight = each voter's **staked DEMOS** at snapshot block P (not total balance)
   - Threshold = 2/3 of **TOTAL** staked weight of **ALL** snapshot validators
   - **Abstention = implicit NO** (non-voters count against the proposal)
   - If threshold met → status = `approved`
   - If threshold NOT met → status = `rejected` (final, no retry on same proposal)
6. **Grace period**: proposal transitions to `activating` status, affected parameter keys are **locked**
   - gracePeriodBlocks default = 50 (gives nodes time to prepare)
   - No new proposals targeting the same keys are accepted during this period
7. **Activation** occurs at effectiveAtBlock (must be >= tallyBlock + gracePeriodBlocks)
   - Each node independently applies the upgrade — deterministic, no coordinator
   - Status transitions to `active`

**Rejection:**

- Rejected proposals are final and cannot be re-opened
- A new proposal (new proposalId, new version) may be submitted immediately
- The per-validator limit of 1 active proposal is released on rejection

**Concurrent Proposals:**

- Multiple proposals MAY be active simultaneously if they modify **disjoint parameter sets**
- Affected parameters are derived from `Object.keys(proposedParameters)` at validation time
- A new proposal is **rejected at validation** if any of its affected keys overlap with:
  - Any `pending` proposal's affected keys (voting window open)
  - Any `activating` proposal's affected keys (grace period)
- Each validator may have at most **1 active (pending) proposal** at a time (spam prevention)

**Deterministic Activation Ordering:**

- When multiple approved proposals share the same `effectiveAtBlock`, they are applied
  in **ascending ASCII sort order of proposalId**
- Version numbers are human-readable labels assigned at proposal time, not ordering mechanisms

**Vote Integrity Rules:**

1. One vote per validator per proposalId (enforced at tx validation, duplicates rejected)
2. Votes are final and cannot be changed after submission
3. Only validators in the staking set at snapshotBlock may vote
4. Vote weight = staked DEMOS at snapshotBlock (not total balance)
5. Validators who join or leave the set after snapshotBlock are unaffected

**Fork/Reorg Safety:**

- Tally is always re-derived from on-chain votes — never cached
- If a reorg rolls back past a tally or activation block, proposal status is
  re-evaluated from chain state. This is safe because tally is deterministic.
- Votes only count if they are in confirmed blocks between proposalBlock and
  proposalBlock + votingWindowBlocks

---

### 4. Safety Bounds (Non-Upgradeable)

Every tunable parameter has **dual-layer safety bounds** that cannot be overridden via governance:

**Layer 1 — Percentage cap:** No single proposal can change a numeric parameter by more than 50%
in either direction (cannot halve or double a value in one proposal).

**Layer 2 — Absolute floors** (calibrated to 1% of genesis values):

| Parameter | Floor | Ceiling | Notes |
|-----------|-------|---------|-------|
| minValidatorStake | 1% of genesis value | — | Prevents near-zero entry bar |
| networkFee | 0 bps | 5000 bps (50%) | |
| rpcFee | 0 bps | 5000 bps (50%) | |
| blockTimeMs | 1000 ms | 60000 ms | Phase 2 only |
| shardSize | 3 | maxValidators | Phase 2 only |

> Non-numeric parameters (booleans in featureFlags) are exempt from percentage/floor bounds.
> Phase 2 will introduce an allowed-values registry for feature flag names.

These bounds are validated at proposal submission time. Proposals violating any bound are rejected.

---

### 5. What Can Be Upgraded

**Phase 1 (safe, no consensus changes):**

- `featureFlags` — enable/disable features
- `networkFee` / `rpcFee` — fee parameters
- `minValidatorStake` — staking minimum

**Phase 2 (needs careful coordination):**

- `shardSize` — affects consensus shard selection
- `blockTimeMs` — affects timing loops

**Phase 2 Activation Constraint:**

- Parameters affecting consensus (shardSize, blockTimeMs) MUST activate at a
  consensus round boundary. effectiveAtBlock must align with round starts.
- Design details deferred to Phase 2 specification.

**Explicitly NOT upgradeable via this mechanism:**

- Initial genesis balances (immutable)
- Cryptographic algorithms (require code deployment)
- The 2/3 voting threshold (a cartel could lower it and take over governance)
- Transaction format (would break backward compatibility)
- Safety bounds themselves (non-governable by design)

---

## Proposal Status Lifecycle

```
  pending ──(tally: threshold met)──► approved ──(grace period)──► activating ──(effectiveAtBlock)──► active
     │
     └──(tally: threshold not met)──► rejected
```

---

## Implementation Plan

### Step 1: Types + DB tables

- Add `NetworkParameters` and `NetworkUpgradeProposal` interfaces to `src/libs/blockchain/types/`
- Add `NetworkUpgrade` TypeORM entity: `src/model/entities/NetworkUpgrade.ts`
  - Fields: `id`, `proposalId`, `version`, `proposedParameters (jsonb)`, `status`, `effectiveAtBlock`, `snapshotBlock`, `createdAtBlock`
- Add `NetworkUpgradeVote` TypeORM entity: `src/model/entities/NetworkUpgradeVote.ts`
- Register entities in `src/model/datasource.ts`

### Step 2: Load parameters at startup

- New function `loadNetworkParameters()` in `src/libs/blockchain/routines/`
- Called in `preMainLoop()` in `index.ts` after `findGenesisBlock()`
- Reads from DB (latest active), falls back to genesis defaults
- Stores in `getSharedState.networkParameters`

### Step 3: networkUpgrade transaction validation

- Add case to `validateTransaction.ts` for type `"networkUpgrade"`
- Checks:
  - Proposer is active validator with 0 other pending proposals
  - Version is auto-assigned (highest existing + 1)
  - `effectiveAtBlock >= currentBlock + votingWindowBlocks + gracePeriodBlocks`
  - `Object.keys(proposedParameters)` is non-empty and contains only Phase-1-allowed parameters
  - No key overlap with any `pending` or `activating` proposal
  - All proposed parameter values are within safety bounds (percentage + absolute)
  - `rationale` length <= 1024 bytes

### Step 4: Vote collection

- New transaction type `"networkUpgradeVote"` (validated similarly)
- On confirmed `networkUpgrade` tx, nodes begin accepting votes for that `proposalId`
- Votes stored in DB table `network_upgrade_votes`
- Validation: voter is in snapshot, one vote per validator, proposalId exists and is pending

### Step 5: Tally + activation check

- In block processing (after each block is confirmed):
  - At votingWindowEnd: tally stake-weighted votes, set status to `approved` or `rejected`
  - At effectiveAtBlock: apply approved upgrades (in proposalId lexicographic order)
  - Update `getSharedState.networkParameters`
  - Log status transitions prominently

### Step 6: Apply parameters

- Replace hardcoded values in:
  - `defaults.ts`: `shardSize` → `getSharedState.networkParameters.shardSize`
  - `validatorsManagement.ts`: `minToStake` → `getSharedState.networkParameters.minValidatorStake`
  - Fee calculations: `networkFee`/`rpcFee` from parameters

### Step 7: RPC endpoints

- `getNetworkProperties` — returns current `NetworkParameters` + version
- `getActiveProposals` — lists pending/activating proposals with vote tallies
- `getProposalVotes(proposalId)` — vote breakdown for a specific proposal
- `getUpgradeHistory` — historical upgrades with activation blocks

---

## Files to Create

- `src/libs/blockchain/types/NetworkParameters.ts`
- `src/model/entities/NetworkUpgrade.ts`
- `src/model/entities/NetworkUpgradeVote.ts`
- `src/libs/blockchain/routines/loadNetworkParameters.ts`
- `src/libs/blockchain/routines/applyNetworkUpgrade.ts`
- `src/libs/blockchain/routines/tallyUpgradeVotes.ts`

## Files to Modify

- `src/model/datasource.ts` — register new entities
- `src/libs/blockchain/routines/validateTransaction.ts` — new tx type validation
- `src/libs/blockchain/transaction.ts` — add types to TX union
- `src/index.ts` — call `loadNetworkParameters()` at startup
- `src/config/defaults.ts` — make values read from `networkParameters`
- `src/libs/blockchain/routines/validatorsManagement.ts` — use dynamic min stake
- `src/libs/network/manageNodeCall.ts` handler registry — add RPC endpoints

---

## Verification

1. **Boundary test**: Create proposal with exactly 2/3 stake voting yes — verify activation
2. **Below-threshold test**: 2/3 minus one vote → verify rejection
3. **Snapshot integrity**: Validator unstakes during voting window — verify earlier vote still counted at snapshot weight
4. **Deterministic tally**: Two nodes sync the same chain independently — verify identical upgrade decisions
5. **Concurrent proposals**: Two proposals on disjoint keys — both pass and activate correctly
6. **Concurrent conflict**: Two proposals on overlapping keys — second rejected at validation
7. **Grace period lock**: New proposal on locked key during grace period — rejected
8. **Safety bounds**: Proposal exceeding 50% change or violating floor — rejected
9. **Version ordering**: Two proposals same effectiveAtBlock — activate in proposalId order
10. **Rejection + re-proposal**: Failed proposal, then new proposal on same key — accepted
11. **Reorg resilience**: Simulate reorg past tally block — verify re-derivation
12. **Existing tests**: `bun test src/features/l2ps-messaging/tests/` must still pass

---

## Confirmed Design Choices

- **Vote storage**: On-chain (transparent, deterministic, auditable)
- **Vote weight**: Staked DEMOS (not liquid balance), snapshotted at proposal confirmation block
- **Snapshot scope**: Both validator set AND stake amounts frozen at proposal block
- **Abstention**: Implicit NO — threshold is 2/3 of ALL staked weight, not just voters
- **Concurrent proposals**: Allowed for disjoint parameter sets; derived key conflict detection
- **Grace period locking**: Approved proposals lock affected keys until activation
- **Version assignment**: At proposal time (human-readable label); ordering via proposalId
- **Activation ordering**: Lexicographic by proposalId for same-block activations
- **Type separation**: NetworkParameters (config) vs NetworkUpgradeProposal (lifecycle)
- **Safety bounds**: Dual-layer (50% cap + absolute floors), non-upgradeable
- **DB-only storage**: No local JSON cache; DB is sole source of truth
- **Vote finality**: One vote per validator per proposal, no changes allowed
- **Phase 1 scope**: featureFlags, networkFee, rpcFee, minValidatorStake
- **Phase 2 scope**: shardSize, blockTimeMs (require round-boundary activation)

## Remaining Open Questions

- **Upgrade cancellation**: Can the proposer withdraw before tally? (Suggest: yes, via a
  `networkUpgradeCancel` tx, only before voting window closes)
- **Emergency path**: Fast-path with higher threshold (e.g. 4/5) and shorter voting window
  for critical fixes?
- **Slashing interaction**: Should proposing a malformed upgrade have slashing consequences?
- **featureFlags registry**: Phase 2 — introduce allowed-values set for flag names to prevent
  nodes running different code versions from disagreeing on flag validity
