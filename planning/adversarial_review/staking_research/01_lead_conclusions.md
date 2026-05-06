# Lead Conclusions: Staking as Prerequisite for Stackable Genesis

> Tech Lead synthesis from research by Team "Stack Overflow Prevention Unit"

---

## TL;DR

Demos has ~40% of the infrastructure needed. The Validators entity and GCR query methods
provide a foundation, but there's no dynamic staking lifecycle (stake/unstake/exit), no
RPC exposure, and zero SDK support. The governance system (stackable genesis) cannot be
built until a basic staking lifecycle exists.

---

## What We Have (and what it means)

### The good news

1. **The `Validators` entity already tracks stake.** It has both `staked` (text) and `stake`
   (integer) columns. The data model is there — it just needs cleanup (pick one column,
   type it properly as bigint or string-encoded bigint).

2. **`getGCRValidatorsAtBlock(blockN)` already exists.** This is the foundation for the
   snapshot mechanism the governance design requires. It filters by `first_seen <= blockN`,
   so we can get the validator set at any historical block.

3. **`manageValidatorEntranceTx()` validates minimum stake.** The pattern for
   validator-related transaction validation exists — it's just incomplete.

4. **The consensus pipeline doesn't need immediate changes for Phase 1.** Shard selection
   (`getShard.ts`) is headcount-based, but the governance voting system uses its own
   stake-weighting, independent of consensus shard selection. Phase 1 governance doesn't
   require stake-weighted consensus — just stake-weighted voting.

### The bad news

1. **No unstake/exit.** Once a validator is in, there's no way out. This is a showstopper
   for governance — if validators can't exit, the "snapshot staked weight" is meaningless
   because it never changes.

2. **No stake updates.** A validator's stake is set at entrance and never modified. You
   can't increase or decrease your stake.

3. **No RPC endpoints.** The GCR methods exist but are node-internal. The SDK can't query
   validator state, which means wallets/tooling can't display governance info.

4. **SDK is a blank slate.** Zero staking/governance code. Everything must be built
   from scratch.

---

## Recommended Path: Minimal Viable Staking (MVS)

The full staking system described below is the minimum needed before the stackable genesis
governance system can be implemented. I recommend a phased approach.

### Phase 0: Staking Foundation (prerequisite for governance)

**Goal:** Validators can stake, increase stake, and unstake with a lock period.

#### Node Changes

**1. Clean up Validators entity**
- Remove duplicate `staked`/`stake` columns → single `staked_amount: string` (bigint as string)
- Add `unstake_requested_at: number | null` (block number when unstake was requested)
- Add `unstake_available_at: number | null` (block number when funds are unlocked)
- Keep `first_seen`, `valid_at`, `status` as-is

**2. New transaction types in `transaction.ts` + `validateTransaction.ts`**

| TX Type | Purpose | Validation |
|---------|---------|------------|
| `validatorStake` | Register as validator OR increase stake | amount >= minToStake (if new), sender not blacklisted |
| `validatorUnstake` | Request unstake (starts lock period) | sender is active validator, no pending proposals |
| `validatorExit` | Withdraw funds after lock period | unstake_available_at <= currentBlock |

**3. Unstake lock period**
- `UNSTAKE_LOCK_BLOCKS = 1000` (configurable, ~= voting window * 10)
- When a validator requests unstake: `unstake_requested_at = currentBlock`,
  `unstake_available_at = currentBlock + UNSTAKE_LOCK_BLOCKS`
- During lock period: validator is still in the active set, can still be selected for
  consensus, votes still count. This prevents vote-and-run attacks.
- After lock period: validator can call `validatorExit` to withdraw. Status changes to
  inactive, removed from active set.

**4. Expose GCR methods via RPC handlers**
- `getValidatorInfo(address)` → wraps `getGCRValidatorStatus()`
- `getValidators(blockNumber?)` → wraps `getGCRValidatorsAtBlock()`
- `getStakedAmount(address)` → returns validator's current staked_amount
- Register in `handlerRegistry` in `manageNodeCall.ts`

**5. GCR edit for staking**
- New `GCREditValidatorStake` type for atomic stake mutations
- Applied in `HandleGCR.applyTransaction()` like all other GCR edits

#### SDK Changes

**6. New transaction types**
- `src/types/blockchain/TransactionSubtypes/ValidatorStakeTransaction.ts`
- `src/types/blockchain/TransactionSubtypes/ValidatorUnstakeTransaction.ts`
- `src/types/blockchain/TransactionSubtypes/ValidatorExitTransaction.ts`
- Add to `TransactionContentData` union, `TransactionContent["type"]`, and `SpecificTransaction`

**7. New SDK methods**
- `DemosTransactions.stake(amount, demos)` → builds + signs `validatorStake` tx
- `DemosTransactions.unstake(demos)` → builds + signs `validatorUnstake` tx
- `DemosTransactions.validatorExit(demos)` → builds + signs `validatorExit` tx
- `Demos.getValidatorInfo(address)` → nodeCall `getValidatorInfo`
- `Demos.getValidators(blockNumber?)` → nodeCall `getValidators`

**8. New GCR edit type**
- `GCREditValidatorStake` in `src/types/blockchain/GCREdit.ts`

### Phase 1: Governance (stackable genesis)

**Only after Phase 0 is complete.** This is the implementation described in
`stackable_genesis_system_v2.md`. With the staking foundation in place:

- `getGCRValidatorsAtBlock(snapshotBlock)` provides the voter snapshot
- `staked_amount` provides vote weight
- Lock period prevents vote-and-unstake attacks
- RPC endpoints enable wallet/explorer integration

#### Additional node changes (on top of Phase 0)
- `networkUpgrade` and `networkUpgradeVote` transaction types
- `NetworkUpgrade` and `NetworkUpgradeVote` DB entities
- Vote tally logic at voting window end
- Activation logic at effectiveAtBlock
- `loadNetworkParameters()` at startup
- New RPC handlers: `getNetworkParameters`, `getActiveProposals`, `getProposalVotes`

#### Additional SDK changes (on top of Phase 0)
- `NetworkUpgradeTransaction.ts`, `NetworkUpgradeVoteTransaction.ts` subtypes
- `Demos.proposeNetworkUpgrade(params)` method
- `Demos.voteOnUpgrade(proposalId, approve)` method
- `Demos.getNetworkParameters()`, `Demos.getActiveProposals()`, etc.
- `NetworkParameters` type in `genesisTypes.ts`

---

## Alternative: Skip Full Staking, Use Implicit Stake

If Phase 0 is too much work for now, there's a simpler path:

**Use the existing entrance amount as "implicit stake."** Every validator already has a
`staked` field set at registration time. The governance system could use this directly:

- Vote weight = `validator.staked` (set at entrance, never changes)
- Snapshot = `getGCRValidatorsAtBlock(proposalBlock)` (already works)
- No unstaking needed (validators can't leave anyway)

**Pros:**
- Minimal changes — governance can be built almost immediately
- The existing GCR queries already support block-height filtering

**Cons:**
- No stake mobility (can't increase, decrease, or withdraw)
- All validators who staked the minimum have equal weight (effectively headcount)
- No exit mechanism — validators are permanent
- Needs to be replaced with proper staking eventually

**My recommendation:** Do Phase 0 first. The implicit stake shortcut creates technical
debt that will be painful to unwind, and the governance design specifically requires
dynamic staking (snapshot semantics, vote-and-run prevention). Phase 0 is not massive —
it's 3 tx types, 1 entity update, 4 RPC handlers, and the SDK counterparts. Maybe 2-3
days of focused work.

---

## Files Summary

### Node — Files to Create
| File | Purpose |
|------|---------|
| `src/libs/network/handlers/validatorHandlers.ts` | RPC handlers for validator queries |
| `src/model/entities/NetworkUpgrade.ts` | Governance proposal entity (Phase 1) |
| `src/model/entities/NetworkUpgradeVote.ts` | Governance vote entity (Phase 1) |
| `src/libs/blockchain/types/NetworkParameters.ts` | Network params type (Phase 1) |
| `src/libs/blockchain/routines/loadNetworkParameters.ts` | Startup loader (Phase 1) |
| `src/libs/blockchain/routines/tallyUpgradeVotes.ts` | Vote tally (Phase 1) |
| `src/libs/blockchain/routines/applyNetworkUpgrade.ts` | Activation (Phase 1) |

### Node — Files to Modify
| File | Change |
|------|--------|
| `src/model/entities/Validators.ts` | Cleanup columns, add unstake fields |
| `src/libs/blockchain/routines/validatorsManagement.ts` | Add unstake/exit logic, make minToStake dynamic |
| `src/libs/blockchain/routines/validateTransaction.ts` | Add cases for new tx types |
| `src/libs/blockchain/transaction.ts` | Add types to TX union |
| `src/libs/network/manageNodeCall.ts` | Register new handlers |
| `src/model/datasource.ts` | Register new entities |
| `src/config/defaults.ts` | Make values read from networkParameters |

### SDK — Files to Create
| File | Purpose |
|------|---------|
| `src/types/blockchain/TransactionSubtypes/ValidatorStakeTransaction.ts` | Stake tx type |
| `src/types/blockchain/TransactionSubtypes/ValidatorUnstakeTransaction.ts` | Unstake tx type |
| `src/types/blockchain/TransactionSubtypes/ValidatorExitTransaction.ts` | Exit tx type |
| `src/types/blockchain/TransactionSubtypes/NetworkUpgradeTransaction.ts` | Proposal tx (Phase 1) |
| `src/types/blockchain/TransactionSubtypes/NetworkUpgradeVoteTransaction.ts` | Vote tx (Phase 1) |

### SDK — Files to Modify
| File | Change |
|------|--------|
| `src/types/blockchain/Transaction.ts` | Add new types to unions |
| `src/types/blockchain/TransactionSubtypes/index.ts` | Re-export new subtypes |
| `src/types/blockchain/GCREdit.ts` | Add `GCREditValidatorStake` |
| `src/types/blockchain/genesisTypes.ts` | Add `NetworkParameters` |
| `src/websdk/DemosTransactions.ts` | Add stake/unstake/exit builders |
| `src/websdk/demosclass.ts` | Add query methods (getValidatorInfo, etc.) |

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Dual stake columns cause data inconsistency | Medium | Clean up in Phase 0, migrate existing data |
| Unstake lock period too short → vote-and-run | High | Set lock = 10x voting window minimum |
| No validator exit breaks test environments | Low | Add `validatorExit` in Phase 0 |
| SDK breaking change (new tx types) | Medium | Additive change, no existing types modified |
| GCR validator queries not tested at scale | Medium | Load test with 100+ validators before Phase 1 |
| minToStake hardcoded as JS number (precision loss) | High | Use bigint/string, fix in Phase 0 |
