# State Restore from Snapshot — Implementation Plan

> **Target:** Hard fork chain bootstrap. Backward compatibility with the legacy `genesisData.balances`/`genesisData.users` path is preserved — nodes without a snapshot directory continue to boot via the existing flow.
> **Scope:** Single-shot fresh-chain bootstrap from a peer-sourced PG snapshot. Populates pre-fork `gcr_main`, `gcr_storageprogram`, `identity_commitments` such that the new chain starts with full historical state, then lets the existing `osDenomination` + `gasFeeSeparation` fork machinery apply at scheduled heights.

---

## Context

The merges of `decimals` (PR #812, osDenomination fork) and `gas-fee-separation` (PR #817, gasFeeSeparation fork) plus the `better_startup` rollup are a coordinated **chain-wipe hard fork**. Combined fork activation requires fresh PG. As-shipped, operators starting a fresh node have an empty `gcr_main` — every account, balance, identity, StorageProgram, and identity-commitment is lost.

This plan packages a single snapshot (taken once, committed to repo) that the next-gen genesis loader auto-restores when a fresh chain boots. The two existing forks then activate at their configured heights against fully populated state.

### Source of truth

Snapshot was extracted from `node3.demos.sh` PG (workers-debug v0.9.8, PG17) at block height 2285755. SHA verified: `c4568141f2c7066aaf22e9332b7ed96835b16f8defd93e6d83fe040be988f9f8` (state-snapshot.sql.gz, 62MB).

- `gcr_main`: 13880 rows (1057 with balance > 0). Balance sum (DEM raw): 15024999999998868586
- `gcr_storageprogram`: 1382 rows. Total `sizeBytes` sum: 1269189 (~1.27 MB)
- `identity_commitments`: 1 test row (`leaf_index=-1`, `provider='test'`) — likely safe to drop
- `validators`, `gcr_tlsnotary`, `gcr_hashes`, `gcr_tracker`, `merkle_tree_state`, `used_nullifiers`, `global_change_registry`: all 0 rows on source

### Design constraints (locked)

1. **Genesis block content must not change.** Block-0 hash stays bit-identical to current behavior. The snapshot is loaded via the existing `genesisData.users[]` path (already wired through `chainGenesis.ts:115` + `HandleGCR.createAccount`), NOT by mutating block-0 transactions.
2. **Forks run unchanged.** `osDenomination` and `gasFeeSeparation` activate at their `data/genesis.json`-configured heights and operate on restored state. No fork code touched.
3. **Operator workflow unchanged.** `./run` and `./run --docker` continue to work as today. Bootstrap is automatic on fresh DB.
4. **Idempotent / safe.** Re-running on an already-populated DB aborts hard. Tampered snapshot files fail verification before any write.
5. **Forks ARE NOT pre-applied** in the snapshot. Snapshot carries pre-fork DEM bigint balances. Forks transform them on activation as they would for any chain.
6. **Pubkey collision policy.** Genesis founder pubkeys in `data/genesis.json.balances` (7 entries, all 1e18 DEM) ALSO appear in the snapshot. Per operator decision: balances in `genesis.json.balances` will be **zeroed**, snapshot owns all balances. See P3.

---

## How it plugs into existing genesis flow

Current state (from `src/libs/blockchain/chainGenesis.ts:107-145`):

```typescript
// genesisData.balances → founders, currently 7 pubkeys @ 1e18 each
for (const balance of genesisData.balances) { users[user.pubkey] = { pubkey, balance } }

// genesisData.users[] → full GCR rows (currently unused in shipped genesis.json)
for (const user of genesisData?.users || []) {
    const balance = users[user.pubkey]?.balance || 0n
    users[user.pubkey] = { ...user, balance }
}

const userAccounts = Object.values(users)
// batched HandleGCR.createAccount() calls — accepts full fillData
```

**The genesis builder already supports `users[]` ingestion.** Our work:

1. Convert the snapshot into a `users[]` array shape compatible with `genesisData.users`.
2. Ship that data alongside `data/genesis.json` (separate file or inline).
3. Add restore for `gcr_storageprogram` + `identity_commitments` (genesis builder currently only handles `gcr_main`).
4. Zero out the `balances` section in `data/genesis.json` (founder balances now ride inside snapshot).
5. Verification harness.

---

## Plan

### P0 — Snapshot transform (one-shot, output committed)

**Goal:** Convert `.snapshot-restore/state-snapshot.sql.gz` (213M raw / 62M gz, INSERT-based PG dump) into structured JSONL committed to `data/snapshot/` plus a manifest with cryptographic integrity bound.

**Tasks:**

- **P0-T1** — Script `scripts/state-snapshot/transform.ts`:
  - Parse `state-snapshot.sql.gz` line-by-line (streaming — avoid loading 213M into memory).
  - Recognize three table INSERT shapes via header line (`INSERT INTO public.gcr_main`, etc.).
  - Robust SQL value parser for the column-inserts format (handle quoted strings with `''` escapes, JSONB cast, `NULL`, numeric, boolean, timestamp).
  - Emit one JSON object per row to `data/snapshot/<table>.jsonl`, fields keyed by column names from the INSERT header.
  - Per the operator's directives:
    - **Nonces reset to 0** (D from chat). Override `nonce` field at write time.
    - **`assignedTxs` reset to `[]`**. New chain has no tx history to reference.
    - **`createdAt` / `updatedAt` preserved.** Maintains "user since" UX.
  - Compute and emit `data/snapshot/manifest.json`:
    ```json
    {
      "schemaVersion": 1,
      "source": {
        "host": "node3.demos.sh",
        "chain_block_height": 2285755,
        "chain_block_hash": "3c6a0b81e4cc8fdd44719f79f5f71938e75f465802f312c4fb475886a36b8338",
        "node_version": "0.9.8",
        "pg_version": "17.0",
        "dumped_at": "<iso>"
      },
      "files": {
        "gcr_main.jsonl": { "sha256": "...", "rows": 13880, "balance_sum": "15024999999998868586" },
        "gcr_storageprogram.jsonl": { "sha256": "...", "rows": 1382, "size_bytes_sum": 1269189 },
        "identity_commitments.jsonl": { "sha256": "...", "rows": 1 }
      },
      "transforms_applied": {
        "nonces_reset_to_zero": true,
        "assigned_txs_emptied": true,
        "test_identity_commitments_dropped": true
      }
    }
    ```
  - Drop the single `identity_commitments` row (provider=`test`, leaf_index=-1) since it's not a real commitment. Record drop in manifest.
- **P0-T2** — Verifier `scripts/state-snapshot/verify-snapshot.ts`:
  - Reads `data/snapshot/manifest.json`.
  - Recomputes sha256 of each `.jsonl` and compares.
  - Recomputes balance sum, row counts. Compares.
  - Hard-fail on any mismatch.
  - This is what the genesis loader calls before consuming.

**Acceptance:**
- `data/snapshot/gcr_main.jsonl` exists with 13880 lines, each parseable as JSON
- `data/snapshot/gcr_storageprogram.jsonl` exists with 1382 lines
- `data/snapshot/identity_commitments.jsonl` exists with 0 rows OR not present (test row dropped per manifest)
- `data/snapshot/manifest.json` valid; verify-snapshot exits 0
- Re-running `transform.ts` against same input produces byte-identical output (determinism)

**Risk:** PG `column-inserts` format has tricky escaping for jsonb-with-embedded-quotes. Mitigation: prefer parsing INSERT VALUES via a small grammar (not regex) — pgsql-parser or hand-rolled state machine. Validate every parsed row against expected column count from header.

---

### P1 — Genesis builder extensions

**Goal:** Teach `chainGenesis.ts` to additionally restore `gcr_storageprogram` and `identity_commitments` from a snapshot file. Current builder only handles `gcr_main` via `users[]`.

**Tasks:**

- **P1-T1** — Snapshot loader hook (`src/libs/blockchain/genesis/loadSnapshot.ts`):
  - Reads `data/snapshot/manifest.json` (path resolved relative to `process.cwd()` or via env var `SNAPSHOT_DIR`).
  - Calls `verify-snapshot` programmatically; throws on any mismatch.
  - Streams `.jsonl` files (avoid loading 13880 + 1382 rows fully into memory at once — batch by 100).
  - Exports:
    - `streamGcrMain(): AsyncIterable<GCRMainSeed>`
    - `streamGcrStorageProgram(): AsyncIterable<GCRStorageProgramSeed>`
    - `streamIdentityCommitments(): AsyncIterable<IdentityCommitmentSeed>`
    - `getSnapshotMetadata(): SnapshotManifest`
- **P1-T2** — Extend `generateGenesisBlock` in `src/libs/blockchain/chainGenesis.ts`:
  - After the existing `users[]` loop (line 115), check if snapshot dir exists.
  - If present:
    - Stream `gcr_main` rows from snapshot, batch into existing `HandleGCR.createAccount` calls. (NOTE: replaces the existing `users[]` path — snapshot IS the users array in this model.)
    - Stream `gcr_storageprogram` rows; bulk INSERT via TypeORM repository (`repository.save(batch)` in batches of 100).
    - Stream `identity_commitments` rows; same pattern. (Will be 0 rows after test-row drop.)
  - Each bulk-insert section logs progress + final count.
  - Wrap entire restore in a single transaction via `dataSource.transaction(em => ...)` — partial failure = full rollback.
- **P1-T3** — Snapshot-source validation at genesis time:
  - Pre-flight: assert `gcr_main` table is empty, `gcr_storageprogram` empty, `identity_commitments` empty, `blocks` either empty or contains only block 0 from this exact run.
  - If non-empty → abort with operator-friendly error: "Snapshot restore requires empty PG; existing data found in <table>. To wipe + restore, use `./run -b true`."

**Acceptance:**
- Genesis builder on fresh PG with snapshot present populates 13880 gcr_main + 1382 gcr_storageprogram rows in a single block-0 boot
- Block-0 hash bit-identical to a pre-snapshot baseline run (`chainGenesis.generateGenesisBlock` does NOT include snapshot data in block hashing; only `genesisData` is hashed and snapshot is loaded as separate side-effect)
- Re-boot of already-populated chain skips restore cleanly (idempotency check fires)
- Restore of all three tables happens in a single PG transaction; killing the node mid-restore leaves DB in pre-restore (empty) state

**Risk:**
- StorageProgram blob `data` field is jsonb with potentially escaped content; transformer in P0 must produce valid JSON.
- Block-0 hash stability: snapshot data IS NOT in the block hash, but if any of `genesisData.balances` or `genesisData.users` changes (per P3 below), block-0 hash changes. Plan to verify with a hash before/after test against current testnet genesis.

---

### P2 — Snapshot-aware fork interplay

**Goal:** Ensure `osDenomination` and `gasFeeSeparation` migrations operate correctly on snapshot-restored state. The forks are designed to be a single-shot DB transformation against existing gcr_main rows — exactly the post-restore shape.

**Tasks:**

- **P2-T1** — Verify `osDenomination` against snapshot scale:
  - Read `osDenomination.ts:300+` (`runOsDenominationMigration`).
  - Confirm the single `UPDATE gcr_main SET balance = balance * 1000000000` is bounded-cost on 13880 rows (trivially fast, < 1s).
  - Verify the `computePreSumDem` returns 15024999999998868586 against restored snapshot (= our manifest balance_sum). Add assertion.
  - Verify `computePostSumOs` = 15024999999998868586 × 1e9 = ~1.5e28 fits within `numeric(38,0)` column (yes — 38 digits handles up to ~1e38).
- **P2-T2** — Verify `gasFeeSeparation` runs correctly post-restore:
  - It mainly seeds NetworkParameters + treasury setup; no balance scan needed. Confirm by reading `gasFeeSeparation.ts`.
- **P2-T3** — Document activation heights in `data/genesis.json`:
  - Operator must set `forks.osDenomination.activationHeight` (smallest acceptable = 1) and `forks.gasFeeSeparation.activationHeight` (= same as osDenomination per "combined fork" decision in PR #817).
  - Recommended: both = 1, so forks apply on the first non-genesis block, on full restored state.
  - `treasuryAddress` must be set to a real address (not `PLACEHOLDER_TREASURY_ADDRESS`) before launch. Operator responsibility, documented in runbook.

**Acceptance:**
- E2E test: empty PG + snapshot + genesis.json with `forks.osDenomination.activationHeight = 1, forks.gasFeeSeparation.activationHeight = 1, treasuryAddress = <real>` →
  1. Genesis boots, restores 13880 gcr_main rows with bigint DEM balances (sum = 15024999999998868586)
  2. Block 1 triggers osDenomination, multiplies all balances × 1e9 (sum = 15024999999998868586000000000)
  3. Block 1 also triggers gasFeeSeparation, network parameters seeded
  4. `fork_state` table shows both forks `applied=true`, `applied_at_block=1`
  5. Subsequent blocks operate normally on OS-denominated balances

**Risk:**
- `runOsDenominationMigration` reads pre-sums BEFORE the multiplication. With a 13880-row gcr_main + sum-bigint cast, should be instant. Bench in test.
- The legacy `global_change_registry` table is empty (verified 0 rows in source). Migration code may still try to scan it — should no-op gracefully. Verify.

---

### P3 — Operator workflow integration

**Goal:** Operator runs `./run` (or `./run --docker`) on a fresh checkout; node starts; everything restores automatically. No new manual steps required beyond the existing flow.

**Tasks:**

- **P3-T1** — Update `data/genesis.json`:
  - **Zero out `balances` array.** Per operator decision: snapshot owns balances; the 7 founder pubkeys in `balances` collide with snapshot pubkeys. Setting `balances` to `[]` cleanly hands ownership to the snapshot path. The 7 founders are already in `gcr_main.jsonl` with their original balances.
  - Add `forks.osDenomination.activationHeight = 1`.
  - Add `forks.gasFeeSeparation.activationHeight = 1, treasuryAddress = <REAL_TREASURY_HEX>`.
  - Note: zeroing `balances` changes block-0 hash. **This is fine and expected for a wipe-fork.** Document it.
- **P3-T2** — Document in `forking/restore/RUNBOOK.md`:
  - Step-by-step operator instructions (mirror `forking/RUNBOOK_FORK_ACTIVATION.md` style).
  - Includes: confirm `data/snapshot/manifest.json` matches expected sha256 (committed to repo; check via `bun scripts/state-snapshot/verify-snapshot.ts`), set treasury, run `./run`, observe genesis logs, observe fork activation at block 1, post-flight balance-sum verification.
- **P3-T3** — Ensure `scripts/run` doesn't need changes:
  - PG comes up via `docker compose up -d` in `postgres_${PG_PORT}/` directory (already there).
  - Node binary boots, calls `generateGenesisBlock`, which calls the new snapshot loader.
  - **No changes to `scripts/run`** if genesis builder handles everything.
  - If we discover a need to wait for snapshot transform or download, add a one-shot pre-node command in `scripts/run` — but for now snapshot is committed to repo.
- **P3-T4** — Reuse existing `bun run restore` slot OR retire it:
  - The existing `src/utilities/backupAndRestore.ts` is an export tool (despite name). Either:
    - **(a)** Replace its body with a call into the new snapshot transform/verify flow.
    - **(b)** Leave it as legacy export. Add new `bun run bootstrap:verify` script that calls `scripts/state-snapshot/verify-snapshot.ts`.
  - **Recommend (b).** Don't break existing operator muscle memory; existing `-b true` flow already wipes + replays. With snapshot in place, that flow continues to work.

**Acceptance:**
- Fresh clone → `./run` on a fresh machine boots, genesis restores from `data/snapshot/`, block 1 fires both forks, balances OS-denominated, `fork_state` shows both forks applied
- Restart of same node = idempotent (genesis loader detects existing chain, skips restore)
- Wipe + restart via `./run -b true` (or manual `data_*` removal) = full re-restore from snapshot

**Risk:**
- Block-0 hash divergence from existing testnet genesis. **Intentional.** Operators must wipe.

---

### P4 — Testing

- **P4-T1** — Unit tests for transform.ts: round-trip a hand-crafted PG dump fragment through transform → JSONL → loader, assert byte-equality.
- **P4-T2** — Unit tests for verify-snapshot.ts: corrupt manifest (wrong sha), corrupt JSONL (extra row, missing row, modified balance), missing file. All hard-fail.
- **P4-T3** — Integration test for extended genesis builder:
  - Empty PG + sample 5-row snapshot + minimal genesis.json
  - Run `generateGenesisBlock`
  - Assert: 5 gcr_main rows present, all with correct balance/nonce=0/assignedTxs=[]; 0 gcr_storageprogram, 0 identity_commitments
- **P4-T4** — Integration test for fork activation post-restore:
  - Use existing `testing/forks/migrations/osDenomination.test.ts` patterns
  - Seed gcr_main with 5 known rows (sample from snapshot)
  - Run osDenomination migration
  - Assert balance × 1e9, fork_state row created
- **P4-T5** — E2E test (`testing/forks/migrations/restoreE2E.test.ts`):
  - Programmatic: empty PG, place snapshot files, write genesis.json with activation heights = 1, programmatically boot Chain, mine block 1, assert end-state
- **P4-T6** — Determinism test: run transform.ts twice, diff outputs. Must be byte-identical.

**Acceptance:** All tests pass. Coverage on transform.ts + loadSnapshot.ts ≥ 80%.

---

### P5 — Cleanup + commit

- **P5-T1** — Add `.snapshot-restore/` and any large source artifacts to `.gitignore` if not already (verified during step 9).
- **P5-T2** — Decide if `data/snapshot/*.jsonl` is committed:
  - Estimated post-transform size: `gcr_main.jsonl` ~5-8 MB, `gcr_storageprogram.jsonl` ~1.5-2 MB, manifest tiny.
  - Total ~10 MB. Committable.
  - **Commit.** Repo growth tolerable; reproducibility wins.
- **P5-T3** — Update `forking/RUNBOOK_FORK_ACTIVATION.md` and `forking/REHEARSAL_RESULTS.md` to reference snapshot-restore as a prerequisite step.
- **P5-T4** — Code review pass via `code-reviewer` agent on the new files.

---

## Dependency graph

```
P0-T1 (transform) ───┬──> P0-T2 (verify) ────> P1-T1 (loadSnapshot)
                     │                                  │
                     └──> P5-T2 (commit jsonl)          ▼
                                                P1-T2 (genesis ext) ─────> P2-T1/T2 (fork verify)
                                                P1-T3 (preflight)              │
                                                        │                       ▼
                                                        ▼              P3-T1 (genesis.json edit)
                                                P4-T3 (genesis test)            │
                                                P4-T4 (fork test)               ▼
                                                P4-T5 (e2e)            P3-T2 (runbook)
                                                                       P3-T3 (run script audit)
                                                                       P3-T4 (npm script decision)
                                                                                │
                                                                                ▼
                                                                       P5 (cleanup + commit)
```

## Out of scope (this epic)

- Consensus-enforced state-root verification at block 1 (Merkle root of restored gcr_main). Could be Phase 2; for now we trust operators ran the same committed snapshot.
- IPFS / CDN distribution of the snapshot. Committed to repo for simplicity.
- Restoration of `transactions`, `mempool`, `blocks`, or other history tables. New chain starts fresh on those.
- Validator set restoration. Source had 0 validators; operators bring their own (existing flow).
- Migration of `global_change_registry` (legacy v1 GCR table). Source had 0 rows; not relevant for this snapshot.

## Risks summary

| Risk | Severity | Mitigation |
|---|---|---|
| SQL parsing edge cases break transform | high | Strict per-row column-count assertion; sample-row hash checks |
| Block-0 hash divergence trips operators | medium | RUNBOOK explicitly states "wipe required" |
| StorageProgram jsonb data round-trip lossy | medium | Hash each row's data field pre/post; assert equality |
| osDenomination math wrong on snapshot scale | low | Existing tests + new P4-T4 |
| Identity_commitments empty / single test row | low | Drop test row in transform |
| Operator forgets to set real treasuryAddress | medium | Pre-flight check in loadForkConfig already rejects placeholder when activationHeight ≠ null (see forkConfig.ts) |
| Snapshot file tampered after commit | medium | sha256 in manifest verified at load time |

## Estimate

- P0: 1 day (transform + verify)
- P1: 1.5 days (genesis ext, careful with batching + transaction)
- P2: 0.5 day (verify existing forks still work, no code changes if reads check out)
- P3: 0.5 day (config + runbook)
- P4: 1.5 days (tests, especially E2E)
- P5: 0.5 day

Total ~5.5 days of focused work.
