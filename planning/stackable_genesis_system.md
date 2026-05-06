# Stackable Genesis (Network Upgrade) System

## Context
The current genesis block (block 0) is a one-time initialization. Once loaded, the network
properties it defines (fees, block time, min stake, feature flags) are hardcoded and cannot be
changed without deploying a new chain. This limits upgradeability without coordination.

The goal is a **stackable genesis** system: a special on-chain transaction type that can redefine
network parameters — but only when approved by a supermajority of staked validators (weighted by
stake, not just headcount). This is effectively a lightweight on-chain governance mechanism.

---

## Design Decisions

### 1. Network Parameter Schema ("Genesis Properties")
Add a `NetworkProperties` object that all nodes load at startup and update when an upgrade is approved.

```typescript
interface NetworkProperties {
  version: number            // Monotonically increasing; upgrade must be > current
  blockTimeMs: number        // Target block time in ms
  shardSize: number          // Default shard size for consensus
  minValidatorStake: bigint  // Min DEMOS to be a validator
  networkFee: number         // Default network fee basis points
  rpcFee: number             // Default rpc fee basis points
  featureFlags: Record<string, boolean>  // e.g. { "l2ps": true, "tlsn": true }
  effectiveAtBlock: number   // Block at which this upgrade activates
}
```

- **Storage:** `data/network_properties.json` (local cache) + new DB table `network_upgrades`
- **At startup:** Load current properties from DB (highest approved version) or fall back to genesis defaults

---

### 2. Upgrade Transaction Type
New transaction type: `"networkUpgrade"`

```typescript
content: {
  type: "networkUpgrade"
  from: string                   // Proposer's public key
  data: ["networkUpgrade", {
    proposedProperties: NetworkProperties
    proposalId: string           // UUID for tracking
    rationale: string            // Human-readable reason
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
Reuse the existing **2/3 supermajority** threshold from `PoRBFT.ts:isBlockValid()` but weight votes
by validator stake instead of headcount.

**Voting Flow:**
1. Proposer submits `networkUpgrade` tx to mempool
2. TX is included in a block normally (no special treatment at inclusion time)
3. When a node sees a `networkUpgrade` tx confirmed in a block, it enters a **voting window**
   - Window: next N blocks (configurable, default 100)
4. Each validator broadcasts a signed `networkUpgradeVote` tx:
   ```
   { proposalId, approve: true/false, voterPublicKey, signature }
   ```
5. Votes accumulate on-chain as regular transactions
6. At `effectiveAtBlock`, a node tallies votes:
   - **Weight** = each voter's DEMOS balance at the proposal block
   - **Threshold** = 2/3 of total staked weight among active validators
   - If threshold met → upgrade activates

**Activation:**
- Each node independently tallies votes and applies upgrade at `effectiveAtBlock`
- Activation is deterministic (same block, same votes → same outcome for all nodes)
- No coordinator needed

---

### 4. What Can Be Upgraded
**Phase 1 (safe, no consensus changes):**
- `featureFlags` — enable/disable features
- `networkFee` / `rpcFee` — fee parameters
- `minValidatorStake` — staking minimum

**Phase 2 (needs careful coordination):**
- `shardSize` — affects consensus shard selection
- `blockTimeMs` — affects timing loops

**Explicitly NOT upgradeable via this mechanism:**
- Initial genesis balances (those are immutable)
- Cryptographic algorithms (require code deployment)

---

## Implementation Plan

### Step 1: NetworkProperties type + DB table
- Add `NetworkProperties` interface to `src/libs/blockchain/types/` (new file)
- Add `NetworkUpgrade` TypeORM entity: `src/model/entities/NetworkUpgrade.ts`
  - Fields: `id`, `proposalId`, `proposedProperties (jsonb)`, `status` (pending/approved/rejected), `effectiveAtBlock`, `createdAtBlock`
- Register entity in `src/model/datasource.ts`

### Step 2: Load properties at startup
- New function `loadNetworkProperties()` in `src/libs/blockchain/routines/`
- Called in `preMainLoop()` in `index.ts` after `findGenesisBlock()`
- Reads from DB (latest approved), falls back to genesis defaults
- Stores in `getSharedState.networkProperties`

### Step 3: networkUpgrade transaction validation
- Add case to `validateTransaction.ts` for type `"networkUpgrade"`
- Checks: proposer is active validator, `version > current`, `effectiveAtBlock > currentBlock + MIN_BLOCKS`

### Step 4: Vote collection
- New transaction type `"networkUpgradeVote"` (validated same as above)
- On confirmed `networkUpgrade` tx, nodes begin accepting votes for that `proposalId`
- Votes stored in DB table `network_upgrade_votes`

### Step 5: Activation check
- In block processing (after each block is confirmed), check if any pending upgrades reach `effectiveAtBlock`
- Tally stake-weighted votes, apply if threshold met
- Update `getSharedState.networkProperties`
- Log the upgrade prominently

### Step 6: Apply properties
- Replace hardcoded values in:
  - `defaults.ts`: `shardSize` → `getSharedState.networkProperties.shardSize`
  - `validatorsManagement.ts`: `minToStake` → `getSharedState.networkProperties.minValidatorStake`
  - Fee calculations: `networkFee`/`rpcFee` from properties

---

## Files to Create
- `src/libs/blockchain/types/NetworkProperties.ts`
- `src/model/entities/NetworkUpgrade.ts`
- `src/model/entities/NetworkUpgradeVote.ts`
- `src/libs/blockchain/routines/loadNetworkProperties.ts`
- `src/libs/blockchain/routines/applyNetworkUpgrade.ts`
- `src/libs/blockchain/routines/tallyUpgradeVotes.ts`

## Files to Modify
- `src/model/datasource.ts` — register new entities
- `src/libs/blockchain/routines/validateTransaction.ts` — new tx type validation
- `src/libs/blockchain/transaction.ts` — add types to TX union
- `src/index.ts` — call `loadNetworkProperties()` at startup
- `src/config/defaults.ts` — make values read from `networkProperties`
- `src/libs/blockchain/routines/validatorsManagement.ts` — use dynamic min stake
- `src/libs/network/manageNodeCall.ts` handler registry — add `getNetworkProperties` endpoint

---

## Verification
1. Unit test: Create a `networkUpgrade` proposal, collect enough votes, verify activation
2. Integration test: Propose fee change, vote with 2/3 stake, check new fee applies at `effectiveAtBlock`
3. Negative test: Insufficient stake → upgrade rejected; version < current → TX rejected
4. Run existing tests: `bun test src/features/l2ps-messaging/tests/` must still pass

---

## Confirmed Design Choices
- **Vote storage**: On-chain (transparent, deterministic, auditable)
- **Vote weight**: Stake-weighted (DEMOS balance at proposal block)
- **Phase 1 scope**: Safe params only — `featureFlags`, `networkFee`, `rpcFee`, `minValidatorStake`
  - `shardSize` and `blockTimeMs` deferred to Phase 2

## Remaining Open Questions
- **Upgrade cancellation**: Can the proposer withdraw a proposal before `effectiveAtBlock`?
- **Emergency path**: Fast-path with higher threshold (e.g. 4/5) for critical fixes?
