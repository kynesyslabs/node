# Runbook — Coordinated Combined Fork Activation

**Audience**: Demos Network validators.
**Scope**: Single coordinated activation of the two bundled hard forks `osDenomination` (DEM → OS denomination, ×10⁹) AND `gasFeeSeparation` (DEM-665 — three-component fee + burn/treasury/rpc-operator distribution) at the same `activationHeight`.
**Status**: Operational. Read end-to-end before fork day.

---

## 0. TL;DR

```
┌───────────────────────────────────────────────────────────────────┐
│  Fork bundle: osDenomination + gasFeeSeparation                   │
│  Trigger:     same activationHeight N in data/genesis.json        │
│  Side-effect: balances × 10⁹, burn + treasury accounts created    │
│  Rollback:    impossible after N is finalised — plan accordingly  │
│  SDK floor:   @kynesyslabs/demosdk@4.0.0 at and after block N     │
└───────────────────────────────────────────────────────────────────┘
```

Until you set a non-null `activationHeight` in `data/genesis.json` and operators restart with the new genesis, **nothing fires**. The hooks are gated by `isForkActive(name, blockHeight)` which returns `false` when `activationHeight === null`.

---

## 1. Architecture (one-screen overview)

Both forks plug into the same machinery:

| Layer | osDenomination | gasFeeSeparation |
|---|---|---|
| Config registry | `src/forks/forkConfig.ts` `OsDenominationConfig` | `src/forks/forkConfig.ts` `GasFeeSeparationConfig` |
| Genesis loader | `loadForkConfigFromGenesis()` — validates `activationHeight` | same, plus strict-lowercase 64-hex `treasuryAddress` + placeholder-zero rejection |
| Activation hook | `chainBlocks.ts:235-242` calls `runOsDenominationMigration` | `chainBlocks.ts:250-270` calls `runGasFeeSeparationMigration` (FIRES AFTER osDenomination) |
| State migration | `src/forks/migrations/osDenomination.ts` — `gcr_main.balance ×= 10⁹`, legacy GCR row-by-row (cap policy), `validators.staked_amount ×= 10⁹` | `src/forks/migrations/gasFeeSeparation.ts` — create burn account `0x000…0` + treasury account at fork-payload pubkey, both balance 0 |
| Idempotency | `fork_state.applied = true` row per fork name | same |
| Atomicity | Whole migration runs inside the block-insert TypeORM transaction; rollback rolls back the block | same |

Both migrations run inside the **same** transaction at block `N`. If either throws, the outer transaction rolls back and the block is not persisted; the validator stays at `N-1` and retries on restart.

---

## 2. Pre-flight checklist (run on every validator)

Every command must succeed before that validator is fork-ready.

### 2.1 Node binary

Build from `stabilisation` HEAD (or whatever commit ops announces as the activation commit). Verify:

```bash
cd /path/to/node
git fetch origin stabilisation
git checkout <agreed-commit-hash>
git log -1 --pretty=format:%H
bun install
bun run build
echo "build exit code: $?"   # must be 0
```

### 2.2 SDK pin

```bash
jq -r '.dependencies["@kynesyslabs/demosdk"]' package.json
# expected: 4.0.0  (or whatever the agreed pin is in the announcement)
```

Anyone signing transactions at and after block `N` MUST be on `@kynesyslabs/demosdk@4.0.0`. SDK 2.x and 3.x clients fail at the fork boundary (signature hash mismatch under the post-fork wire format).

### 2.3 Genesis content

```bash
jq '.forks' data/genesis.json
# expected (matches the published sha256):
# {
#   "osDenomination":   { "activationHeight": N, "description": "..." },
#   "gasFeeSeparation": { "activationHeight": N, "description": "...",
#                         "treasuryAddress": "0x<64 lowercase hex>" }
# }

sha256sum data/genesis.json
# announce this hash; every validator must see the same hash.
```

Strict checks:

```bash
# treasuryAddress format — lowercase, 0x + 64 hex
jq -r '.forks.gasFeeSeparation.treasuryAddress' data/genesis.json \
  | grep -E '^0x[0-9a-f]{64}$' \
  || { echo "FAIL: treasuryAddress malformed"; exit 1; }

# activationHeight alignment
OS_N=$(jq -r '.forks.osDenomination.activationHeight' data/genesis.json)
GFS_N=$(jq -r '.forks.gasFeeSeparation.activationHeight' data/genesis.json)
[ "$OS_N" = "$GFS_N" ] || { echo "FAIL: heights diverge ($OS_N vs $GFS_N)"; exit 1; }

# treasuryAddress is NOT the placeholder zero (loader also catches this)
TA=$(jq -r '.forks.gasFeeSeparation.treasuryAddress' data/genesis.json)
ZERO="0x$(printf '0%.0s' {1..64})"
[ "$TA" = "$ZERO" ] && { echo "FAIL: still on placeholder treasury"; exit 1; }
```

### 2.4 Postgres column types

`gcr_main.balance` MUST be `numeric` (NOT `bigint`). If `bigint`, the migration overflows on any account ≥ ~9.2 × 10⁹ OS units.

```bash
psql -h <host> -U demosuser -d <db> -c "\d gcr_main" | grep balance
# expected: balance | numeric | not null default '0'::numeric
```

### 2.5 TypeORM migrations applied

```bash
psql -h <host> -U demosuser -d <db> -c \
    "SELECT name FROM migrations ORDER BY timestamp;"
# expected (order may vary):
#   WidenFeeColumnsToBigint1714521600000
#   CreateForkStateTable1714608000000
#   WidenGcrMainBalanceToNumeric1714694400000
#   AddRpcAddressToTransactions1714780800000
```

### 2.6 `fork_state` empty pre-fork

```bash
psql -h <host> -U demosuser -d <db> -c "SELECT fork_name, applied FROM fork_state;"
# expected: 0 rows. If applied=t already exists, this DB has crossed
# the fork — do NOT proceed.
```

### 2.7 `DEMOS_DISABLE_FORK_MACHINERY` is UNSET

```bash
echo "${DEMOS_DISABLE_FORK_MACHINERY:-unset}"
# expected: unset (or "false" / "0" / empty)
```

This is a rehearsal-only flag. With it set, the fork machinery short-circuits and the validator silently desyncs at `N`. The node has a hard guard against this in `NODE_ENV=production` (`loadForkConfig.ts:isForkMachineryDisabled`), but verify anyway.

### 2.8 Peer connectivity

```bash
for peer in <peer1> <peer2> <peer3>; do
    nc -zv "$peer" <port> 2>&1 | grep -E "succeeded|open"
done
# every line must succeed.
```

---

## 3. Height selection

- **Block time**: ~20 s (commit `28a161f4`).
- **Minimum lead**: **600 blocks** (≈ 3.3 h) between announcement chain head and chosen `N`. Gives the slowest validator room to update + restart + reconnect.
- **Treasury address**: pick the real ed25519 pubkey ops will hold. The placeholder `0x` + 64 zeros MUST be replaced before genesis is sealed.

### 3.1 Read current head

```bash
curl -s http://127.0.0.1:53551/rpc/getLastBlock | jq '.response.number'
# or:
psql -h <host> -U demosuser -d <db> -c 'SELECT MAX("blockNumber") FROM transactions;'
```

### 3.2 Seal the genesis

Update `data/genesis.json` `forks` block (both entries at the same `N`):

```json
"forks": {
    "osDenomination": {
        "activationHeight": <N>,
        "description": "DEM→OS denomination fork"
    },
    "gasFeeSeparation": {
        "activationHeight": <N>,
        "description": "DEM-665 — three-component gas fee separation",
        "treasuryAddress": "0x<ops-controlled ed25519 pubkey, lowercase hex>"
    }
}
```

Run the §2.3 strict checks. Announce `sha256sum data/genesis.json` to all validators.

---

## 4. Fork-day timeline

Times are wall-clock relative to expected `T-0` (= announcement-head + (N - announcement-head) × 20s).

### 4.1 T-24 h — announcement

Ops broadcasts:
- chosen `N`
- expected `T-0` wall-clock
- `sha256sum data/genesis.json` of the sealed genesis
- target SDK version (`4.0.0`) for ecosystem partners

Every validator runs §2 in full and confirms in the validator channel.

### 4.2 T-1 h — update + restart

```bash
# 1. Stop the node cleanly via your supervisor (systemctl/pm2/docker compose stop).
ps aux | grep -E "tsx|bun.*src/index.ts" | grep -v grep
# expected: no rows.

# 2. Pull the agreed commit + rebuild.
git fetch origin stabilisation
git checkout <agreed-commit-hash>
bun install
bun run build

# 3. Replace data/genesis.json with the agreed file.
sha256sum data/genesis.json   # MUST match the announcement.

# 4. Restart (e.g. bun run start:bun, systemctl, docker compose up -d).
```

### 4.3 Verify the loader saw both forks

Tail the log after start. Look for **two** loader lines from `src/forks/loadForkConfig.ts`:

```
[FORKS] Loaded fork "osDenomination" with activationHeight=<N>
[FORKS] Loaded fork "gasFeeSeparation" with activationHeight=<N>
```

If either is absent, stop the node, re-check `data/genesis.json`, restart. Do not proceed without both lines.

If you see:

```
[FORKS] DEMOS_DISABLE_FORK_MACHINERY set — ignoring genesis `forks` field
```

stop the node, unset the flag, restart. This flag is rehearsal-only.

### 4.4 Block `N-3` → `N+5` observation

From `T-0` minus a few minutes, watch the activation sequence on every validator.

```bash
docker compose logs -f node | grep -E '\[forks\]\['
```

Expected order at block `N` (osDenomination runs FIRST, then gasFeeSeparation):

**osDenomination block (lines from `osDenomination.ts`)**:
1. `[forks][osDenomination] activation hook firing at block <N>`
2. `[forks][osDenomination] starting state migration at block <N>`
3. `[forks][osDenomination] preSumDem=<...> gcrV2Rows=<...> legacyRows=<...> validatorsRows=<...>`
4. `[forks][osDenomination] gcr_main migrated (rows=<...>)`
5. `[forks][osDenomination] global_change_registry migrated (rows=<...>, capped=<...>, valueLostOs=<...>)`
6. `[forks][osDenomination] validators migrated (rows=<...>)`
7. `[forks][osDenomination] postSumOs=<...>`
8. `[forks][osDenomination] sum invariant verified: postSumOs == preSumDem * 10^9 - valueLostOs`  ← **load-bearing**
9. `[forks][osDenomination] fork_state row persisted; migration complete`

**gasFeeSeparation block (lines from `gasFeeSeparation.ts`)**:
10. `[forks][gasFeeSeparation] activation hook firing at block <N>`
11. `[forks][gasFeeSeparation] starting state migration at block <N>`
12. `[forks][gasFeeSeparation] created account at 0x000…0 with balance=0`
13. `[forks][gasFeeSeparation] created account at <treasuryAddress> with balance=0`
14. `[forks][gasFeeSeparation] fork_state row persisted; burn=0x000…0, treasury=<...>, burnCreated=true, treasuryCreated=true`

Absence of any of these on a validator after the network produces `N+1` ⇒ that validator is desynced. See §6.1.

### 4.5 Post-activation checks (after `N+1` lands)

```sql
-- Both fork_state rows present and converged.
SELECT fork_name, applied, applied_at_block, applied_at,
       pre_sum_dem, post_sum_os, capped_count, total_value_lost_os
FROM fork_state ORDER BY fork_name;
-- Expected: 2 rows, applied=t for both, applied_at_block=<N>.
-- osDenomination row carries the sum-invariant values; gasFeeSeparation
-- row carries only fork_name/applied/applied_at_block/applied_at.

-- Burn + treasury accounts exist at balance 0.
SELECT pubkey, balance::text FROM gcr_main
  WHERE pubkey IN (
    '0x0000000000000000000000000000000000000000000000000000000000000000',
    '<treasuryAddress>'
  );
-- expected: 2 rows, balance = "0" each.
```

```bash
# Block N hash convergence across validators.
for p in 53551 53553 53555 53557; do
    curl -s http://127.0.0.1:$p/rpc/getBlock?height=<N> \
      | jq -r '.response.hash'
done
# every value must be identical.
```

### 4.6 Liveness

```bash
for i in 1 2 3; do
    curl -s http://127.0.0.1:53551/rpc/getLastBlock | jq '.response.number'
    sleep 25
done
# expected: monotonically increasing (block time ~20s).
```

---

## 5. "What right looks like" — rehearsal reference values

Empirically verified against the 4-node Postgres devnet (Run 5 + Run 6 + Run 8, `forking/REHEARSAL_RESULTS.md`).

### 5.1 osDenomination `fork_state` (7-account seed, 1e18 each)

```
fork_name           = osDenomination
applied             = t
applied_at_block    = <N>
pre_sum_dem         = 7000000000000000000           (= 7 × 10^18)
post_sum_os         = 7000000000000000000000000000  (= 7 × 10^27)
capped_count        = 0
total_value_lost_os = 0
```

### 5.2 gasFeeSeparation `fork_state` (combined fork rehearsal)

```
fork_name        = gasFeeSeparation
applied          = t
applied_at_block = <N>
(other columns NULL — this migration doesn't touch balances)
```

### 5.3 Burn + treasury accounts

```
pubkey                                                              balance
0x0000000000000000000000000000000000000000000000000000000000000000  0
<treasuryAddress>                                                   0
```

### 5.4 Cap policy (only fires if any pre-fork legacy GCR account ≥ ~9 M DEM)

```
fork_name           = osDenomination
capped_count        = >0
total_value_lost_os = >0
```

with log lines:

```
[WARNING] [forks][osDenomination] CAP applied: account=<addr> preBalanceDem=<...> postBalanceOs=<...> valueLostOs=<...>
```

Capped balance floors at `LEGACY_NUMBER_CAP = 8_106_479_329_266_892` (= `Math.floor(Number.MAX_SAFE_INTEGER * 0.9)`). Intentional fail-loud policy.

---

## 6. Recovery procedures

### 6.1 Validator desync

**Detection signs**:
- Local head stuck at `N-1` while peers report `≥ N`.
- Logs contain hash-mismatch / signature / fork / migration / reject lines.
- One or both `[FORKS] Loaded fork ...` lines missing from the last startup log.

**Fix**:

```bash
# 1. Stop the node.

# 2. Wipe local chain state.
psql -h <host> -U postgres -c \
    "DROP DATABASE node_db; CREATE DATABASE node_db OWNER demosuser;"

# 3. Confirm data/genesis.json matches the announced sha256.
sha256sum data/genesis.json

# 4. Restart. The node resyncs from peers; both migrations fire
#    automatically during historical replay (Run 5 Scenario 3).
bun run start:bun

# 5. Watch §4.3 + §4.4 logs.
```

### 6.2 Crash during migration

Both migrations run inside the block-insert TypeORM transaction. On a mid-migration crash (kill, OOM, Postgres drop), the transaction rolls back; `fork_state` stays empty for both forks; on restart the gates return false; the hooks fire again and run to completion. Run 5 Scenario 8 confirmed this for osDenomination; the same atomicity applies to gasFeeSeparation by construction.

On persistent crash-loop: capture last 200 lines of node + Postgres logs, halt the validator, escalate. **Do NOT bypass migrations manually.**

### 6.3 Cap policy fires

If any pre-fork legacy GCR account exceeds the cap, the migration logs the CAP banner and persists `capped_count > 0`. **Intentional**. `capped_count` and `total_value_lost_os` MUST be bit-identical across all validators. If they differ, the network is forked — escalate.

### 6.4 Fresh validator post-fork

A validator joining after `T-0` spins up with the agreed binary + sealed `data/genesis.json`. Sync replay processes block `N`; both hooks fire automatically. No special procedure — Run 5 Scenario 3 confirms end-to-end.

---

## 7. Post-fork operational notes

- **SDK 2.x and 3.x clients fail.** By design. They sign DEM-number wire bytes (2.x) or omit `rpc_address` (3.x); post-fork nodes verify OS-string bytes WITH `rpc_address`. Hash mismatch surfaces as signature error. Not a node bug.
- **`forks.osDenomination` and `forks.gasFeeSeparation` stay in genesis forever.** Preserve both entries. Future forks add new entries; they do not replace existing ones.
- **Both `fork_state` rows stay in the DB forever.** Audit data. Do not edit manually.
- **Burn address `0x000…0` is consensus-fixed.** Spending FROM it is refused by `GCRBalanceRoutines.apply()` post-fork (rollback inversions are allowed — fee reversibility).
- **Treasury address is fork-payload-immutable** for the chain's life. Rotation = de facto new hard fork. Distribution percentages, by contrast, ARE governance-mutable from day 1 (see §8).

---

## 8. Governance — mutable distribution percentages

The per-component fee distribution lives in `NetworkParameters` and is governable from day 1 via `networkUpgrade` proposals:

| Group | Keys | Defaults |
|---|---|---|
| `network_fee` | `networkFeeBurnPct`, `networkFeeTreasuryPct` | 50 / 50 |
| `additional_fee` | `additionalFeeBurnPct`, `additionalFeeTreasuryPct` | 25 / 75 |
| `special_ops` (TLSN) | `specialOpsBurnPct`, `specialOpsTreasuryPct`, `specialOpsRpcPct` | 25 / 25 / 50 |
| Scalar amount | `additionalFee` | 0 |

Safety bounds (`src/features/networkUpgrade/safetyBounds.ts`):
- Per-key cap: ±10% per proposal (vs ±50% default for other params).
- Per-key absolute bounds: `[0, 100]` for `*Pct`, `[0, 5000]` for `additionalFee`.
- **Cross-key sum-100 invariant** on the merged (current ⊕ proposed) view — within each group the percentages MUST equal exactly 100.

A proposal touching only one percentage key (e.g. `networkFeeBurnPct` 50 → 55) fails sum-100 because the untouched sibling stays at 50 → merged total 105. Move both keys in the same proposal so the merged view sums to 100.

Multi-cycle gradients are safer governance hygiene than one large shift, even when the ±10% cap permits it.

---

## 9. Don't-do list

- **Don't change `data/genesis.json` `balances` mid-run.** Balances are inside `BlockContent` and will invalidate every existing `chain.db`. Only the `forks` block additions are hash-invariant.
- **Don't enable `DEMOS_DISABLE_FORK_MACHINERY` on testnet/production.** Rehearsal-only flag. With it set, neither migration fires and the validator silently desyncs at `N`. Production has a hard guard but verify anyway.
- **Don't skip the genesis update on any validator.** A validator without the two `activationHeight` values never crosses the fork; it hard-fails on every post-fork block from peers.
- **Don't activate at a height too close to current head.** Minimum 600 blocks lead time.
- **Don't roll back the binary post-fork.** The pre-fork binary cannot validate post-fork blocks. Rolling back guarantees desync.
- **Don't delete `fork_state` rows.** Idempotency depends on them. Removal causes a migration to re-run on restart, double-multiplying balances or doubly-creating burn/treasury — unrecoverable doomsday for that DB.
- **Don't trust either migration without checking the load-bearing log lines.** For osDenomination: `sum invariant verified: postSumOs == preSumDem * 10^9 - valueLostOs`. For gasFeeSeparation: `fork_state row persisted; burn=…, treasury=…`. Absence means the migration aborted; the outer transaction rolled back; the block was not persisted; the validator is stuck at `N-1`.
- **Don't seal genesis with the placeholder treasury** (`0x` + 64 zeros). The loader refuses to boot when `activationHeight !== null` and `treasuryAddress === BURN_ADDRESS`. The check exists for exactly this operator mistake.
- **Don't desync the two `activationHeight` values.** The chainBlocks hook runs them sequentially in the same block; misaligned heights ⇒ osDenomination scales balances at one height and gasFeeSeparation creates fresh-zero accounts at another, producing a recoverable but pointless state confusion.
- **Don't manually edit the burn or treasury rows in `gcr_main`.** Burn balance is reachable only via `add` edits (and rollback inversions of those). Treasury balance is governance-mutated indirectly through fee distribution. Manual SQL edits are not consensus-replayed and desync the validator.
- **Don't propose to change every distribution percentage in one go.** ±10% per proposal permits it, but large simultaneous shifts give observers no window to react. Prefer multi-cycle gradients.

---

## 10. References

- `src/forks/forkConfig.ts` — fork registry + per-fork type definitions
- `src/forks/loadForkConfig.ts` — genesis loader + per-fork validation
- `src/forks/burnAddress.ts` — burn-address constant (single source of truth)
- `src/forks/migrations/osDenomination.ts` — DEM→OS state migration
- `src/forks/migrations/gasFeeSeparation.ts` — burn + treasury account creation
- `src/libs/blockchain/chainBlocks.ts:225-275` — activation hooks (ordered: osDenomination first, then gasFeeSeparation)
- `src/libs/blockchain/routines/calculateCurrentGas.ts` — fee breakdown
- `src/libs/blockchain/gcr/gcr_routines/feeDistribution.ts` — per-component edit generator
- `src/libs/blockchain/routines/applyGasFeeSeparation.ts` — confirmTransaction wiring
- `src/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines.ts` — burn-address spend prevention
- `src/features/networkUpgrade/constants.ts` — governable keys + bounds
- `src/features/networkUpgrade/safetyBounds.ts` — sum-100 invariant + tighter cap
- `forking/gas_separation/PLAN.md` — as-shipped DEM-665 plan with file:line map
- `forking/decimal_planning/SPEC.md` — DEM→OS denomination design rationale
- `forking/REHEARSAL_RESULTS.md` — 8 rehearsal runs on real Postgres

---

**Last updated**: 2026-05-12. Branch: `claude/gas-fee-separation-aDJK5` (post-DEM-665).
