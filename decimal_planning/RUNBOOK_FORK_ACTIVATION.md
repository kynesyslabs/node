# Runbook — Coordinated `osDenomination` Fork Activation (Testnet)

**Audience**: Demos Network testnet validators.
**Scope**: Activating the DEM → OS denomination hard fork at a coordinated block height `N`.
**Status**: Operational. Read end-to-end before fork day.

---

## 1. Overview

This runbook covers the one-time activation of the `osDenomination` hard fork on testnet. The mechanism is a block-height-gated state migration that runs **inside** `Chain.insertBlock`'s atomic TypeORM transaction at `src/libs/blockchain/chainBlocks.ts:218`. At the first block where `block.number === activationHeight`, the migration multiplies every `gcr_main.balance`, every legacy `global_change_registry.details.content.balance`, and every `validators.staked_amount` by `10^9`, then writes a single row to `fork_state`. Idempotency is enforced by reading `fork_state.applied` before running. The hook also fires during historical replay, so fresh validators sync correctly without operator intervention (Run 5 Scenario 3 — confirmed on real Postgres + real peer sync).

For design rationale, see `decimal_planning/SPEC.md` §1 and `decimal_planning/forking_feasibility.md` §3, §5, §8.

---

## 2. Pre-requisites checklist

Run every command on every validator. Do not proceed if any check fails.

### 2.1 Node binary

The binary MUST be built from `decimals` HEAD. The current `decimals` HEAD at the time of this runbook is **`b06f488b30f09c87ce195311e3e58c96fa6e3c3e`**.

```bash
cd /path/to/node
git fetch origin decimals
git checkout decimals
git log -1 --pretty=format:%H
# expected: b06f488b30f09c87ce195311e3e58c96fa6e3c3e (or the agreed activation commit)
bun install
bun run build
echo "build exit code: $?"   # must be 0
```

### 2.2 SDK pin

Anyone signing transactions against the post-fork chain must be on `@kynesyslabs/demosdk@3.1.0` or later. SDK 2.x consumers will fail with signature verification errors at and after block `N`.

```bash
# Validator-side verification (the node itself):
jq -r '.dependencies["@kynesyslabs/demosdk"]' package.json
# expected: 3.1.0  (exact pin per Session 14)
```

### 2.3 Genesis content

```bash
sha256sum data/genesis.json
# Compare against the sha256 that ops will publish in the announcement.
diff data/genesis.json data/genesis.json.rehearsal-backup 2>/dev/null || true
# After the fork-day update, expect a single diff: the new `forks` block.
```

### 2.4 Postgres column types (P5a fix)

`gcr_main.balance` MUST be `numeric` (not `bigint`). If it is still `bigint`, the migration WILL overflow on any account `>= 9_223_372_036` column units (Run 2 evidence) and the chain will halt at `N`.

```bash
psql -h <host> -U demosuser -d <db> -c "\d gcr_main"
# expected output excerpt:
#   pubkey  | text          | not null
#   balance | numeric       | not null  default '0'::numeric
```

### 2.5 TypeORM migrations applied

`synchronize: true` is enabled (`src/model/datasource.ts:82`). The explicit migration files carry the deterministic column-type changes `synchronize` will not retro-apply on existing rows (notably `WidenGcrMainBalanceToNumeric`). Verify all three are recorded:

```bash
psql -h <host> -U demosuser -d <db> -c \
    "SELECT name FROM migrations ORDER BY timestamp;"
# expected (order may vary by timestamp):
#   WidenFeeColumnsToBigint1714521600000
#   CreateForkStateTable1714608000000
#   WidenGcrMainBalanceToNumeric1714694400000
```

(Default TypeORM table name is `migrations` — no `migrationsTableName` override in `src/model/datasource.ts`. Substitute if your operator overrode it.)

### 2.6 `fork_state` empty pre-fork

```bash
psql -h <host> -U demosuser -d <db> -c "SELECT * FROM fork_state;"
# expected: 0 rows.  If applied=t already exists, this DB has already
# crossed the fork — do NOT proceed.
```

### 2.7 Peer connectivity

Each validator must reach every other validator on the consensus port. Use the testnet peerlist from ops:

```bash
for peer in <peer1> <peer2> <peer3>; do
    nc -zv "$peer" <port> 2>&1 | grep -E "succeeded|open"
done
# expected: every line reports succeeded/open.
```

---

## 3. Height selection

- **Block time**: ~20 s (commit `28a161f4` "bump block time to 20s").
- **Recommended lead time**: at least **600 blocks** (~3.3 h) between announcement chain head and chosen activation height. This gives the slowest validator room to update, restart, and reconnect.
- **Do NOT pick `N` < currentHead + 600.**

### 3.1 Read current chain head

Either of:

```bash
# Via RPC (substitute your node's RPC port):
curl -s http://127.0.0.1:53551/rpc/getLastBlock | jq '.response.number'

# Or directly from Postgres:
psql -h <host> -U demosuser -d <db> -c \
    'SELECT MAX("blockNumber") FROM transactions;'
```

Pick `N` = `currentHead + 600` (or higher, rounded to a memorable number).

### 3.2 Genesis edit

Add (or update) the `forks` block in `data/genesis.json`:

```json
"forks": {
    "osDenomination": {
        "activationHeight": <N>,
        "description": "DEM→OS denomination fork"
    }
}
```

Run 5 Scenario 4 confirmed adding `forks` does NOT change the genesis block hash; existing `chain.db` state remains valid (`BlockContent` excludes `forks`).

After editing, sanity-check:

```bash
jq '.forks.osDenomination.activationHeight' data/genesis.json
# expected: the agreed N
sha256sum data/genesis.json
# announce this hash; every validator must see the same hash.
```

---

## 4. Fork-day timeline

Times are relative to the announced activation moment (`T-0` = the wall-clock that block `N` is expected, ≈ `currentHead × 20s` from announcement).

### 4.1 T-24h — announcement

- Ops broadcasts: chosen `N`, expected wall-clock for `T-0`, sha256 of the updated `data/genesis.json`.
- Each validator runs §2 in full and confirms in the validators channel.

### 4.2 T-1h — pull binary, update genesis, restart

For each validator:

```bash
# 1. Stop the node (use your operator's supervisor: systemctl/pm2/docker).
#    Confirm the process is gone:
ps aux | grep -E "tsx|bun.*src/index.ts" | grep -v grep
# expected: no rows.

# 2. Pull the agreed binary.
git fetch origin decimals
git checkout <agreed-commit-hash>
bun install
bun run build

# 3. Replace data/genesis.json with the agreed file. Verify hash:
sha256sum data/genesis.json
# expected: matches the announcement hash exactly.

# 4. Start the node (e.g. `bun run start:bun`, systemctl, docker compose).
```

### 4.3 Restart sequence — verify fork loaded

Tail the log after start. Look for the loader line emitted by `src/forks/loadForkConfig.ts:79`:

```
[FORKS] Loaded fork "osDenomination" with activationHeight=<N>
```

Absent: the genesis update did not take effect. Stop the node, re-check `data/genesis.json`, restart.

If `DEMOS_DISABLE_FORK_MACHINERY` is set, `loadForkConfig.ts:52` instead emits:

```
[FORKS] DEMOS_DISABLE_FORK_MACHINERY set — ignoring genesis `forks` field (rehearsal-only behaviour, do NOT use in prod)
```

This flag is rehearsal-only. **Stop the node and unset the flag** if you see this line on testnet.

Then confirm peers and consensus:

```bash
# Peers reachable:
curl -s http://127.0.0.1:53551/rpc/getNetworkInfo | jq '.response'
# Look for non-empty peers and forks.osDenomination.activationHeight = <N>.

# Block height advancing:
for i in 1 2 3; do
    curl -s http://127.0.0.1:53551/rpc/getLastBlock | jq '.response.number'
    sleep 25
done
# expected: increasing values (block time ~20s).
```

### 4.4 Block N-3 → N+5 observation

From `T-0` minus a few minutes, watch for these events.

#### Logs to grep (strings sourced from `src/forks/migrations/osDenomination.ts`)

```bash
docker compose logs -f node | grep -E '\[forks\]\[osDenomination\]'
```

Expected sequence on each validator at block `N`:

1. `[forks][osDenomination] activation hook firing at block <N>` — emitted by `chainBlocks.ts:240` when the gate condition is true.
2. `[forks][osDenomination] starting state migration at block <N>` — `osDenomination.ts:253`.
3. `[forks][osDenomination] preSumDem=<...> gcrV2Rows=<...> legacyRows=<...> validatorsRows=<...>` — `osDenomination.ts:267`.
4. `[forks][osDenomination] gcr_main migrated (rows=<...>)` — `osDenomination.ts:277`.
5. `[forks][osDenomination] global_change_registry migrated (rows=<...>, capped=<...>, valueLostOs=<...>)` — `osDenomination.ts:329`.
6. `[forks][osDenomination] validators migrated (rows=<...>)` — `osDenomination.ts:360`.
7. `[forks][osDenomination] postSumOs=<...>` — `osDenomination.ts:366`.
8. `[forks][osDenomination] sum invariant verified: postSumOs == preSumDem * 10^9 - valueLostOs` — `osDenomination.ts:382`.
9. `[forks][osDenomination] fork_state row persisted; migration complete` — `osDenomination.ts:429`.

If any of lines 1–9 is missing on a validator after the network has produced block `N+1`, treat that validator as desynced (see §6.1).

#### DB queries (after `N+1` lands, on every validator)

```sql
-- fork_state row written by the migration. Fields per ForkState entity.
SELECT fork_name, applied, applied_at_block, applied_at,
       pre_sum_dem, post_sum_os,
       gcr_v2_row_count, legacy_row_count, validators_row_count,
       capped_count, total_value_lost_os
FROM fork_state WHERE fork_name = 'osDenomination';
-- Expected: applied=t, applied_at_block=<N>, capped_count=0 (assuming
-- no legacy account exceeds the cap; see §5).

-- gcr_main spot-check (pre_sum_dem above aggregates ALL 3 sources):
SELECT SUM(balance) FROM gcr_main;
-- Compare to the gcr_main pre-sum captured at T-1h, ×10^9.
```

#### Block `N` content hash

Run 5 confirmed block `N`'s hash is byte-identical across all 4 rehearsal validators when the migration runs cleanly. Cross-check:

```bash
curl -s http://127.0.0.1:53551/rpc/getBlock?height=<N> | jq -r '.response.hash'
# Compare across all validators; every value must be identical.
```

### 4.5 Post-fork

- SDK 3.1.0 consumers send OS-string wire format and validate.
- SDK 2.x consumers fail with signature verification errors. Confirm ecosystem partners are on 3.1.0 before `T-0`.

---

## 5. "What right looks like" — Run 5 reference values

Empirically-verified values from the rehearsal devnet (4 nodes, `genesis-fork-low.json`, activationHeight=5, 7-account seed of `1e18` per row). Magnitudes on testnet will differ; the relationships hold.

### 5.1 `fork_state` row (Run 5 Scenario 1, all 4 nodes bit-identical except `applied_at`)

```
fork_name           = osDenomination
applied             = t
applied_at_block    = 5
pre_sum_dem         = 7000000000000000000           (= 7 × 10^18)
post_sum_os         = 7000000000000000000000000000  (= 7 × 10^27)
capped_count        = 0
total_value_lost_os = 0
```

### 5.2 Sum invariant

`postSumOs == preSumDem * 10^9 - totalValueLostOs` — held bit-for-bit on every node, every backend, in Run 5 Scenario 7.

### 5.3 Block `N` hash (Run 5 Scenario 1)

```
7600aa2889425bc1f2e8411532e1669551e075bbc1f512ea86504807612d6dcc
```

Rehearsal-seed-specific. The operational property is **all validators agree on the same value at height `N`**.

### 5.4 Cap policy values (Run 5 Scenario 5, `genesis-fork-overflow.json` activationHeight=10)

```
fork_name           = osDenomination
applied             = t
applied_at_block    = 10
capped_count        = 1
total_value_lost_os = 1893520670733108
```

Post-cap legacy balance floors at `LEGACY_NUMBER_CAP = 8_106_479_329_266_892` (= `Math.floor(Number.MAX_SAFE_INTEGER * 0.9)`, `osDenomination.ts:57`). The forensic value `1893520670733108` matches the SQLite unit-test value bit-for-bit.

### 5.5 Migration-complete log line

The exact string emitted at completion (`osDenomination.ts:429`):

```
[forks][osDenomination] fork_state row persisted; migration complete
```

The exact CAP banner (`osDenomination.ts:303`-`309`):

```
[WARNING] [forks][osDenomination] CAP applied: account=<addr> preBalanceDem=<...> postBalanceOs=<...> valueLostOs=<...>
```

---

## 6. Recovery procedures

### 6.1 Validator desync (Run 5 Scenario 2)

**Detection signs**:
- Local head not advancing past `N-1` while peers report `>= N`.
- Logs contain hash-mismatch / signature / "fork" / "migration" / "reject" lines (Run 5 detection regex: `(hash mismatch|invalid block|signature|fork|migration|reject)`).
- `[FORKS] Loaded fork "osDenomination" ...` was missing from the last startup log.

**Fix** (Run 5 Scenario 2 PASS):

```bash
# 1. Stop the node (operator's command).

# 2. Wipe local chain state. Two packaged shortcuts in package.json:
#    line 21  "start:clean": "rm -rf data/chain.db && tsx ..."
#    line 22  "start:purge": "rm -rf .demos_identity && rm -rf data/chain.db && tsx ..."
#    On a testnet validator KEEP your identity — use start:clean.
#    For Postgres-backed deployments, drop and recreate the database:
psql -h <host> -U postgres -c \
    "DROP DATABASE node_db; CREATE DATABASE node_db OWNER demosuser;"

# 3. Verify data/genesis.json matches the agreed sha256.
sha256sum data/genesis.json

# 4. Restart. The node resyncs from peers; the migration hook fires
#    automatically during historical replay (Run 5 Scenario 3 PASS).
bun run start:bun

# 5. Watch the loader line and migration sequence per §4.3 / §4.4.
```

### 6.2 Crash during migration

The migration runs inside the same TypeORM transaction as the block insert (`chainBlocks.ts:219`, design Q2 from LOG Session 11). On crash mid-migration (process kill, OOM, Postgres drop), the transaction rolls back and `fork_state` stays empty. On restart, the gate `isOsDenominationMigrationApplied` returns false, the hook fires, the migration retries to completion. Run 5 Scenario 8 (idempotent restart) PASS confirms this empirically.

On persistent crash-loop, capture the last 200 lines of node log + Postgres log, halt the validator, escalate to ops. Do **not** bypass the migration manually.

### 6.3 Cap policy fires (Run 5 Scenario 5)

If any pre-fork legacy GCR account exceeds the cap (`>= ~9.0M` DEM pre-multiplication), the migration logs the CAP banner from `osDenomination.ts:303`-`309`:

```
[WARNING] [forks][osDenomination] CAP applied: account=<addr> preBalanceDem=<...> postBalanceOs=<...> valueLostOs=<...>
```

and persists `capped_count > 0`, `total_value_lost_os > 0` in `fork_state`. **Intentional** per LOG Session 11 Q1 (fail-loud cap policy). Capped balance floors at `LEGACY_NUMBER_CAP`; lost OS recorded for forensic accounting.

Enumerate capped accounts:

```bash
docker compose logs node | grep "CAP applied:"
```

`capped_count` and `total_value_lost_os` MUST be bit-identical across all validators. If they differ, treat the network as forked and escalate.

### 6.4 Fresh validator post-fork (Run 5 Scenario 3)

A validator joining after `T-0` spins up normally with the agreed binary and `data/genesis.json`. Sync replay processes block `N`; the migration hook fires automatically. No special procedure. Run 5 Scenario 3 (load-bearing) confirmed end-to-end: fresh `node-5` joined at height >30, replayed through `applied_at_block=5`, converged.

---

## 7. Post-fork operational notes

- **SDK 2.x clients fail.** By design. They sign DEM-number wire bytes; post-fork nodes verify OS-string wire bytes. The hash mismatch surfaces as a signature error. Not a node bug.
- **Sub-DEM precision rejection by SDK 3.1.0 talking to pre-fork nodes** — irrelevant post-`T-0`. If seen, the SDK misdetected fork status; refresh the `Demos` instance.
- **`forks.osDenomination` stays in genesis forever.** Preserve the entry. Future forks add new entries; they do not replace this one.
- **`fork_state` row stays in the DB forever.** Audit data. Do not edit manually.

---

## 8. Don't-do list

- **Don't change `data/genesis.json` `balances` mid-run.** Genesis-hash invariance (Run 5 Scenario 4) covers the `forks` field only. Balance changes ARE inside `BlockContent` and will invalidate every existing `chain.db`.
- **Don't enable `DEMOS_DISABLE_FORK_MACHINERY` on testnet/production.** Rehearsal-only flag (`loadForkConfig.ts:42`). With it set, the migration hook never fires and the validator silently desyncs at `N`.
- **Don't skip the genesis update on any validator.** A validator without `forks.osDenomination.activationHeight` never crosses the fork; it hard-fails on every post-fork block from peers.
- **Don't activate at a height too close to current head.** §3 mandates ≥ 600 blocks lead time.
- **Don't roll back the binary post-fork.** The pre-fork binary cannot validate post-fork blocks. Rolling back guarantees desync.
- **Don't delete `fork_state` rows.** Idempotency depends on them. Removal causes the migration to re-run on restart, double-multiplying every balance — unrecoverable doomsday state for that DB. Run 5 Scenario 8 exists to catch this.
- **Don't trust the migration without checking the sum-invariant log.** The line `sum invariant verified: postSumOs == preSumDem * 10^9 - valueLostOs` (`osDenomination.ts:382`) is the single load-bearing proof point. Absence means the migration aborted, the outer transaction rolled back, the block was not persisted, the validator is stuck at `N-1`.

---

**Last updated**: 2026-05-09. Source-branch: `decimals` @ `b06f488b`.

---

## 9. DEM-665 — `gasFeeSeparation` co-activation

> **Source branch**: `claude/gas-fee-separation-aDJK5`. Linear: DEM-665. Mycelium epic #10.
>
> **TL;DR**: a second fork named `gasFeeSeparation` rides on the **same `activationHeight`** as `osDenomination`. One coordinated event, one coordinated chain wipe, two state migrations.

### 9.1 Why bundle

The plan analysis (see Linear DEM-665 design comment) ruled out putting `fee_config` at the top level of `genesis.json` once `chainGenesis.ts:60-73` was verified to hash `block.content.extra`. Any change to the hashed payload changes the genesis hash and breaks every existing `chain.db`. Since `osDenomination` already requires a coordinated wipe, `gasFeeSeparation` rides on the same wipe with zero extra operator friction.

### 9.2 What changes in `data/genesis.json`

Add a second entry under `forks`, at the **same** `activationHeight` as `osDenomination`:

```json
{
  "forks": {
    "osDenomination": { "activationHeight": <N>, "description": "..." },
    "gasFeeSeparation": {
      "activationHeight": <N>,
      "description": "Gas fee separation (DEM-665). ...",
      "treasuryAddress": "0x<ed25519 pubkey, lowercase hex, 64 chars>"
    }
  }
}
```

Validation rules (`src/forks/loadForkConfig.ts:validateGasFeeSeparationEntry`):
- `activationHeight` MUST equal the `osDenomination` activation height (operator policy, not yet auto-enforced; misalignment is a bug).
- `treasuryAddress` MUST match `/^0x[0-9a-f]{64}$/` — strict lowercase, no mixed case (PR #778 G-1/G-4 lesson, myc#6). Mixed case = node refuses to boot with `ForkConfigValidationError`.
- `treasuryAddress` MUST NOT equal `BURN_ADDRESS` (the all-zeros placeholder) when `activationHeight !== null`. Sealing genesis with the placeholder is the most likely operator mistake; the loader fails closed.

### 9.3 Treasury key custody (ops-owned)

The placeholder treasury address shipped in `DEFAULT_FORK_CONFIG.gasFeeSeparation.treasuryAddress` is `0x` + 64 zeros. **Replace it with the real treasury ed25519 pubkey before sealing genesis.** The keypair itself lives outside the node repo — ops owns generation, storage, and rotation custody. A production sealing checklist:

1. Generate a fresh ed25519 keypair (`npm run keygen` or the standalone Demos keymaker).
2. Hex-encode the public key, lowercase, with `0x` prefix.
3. Paste into `genesis.json` under `forks.gasFeeSeparation.treasuryAddress`.
4. Store the private key per the ops key-custody SOP (cold storage / multisig — out of scope for this runbook).

### 9.4 What the activation hook does

`src/libs/blockchain/chainBlocks.ts:235-260` runs `osDenomination` FIRST, then `gasFeeSeparation`. The ordering is documented in code: `osDenomination` scales every existing balance × 10^9 to OS units, then `gasFeeSeparation` creates two fresh **OS-denominated** accounts at balance 0:

- **Burn account** at `0x` + 64 zeros (code constant from `src/forks/migrations/gasFeeSeparation.ts:BURN_ADDRESS`). Spending FROM it is blocked at the GCRBalanceRoutines layer post-fork. Adds to it = burned supply.
- **Treasury account** at the genesis-supplied `treasuryAddress`. Receives the treasury share of every fee distribution. Owned by ops.

Both creations are idempotent: a pre-seeded account at either pubkey is left untouched.

The migration writes a row into `fork_state` with `fork_name = "gasFeeSeparation"`, `applied = true`, `applied_at_block = N`. Idempotency on restart works the same way as `osDenomination` — the hook short-circuits if the row exists.

### 9.5 Pre-flight checklist additions

On top of §2 of this runbook, add:

```bash
# 9.5.1 treasuryAddress format check — strict lowercase 0x+64hex
jq -r '.forks.gasFeeSeparation.treasuryAddress' data/genesis.json \
  | grep -E '^0x[0-9a-f]{64}$' \
  || echo "FAIL: treasuryAddress malformed"

# 9.5.2 same activationHeight as osDenomination
OS_N=$(jq -r '.forks.osDenomination.activationHeight' data/genesis.json)
GFS_N=$(jq -r '.forks.gasFeeSeparation.activationHeight' data/genesis.json)
[ "$OS_N" = "$GFS_N" ] || echo "FAIL: activation heights differ ($OS_N vs $GFS_N)"

# 9.5.3 treasuryAddress is not the placeholder zero address
TA=$(jq -r '.forks.gasFeeSeparation.treasuryAddress' data/genesis.json)
[ "$TA" = "0x$(printf '0%.0s' {1..64})" ] && echo "FAIL: still on placeholder treasury"
```

### 9.6 Post-activation verification

After block `N` is final on every validator:

```bash
# Burn account exists with balance 0
curl -s http://localhost:8079/getAddressInfo \
  -X POST -H 'Content-Type: application/json' \
  -d '{"address":"0x'"$(printf '0%.0s' {1..64})"'"}' \
  | jq '.balance'   # expect "0"

# Treasury account exists with balance 0 (pre-traffic)
TA=$(jq -r '.forks.gasFeeSeparation.treasuryAddress' data/genesis.json)
curl -s http://localhost:8079/getAddressInfo \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"address\":\"$TA\"}" \
  | jq '.balance'   # expect "0"

# fork_state row persisted
psql -c "SELECT fork_name, applied, applied_at_block \
         FROM fork_state \
         WHERE fork_name = 'gasFeeSeparation'"
# expect: gasFeeSeparation | t | N
```

After the first post-fork transaction lands, the burn/treasury balances should move per the distribution percentages governed by `NetworkParameters` (see §9.8).

### 9.7 Rollback

The activation hook runs inside the same TypeORM transaction as the block insert (`chainBlocks.ts:dataSource.transaction(...)`). If the `gasFeeSeparation` migration throws, the outer transaction rolls back and the activation block is not persisted — same atomicity contract as `osDenomination`. No special node-level rollback procedure; the existing osDenomination one applies verbatim.

### 9.8 Governable percentages (DEM-665 P13)

Distribution percentages live in `NetworkParameters`, **not** in the fork payload. Treasury address and burn address are immutable fork-level constants; the per-component splits (50/50, 25/75, 25/50/25 by default) are governance-mutable from day 1 with tighter safety bounds:

- Per-proposal change cap: **±10%** (vs the ±50% default).
- Per-key absolute bounds: `[0, 100]` on every `*Pct` field.
- Cross-key invariant: each distribution group's percentages must sum to **exactly 100** on the merged (current ⊕ proposed) view.

A proposal touching only `networkFeeBurnPct` without also adjusting `networkFeeTreasuryPct` is rejected because the merged sum != 100. Proposers must move both keys in the same proposal so the invariant holds.

### 9.9 Don't-do list additions (gasFeeSeparation-specific)

- **Don't seal genesis with the placeholder treasury** (`0x` + 64 zeros). The loader refuses to boot. The check exists precisely to catch this operator mistake — overriding it is unsafe.
- **Don't desync the two `activationHeight` values** between `osDenomination` and `gasFeeSeparation`. The chainBlocks hook runs them sequentially in the same block; running them on different heights means osDenomination scales balances at one height and gasFeeSeparation creates OS-denominated accounts at another, which is a recoverable but pointless state confusion.
- **Don't manually edit the burn or treasury rows in `gcr_main`.** Burn balance is reachable only via `add` edits (and rollback inversions of those). Treasury balance is governance-mutated indirectly through fee distribution. Manual SQL edits are not consensus-replayed and will desync the validator.
- **Don't propose to change every distribution percentage in one go.** Even though the bounds permit ±10% per proposal, large simultaneous shifts give observers no window to react. A multi-cycle gradient is safer governance hygiene.

---

**DEM-665 status**: design and implementation merged. Source-branch: `claude/gas-fee-separation-aDJK5`. SDK companion: 4.0.0-rc.1 (pending publish; user owns).
