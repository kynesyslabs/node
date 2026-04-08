# Stabilisation Hotfix Report — Impact on Tokens Branch

**Date**: 2026-04-01  
**Source branch**: `stabilisation` (9 commits)  
**Target branch**: `tokens-stabilisation-merge` (transient)

---

## Executive Summary

The stabilisation branch implements a **major batch-processing refactor of GCR state application**, moving from per-transaction sequential DB processing to in-memory batch processing. This eliminates DB round-trips per edit, dramatically improving throughput. Additionally, it fixes a **critical success/failure logic inversion** bug and updates L2PS consensus to the new API.

---

## Critical Hotfixes (Must Understand)

### 1. GCR Batch In-Memory Processing (`979eb8c3`)

**Problem**: Original architecture hit the database for every GCR edit operation, creating bottlenecks during consensus mempool processing.

**Solution**: New batch architecture:
```
Load Phase:  prepareAccounts(txs) → single DB query → Map<pubkey, GCRMain>
Process Phase: simulateOne() per tx → in-memory mutations with snapshot rollback
Save Phase:  bulk save + raw SQL batch update → O(1) DB operations
```

**Key API Changes**:
| Method | Old Signature | New Signature |
|--------|--------------|---------------|
| `HandleGCR.apply()` | `(edit, tx, rollback, simulate)` | Renamed to `applyGCREdit(edit, account, isRollback, simulate)` |
| `GCRBalanceRoutines.apply()` | `(edit, repository, simulate)` | `(edit, accountGCR)` — in-memory entity |
| `GCRNonceRoutines.apply()` | `(edit, repository, simulate)` | `(edit, accountGCR)` — in-memory entity |
| `GCRIdentityRoutines.apply()` | `(edit, repository, simulate)` | `(edit, accountGCR, simulate?)` — in-memory entity |
| `HandleGCR.applyToTx()` | per-tx DB operations | Delegates to `applyTransactions()` batch |
| New: `HandleGCR.applyTransactions()` | — | Batch entry point for tx array |
| New: `HandleGCR.prepareAccounts()` | — | Batch-loads GCRMain entities |

**New helpers**: `isBatchableGCREdit()`, `normalizePubkey()`, `GCRMainSnapshot`

### 2. Success/Failure Logic Inversion Fix (`74a4a6e8`)

**Problem**: In `applyGCREditsFromMergedMempool()`, successful transactions were being counted as failed and vice versa.

**Fix**: Corrected `if (applyResult.success) { failedTxs.push() }` → `if (!applyResult.success) { failedTxs.push() }`

Also added transaction deduplication sets to prevent double-processing.

### 3. L2PS Consensus Batch Integration (`628937b7`)

**Problem**: L2PSConsensus used old per-edit `HandleGCR.apply()` API.

**Fix**: Refactored to use `prepareAccounts()` → `applyTransaction()` → `saveGCREditChanges()` pattern. Removed manual `rollbackEdits()` method (batch architecture handles rollback atomically).

### 4. Error Handling Hardening (`5dd0a9b1`)

- Side effects now execute sequentially with per-effect try-catch (was `Promise.all`)
- Added null checks before spreading `gcr_edits`
- Added try-catch around `applyGCREdit()` calls in both apply and rollback paths
- `sender` normalization uses `normalizePubkey()` for Uint8Array support

---

## Non-Critical Changes

| Commit | What | Impact |
|--------|------|--------|
| `fdd86f0c` | Stagger devnet RPC/OmniP2P ports | Testing infra only |
| `b9f62d45` | Add timing instrumentation to GCR batch apply | Observability |
| `f29e49db` | Add debug logging throughout PoRBFT | Observability |
| `b57292a2` | Fix omni reconnection test scenario | Test fix only |
| `e82ce9ba` | Merge commit from omni_throughput_debug | Integration |

---

## Impact on Tokens Branch — Action Items

### HIGH PRIORITY

1. **Token GCR Routines Signature Alignment**  
   `GCRTokenRoutines.apply()` still uses the old `(edit, repository, simulate, tx)` signature.  
   Must be updated to match the new in-memory pattern `(edit, account/entity)` or explicitly handle the token-specific path differently since tokens have a separate entity type (`GCRToken` vs `GCRMain`).

2. **Token Edit Exclusion from Batch Processing**  
   The merge resolution already strips token edits before batch `applyTransactions()` and validates them separately via `applyTokenEditsToTx()`. **Verify** this path works correctly with the new architecture.

3. **`applyGCREdit` Accepts `ExtendedGCREdit`**  
   The merge resolution widened the type from `GCREdit` to `ExtendedGCREdit` to accommodate token edit types. Verify type compatibility.

### MODERATE PRIORITY

4. **Rollback Compatibility**  
   The new `rollback()` method uses `accounts: Map<string, GCRMain>` and calls `applyGCREdit()` with account lookup. Token edits have a separate rollback path — verify it's still invoked correctly.

5. **`applyTokenEditsToTx` Integration**  
   This tokens-branch method is called in `applyGCREditsFromMergedMempool()` to validate token edits before batch GCR processing. Ensure it doesn't depend on the old per-tx state management.

6. **L2PS + Tokens Interaction**  
   If L2PS proofs can contain token edits, verify the new L2PSConsensus batch path handles them (it currently uses `isBatchableGCREdit()` which only matches balance/nonce edits).

### LOW PRIORITY

7. **Port Configuration** — If tokens branch testing uses devnet, update port mappings.
8. **Debug Logging** — Review `log.only()` calls; may want to revert some to `log.debug()` before production.

---

## Merge Conflict Resolution Summary

| File | Conflicts | Resolution |
|------|-----------|-----------|
| `handleGCR.ts` | 6 | Stabilisation batch architecture + tokens token routing preserved |
| `Sync.ts` | 1 | Stabilisation batch `applyTransactions()` |
| `PoRBFT.ts` | 4 | Stabilisation batch + tokens token edit validation integrated |

All conflicts resolved. No remaining conflict markers.
