# Post-Staking-Merge Investigation — P3b

**Date:** May 6, 2026  
**Staking PR:** #778 (upgradable_network), merged at commit 4b099c5d  
**Decimals branch:** pulled staking PR at 4b099c5d, 31/31 fork tests still passing  

---

## Diff Summary

The staking PR introduced **6 major feature areas** that impact P3b scope:

1. **Validator staking system** (new)
2. **Network upgrade governance system** (new)
3. **Storage program enhancements** (extensions)
4. **Network parameters & tally system** (new)
5. **Fee recalculation & gas system** (modifications)
6. **Validator state machine** (expanded)

**New entities**: `NetworkUpgrade`, `NetworkUpgradeVote` (both governance-related, not stake-denominated).  
**Modified entities**: `Validators` (stake column replaced), `Transactions` (fees already widened to bigint, per P-1).  
**Unchanged**: `GCRMain` (balance still bigint), `GlobalChangeRegistry` (legacy backend unchanged).

---

## Q1: `Validators.stake` — The Original Blocker

### Column Type Change

**Before merge (commit 28a161f4):**
```typescript
// src/model/entities/Validators.ts:24
@Column("integer", { name: "stake", nullable: true })
stake: number | null
```

**After merge (current):**
```typescript
// src/model/entities/Validators.ts:15
@Column("text", { name: "staked_amount", nullable: true, default: "0" })
staked_amount: string | null
```

**CRITICAL CHANGE**: Column renamed from `stake` to `staked_amount` and type widened from `integer` (32-bit) to `text` (bigint-as-string). This is **not** an oversight — it's the staking PR's intentional design.

### Write Paths — Complete Trace

The staking PR adds exactly one write point for validator stakes:

**File**: `src/libs/blockchain/gcr/gcr_routines/GCRValidatorStakeRoutines.ts`

| Operation | Handler | Unit |
|---|---|---|
| **Initial stake** | `applyStake()` line 130 | `amount.toString()` where `amount = BigInt(edit.amount)` |
| **Stake increase** | `applyStake()` line 153 | `(prev + amount).toString()` |
| **Unstake** | `applyUnstake()` line 180-182 | No write to balance (only timestamps) |
| **Exit** | `applyExit()` line 220 | `staked_amount = "0"` |

**Unit denomination**: Trace from SDK backward:
1. SDK `ValidatorStakePayload.amount` is a **bigint-as-string** (file: `/sdks/src/types/blockchain/TransactionSubtypes/ValidatorStakeTransaction.ts:6`)
2. Node RPC handler receives it as string: `GCREditValidatorStake.amount: string`
3. Node coerces to bigint: `amount = BigInt(edit.amount)` (line 117)
4. Node serializes back to string: `staked_amount: amount.toString()` (line 130, 153)

**The question: what denomination is the SDK sending?** 
- **Pre-fork (current SDK 2.12.2)**: The SDK still uses **DEM** for all user-facing APIs. Validators stake in DEM.
- **Post-fork (planned SDK v3)**: Validators will stake in OS (9 decimals lower = 10^9× larger numeric value).

**Implication**: Today's staked_amount column holds DEM-denominated values. Post-fork genesis will specify staked amounts in OS. The migration must multiply `Validators.staked_amount` by 10^9 when the fork activates.

### Semantics Summary

- **Column type**: Text (bigint-as-string) — safe for OS without widening
- **Denomination pre-fork**: DEM
- **Denomination post-fork**: OS (10^9× larger)
- **Read path**: `getGCRHashedStakes()` at `src/libs/blockchain/gcr/gcr.ts:310` sums all staked_amounts and returns the hash. This hash is used in block validation. Post-fork, the same code will read OS values, producing a different hash (which is correct — hard fork).
- **MAX_SAFE_INTEGER risk**: No. Column is `text` (unbounded). No precision loss.
- **Coupled migrations**: YES — stakes and balances must migrate atomically.

---

## Q2: Re-confirm the Legacy GCR Backend

**File**: `src/model/entities/GCR/GlobalChangeRegistry.ts`

```typescript
export interface GCRStatus {
    hash: string
    content: {
        balance: number                    // JS number
        identities: StoredIdentities
        txs: string[]
        nonce: number
    }
}
```

**Status**: UNCHANGED. Still `balance: number` (max ~9.007e15).

**New fields from staking PR**: NONE. The legacy backend does not store validator stakes — those live in the `Validators` table. No new JSONB fields were added.

**Implication**: Legacy backend still has the same MAX_SAFE_INTEGER ceiling. Any account with > ~9M DEM pre-fork will overflow if migrated via the legacy path. This is pre-existing (not introduced by staking PR) but still a blocker for P3b.

---

## Q3: GCRv2 (Modern) Backend

**File**: `src/model/entities/GCRv2/GCR_Main.ts`

```typescript
@Column({ type: "bigint", name: "balance" })
balance: bigint
```

**Status**: UNCHANGED. Still `bigint`, still the only modern balance store.

**New fields from staking PR**: NONE. No staking-related columns in GCRv2.

**Implication**: GCRv2 migration is straightforward: `UPDATE gcr_main SET balance = balance * 1000000000n`. No new columns to handle.

---

## Q4: Block-Acceptance Hook Site

**File**: `src/libs/blockchain/chainBlocks.ts:148–347`

The `insertBlock()` function now includes three new governance-related operations **within the transaction context** (lines 301–311):

```typescript
// Line 301-311
const govProposalRepo = transactionalEntityManager.getRepository(NetworkUpgrade)
const govVoteRepo = transactionalEntityManager.getRepository(NetworkUpgradeVote)
await tallyUpgradeVotes(block.number, govProposalRepo, govVoteRepo)
await applyNetworkUpgrade(block.number, govProposalRepo)
```

**No new pre-block hooks** that would conflict with state migration. Both governance calls happen **after** block persistence (line 213–314 all in one transaction), so our fork-activation migration hook can still run at line 148 (block entry) or inline before line 213 (pre-save).

**Recommended hook site**: Still **`Chain.insertBlock` at line 148**, before block persistence. The migration check and execution should run in the transaction context (same as governance hooks) so it rolls back if the block save fails.

**Order**: 
1. Check fork activation (migration idempotent gate)
2. Run state migration if needed (all balances, all stakes, one atomic UPDATE per table)
3. Persist block
4. Tally votes & apply governance

**No ordering conflict**: Governance reads from `NetworkUpgrade` (no balance-related columns). State migration reads from `GCRMain` and `Validators` (both pre-block state). No race.

---

## Q5: New TypeORM Migrations Introduced by the Staking PR

**Pre-merge baseline**: Commit 28a161f4.  
**Post-merge**: Commit 4b099c5d.

**Files created/modified under `src/migrations/`**:

| File | Status | Purpose | Impact on P3b |
|---|---|---|---|
| `WidenFeeColumnsToBigint.ts` | Pre-existing (P-1) | Widen fee columns from 32-bit to 64-bit | No new migrations added by staking PR |
| `AddReferralSupport.ts` | Pre-existing | (unrelated) | No new migrations added by staking PR |

**New migrations from staking PR**: **ZERO**.

The staking PR modified `Validators.stake` → `Validators.staked_amount` (schema change) but **did not include a TypeORM migration file**. This is concerning but not a blocker if we use `synchronize: true` at startup (per CLAUDE.md).

**Implication for P3b**: Our planned migration `CreateForkStateTable` (to track one-time fork activation) can run anywhere in the sequence. No ordering constraint from staking PR migrations.

---

## Q6: `Transactions.amount` and Consensus State Hashing

**File**: `src/model/entities/Transactions.ts:43–44`

```typescript
@Column("bigint", { name: "amount", nullable: true })
amount: bigint
```

**Status**: UNCHANGED from audit_node.md. Still `bigint`.

**Did staking PR add state-hashing touchpoints?** 

Searched for `hash` + `stake`:
- `getGCRHashedStakes()` (line 310–343 of `src/libs/blockchain/gcr/gcr.ts`) — reads all validator stakes from `Validators.staked_amount`, sums them, returns SHA256 of the sum
- Called by: consensus block validation (implicit via block content comparison)
- **Pre-fork behavior**: Hashes DEM-denominated stake sum
- **Post-fork behavior**: Hashes OS-denominated stake sum (automatically different, expected)
- **No code change needed**: The hash function doesn't care about denomination; it just sums strings converted to bigint

**Implication**: Block hashes will change at fork (expected hard fork). No regression.

---

## Q7: P3a Regression Sanity-Check

**Test suite**: `testing/forks/` (31/31 tests)

```bash
$ bun test testing/forks/ 2>&1 | tail -5
 31 pass
 0 fail
 88 expect() calls
Ran 31 tests across 5 files. [3.95s]
```

**Result**: ALL PASS. No new "fork" name collisions or unexpected warnings from the staking PR. The merged code in `decimals` branch maintains bit-identical legacy behavior (fork inactive by default).

---

## Q8: Genesis Schema Changes

**File**: `data/genesis.json`

```json
{
  "properties": {
      "id": 1,
      "name": "DEMOS",
      "currency": "DEM"
  },
  "mutables": { ... },
  "balances": [ ... ],
  "timestamp": "...",
  "status": "confirmed"
}
```

**Changes from staking PR**: NO NEW TOP-LEVEL FIELDS.

- `forks` field does NOT exist (we will add it in P2)
- `upgrades`, `protocol_version`, `chainVersion` do NOT exist
- No collision with planned `forks: { osDenomination: { activationHeight } }` field

**New fields in balances format**: NO. Still `[address, amount_string]` tuples.

**Implication**: Our planned genesis change to add `forks` config is safe. No pre-existing conflict.

---

## Updated Migration Plan

### Entities Requiring ×10^9 Migration

| Entity | Column | Type | Denomination | Write Path | Migration Approach | MAX_SAFE_INTEGER |
|---|---|---|---|---|---|---|
| `GCRMain` | `balance` | `bigint` | DEM→OS | `GCRBalanceRoutines.apply()` | `UPDATE gcr_main SET balance = balance * 1000000000n` | N/A (safe) |
| `Validators` | `staked_amount` | `text` | DEM→OS | `GCRValidatorStakeRoutines.apply()` | `UPDATE validators SET staked_amount = (CAST(staked_amount AS numeric) * 1000000000)::text` | N/A (safe) |
| `GlobalChangeRegistry` | `details.content.balance` | `number` (JSONB) | DEM→OS | Direct JSONB edit in ledger system (legacy backend, being phased out) | Two-step: (1) widen JSONB balance to string JSONB, (2) multiply on read, (3) pre-fork abort if any account > 9M DEM | YES — pre-check required |
| `Transactions.amount` | `amount` | `bigint` | (not migrated) | Transaction history (read-only post-fork) | No migration needed; reinterpreted at fork | N/A (historical) |

### Idempotency Mechanism

**Recommended approach (Option A from PAUSED.md)**: Add a persistent `fork_state` table with one row per fork, tracking whether that fork's migration has run.

```sql
CREATE TABLE fork_state (
    fork_name TEXT PRIMARY KEY,
    migration_block_number INTEGER NOT NULL,
    completed_at TIMESTAMP NOT NULL
);
```

Check: `SELECT * FROM fork_state WHERE fork_name = 'osDenomination'`  
If exists → skip migration  
If not → run migration, then INSERT

**Verification step**: After migration, sum all balances and stakes:
```
pre_sum = (SELECT SUM(balance) FROM gcr_main) + 
          (SELECT SUM(CAST(staked_amount AS numeric)) FROM validators) +
          (SELECT SUM((details.content.balance)::numeric) FROM global_change_registry)
post_sum = (SELECT SUM(balance) FROM gcr_main) + 
           (SELECT SUM(CAST(staked_amount AS numeric)) FROM validators) +
           (SELECT SUM((details.content.balance)::numeric) FROM global_change_registry)
ASSERT post_sum == pre_sum * 1000000000
```

---

## Open Questions for User

### 1. Legacy GCR JSONB Overflow (Pre-Staking, Still Blocking)

**Status**: NOT RESOLVED by staking PR.

The legacy `GlobalChangeRegistry.details.content.balance` is still a JS `number` (max ~9.007e15). After ×10^9, any account > ~9M DEM will overflow.

**Options**:
- (a) **Fail-loud**: Migration aborts if any account > 9M DEM. Operators must manually fix legacy backend or prove no such accounts exist in genesis/production.
- (b) **Widen to JSONB string**: `ALTER TABLE global_change_registry SET (details.content.balance = balance::text)` before migration, then multiply.
- (c) **Skip legacy backend**: If legacy backend is already superseded by GCRv2 for all accounts in the deployment, skip legacy migration.

**Recommendation**: Fail-loud (option a). Legacy backend is being phased out. If it has > 9M DEM accounts, that's a risk signal.

**What we need from you**: Confirm option (a) or decide differently.

### 2. Validator Stake Unit Confirmation

**Status**: RESOLVED by code inspection. Traces confirm:
- SDK (v2.12.2) sends stake amounts as **DEM-denominated bigint strings**
- Node stores in `Validators.staked_amount` as text (no conversion)
- Post-fork, SDK v3 will send OS-denominated amounts

**Confirm**: This matches your expectation, or flag if stake amounts should follow different denomination rules than account balances.

### 3. Hook Timing Within `insertBlock` Transaction

**Status**: Clarification needed.

Our migration must run inside the `dataSource.transaction()` block (line 213–315) so it's atomic with block persistence. Two options:

- (A) Run migration **before** line 213 (pre-block-save), inside outer try/catch
- (B) Run migration **within** the transaction context (line 215–314), as a separate operation

**Recommendation**: Option B (inside transaction). This ensures the migration and block both succeed or both roll back together.

**What we need from you**: Confirm or specify if there's a reason to prefer option A.

### 4. Network Upgrade Voting — Stake Denomination

**Status**: PARTIAL CLARITY.

`NetworkUpgradeVote.weight` is stored as text (bigint-as-string), capturing the voter's staked amount at the snapshot block. This will be DEM pre-fork, OS post-fork.

**Question**: Should tally logic adjust vote weights at fork if a voter's stake changed between pre-fork and post-fork? (E.g., a voter stakes 100 DEM pre-fork, the fork happens, stake becomes 100 OS, then they vote — should vote weight be 100 DEM or 100 OS?)

**Current code** (`src/features/networkUpgrade/governanceWeight.ts`) reads `staked_amount` at the snapshot block and freezes it. This is deterministic and safe, regardless of denomination.

**What we need from you**: Confirm this is the intended behavior (immutable weight at snapshot) or flag if vote weights should be denomination-adjusted.

---

## Risk Register Update

### New Risks Introduced by Staking PR

| Risk | Severity | Mitigation |
|---|---|---|
| **Validators table migration coupling** | HIGH | Stakes and balances must migrate atomically. Test with a validator who has both a balance and a stake. |
| **Governance vote weights post-fork** | MEDIUM | Vote weights frozen at snapshot are safe, but confirm this is the intent with governance stakeholders. |
| **New entities not migrated** | LOW | `NetworkUpgrade` and `NetworkUpgradeVote` are governance metadata (not denominated). No migration needed. |
| **Legacy GCR JSONB still overflowing** | HIGH | Same as before staking PR. Blocks P3b unless resolved. |

### Old Risks Now Resolved

| Risk | Resolution |
|---|---|
| **`Validators.stake` write semantics unknown** | RESOLVED. Staking PR shows exact design: column renamed to `staked_amount`, type = text, denomination = DEM pre-fork / OS post-fork. |
| **Fee widening blocking P-1** | RESOLVED. Already in place (P-1 committed). `Transactions` fee columns are `bigint`. |
| **New entities hiding DEM-denominated state** | RESOLVED. Staking PR added only governance entities (`NetworkUpgrade`, `NetworkUpgradeVote`) and validator state machine — no hidden balance/fee columns. |
| **Validator set hash algorithm breaking at fork** | RESOLVED. `getGCRHashedStakes()` is denomination-agnostic. Hash changes (expected), code doesn't. |

---

## Summary for User

### The Headline Question

**Q: Is `Validators.stake` in DEM or OS post-merge?**

**A**: In **DEM** (pre-fork). The old `stake: number` column was removed and replaced by `staked_amount: string` (bigint-as-string, DEM-denominated). It holds DEM values today. Post-fork, new stakes will be OS-denominated (SDK v3 will send OS amounts), but historical stakes must be migrated ×10^9 at the fork boundary.

### Staking PR Impact on P3b Scope

**New DEM-denominated state**: 1 column (`Validators.staked_amount`).  
**New DEM-denominated entities**: 0 (governance entities added, but not denominated).  
**New bigint columns needing migration**: 0 (all existing bigints handled by P-1).

### Planned Hook Site Still Good

✓ **`Chain.insertBlock` at line 148 is still the right place.** No new pre-block hooks conflict. Governance operations (vote tally, proposal apply) happen after block persistence and don't read stale state.

### Top 3 Changes to the Migration Plan

1. **Must migrate `Validators.staked_amount` ×10^9**: It was unknown in the original audit. Staking PR shows it's a full stake ledger (text bigint-as-string). Add to migration scope.
2. **No new TypeORM migrations from staking PR to coordinate with**: Simplifies our dependency graph. Our `CreateForkStateTable` migration can run standalone.
3. **Legacy GCR overflow still a blocker**: Staking PR didn't resolve it. We still need operator decision: fail-loud, widen JSONB, or skip legacy backend.

### Blockers for P3b Resume

1. **Legacy GCR overflow decision** (pre-staking, still open): Can we proceed assuming no account > 9M DEM in legacy backend, or must we widen JSONB first?
2. **Migration atomicity within `insertBlock` transaction** (clarification): Confirm Option B (run migration inside transaction) is acceptable.
3. **Governance vote weight semantics** (optional): Confirm immutable-at-snapshot is the intended behavior.

**Everything else is a GO for P3b implementation.**

