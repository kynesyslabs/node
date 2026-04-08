# Merge Report: Stabilisation Hotfixes into Petri

**Date:** 2026-04-01
**Branch:** `merge/stabilisation-into-petri` (transient)
**Base:** `petri` ← `stabilisation`

---

## 1. Stabilisation Hotfixes Summary

9 commits merged from `stabilisation` that were not in `petri`:

| Commit | Description | Risk to Petri |
|--------|-------------|---------------|
| `979eb8c` | **GCR in-memory edit refactor** — routines now take `GCRMain` entity instead of `Repository` | **CRITICAL** |
| `628937b` | **L2PSConsensus refactor** — updated to use new GCR `prepareAccounts`/`applyTransaction` API | HIGH |
| `5dd0a9b` | LLM-suggested fixes on GCR routines (cleanup pass) | MEDIUM |
| `fdd86f0` | **Port staggering** — RPC/Omni ports now interleaved (53551/53552, 53553/53554, ...) | LOW |
| `74a4a6e` + `f29e49d` | **TX count inversion bug fix** — success/fail arrays were swapped + Set dedup | CRITICAL |
| `b9f62d4` | GCR edit timing instrumentation | LOW |
| `b57292a` | Omni reconnection test fix | LOW |
| `e82ce9b` | Merge commit aggregating all above | — |

---

## 2. Merge Outcome

**Conflicts:** 1 file — `testing/devnet/docker-compose.yml` (port assignments)
**Resolution:** Accepted stabilisation's staggered port scheme, preserved petri env vars (`PETRI_CONSENSUS`)

**Auto-merged cleanly:**
- `src/libs/blockchain/mempool_v2.ts` — TX counting fix integrated
- `src/libs/consensus/v2/PoRBFT.ts` — new `applyTransactions` API already compatible
- `src/libs/network/endpointExecution.ts` — new GCR API adopted
- `testing/devnet/.env.example` — port defaults updated
- `testing/scripts/run-suite.ts` — test infra updates

---

## 3. Petri Code Requiring Adaptation

### 3.1 FIXED: `speculativeExecutor.ts` (CRITICAL)

**File:** `src/libs/consensus/petri/execution/speculativeExecutor.ts`

**Problem:** Was calling old GCR routine API:
```typescript
// OLD — broken after merge
GCRBalanceRoutines.apply(edit, gcrMainRepo, true)
GCRNonceRoutines.apply(edit, gcrMainRepo, true)
GCRIdentityRoutines.apply(edit, gcrMainRepo, true)
```

**Fix applied:** Refactored to use new in-memory pattern:
```typescript
// NEW — uses batch account loading + unified applyTransaction
const accounts = await HandleGCR.prepareAccounts([tx])
const applyResult = await HandleGCR.applyTransaction(accounts, tx, false, true)
```

**Benefits:**
- Consistent with all other GCR callers (L2PS, PoRBFT, endpoint execution, sync)
- Uses batch account loading (fewer DB queries)
- Proper snapshot/rollback support via `applyTransaction` internals
- Handles ALL edit types (not just balance/nonce/identity) through the unified dispatcher

### 3.2 VERIFIED: No Other Petri Files Need Changes

All other GCR callers in the codebase are already using the new API:
- `L2PSConsensus.ts` — uses `prepareAccounts` + `applyTransaction` ✅
- `PoRBFT.ts` — uses `applyTransactions` ✅
- `endpointExecution.ts` — uses `prepareAccounts` + `applyTransaction` ✅
- `Sync.ts` — uses `applyTransactions` ✅

### 3.3 VERIFIED: Port Configuration Consistent

All test/devnet configs verified consistent with the new staggered port scheme across:
- `.env.example` files
- `docker-compose.yml`
- `start-staggered.sh`
- All loadgen and test scripts

---

## 4. Action Plan

### Completed
- [x] Merge stabilisation into petri (transient branch)
- [x] Resolve docker-compose.yml port conflicts (stabilisation priority)
- [x] Fix speculativeExecutor.ts to use new GCR in-memory API
- [x] Verify all GCR callers use new pattern
- [x] Verify port scheme consistency across configs

### Recommended Follow-up
- [ ] **Run full test suite** to validate the merge doesn't break Petri consensus flows
- [ ] **Integration test speculativeExecutor** — the refactored code should produce identical delta hashes as before, but this needs devnet validation
- [ ] **Review `gcr.ts` helper methods** — some utility functions in `src/libs/blockchain/gcr/gcr.ts` still reference `gcrMainRepository` (lines ~579, 620, 716, 815). These appear to be in auxiliary/query paths, not core edit flow, but worth auditing.
- [ ] **Monitor TX counting** — the inverted success/fail fix from stabilisation is now in petri. Petri's forge loop in `petriBlockCompiler.ts` should benefit, but verify mempool metrics are correct after merge.

---

## 5. Key Architectural Insight

The GCR refactor is a **performance-critical change**: instead of N database round-trips per edit, entities are batch-loaded into a `Map<string, GCRMain>`, modified in-memory, and saved once at the end. This directly benefits Petri's continuous forge loop where many TXs are processed per round. The `speculativeExecutor` fix ensures Petri's simulation path also gets this performance improvement.

The TX count inversion bug (`74a4a6e`) was in shared code (`mempool_v2.ts`, `PoRBFT.ts`). Since Petri builds on these same code paths, this fix prevents incorrect transaction classification that could have caused consensus disagreements between nodes.
