# Plan: Staking + Governance Implementation

> Structured around SDK publish cycles.
> Each SDK batch is: code → build → publish → bump in node → use.

---

## Overview

```
SDK Batch 1 (staking types)
    ↓ publish
Node Batch 1 (staking backend)
    ↓ verify
SDK Batch 2 (governance types)
    ↓ publish
Node Batch 2 (governance backend)
    ↓ verify
Integration testing
```

---

## PHASE 0: STAKING FOUNDATION

### Step 0.1 — SDK Batch 1: Staking Types + Methods
**Repo:** `../sdks/`
**Branch:** `feat/staking-types`

#### 0.1.1 — New GCREdit variant
- **File:** `src/types/blockchain/GCREdit.ts`
- **Action:** Add `GCREditValidatorStake` interface
  ```typescript
  interface GCREditValidatorStake {
    type: "validatorStake"
    isRollback: boolean
    account: string
    operation: "stake" | "unstake" | "exit"
    amount: string  // bigint as string
    txhash: string
  }
  ```
- **Action:** Add to `GCREdit` union type

#### 0.1.2 — New transaction subtypes
- **Create:** `src/types/blockchain/TransactionSubtypes/ValidatorStakeTransaction.ts`
  - Payload: `{ amount: string, connectionUrl: string }`
  - Type literal: `"validatorStake"`
- **Create:** `src/types/blockchain/TransactionSubtypes/ValidatorUnstakeTransaction.ts`
  - Payload: `{}` (sender is implicit)
  - Type literal: `"validatorUnstake"`
- **Create:** `src/types/blockchain/TransactionSubtypes/ValidatorExitTransaction.ts`
  - Payload: `{}` (sender is implicit)
  - Type literal: `"validatorExit"`
- **Modify:** `src/types/blockchain/Transaction.ts`
  - Add all three to `TransactionContentData` union
  - Add all three to `TransactionContent["type"]` string union
- **Modify:** `src/types/blockchain/TransactionSubtypes/index.ts`
  - Re-export, add to `SpecificTransaction` union

#### 0.1.3 — SDK builder methods
- **Modify:** `src/websdk/DemosTransactions.ts`
  - Add `stake(amount: string, connectionUrl: string, demos: Demos)`
  - Add `unstake(demos: Demos)`
  - Add `validatorExit(demos: Demos)`
  - Follow existing patterns (prepare → sign → return)

#### 0.1.4 — SDK query methods
- **Modify:** `src/websdk/demosclass.ts`
  - Add `getValidatorInfo(address: string)` → `nodeCall("getValidatorInfo", ...)`
  - Add `getValidators(blockNumber?: number)` → `nodeCall("getValidators", ...)`
  - Add `getStakedAmount(address: string)` → `nodeCall("getStakedAmount", ...)`

#### 0.1.5 — Validator types
- **Create:** `src/types/validator/ValidatorTypes.ts`
  ```typescript
  interface ValidatorInfo {
    address: string
    status: number
    stakedAmount: string
    connectionUrl: string
    firstSeen: number
    validAt: number
    unstakeRequestedAt: number | null
    unstakeAvailableAt: number | null
  }
  ```
- **Modify:** main exports to include new types

#### 0.1.6 — Build + publish
- `bun run build`
- Bump version to `2.12.0` (new feature)
- `npm publish`
- **CHECKPOINT: SDK Batch 1 published**

---

### Step 0.2 — Node Batch 1: Staking Backend
**Repo:** `./` (node)
**Branch:** `feat/staking-foundation`
**Prerequisite:** SDK Batch 1 published, `@kynesyslabs/demosdk@2.12.0`

#### 0.2.1 — Update SDK dependency
- `bun update @kynesyslabs/demosdk`
- Verify new types are available

#### 0.2.2 — Clean up Validators entity
- **Modify:** `src/model/entities/Validators.ts`
  - Remove duplicate `staked` (text) and `stake` (integer) columns
  - Add `staked_amount: string` (bigint as string, not null, default "0")
  - Add `connection_url: string` (keep existing)
  - Add `unstake_requested_at: number | null`
  - Add `unstake_available_at: number | null`
  - Keep `address`, `status`, `first_seen`, `valid_at`
- **Note:** TypeORM synchronize:true handles schema migration

#### 0.2.3 — Update ValidatorsManagement
- **Modify:** `src/libs/blockchain/routines/validatorsManagement.ts`
  - Replace hardcoded `minToStake` with config/genesis-derived value
  - Add `manageValidatorStakeTx(tx)`:
    - New validator: check amount >= minToStake, not already registered
    - Existing validator: add to existing stake
  - Add `manageValidatorUnstakeTx(tx)`:
    - Check sender is active validator
    - Check no pending governance proposals from this validator (future-proof)
    - Set `unstake_requested_at = currentBlock`
    - Set `unstake_available_at = currentBlock + UNSTAKE_LOCK_BLOCKS`
  - Add `manageValidatorExitTx(tx)`:
    - Check `unstake_available_at <= currentBlock`
    - Set status to inactive (0 or dedicated value)
  - `UNSTAKE_LOCK_BLOCKS = 1000` (constant, configurable later via governance)

#### 0.2.4 — Transaction validation
- **Modify:** `src/libs/blockchain/routines/validateTransaction.ts`
  - Add case `"validatorStake"`: call `manageValidatorStakeTx()`
  - Add case `"validatorUnstake"`: call `manageValidatorUnstakeTx()`
  - Add case `"validatorExit"`: call `manageValidatorExitTx()`
- **Modify:** `src/libs/blockchain/transaction.ts`
  - Add types to TX type union (if not already imported from SDK)

#### 0.2.5 — GCR handling
- **Modify:** GCR/HandleGCR to process `GCREditValidatorStake` edits
  - On `stake`: update `staked_amount` in Validators table
  - On `unstake`: set unstake timestamps
  - On `exit`: zero out stake, set inactive

#### 0.2.6 — RPC handlers
- **Create:** `src/libs/network/handlers/validatorHandlers.ts`
  - `getValidatorInfo(address)` → wraps `GCR.getGCRValidatorStatus()`
  - `getValidators(blockNumber?)` → wraps `GCR.getGCRValidatorsAtBlock()`
  - `getStakedAmount(address)` → returns `validator.staked_amount`
- **Modify:** `src/libs/network/manageNodeCall.ts` (or handler registry)
  - Register new handlers

#### 0.2.7 — Tests
- **Create:** `testing/staking/` directory
  - `validatorStake.test.ts` — entrance, increase stake
  - `validatorUnstake.test.ts` — unstake request, lock period check
  - `validatorExit.test.ts` — exit after lock, reject exit before lock
- Run `bun run lint:fix`
- Run `bun test testing/`
- **CHECKPOINT: Phase 0 complete, staking works**

---

## PHASE 1: STACKABLE GENESIS GOVERNANCE

### Step 1.1 — SDK Batch 2: Governance Types + Methods
**Repo:** `../sdks/`
**Branch:** `feat/governance-types`

#### 1.1.1 — NetworkParameters type
- **Create or modify:** `src/types/blockchain/genesisTypes.ts`
  ```typescript
  interface NetworkParameters {
    blockTimeMs: number
    shardSize: number
    minValidatorStake: string
    networkFee: number
    rpcFee: number
    featureFlags: Record<string, boolean>
  }

  interface NetworkUpgradeProposal {
    version: number
    proposalId: string
    proposerPublicKey: string
    proposedParameters: Partial<NetworkParameters>
    effectiveAtBlock: number
    rationale: string
    status: 'pending' | 'approved' | 'activating' | 'active' | 'rejected'
    snapshotBlock: number
  }

  interface ProposalVoteInfo {
    proposalId: string
    totalStakedWeight: string
    approveWeight: string
    rejectWeight: string
    votes: Array<{ voter: string, approve: boolean, weight: string }>
    threshold: string
    passed: boolean
  }
  ```

#### 1.1.2 — New transaction subtypes
- **Create:** `src/types/blockchain/TransactionSubtypes/NetworkUpgradeTransaction.ts`
  - Payload: `{ proposedParameters: Partial<NetworkParameters>, proposalId: string, rationale: string, effectiveAtBlock: number }`
  - Type literal: `"networkUpgrade"`
- **Create:** `src/types/blockchain/TransactionSubtypes/NetworkUpgradeVoteTransaction.ts`
  - Payload: `{ proposalId: string, approve: boolean }`
  - Type literal: `"networkUpgradeVote"`
- **Modify:** `Transaction.ts` — add to unions
- **Modify:** `TransactionSubtypes/index.ts` — re-export

#### 1.1.3 — SDK builder methods
- **Modify:** `src/websdk/DemosTransactions.ts`
  - Add `proposeNetworkUpgrade(params: {...}, demos: Demos)`
  - Add `voteOnUpgrade(proposalId: string, approve: boolean, demos: Demos)`

#### 1.1.4 — SDK query methods
- **Modify:** `src/websdk/demosclass.ts`
  - Add `getNetworkParameters()` → `nodeCall("getNetworkParameters", ...)`
  - Add `getActiveProposals()` → `nodeCall("getActiveProposals", ...)`
  - Add `getProposalVotes(proposalId)` → `nodeCall("getProposalVotes", ...)`
  - Add `getUpgradeHistory()` → `nodeCall("getUpgradeHistory", ...)`

#### 1.1.5 — Build + publish
- `bun run build`
- Bump version to `2.13.0`
- `npm publish`
- **CHECKPOINT: SDK Batch 2 published**

---

### Step 1.2 — Node Batch 2: Governance Backend
**Repo:** `./` (node)
**Branch:** `feat/stackable-genesis`
**Prerequisite:** SDK Batch 2 published, `@kynesyslabs/demosdk@2.13.0`

#### 1.2.1 — Update SDK dependency
- `bun update @kynesyslabs/demosdk`

#### 1.2.2 — DB entities
- **Create:** `src/model/entities/NetworkUpgrade.ts`
  - Fields: `id`, `proposalId` (unique), `version`, `proposedParameters` (jsonb),
    `status`, `effectiveAtBlock`, `snapshotBlock`, `createdAtBlock`,
    `tallyBlock`, `proposerPublicKey`, `rationale`
- **Create:** `src/model/entities/NetworkUpgradeVote.ts`
  - Fields: `id`, `proposalId`, `voterAddress`, `approve` (boolean),
    `weight` (string/bigint), `blockNumber`
  - Unique constraint on `(proposalId, voterAddress)`
- **Modify:** `src/model/datasource.ts` — register both entities

#### 1.2.3 — NetworkParameters type + loader
- **Create:** `src/libs/blockchain/types/NetworkParameters.ts`
  - Import/re-export from SDK types
  - Add safety bounds constants:
    ```typescript
    const PARAMETER_BOUNDS = {
      minValidatorStake: { floor: genesisValue * 0.01, maxChangePercent: 50 },
      networkFee: { floor: 0, ceiling: 5000, maxChangePercent: 50 },
      rpcFee: { floor: 0, ceiling: 5000, maxChangePercent: 50 },
      // Phase 2:
      blockTimeMs: { floor: 1000, ceiling: 60000, maxChangePercent: 50 },
      shardSize: { floor: 3, ceiling: 100, maxChangePercent: 50 },
    }
    ```
- **Create:** `src/libs/blockchain/routines/loadNetworkParameters.ts`
  - Query DB for latest `active` NetworkUpgrade
  - Fall back to genesis defaults if none
  - Store in `getSharedState.networkParameters`
- **Modify:** `src/index.ts` — call `loadNetworkParameters()` in `preMainLoop()` after `findGenesisBlock()`

#### 1.2.4 — Transaction validation
- **Modify:** `src/libs/blockchain/routines/validateTransaction.ts`
  - Add case `"networkUpgrade"`:
    - Proposer is active validator
    - Proposer has 0 other pending proposals
    - `effectiveAtBlock >= currentBlock + votingWindowBlocks + gracePeriodBlocks`
    - `Object.keys(proposedParameters)` non-empty, only Phase-1 allowed params
    - No key overlap with pending/activating proposals
    - All values within safety bounds (percentage + absolute)
    - `rationale.length <= 1024`
    - Auto-assign version = highest existing + 1
  - Add case `"networkUpgradeVote"`:
    - Voter is in snapshot validator set at proposal's snapshotBlock
    - One vote per validator per proposalId
    - Proposal is in `pending` status
    - Vote is within voting window (snapshotBlock + 1 to snapshotBlock + votingWindowBlocks)

#### 1.2.5 — Vote tally + activation
- **Create:** `src/libs/blockchain/routines/tallyUpgradeVotes.ts`
  - Called after each block is confirmed
  - For each `pending` proposal where `currentBlock == snapshotBlock + votingWindowBlocks`:
    - Query all votes for this proposalId
    - Sum approve weight, compute total staked weight from snapshot
    - If approve >= 2/3 of total → status = `approved`, then `activating`
    - Else → status = `rejected`
- **Create:** `src/libs/blockchain/routines/applyNetworkUpgrade.ts`
  - Called after each block is confirmed
  - For each `activating` proposal where `currentBlock >= effectiveAtBlock`:
    - Apply `proposedParameters` to current `NetworkParameters`
    - Deterministic ordering: lexicographic by proposalId
    - Update `getSharedState.networkParameters`
    - Status → `active`
    - Log prominently

#### 1.2.6 — Dynamic parameter usage
- **Modify:** `src/config/defaults.ts`
  - `shardSize` → read from `getSharedState.networkParameters.shardSize`
- **Modify:** `src/libs/blockchain/routines/validatorsManagement.ts`
  - `minToStake` → read from `getSharedState.networkParameters.minValidatorStake`
- **Modify:** Fee calculation locations
  - `networkFee` / `rpcFee` → from `getSharedState.networkParameters`

#### 1.2.7 — RPC handlers
- **Modify:** `src/libs/network/handlers/validatorHandlers.ts` (extend from Phase 0)
  - Add `getNetworkParameters` → returns current `networkParameters` from shared state
  - Add `getActiveProposals` → query NetworkUpgrade where status in (pending, activating)
  - Add `getProposalVotes(proposalId)` → query NetworkUpgradeVote, compute tally
  - Add `getUpgradeHistory` → query NetworkUpgrade where status = active, ordered by version

#### 1.2.8 — Tests
- **Create:** `testing/governance/` directory
  - `networkUpgrade.test.ts` — proposal creation, validation, safety bounds
  - `networkUpgradeVote.test.ts` — vote creation, snapshot enforcement, one-per-validator
  - `voteTally.test.ts` — threshold math, boundary cases (exactly 2/3, below 2/3)
  - `activation.test.ts` — activation ordering, grace period, parameter application
  - `concurrentProposals.test.ts` — disjoint keys pass, overlapping keys rejected
  - `rejection.test.ts` — failed proposal, re-proposal flow
- Run `bun run lint:fix`
- Run `bun test testing/`
- **CHECKPOINT: Phase 1 complete, governance works**

---

## PHASE 2: INTEGRATION TESTING

### Step 2.1 — End-to-end verification
- Manually test full flow on local/testnet:
  1. Stake as validator
  2. Propose fee change
  3. Vote with sufficient stake
  4. Wait for tally
  5. Wait for activation
  6. Verify new fees applied
  7. Propose another change, let it fail
  8. Verify rejection flow
  9. Unstake, wait lock period, exit
- Document results

---

## Constants Reference

| Constant | Value | Governable? |
|----------|-------|-------------|
| `VOTING_WINDOW_BLOCKS` | 100 | Yes (Phase 2) |
| `GRACE_PERIOD_BLOCKS` | 50 | Yes (Phase 2) |
| `UNSTAKE_LOCK_BLOCKS` | 1000 | No (safety) |
| `MAX_RATIONALE_LENGTH` | 1024 bytes | No |
| `SUPERMAJORITY_THRESHOLD` | 2/3 (66.67%) | No (immutable) |
| `MAX_CHANGE_PERCENT` | 50% | No (safety) |

---

## Dependency Graph

```
SDK Batch 1 (v2.12.0)
  ├── ValidatorStakeTransaction.ts
  ├── ValidatorUnstakeTransaction.ts
  ├── ValidatorExitTransaction.ts
  ├── GCREditValidatorStake
  ├── ValidatorTypes.ts
  ├── DemosTransactions: stake(), unstake(), validatorExit()
  └── Demos: getValidatorInfo(), getValidators(), getStakedAmount()
        │
        ▼  publish + bump
Node Batch 1
  ├── Validators entity cleanup
  ├── ValidatorsManagement: stake/unstake/exit logic
  ├── validateTransaction: 3 new cases
  ├── HandleGCR: GCREditValidatorStake processing
  ├── validatorHandlers: 3 RPC endpoints
  └── Tests
        │
        ▼  verify Phase 0
SDK Batch 2 (v2.13.0)
  ├── NetworkParameters, NetworkUpgradeProposal types
  ├── NetworkUpgradeTransaction.ts
  ├── NetworkUpgradeVoteTransaction.ts
  ├── DemosTransactions: proposeNetworkUpgrade(), voteOnUpgrade()
  └── Demos: getNetworkParameters(), getActiveProposals(), ...
        │
        ▼  publish + bump
Node Batch 2
  ├── NetworkUpgrade + NetworkUpgradeVote entities
  ├── loadNetworkParameters() at startup
  ├── validateTransaction: 2 new cases (full validation)
  ├── tallyUpgradeVotes.ts
  ├── applyNetworkUpgrade.ts
  ├── Dynamic param usage (defaults.ts, validatorsManagement, fees)
  ├── validatorHandlers: 4 more RPC endpoints
  └── Tests
        │
        ▼  verify Phase 1
Integration Testing
```

---

## Estimated Effort (rough, not a commitment)

| Step | Scope | Complexity |
|------|-------|-----------|
| SDK Batch 1 | 5 new files, 4 modified | Low — mechanical, follows existing patterns |
| Node Batch 1 | 1 new file, 4 modified, tests | Medium — staking logic + GCR integration |
| SDK Batch 2 | 4 new files, 3 modified | Low — same pattern as Batch 1 |
| Node Batch 2 | 5 new files, 6 modified, tests | High — tally logic, activation, safety bounds |
| Integration | Testing only | Medium — manual E2E flows |
