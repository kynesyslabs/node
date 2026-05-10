# PAUSED — waiting for staking PR

> **Status as of session 9 (2026-05-01)**: P3b investigation surfaced unknowns about `Validators.stake` that depend on an in-flight staking PR. Pausing migration work here until the staking PR lands in `stabilisation` so we can plan against the final design, not assumptions.

## Where we are

- **Branch**: `decimals`, 12 commits ahead of `main`
- **Workspace**: clean (formatter-noise unstaged edits from P3b investigation discarded)
- **Mycelium epic #3**: P-1, P0, P1, P2, P3a closed. P3b open and blocking everything downstream.
- **All P3a tests pass** (31/31 in `testing/forks/`). Production behavior bit-identical (fork inactive by default).

## Why we paused

P3b (state migration script) hit two open questions during the **investigation** phase, before any DB-touching code was written:

### Q1: `Validators.stake` (the blocker)

- File: `src/model/entities/Validators.ts:24`
- Type: `integer` column, denominated in DEM
- Read by `getGCRHashedStakes` (consensus stake-hash)
- **Senior couldn't find any code path that writes to it** — it's read-only as far as the current node code is concerned
- Audit didn't list it as a balance column

A staking PR is in approval that adds the write side of this. Migrating `stake` without understanding the staking PR's design risks:
- Corrupting validator sets at fork
- Producing invalid blocks (consensus stake-hash mismatch)
- Conflicts when the staking PR merges and changes column types or write semantics

The right call is to wait for the staking PR, pull it from `stabilisation`, then revisit migration scope with a complete picture.

### Q2: Legacy GCR JSONB balance overflow (deferred, not blocking)

- `GlobalChangeRegistry.details.content.balance` is JS `number` (max ~9.007e15)
- After ×10^9, any account > ~9M DEM cannot migrate via legacy path without precision loss
- **My recommendation**: fail-loud — migration aborts with offender list, operators remediate per-account, legacy backend is being phased out by GCRv2 anyway
- **Not blocking the pause**: depends on Q1 resolution and on whether genesis/current state has any >9M DEM accounts (empirical check needed when we resume)

## Resume protocol — when staking PR is approved

1. **Pull staking from `stabilisation`** into `decimals` (merge or rebase — your call). Resolve any conflicts in the P-1/P2/P3a touch sites:
   - `src/model/entities/Transactions.ts` (fee column widening)
   - `src/libs/blockchain/transaction.ts` (P2 serializer gate)
   - `src/libs/blockchain/routines/subOperations.ts` (P-1 BigInt coercions)
   - `src/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines.ts` (P-1)
   - `src/libs/consensus/v2/routines/createBlock.ts` (P2)
   - `src/forks/` (entire dir new)
   - `testing/forks/` (entire dir new)
2. **Re-run the P3a regression**: `bun test testing/forks/` should still pass. If it doesn't, the staking PR changed serialization semantics and we need to re-investigate.
3. **Re-investigate `Validators.stake`** with the staking PR's full design visible:
   - Where is `stake` written?
   - What unit is written? (DEM? OS already? Something else?)
   - Is there a separate "staking pool" table that also holds DEM-denominated values?
   - Does the staking PR introduce new TypeORM migrations that we need to coordinate with our `WidenFeeColumnsToBigint` and `CreateForkStateTable` (planned)?
4. **Re-run P3b investigation** with that context. Expected outputs from Senior:
   - Updated entity list (gcr_main, GlobalChangeRegistry, Validators.stake, anything new from staking PR)
   - Updated MAX_SAFE_INTEGER analysis (legacy backend + any new staking tables)
   - Hook insertion point still `Chain.insertBlock` (likely unchanged)
   - Idempotency mechanism still option (a) persistent `fork_state` table
5. **Resume P3b implementation** only after the updated investigation lands and is approved.
6. **Then P3c** (`getNetworkInfo` RPC), **P3d** (integration tests), then close P3.

## Open questions to revisit when resuming

- **Q1**: Should `Validators.stake` migrate ×10^9 alongside balances? Depends on staking PR's design.
- **Q2**: Legacy GCR JSONB overflow — fail-loud (recommended), widen JSONB to string, or two-step migration?
- **Q3** (new, surfaced by Q1): Does the staking PR introduce any other DEM-denominated state we'd need to migrate?

## What we built that doesn't depend on the staking PR

These commits are stable and don't need re-doing when the staking PR merges:

| Commit | Phase | Description |
|---|---|---|
| `438ade1f` | P-1 | parseInt → BigInt in subOperations |
| `c343d426` | P-1 | Widen Transactions fee columns to bigint |
| `cf798bad` | P-1 | BigInt coercion in GCRBalanceRoutines |
| `f140a0c7` | P1 | Bump demosdk to 2.12.0 |
| `2891f745` | P2 | Fork config types + default registry |
| `a8179125` | P2 | isForkActive gate + serializer wrappers |
| `b0cbe138` | P2 | Load fork config from genesis into SharedState |
| `ee4d398d` | P2 | Route transaction hashing through serializer gate |
| `b90ca7fd` | P2 | Route block hashing through serializer gate |
| `a5e28183` | P2 | Gate truth table + bit-identical regression tests |
| `2b2d2ece` | P3a | Post-fork transaction serializer (OS strings) |
| `974b361b` | P3a | Post-fork serializer + boundary tests |

12 commits, 31/31 tests in `testing/forks/`, lint clean, typecheck baseline preserved (11 errors, none new).

## Don't lose

- **gcr_edits flag for P4**: `tx.content.gcr_edits[]` carries per-entry `amount: number` (DEM) today. SDK v3 (P4) must produce these with OS-string amounts. Already noted in LOG.md Session 9 but worth re-flagging when P4 starts.
- **SDK pin**: node is on demosdk `2.12.0` (exact, not caret). Keep exact when bumping to v3 RC and v3 final to avoid auto-pulls.

## How to resume from cold context

1. Read `AGENTS.md` (Team Mode marker)
2. Read this file (PAUSED.md)
3. Read `decimal_planning/LOG.md` from the top — Sessions 1 through 9
4. Read `decimal_planning/SPEC.md` (working plan)
5. `myc task list --epic 3` — see what's open
6. Confirm staking PR has merged into `stabilisation` and pull it before doing anything else
