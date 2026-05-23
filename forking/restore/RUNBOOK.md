# Runbook — State Restore from Snapshot + Genesis-Time Fork Pre-Apply

**Audience**: Demos Network operators bootstrapping a fresh chain from the committed PG snapshot.
**Scope**: Fresh-chain bootstrap from `data/snapshot/`, automatic restoration of `gcr_main` (13 880 rows), `gcr_storageprogram` (1 382 rows), and `identity_commitments` (0 rows), seeding of 5 genesis-baked validators from `data/genesis.json`, followed by deterministic pre-application of `osDenomination` + `gasFeeSeparation` **at block 0 (genesis)** inside the same transaction.
**Status**: Operational. Read end-to-end before starting the boot sequence.

---

## 0. TL;DR

```text
┌────────────────────────────────────────────────────────────────────┐
│  Boot mode:     fresh chain from committed snapshot                │
│  Source block:  2285755 on node3.demos.sh (v0.9.8, PG17)          │
│  Fork bundle:   osDenomination + gasFeeSeparation at genesis       │
│  Side-effect:   balances × 10⁹, burn + treasury accounts created  │
│  Rollback:      impossible after genesis — plan accordingly        │
│  SDK floor:     @kynesyslabs/demosdk@4.0.0 from block 0 onward    │
└────────────────────────────────────────────────────────────────────┘
```

On a fresh DB the genesis builder detects `data/snapshot/`, verifies integrity, restores all three tables, seeds 5 genesis validators, and **pre-applies both forks** — all inside a single transaction. A solo node with 20% stake boots fully post-fork immediately, without waiting for consensus quorum to produce block 1.

---

## 0a. Why forks pre-apply at genesis

### The quorum problem

Producing block 1 requires consensus quorum (≥2/3 of validator stake online). With 5 equal validators, a single node holds 1/5 = 20% stake — below quorum. Under the old design (forks activate at block 1), the chain would sit at block 0 indefinitely until at least 3 of the 5 baked validators came online, leaving the node in a pre-fork state the entire time.

### The insight: migrations are pure functions

The osDenomination and gasFeeSeparation migrations are pure functions of their input state. Given the same snapshot rows and the same treasury address, they produce byte-identical output regardless of when they run — at block 0 or block 1. There is no consensus-dependent side-effect.

Running them inside the genesis transaction (before `insertBlock(genesisBlock, ...)` is called) produces the same final DB state as running them at block 1 via the hook in `chainBlocks.ts`. The `fork_state` table row is the durable, permanent record of "migration applied". Both the null `activationHeight` in `data/genesis.json` and the idempotency guard in each migration function prevent any double-application — two layers of defence.

The result: a fresh node boots with all accounts already in OS units, burn and treasury accounts already present, and the fork_state table already populated. Block 1 is a normal block requiring no migration work.

---

## 1. Prerequisites

### 1.1 Repository checkout

```bash
git clone https://github.com/kynesyslabs/node
cd node
git checkout <agreed-commit-hash>
git log -1 --pretty=format:%H
# must match the announced activation commit
```

### 1.2 Runtime

```bash
bun --version
# must be installed; install from https://bun.sh if absent
bun install
```

### 1.3 Docker (for the PostgreSQL container)

```bash
docker info 2>&1 | head -1
# must show "Client:" — Docker Desktop or Docker Engine running
docker compose version
```

### 1.4 Snapshot files

All three snapshot files are committed to the repository. Verify they are present:

```bash
ls -lh data/snapshot/
# expected:
#   gcr_main.jsonl
#   gcr_storageprogram.jsonl
#   identity_commitments.jsonl  (0 rows — empty file or absent)
#   manifest.json
```

If any file is missing, the genesis builder will refuse to restore (pre-flight aborts before writing to the DB).

---

## 2. Pre-flight verification

Run the snapshot verifier before every boot on a fresh DB. It exits 0 on success and prints a hard error on any mismatch.

```bash
bun snapshot:verify
# expected: exits 0 with a summary line per file
```

### 2.1 Pinned manifest values

Cross-check `data/snapshot/manifest.json` against these known-good values:

| Field | Expected value |
|---|---|
| `source.chain_block_height` | `2285755` |
| `source.chain_block_hash` | `3c6a0b81e4cc8fdd44719f79f5f71938e75f465802f312c4fb475886a36b8338` |
| `files.gcr_main.jsonl.sha256` | `b50513ce9632c5460a608d29cc0f4593cbb961bcf585a017323100a9bef10b55` |
| `files.gcr_storageprogram.jsonl.sha256` | `30f6f31243b77c66c25cadf5523c251a7aada7e858b669288f5c6b53cd11ee9f` |
| `files.identity_commitments.jsonl.sha256` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `balance_sum` (gcr_main, DEM raw) | `15024999999998868586` |
| `gcr_main` rows | `13880` |
| `gcr_storageprogram` rows | `1382` |
| `identity_commitments` rows | `0` |

```bash
# Quick cross-check via jq
jq '{
  height:    .source.chain_block_height,
  hash:      .source.chain_block_hash,
  gcr_sha:   .files["gcr_main.jsonl"].sha256,
  sp_sha:    .files["gcr_storageprogram.jsonl"].sha256,
  ic_sha:    .files["identity_commitments.jsonl"].sha256,
  balance:   .files["gcr_main.jsonl"].balance_sum,
  gcr_rows:  .files["gcr_main.jsonl"].rows,
  sp_rows:   .files["gcr_storageprogram.jsonl"].rows,
  ic_rows:   .files["identity_commitments.jsonl"].rows
}' data/snapshot/manifest.json
```

Any deviation means the snapshot files were altered after the last commit. Do NOT proceed — check `git diff data/snapshot/` and restore via `git checkout data/snapshot/`.

### 2.2 Genesis fork config

```bash
jq '.forks' data/genesis.json
# expected (P7 shape — activationHeight null, pre-apply at genesis):
# {
#   "osDenomination":   { "activationHeight": null },
#   "gasFeeSeparation": { "activationHeight": null,
#                         "treasuryAddress": "0xf7a1c3417e39563ca8f63f2e9a9ba08890888695768e95e22026e6f942addf23" }
# }

# Confirm balances array is empty
jq '.balances | length' data/genesis.json
# expected: 0
```

The `activationHeight: null` values tell the `chainBlocks.ts` block-N hook (`isForkActive`) that these forks are not scheduled via the hook — they were already applied at genesis. The treasury address is still required for the pre-apply step even though the height is null.

### 2.3 Fork machinery enabled

```bash
echo "${DEMOS_DISABLE_FORK_MACHINERY:-unset}"
# expected: unset (or empty / "false" / "0")
```

This is a rehearsal-only flag. With it set the loader short-circuits, both forks are silently skipped, and the chain boots without migration. The node has a hard production guard but verify anyway.

### 2.4 Validator-set enforcement (epic #17)

`data/genesis.json` `validators[]` is **consensus-gated** as of epic #17. `getShard()` intersects online peers with the `validators` table (status `'2'` ACTIVE, `valid_at <= currentBlock`) before selecting shard members. Non-validators stay passive (sync only).

```bash
echo "${DEMOS_REQUIRE_VALIDATORS:-unset}"
# production:  expected = "true"   (node refuses to operate if validators table is empty)
# dev/devnet:  expected = unset    (warn-and-allow legacy fallback)
```

| State | DEMOS_REQUIRE_VALIDATORS unset | DEMOS_REQUIRE_VALIDATORS=true |
|---|---|---|
| validators table has ACTIVE rows | normal — shard is intersection of online + validators | same |
| validators table empty OR all non-ACTIVE | loud warning + fall back to all online peers (legacy) | throws Error, consensus crashes |

Set `DEMOS_REQUIRE_VALIDATORS=true` in production environments (e.g. compose `.env`). Operators booting fresh dev chains without baked validators keep the lenient default.

---

## 3. Boot sequence

### 3.1 Bare-metal

```bash
./run
```

### 3.2 Containerised

```bash
./run --docker
```

Both invocations:
1. Start the PostgreSQL container (`postgres_<port>/`).
2. Wait for PG to accept connections.
3. Launch the node binary (`bun start:bun`).
4. The genesis builder detects `data/snapshot/`, calls `bun snapshot:verify` internally, then restores all three tables, seeds the 5 genesis validators, and pre-applies both forks — all inside a single PG transaction. If any step fails the entire transaction rolls back and the DB is left empty for a clean retry.

### 3.3 Log lines to watch during genesis (block 0)

Tail node output for these lines — order is significant:

```text
[GENESIS][SNAPSHOT] snapshot present: block=2285755 hash=3c6a0b81e4cc8fdd44719f79f5...
[GENESIS][SNAPSHOT] gcr_main: inserted 500/13880
[GENESIS][SNAPSHOT] gcr_main: inserted 1000/13880
... (this line repeats per batch of 500; the final occurrence reads "inserted 13880/13880") ...
[GENESIS][SNAPSHOT] gcr_main: inserted 13880/13880
[GENESIS][SNAPSHOT] gcr_storageprogram: inserted 100/1382
... (this line repeats per batch of 100; the final occurrence reads "inserted 1382/1382") ...
[GENESIS][SNAPSHOT] gcr_storageprogram: inserted 1382/1382
[GENESIS][SNAPSHOT] identity_commitments: inserted 0/0
[GENESIS][SNAPSHOT] restore complete: gcr_main=13880, gcr_storageprogram=1382, identity_commitments=0 elapsed=<ms>ms
[GENESIS][SNAPSHOT] validators: seeded 5
[GENESIS][FORKS] pre-applying osDenomination at block 0
[forks][osDenomination] starting state migration at block 0
[forks][osDenomination] preSumDem=15024999999998868586 gcrV2Rows=13880 legacyRows=0 validatorsRows=5
[forks][osDenomination] gcr_main migrated (rows=13880)
[forks][osDenomination] global_change_registry migrated (rows=0, capped=0, valueLostOs=0)
[forks][osDenomination] validators migrated (rows=5)
[forks][osDenomination] postSumOs=15024999999998868586000000000
[forks][osDenomination] sum invariant verified: postSumOs == preSumDem * 10^9 - valueLostOs
[forks][osDenomination] fork_state row persisted; migration complete
[GENESIS][FORKS] pre-applying gasFeeSeparation at block 0
[forks][gasFeeSeparation] starting state migration at block 0
[forks][gasFeeSeparation] created account at 0x0000000000000000000000000000000000000000000000000000000000000000 with balance=0
[forks][gasFeeSeparation] created account at 0xf7a1c3417e39563ca8f63f2e9a9ba08890888695768e95e22026e6f942addf23 with balance=0
[forks][gasFeeSeparation] fork_state row persisted; burn=0x000…0, treasury=0xf7a1c341…, burnCreated=true, treasuryCreated=true
[GENESIS][FORKS] pre-apply complete: osDenomination=true gasFeeSeparation=true elapsed=<ms>ms
```

The `sum invariant verified` line from osDenomination is load-bearing. Its absence means the migration aborted and the transaction rolled back — genesis was not persisted and the node stays unbooted. Escalate; do NOT restart without investigating.

The `gcr_main` batch line repeats 28 times (⌈13880 ÷ 500⌉ = 28 batches). The `gcr_storageprogram` line repeats 14 times (⌈1382 ÷ 100⌉ = 14 batches). The `identity_commitments` line is emitted once explicitly because there are 0 rows (no batches flush).

If the pre-flight finds existing rows it emits:

```text
[GENESIS][SNAPSHOT] ABORT: existing data found in gcr_main (N rows). To wipe + restore, use ./run -b true
```

See §6 (Recovery) in that case.

Also watch for the fork loader lines that follow startup:

```text
[FORKS] Loaded fork "osDenomination" with activationHeight=null
[FORKS] Loaded fork "gasFeeSeparation" with activationHeight=null
```

These are expected — both forks are marked null in genesis.json because they were pre-applied at block 0. The block-N hook in `chainBlocks.ts` sees `activationHeight=null` → `isForkActive()=false` → no re-application. Two layers of defence (null height + fork_state idempotency guard) prevent double-application.

---

## 4. Post-genesis state verification

Forks were applied at block 0 (genesis). Block 1 is a normal block — no migration work.

### 4.1 Database verification (run after genesis, not after block 1)

```sql
-- Balance sum must equal pre-fork DEM sum × 1e9
SELECT SUM(balance)::text FROM gcr_main;
-- expected: 15024999999998868586000000000

-- Both fork_state rows present and applied at block 0
SELECT fork_name, applied, applied_at_block FROM fork_state ORDER BY fork_name;
-- expected: 2 rows, applied=t, applied_at_block=0 for both

-- Burn + treasury accounts exist with balance 0
SELECT pubkey, balance::text FROM gcr_main
  WHERE pubkey IN (
    '0x0000000000000000000000000000000000000000000000000000000000000000',
    '0xf7a1c3417e39563ca8f63f2e9a9ba08890888695768e95e22026e6f942addf23'
  );
-- expected: 2 rows, balance = 0 each
```

### 4.2 Row counts

```sql
SELECT COUNT(*) FROM gcr_main;           -- expected: 13882 (13880 snapshot + 2 created by gasFeeSeparation)
SELECT COUNT(*) FROM gcr_storageprogram; -- expected: 1382
SELECT COUNT(*) FROM identity_commitments; -- expected: 0
SELECT COUNT(*) FROM validators;         -- expected: 5 (genesis-baked founding set)
```

---

## 5. What right looks like — reference values

| Metric | Value |
|---|---|
| Pre-fork balance sum (DEM raw) | `15024999999998868586` |
| Post-fork balance sum (OS raw) | `15024999999998868586000000000` |
| osDenomination `pre_sum_dem` (fork_state) | `15024999999998868586` |
| osDenomination `post_sum_os` (fork_state) | `15024999999998868586000000000` |
| osDenomination `applied_at_block` | `0` |
| osDenomination `capped_count` | `0` (no pre-fork legacy accounts exceeded the cap) |
| osDenomination `total_value_lost_os` | `0` |
| gasFeeSeparation `applied_at_block` | `0` |
| gasFeeSeparation — burn account balance | `0` |
| gasFeeSeparation — treasury account balance | `0` |
| genesis validators seeded | `5` |
| validator `staked_amount` post-fork (each, OS raw) | `1000000000000000000000000000` (1e27) |

---

## 6. Recovery / re-run

### 6.1 Boot failed mid-restore or insertBlock failure

If the node is killed mid-restore, the PG transaction (which wraps the entire snapshot restore, seedValidators, and applyForksAtGenesis in `chainGenesis.ts`) rolls back and the DB is in the pre-restore (empty) state. A plain `./run` re-boot will re-attempt the restore. No manual intervention needed.

If restore + forks succeed but `insertBlock` for block 0 subsequently fails, the DB has `gcr_main`/`gcr_storageprogram` rows (and fork_state rows) but no `blocks` entry. The next boot's pre-flight detects this (`blocks=0` AND `gcr_main≠0`) and aborts with a wipe-required error. Recover with `./run -b true`.

Note: `insertBlock` for block 0 runs AFTER the snapshot transaction closes (separate call in `chainGenesis.ts`). This is by design — the two operations are in separate transactions. A partial failure between them requires a wipe (see above).

### 6.2 Non-empty DB blocks restore

If the DB already has rows from a previous (possibly partial) boot that committed, the pre-flight refuses to proceed:

```text
[GENESIS][SNAPSHOT] ABORT: existing data found in gcr_main (N rows). ...
```

Wipe and re-run:

```bash
# Option A — use the run script wipe flag
./run -b true

# Option B — manual wipe
cd postgres_<PG_PORT>
docker compose down
rm -rf data_*
mkdir data_<PG_PORT>
docker compose up -d
cd ..
./run
```

Both paths leave `data/snapshot/` untouched. The genesis builder picks it up again on the fresh boot.

### 6.3 Snapshot verification failure

If `bun snapshot:verify` exits non-zero, the JSONL files or manifest have been altered. Restore from git:

```bash
git checkout data/snapshot/
bun snapshot:verify
# must exit 0 before proceeding
```

### 6.4 Fork machinery disabled

If the startup log shows:

```text
[FORKS] DEMOS_DISABLE_FORK_MACHINERY set — ignoring genesis `forks` field
```

Stop the node, unset the env var, restart. This flag is rehearsal-only and must never be set for the activation boot.

---

## 7. Safety notes

### 7.1 Snapshot integrity

The snapshot files in `data/snapshot/` are committed to the repository. Their sha256 hashes are pinned in `data/snapshot/manifest.json` and cross-checked by the genesis loader at every fresh-DB boot. If you need to replace the snapshot (e.g. for a newer source block), you must:

1. Replace the JSONL files.
2. Regenerate `manifest.json` via `bun snapshot:transform`.
3. Update the pinned values in this runbook.
4. Commit all four files together.

Do NOT edit `data/snapshot/*.jsonl` manually — sha256 verification will reject any tampered file at load time and abort the boot.

### 7.2 Founder balances

The 7 original founder pubkeys and their pre-fork DEM balances (1 000 000 000 000 000 000 DEM each) are stored inside `data/snapshot/gcr_main.jsonl`. The `balances` array in `data/genesis.json` has been intentionally zeroed to prevent double-crediting. Their balances are OS-denominated at block 0 (× 10⁹) by the `osDenomination` pre-apply inside the genesis transaction.

### 7.3 Nonces and assignedTxs

The snapshot transform reset all `nonce` fields to `0` and all `assignedTxs` fields to `[]`. The new chain has no transaction history to reference. `createdAt` and `updatedAt` timestamps were preserved to maintain "user since" metadata.

### 7.4 Validator set

The source snapshot (`node3.demos.sh` at block 2285755) had 0 validator rows. The restored chain bootstraps with **5 genesis-baked validators** declared in `data/genesis.json`. These validators are seeded inside the same transaction as the snapshot restore — they appear at status=ACTIVE with `staked_amount = 1 000 000 000 000 000 000` (1 DEM = 1e18) at genesis.

The `osDenomination` pre-apply (also inside the same transaction) multiplies each validator's `staked_amount` by 10^9, making the founding stake 1 OS (1e27) per validator. This all happens before `insertBlock` is called.

Caveats:
- The snapshot itself has 0 validator rows; genesis-baked validators in `data/genesis.json` form the founding set.
- After genesis, each `staked_amount` is already in OS units (× 10^9). No further migration needed.
- Additional validators may join via the existing staking flow (`bun upgradable:cli` / `scripts/upgradable-network/cli.ts`) after the network is live.
- Genesis-baked validators are NOT seeded on empty-dev-chain boots (no snapshot path). Dev-chain operators use the staking flow directly.

### 7.5 Block-0 hash

Zeroing `data/genesis.json.balances`, adding the `forks` block (with null heights), and pre-applying forks changes the block-0 hash relative to any pre-snapshot genesis. This is intentional and expected for a chain-wipe hard fork. Operators joining this chain must use this genesis, not any older one.

### 7.6 Legacy (non-snapshot) path

Dev-chain operators who boot without `data/snapshot/` (the `else` branch in `chainGenesis.ts`) follow the pre-snapshot behavior. `applyForksAtGenesis` is NOT called in that path. Their forks (if any are declared with non-null `activationHeight`) activate via the `chainBlocks.ts` block-N hook normally. This is intentional: dev operators control their own genesis and their own fork schedule.

---

## 8. Don't-do list

- **Don't edit `data/snapshot/*.jsonl` manually.** sha256 verification rejects tampered files at genesis load time.
- **Don't restore the old `balances` array** in `data/genesis.json`. Founder balances now ride inside the snapshot; re-adding them would double-credit the 7 founders.
- **Don't set `DEMOS_DISABLE_FORK_MACHINERY`** for this boot. Both forks must pre-apply at block 0.
- **Don't use `./run -b true` on a running node** without understanding it wipes `data_*` and forces a full re-restore from snapshot on the next start.
- **Don't delete `fork_state` rows** post-genesis. Idempotency depends on them. Removal causes the migration to re-run on restart, double-multiplying all balances.
- **Don't proceed if `bun snapshot:verify` exits non-zero.** The genesis loader runs the same check and will abort, but catching it pre-boot saves time.
- **Don't run on a DB that already crossed genesis forks** without wiping first. The pre-flight in the genesis loader detects this and refuses; follow §6.2.
- **Don't change `activationHeight` from null back to 1** in `data/genesis.json`. The migrations run deterministically at block 0; re-enabling the block-N hook would create a double-apply on a fresh boot (the idempotency guard would throw, aborting block 1 on every validator).

---

## 9. Reference

- `forking/restore/PLAN.md` — full implementation plan for the State-Restore-from-Snapshot epic (P0–P7)
- `forking/RUNBOOK_FORK_ACTIVATION.md` — coordinated fork activation runbook (multi-validator, live chain)
- `src/libs/blockchain/genesis/loadSnapshot.ts` — snapshot loader (verifies + streams JSONL)
- `src/libs/blockchain/genesis/applyForksAtGenesis.ts` — genesis-time fork pre-apply orchestrator (P7)
- `src/libs/blockchain/chainGenesis.ts` — genesis builder (snapshot restore branch)
- `src/forks/loadForkConfig.ts` — genesis fork config loader + treasury address validator
- `src/forks/forkGates.ts` — `isForkActive()`: returns false when activationHeight=null (chainBlocks safety)
- `src/forks/migrations/osDenomination.ts` — DEM→OS state migration
- `src/forks/migrations/gasFeeSeparation.ts` — burn + treasury account creation
- `scripts/state-snapshot/verify-snapshot.ts` — standalone snapshot verifier (`bun snapshot:verify`)
- `scripts/state-snapshot/transform.ts` — snapshot transform tool (`bun snapshot:transform`)

---

**Last updated**: 2026-05-19. Branch: `chore/restore`.
