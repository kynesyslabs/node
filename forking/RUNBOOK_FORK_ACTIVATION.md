# Runbook — Coordinated Combined Fork Activation

**Audience**: Demos Network validators.
**Scope**: Single coordinated activation of the two bundled hard forks `osDenomination` (DEM → OS denomination, ×10⁹) AND `gasFeeSeparation` (DEM-665 — three-component fee + burn/treasury/rpc-operator distribution) at the same `activationHeight`.
**Status**: Operational. Read end-to-end before fork day.

> **Prerequisite — chain-wipe fork only**: When this runbook is executed against a freshly-wiped chain (rather than activating in-place), operators must first restore historical state via the snapshot-restore flow. See [`forking/restore/RUNBOOK.md`](restore/RUNBOOK.md) and [`forking/restore/PLAN.md`](restore/PLAN.md). The restore is automatic on the first `./run` against an empty PG when `data/snapshot/` is present.
>
> **Production environments**: set `DEMOS_REQUIRE_VALIDATORS=true` in the node's env. As of epic #17, `getShard()` enforces the genesis-baked validator set at the consensus layer. With the env var set, a node booting against an empty/non-active validators table refuses to operate (loud error) instead of silently falling back to permissive online-peer-only shard selection.

---

## 0. TL;DR

```text
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

The RPC probes in §3.1, §4.5, §4.6 and §6.1 need jq 1.6 or later (`jq --version`): they use `utf8bytelength`, so an older jq fails every probe, which looks like an unreachable or desynced peer.

### 2.1 Node runtime

Use the activation commit announced by ops. For a fresh installation, complete [INSTALL.md](../INSTALL.md) first. Bare-metal/Bun-only deployments run TypeScript directly (`start:bun`); there is no `build` script. Install dependencies and verify the agreed commit:

```bash
cd /path/to/node
git fetch origin stabilisation
git checkout <agreed-commit-hash>
git log -1 --pretty=format:%H
bun install --frozen-lockfile
```

Bun-only hosts can run these checks. On bare metal, build the sidecar before restarting only when gossip is on. §4.2 asks Bun, from the node checkout, for the `GOSSIP_ENABLED` value the node will see (a shell value wins over `.env`): unset or empty is on, `true` or `1` is on, and any other value is off. A Bun-only node with `GOSSIP_ENABLED=false` skips the build. Gossip-enabled startup needs Node.js ≥20; `./run` also builds the sidecar itself when needed.

For a wrapper-started local Compose build, check out the agreed commit and build the image instead (no host Bun required):

```bash
./scripts/docker-run build node
```

For a released image, follow [INSTALL.md → Run a released image](../INSTALL.md#run-a-released-image-validators), selecting the release ops announced. Host dependency installation does not update a container's code. Choose the Compose path used to start this node, and keep it for every command below:

- **Wrapper start** (`./run --docker` or `./scripts/docker-run`): use the `./scripts/docker-run` examples with the same instance flags as the running instance (such as `--port 53560 --db 5433`, `--devnet`, or `--proxy`) and env file; never `--clean` or `--rebuild`, which wipe volumes or rebuild the image. `--port 53560` selects project `demos-53560`, its ports and volumes. A stack started with `./run --docker` or `./scripts/docker-run`, or shown as a `demos-<port>`/`demos-devnet` project in `docker compose ls`, always uses this path because the wrapper never loads the override.
- **Raw Compose start** (`docker compose`, including the INSTALL.md released-image path): run the raw `docker compose` examples from the checkout with the same `.env`, `COMPOSE_FILE`, and Compose options used at startup. Compose loads `docker-compose.override.yml` automatically. The wrapper explicitly selects `docker-compose.yml` and would omit that override. An override file or `COMPOSE_FILE` decides the path only when the start method is unknown. Check `docker compose ls` for the running project; a wrapper `--port 53560` instance uses `demos-53560`.

For a local source build on the raw path, use `GIT_COMMIT=$(git rev-parse HEAD) docker compose build node` so the image records its source commit. For a released image, pull the agreed release as in INSTALL.md.

### 2.2 SDK pin

```bash
jq -r '.dependencies["@kynesyslabs/demosdk"]' package.json
# expected: 4.0.0  (or whatever the agreed pin is in the announcement)
```

Anyone signing transactions at and after block `N` MUST be on `@kynesyslabs/demosdk@4.0.0`. SDK 2.x and 3.x clients fail at the fork boundary (signature hash mismatch under the post-fork wire format).

### 2.3 Genesis content

For the INSTALL.md read-only bind mount, first run `export GENESIS_FILE=mainnet/genesis.json` (or use the actual host source shown by `docker compose config`). For any other Compose start, first run `export GENESIS_FILE=data/genesis.json`; this is the host file §4.2 copies into the writable volume. On bare metal, first run `unset GENESIS_FILE`, then resolve the path with Bun from the node checkout so it reads the shell and `.env` as the node does. Run it in the shell or service environment that starts the node. A check in another shell does not prove what the running node received. If a supervisor (systemd `Environment=`, pm2) sets `DEMOS_GENESIS_FILE`, use its value: export it in this shell first, because a shell value wins over `.env`. Keep the selected path for all §2.3 checks. This selected host file is the one §3.2 edits, §4.1 announces and §4.2 checks; keep this shell open (or select it again the same way) for those steps.

```bash
GENESIS_FILE=${GENESIS_FILE:-$(bun -e 'import { genesisFilePath } from "./src/libs/blockchain/genesis/genesisFile"; console.log(genesisFilePath())')}
jq '.forks' "$GENESIS_FILE"
# expected (matches the published sha256):
# {
#   "osDenomination":   { "activationHeight": N, "description": "..." },
#   "gasFeeSeparation": { "activationHeight": N, "description": "...",
#                         "treasuryAddress": "0x<64 lowercase hex>" }
# }

sha256sum "$GENESIS_FILE"
# Every setup: §3.2 announces this hash; every validator's selected file must show the same hash.
```

For Compose, check the file the node reads. Use the matching startup path. Wrapper start:

```bash
./scripts/docker-run run --rm --no-deps node sh -c 'sha256sum "${DEMOS_GENESIS_FILE:-data/genesis.json}"'
```

Raw Compose start (loads `docker-compose.override.yml` or `COMPOSE_FILE`):

```bash
docker compose run --rm --no-deps node sh -c 'sha256sum "${DEMOS_GENESIS_FILE:-data/genesis.json}"'
```

With a writable volume this shows the old file until the §4.2 copy; it must match the announcement only after §4.2. With the INSTALL.md read-only mount it shows the bind-mounted host file, so it must equal the `sha256sum "$GENESIS_FILE"` hash above.

Strict checks:

```bash
# treasuryAddress format — lowercase, 0x + 64 hex
jq -r '.forks.gasFeeSeparation.treasuryAddress' "$GENESIS_FILE" \
  | grep -qE '^0x[0-9a-f]{64}$' \
  || { echo "FAIL: treasuryAddress malformed"; exit 1; }

# activationHeight alignment
jq -e '(.forks.osDenomination | has("activationHeight")) and (.forks.gasFeeSeparation | has("activationHeight"))' "$GENESIS_FILE" >/dev/null || { echo "FAIL: activationHeight missing"; exit 1; }
OS_N=$(jq -r '.forks.osDenomination.activationHeight' "$GENESIS_FILE")
GFS_N=$(jq -r '.forks.gasFeeSeparation.activationHeight' "$GENESIS_FILE")
[ "$OS_N" = "$GFS_N" ] || { echo "FAIL: heights diverge ($OS_N vs $GFS_N)"; exit 1; }

# treasuryAddress is NOT the placeholder zero (loader also catches this)
TA=$(jq -r '.forks.gasFeeSeparation.treasuryAddress' "$GENESIS_FILE")
ZERO="0x$(printf '0%.0s' {1..64})"
[ "$TA" != "$ZERO" ] || { echo "FAIL: still on placeholder treasury"; exit 1; }
```

### 2.4 Postgres column types

The database commands use the Compose container's `POSTGRES_USER`/`POSTGRES_DB` (from `PG_USER`/`PG_DATABASE`, defaults `demosuser`/`demos`). Use the command for the chosen startup path in §2.4–2.6. For bare-metal `./run`, stopping the node also stops its `postgres_<PG_PORT>` container: start Postgres alone and wait for readiness as in the [database migration procedure](../docs/runbooks/database-migrations.md#procedure), then run the same SQL inside that container with `docker exec` and its configured database role. For external Postgres, use host `psql` with your configured `PG_HOST`, `PG_PORT`, `PG_USER`, and `PG_DATABASE`. Compose does not publish Postgres by default.

`gcr_main.balance` MUST be `numeric` (NOT `bigint`). If `bigint`, the migration overflows on any account ≥ ~9.2 × 10⁹ OS units. Wrapper start:

```bash
./scripts/docker-run exec -T postgres sh -c \
  'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d gcr_main"' | grep balance
```

Raw Compose start:

```bash
docker compose exec -T postgres sh -c \
  'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "\d gcr_main"' | grep balance
# expected: balance | numeric(38,0) | not null default '0'::numeric
```

### 2.5 Fork schema present

`BaselineSchema1779062400000` creates `fork_state` and defines `gcr_main.balance` as `numeric(38,0)` at this head. Check the required schema directly; §2.4 also displays the balance type. A missing table or a balance type other than `numeric` means the database needs its normal TypeORM migrations before fork day.

Wrapper start:

```bash
./scripts/docker-run exec -T postgres sh -c \
  'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT fork_name FROM fork_state;"'
```

Raw Compose start:

```bash
docker compose exec -T postgres sh -c \
  'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT fork_name FROM fork_state;"'
# expected: 0 rows before the fork; the query must succeed.
```

### 2.6 `fork_state` empty pre-fork

Wrapper start:

```bash
./scripts/docker-run exec -T postgres sh -c \
  'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT fork_name, applied FROM fork_state;"'
```

Raw Compose start:

```bash
docker compose exec -T postgres sh -c \
  'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT fork_name, applied FROM fork_state;"'
# expected: 0 rows. If applied=t already exists, this DB has crossed
# the fork — do NOT proceed.
```

### 2.7 `DEMOS_DISABLE_FORK_MACHINERY` is UNSET

Each check applies the node's rule (trimmed and lower-cased, `true`, `1` or `yes` means disabled). It prints `fork machinery enabled` and exits 0 only when the fork machinery is enabled. It prints `fork machinery DISABLED` and exits 1 when the flag is set, and the Compose checks also exit nonzero when the node container is stopped or missing.

Bare metal, from the node checkout (Bun reads the shell and `.env` the way the node does):

```bash
bun -e 'const v=(process.env.DEMOS_DISABLE_FORK_MACHINERY??"").trim().toLowerCase(); const off=v==="true"||v==="1"||v==="yes"; console.log(off?"fork machinery DISABLED":"fork machinery enabled"); process.exit(off?1:0)'
# expected: fork machinery enabled (exit 0)
```

Wrapper start, inside the running node container:

```bash
./scripts/docker-run exec -T node bun -e 'const v=(process.env.DEMOS_DISABLE_FORK_MACHINERY??"").trim().toLowerCase(); const off=v==="true"||v==="1"||v==="yes"; console.log(off?"fork machinery DISABLED":"fork machinery enabled"); process.exit(off?1:0)'
# expected: fork machinery enabled (exit 0)
```

Raw Compose start, inside the running node container:

```bash
docker compose exec -T node bun -e 'const v=(process.env.DEMOS_DISABLE_FORK_MACHINERY??"").trim().toLowerCase(); const off=v==="true"||v==="1"||v==="yes"; console.log(off?"fork machinery DISABLED":"fork machinery enabled"); process.exit(off?1:0)'
# expected: fork machinery enabled (exit 0)
```

The stock Compose file does not pass this variable to the container, so a `.env` entry alone does not reach the node; the container shows it only if a compose override or an `environment:` entry adds it. The bare-metal check covers the host `.env`.

For bare metal, run the bare-metal check in the shell or service environment that starts the node. A check in another shell does not prove what the running node received.

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

The HTTP RPC listens on `RPC_PORT` (default `53550`); `53551` is OmniProtocol TCP. Set `RPC_PROBE_PORT` in this shell to the **effective host** RPC port: use the `.env` override for raw Compose, `RPC_PROBE_PORT=<p>` after `./run --docker --port <p>`, `RPC_PROBE_PORT=53650` for a `--devnet` stack (its published host port is +100), or the value passed to bare-metal `./run -p` (for example, `RPC_PROBE_PORT=53560` after either start with port 53560). Use this port for §4.6 too. Compose reads `RPC_PORT` from the shell, so do not export it for these probes. The commands pass it only to their child shells. These examples use the directly published RPC port; for a proxy deployment use its RPC URL instead.

```bash
RPC_PORT="${RPC_PROBE_PORT:-53550}" bash -o pipefail <<'EOF'
curl -fsS --connect-timeout 2 --max-time 5 --max-filesize 1048576 "http://127.0.0.1:${RPC_PORT:-53550}/" \
  -H 'Content-Type: application/json' \
  --data '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{}}]}' \
  | head -c 1048577 | jq -Rser 'select(utf8bytelength <= 1048576) | fromjson | select(.result == 200) | .response | numbers'
EOF
```

### 3.2 Seal the genesis

Update the `forks` block (both entries at the same `N`) in the host file §2.3 selected as `GENESIS_FILE`, the file this node reads: `mainnet/genesis.json` or the `docker compose config` source for the INSTALL.md read-only bind mount, `data/genesis.json` for other Compose starts, and the Bun-resolved path on bare metal:

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

In the same shell, run the §2.3 checks, including its `sha256sum "$GENESIS_FILE"` line. Announce that hash to all validators, and distribute this file as the agreed genesis.

---

## 4. Fork-day timeline

Times are wall-clock relative to expected `T-0` (= announcement-head + (N - announcement-head) × 20s).

### 4.1 T-24 h — announcement

Ops broadcasts:
- chosen `N`
- expected `T-0` wall-clock
- the §3.2 `sha256sum "$GENESIS_FILE"` hash of the sealed genesis (the §2.3 selected file)
- target SDK version (`4.0.0`) for ecosystem partners

Every validator runs §2 in full and confirms in the validator channel.

### 4.2 T-1 h — update + restart

```bash
# 1. Bare metal: stop the node cleanly via its supervisor (systemctl/pm2) or Ctrl+C in its terminal.
systemctl is-active <node-unit>   # expected: inactive (or use: pm2 list)
pgrep -af 'src/index.ts'  # expected: no rows (any bare-metal start, including ./run)
# A row that belongs to a Docker container (docker ps / docker top) is another node, not this one.
# If it lists a process, stop it (Ctrl+C in its terminal, or your supervisor) and check again before step 2.

# 2. Bare metal/Bun only: check out the agreed commit and install dependencies.
git fetch origin stabilisation
git checkout <agreed-commit-hash>
bun install --frozen-lockfile
# Run the step 2 and 3 checks in the shell or service environment that starts the node.
# A check in another shell does not prove what the running node received.
# If a supervisor (systemd Environment=, pm2) sets GOSSIP_ENABLED or DEMOS_GENESIS_FILE, use its value:
# export it in this shell first, because a shell value wins over .env.
# Ask Bun for the node's gossip setting (shell, then .env): unset, empty, true or 1 is on; anything else is off.
gossip=$(bun -e 'const v=process.env.GOSSIP_ENABLED; process.stdout.write(v===undefined||v===""||v==="true"||v==="1"?"on":"off")')
if [ "$gossip" = off ]; then
  printf '%s\n' 'Skipping sidecar build because gossip is off (GOSSIP_ENABLED=false).'
else
  bun run sidecar:build
fi

# 3. Bare metal only: resolve the node's genesis path (shell, then .env), even if this shell checked a different path earlier.
#    A supervisor-set DEMOS_GENESIS_FILE must be exported in this shell first (see step 2).
GENESIS_FILE=$(bun -e 'import { genesisFilePath } from "./src/libs/blockchain/genesis/genesisFile"; console.log(genesisFilePath())')
# Replace "$GENESIS_FILE" with the agreed file.
sha256sum "$GENESIS_FILE"   # MUST match the announcement.

# 4. Restart via your supervisor, or bun run start:bun.
```

For Compose, follow the startup path chosen in §2.1. Build local source **before stopping** the validator: `./scripts/docker-run build node` for the wrapper or `GIT_COMMIT=$(git rev-parse HEAD) docker compose build node` for raw Compose. For a released image, pull the agreed image with `./scripts/docker-run pull node` or `docker compose pull node` before stopping. Record whether `reaper` is running with `./scripts/docker-run ps --status running --services` or `docker compose ps --status running --services`. Stop it and the node with the matching `./scripts/docker-run stop reaper node` or `docker compose stop reaper node`. Confirm `node` is absent from the same Compose service check. For a released image, run `migration:show` and, after a backup if pending, `migration:run` with the same path as in [INSTALL.md → Update the node](../INSTALL.md#update-the-node), without `up` until the hash checks below pass. For a writable `node_data` volume, put the agreed file at the host `GENESIS_FILE` that §2.3 selected for this setup (`data/genesis.json`), check its hash, copy that same file into the volume, and hash the container file before restarting. If `DEMOS_GENESIS_FILE` is set, the copy and hash use that container path. Wrapper start with a writable genesis volume:

```bash
sha256sum "$GENESIS_FILE"   # MUST match the announcement.
./scripts/docker-run run --rm --no-deps --user root --entrypoint sh \
  -v "$PWD/${GENESIS_FILE:?}:/agreed-genesis.json:ro" node -c \
  'cp /agreed-genesis.json "${DEMOS_GENESIS_FILE:-data/genesis.json}" && chown demos:demos "${DEMOS_GENESIS_FILE:-data/genesis.json}"'
./scripts/docker-run run --rm --no-deps node sh -c 'sha256sum "${DEMOS_GENESIS_FILE:-data/genesis.json}"'
```

Raw Compose start with a writable genesis volume:

```bash
sha256sum "$GENESIS_FILE"   # MUST match the announcement.
docker compose run --rm --no-deps --user root --entrypoint sh \
  -v "$PWD/${GENESIS_FILE:?}:/agreed-genesis.json:ro" node -c \
  'cp /agreed-genesis.json "${DEMOS_GENESIS_FILE:-data/genesis.json}" && chown demos:demos "${DEMOS_GENESIS_FILE:-data/genesis.json}"'
docker compose run --rm --no-deps node sh -c 'sha256sum "${DEMOS_GENESIS_FILE:-data/genesis.json}"'
```

For the INSTALL.md read-only bind mount, replace the host `GENESIS_FILE` that §2.3 selected (`mainnet/genesis.json`, or the mount source shown by `docker compose config`) with the agreed file and run `sha256sum "$GENESIS_FILE"`; do **not** run either volume-copy command. The host hash and, with the override loaded, `docker compose run --rm --no-deps node sh -c 'sha256sum "${DEMOS_GENESIS_FILE:-data/genesis.json}"'` MUST match the announcement.

Only after the hash matches, restart with the matching path: `./scripts/docker-run up -d --no-build node reaper` or `docker compose up -d --no-build node reaper` if `reaper` was running; otherwise omit `reaper`. A plain restart keeps the old image. For a released image, pull the agreed release and use `--no-build` as described in INSTALL.md.

After this restart, run the §4.6 liveness probe and compare the head with a healthy peer as described there. Do not call the validator healthy until it advances and catches up.

### 4.3 Verify the loader saw both forks

Tail the log after start. Look for **two** loader lines from `src/forks/loadForkConfig.ts`:

```text
[FORKS] Loaded fork "osDenomination" with activationHeight=<N>
[FORKS] Loaded fork "gasFeeSeparation" with activationHeight=<N>
```

If either is absent, stop the node, re-check the effective genesis file (`DEMOS_GENESIS_FILE` on bare metal when set), restart. Do not proceed without both lines.

If you see:

```text
[FORKS] DEMOS_DISABLE_FORK_MACHINERY set — ignoring genesis `forks` field
```

stop the node, unset the flag, restart. This flag is rehearsal-only.

After any restart in this step, repeat the §4.6 liveness check against a healthy peer before proceeding.

**Accepted risk: a schedule mismatch is log-only.** Peers compare their fork schedules at bootstrap and periodically, and a difference is logged as `FORK SCHEDULE MISMATCH` (error level near a scheduled height), but it never stops the node. A node that missed the genesis edit therefore keeps running and splits from its peers at the first height that differs, so the log lines are the only warning. A hard stop is deliberately not offered: during a rolling genesis edit peers disagree legitimately for a while, and a stop that fires then can remove validators at the worst moment. Check the `getNetworkInfo` schedule digest on every validator rather than relying on the node to refuse.

### 4.4 Block `N-3` → `N+5` observation

From `T-0` minus a few minutes, watch the activation sequence on every validator.

Wrapper start: `./scripts/docker-run logs -f node | grep -E '\[forks\]\['`.

Raw Compose start: `docker compose logs -f node | grep -E '\[forks\]\['`.

Expected order at block `N` (osDenomination runs FIRST, then gasFeeSeparation):

**osDenomination block (lines from `osDenomination.ts`)**:
1. `[forks][osDenomination] activation hook firing at block <N>`
2. `[forks][osDenomination] starting state migration at block <N>`
3. `[forks][osDenomination] preSumDem=<...> gcrV2Rows=<...> legacyRows=<...> validatorsRows=<...>`
4. `[forks][osDenomination] gcr_main migrated (rows=<...>)`
5. `[forks][osDenomination] validators migrated (rows=<count>, malformed=<count>)`
6. `[forks][osDenomination] postSumOs=<value>`
7. `[forks][osDenomination] sum invariant verified: postSumOs == preSumDem * 10^9 - valueLostOs`  ← **load-bearing**
8. `[forks][osDenomination] fork_state row persisted; migration complete`

**gasFeeSeparation block (lines from `gasFeeSeparation.ts`)**:
9. `[forks][gasFeeSeparation] activation hook firing at block <N>`
10. `[forks][gasFeeSeparation] starting state migration at block <N>`
11. `[forks][gasFeeSeparation] created account at <burnAddress> with balance=0` (only if newly created)
12. `[forks][gasFeeSeparation] created account at <treasuryAddress> with balance=0` (only if newly created)
13. `[forks][gasFeeSeparation] fork_state row persisted; burn=<burnAddress>, treasury=<treasuryAddress>, burnCreated=<boolean>, treasuryCreated=<boolean>` ← **load-bearing**

Only a missing load-bearing line on a validator after the network produces `N+1` means the migration did not complete there; check its head and `fork_state` as in §6.1. The account creation lines can be absent if those accounts already exist.

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
# Block N hash convergence across validators. Only the final OK: line counts as a pass.
# Use the announced activation height (not a checkout's genesis file).
# Replace the height and hostnames with the announced N and one URL per distinct validator.
export N='paste-announced-activation-height-here'
export RPC_URLS="http://validator-a.example:53550/ http://validator-b.example:53550/"
bash -euo pipefail <<'EOF'
[[ "${N:-}" =~ ^[1-9][0-9]*$ ]] || { echo "Set N to the announced positive activation height (>0)" >&2; exit 1; }
read -r -a rpc_urls <<< "${RPC_URLS:-}"
for i in "${!rpc_urls[@]}"; do rpc_urls[i]="${rpc_urls[i]%/}"; done
read -r -a rpc_urls <<< "$(printf '%s\n' "${rpc_urls[@]}" | sort -u | tr '\n' ' ')"
if (( ${#rpc_urls[@]} < 2 )); then
    echo "RPC_URLS must contain at least two explicit validator URLs" >&2; exit 1
fi
expected_hash=
for rpc in "${rpc_urls[@]}"; do
    hash=$(curl -fsS --connect-timeout 2 --max-time 5 --max-filesize 1048576 "$rpc" -H 'Content-Type: application/json' \
      --data "{\"method\":\"nodeCall\",\"params\":[{\"message\":\"getBlockByNumber\",\"data\":{\"blockNumber\":$N}}]}" \
      | head -c 1048577 | jq -Rser 'select(utf8bytelength <= 1048576) | fromjson | select(.result == 200) | .response.hash | strings | select(length > 0)') || {
        echo "No block $N hash from $rpc (not at N yet, desynced, or unreachable)" >&2; exit 1
    }
    if [[ -n "$expected_hash" && "$hash" != "$expected_hash" ]]; then
        echo "Block $N hash mismatch at $rpc" >&2; exit 1
    fi
    expected_hash=$hash
    printf '%s %s\n' "$rpc" "$hash"
done
echo "OK: block $N hash $expected_hash on all ${#rpc_urls[@]} validators"
EOF
```

### 4.6 Liveness

```bash
RPC_PORT="${RPC_PROBE_PORT:-53550}" bash -o pipefail <<'EOF'
for i in 1 2 3; do
    curl -fsS --connect-timeout 2 --max-time 5 --max-filesize 1048576 "http://127.0.0.1:${RPC_PORT:-53550}/" \
      -H 'Content-Type: application/json' \
      --data '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{}}]}' \
      | head -c 1048577 | jq -Rser 'select(utf8bytelength <= 1048576) | fromjson | select(.result == 200) | .response | numbers' || exit 1
    sleep 25
done
EOF
# expected: monotonically increasing (block time ~20s).
```

After every restart, require the local head to advance and come within three blocks of a healthy peer within five minutes. Read the peer's head with the probe below, which uses the peer's full RPC URL in place of `http://127.0.0.1:${RPC_PORT:-53550}/`. `RPC_PROBE_PORT` only changes the port on this host, so it cannot point the probe at a peer.

```bash
# Replace the URL with the healthy peer's full RPC URL.
HEALTHY_RPC_URL='http://healthy-validator.example:53550/' bash -o pipefail <<'EOF'
curl -fsS --connect-timeout 2 --max-time 5 --max-filesize 1048576 "$HEALTHY_RPC_URL" \
  -H 'Content-Type: application/json' \
  --data '{"method":"nodeCall","params":[{"message":"getLastBlockNumber","data":{}}]}' \
  | head -c 1048577 | jq -Rser 'select(utf8bytelength <= 1048576) | fromjson | select(.result == 200) | .response | numbers' \
  || { echo "No head from $HEALTHY_RPC_URL" >&2; exit 1; }
EOF
```

A head that keeps advancing toward the peer is catching up (for example after a backup restore); fix the peerlist only if it does not advance. If the head does not advance, check the node log for `Finished checking N offline and N quiet peers`, and check that the peer list file the node reads names at least one other validator. Fix that file and restart (for a wrapper start with the default file, use the stop and `up` pair below), then repeat this check. The node does not write learned peers back to the file. Find the file for your startup path:

```bash
# Wrapper start:
./scripts/docker-run exec -T node printenv PEER_LIST_FILE
# Raw Compose:
docker compose exec -T node printenv PEER_LIST_FILE
# Bare metal ./run: the -l value (default demos_peerlist.json); ./run sets it over any shell or .env value.
# Bare metal without ./run (bun run start:bun or a supervisor), from the node checkout (shell, then .env):
bun -e 'console.log(process.env.PEER_LIST_FILE || "demos_peerlist.json")'
```

Then edit that file:

- Wrapper start with `demos_peerlist.json` (the default): edit the repo's `demos_peerlist.json`, which `./scripts/docker-run up` copies into the `node_state` volume. The container reads it through `/app/demos_peerlist.json`. The node reads the file only at startup, so restart with the §4.2 pair: record whether `reaper` is running (`./scripts/docker-run ps --status running --services`), run `./scripts/docker-run stop reaper node`, then `./scripts/docker-run up -d --no-build node reaper`, omitting `reaper` if it was not running. `./scripts/docker-run restart` does not copy the file, and `up` alone leaves a running node on the old list.
- Raw Compose with `demos_peerlist.json`: edit `demos_peerlist.json` in the `node_state` volume. Raw Compose does not copy the repo file.
- Wrapper or raw Compose with any other file: the node reads that path inside the container, relative to `/app`. `./scripts/docker-run up` copies only the repo's `demos_peerlist.json` to `/app/state/demos_peerlist.json` and does not update this file, so edit this file. An edit inside the container outlasts a container recreate only if the path is on a volume, such as under `/app/state`.
- Bare metal: edit the file named above. A relative path is relative to the node checkout. If a supervisor starts the node without `./run` and sets `PEER_LIST_FILE`, use the supervisor's value instead.

---

## 5. "What right looks like" — rehearsal reference values

Empirically verified against the 4-node Postgres devnet (Run 5 + Run 6 + Run 8, `forking/REHEARSAL_RESULTS.md`).

### 5.1 osDenomination `fork_state` (7-account seed, 1e18 each)

```text
fork_name           = osDenomination
applied             = t
applied_at_block    = <N>
pre_sum_dem         = 7000000000000000000           (= 7 × 10^18)
post_sum_os         = 7000000000000000000000000000  (= 7 × 10^27)
capped_count        = 0
total_value_lost_os = 0
```

### 5.2 gasFeeSeparation `fork_state` (combined fork rehearsal)

```text
fork_name        = gasFeeSeparation
applied          = t
applied_at_block = <N>
(other columns NULL — this migration doesn't touch balances)
```

### 5.3 Burn + treasury accounts

```text
pubkey                                                              balance
0x0000000000000000000000000000000000000000000000000000000000000000  0
<treasuryAddress>                                                   0
```

### 5.4 Cap policy (only fires if any pre-fork legacy GCR account ≥ ~9 M DEM)

```text
fork_name           = osDenomination
capped_count        = >0
total_value_lost_os = >0
```

with log lines:

```text
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
- Head not advancing five minutes after restart, or no longer closing the gap to a healthy peer, even when the loader and digest checks passed.

**Fix**:

If the fork schedule was added or changed after the network created block 0, **do not boot an empty database from the edited genesis**. The node cannot rebuild the network's block 0 from that file. For a planned chain-wipe activation, follow the [snapshot restore runbook](restore/RUNBOOK.md).

A validator joining an existing chain with an empty database (new, or after losing its disk) has no documented self-service path: restore a verified backup from the intended chain as below, or contact the core team.

If the node refused at bootstrap with `created its block 0 from an edited data/genesis.json`, that database holds only the wrong block 0. Keep it stopped and restore as in the last paragraph of this section, or escalate; the head/`fork_state` rule below applies only to a database built on the network's block 0.

With an **intact database**, stop the validator first (and the reaper if running), as in §4.2, so its head cannot advance during the check. For bare-metal `./run`, start Postgres alone as in §2.4. First compare this database's block 0 hash with a healthy peer's `getBlockByNumber` at `blockNumber: "0"`. Use the database command for your startup path:

```bash
# Wrapper Compose:
./scripts/docker-run exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT hash FROM blocks WHERE number = 0;"'
# Raw Compose:
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT hash FROM blocks WHERE number = 0;"'
# Bare metal ./run: set PG_PORT to the `-d` value passed to `./run` (default 5332),
# then start its Postgres container alone as in §2.4.
docker exec "postgres_${PG_PORT:-5332}" psql -v ON_ERROR_STOP=1 -U demosuser -d demos -tAc 'SELECT hash FROM blocks WHERE number = 0;'
# External Postgres: set PG_HOST, PG_PORT, PG_USER, PG_DATABASE and
# PG_PASSWORD from the node's .env in this shell first.
PGPASSWORD="$PG_PASSWORD" psql -v ON_ERROR_STOP=1 -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" -tAc 'SELECT hash FROM blocks WHERE number = 0;'
```

```bash
export HEALTHY_RPC_URL='http://healthy-validator.example:53550/'
bash -o pipefail <<'EOF'
curl -fsS --connect-timeout 2 --max-time 5 --max-filesize 1048576 "$HEALTHY_RPC_URL" -H 'Content-Type: application/json' \
  --data '{"method":"nodeCall","params":[{"message":"getBlockByNumber","data":{"blockNumber":"0"}}]}' \
  | head -c 1048577 | jq -Rser 'select(utf8bytelength <= 1048576) | fromjson | select(.result == 200) | .response.hash | strings | select(length > 0)' \
  || { echo "No block 0 hash from $HEALTHY_RPC_URL" >&2; exit 1; }
EOF
```

If either hash is missing or they differ, treat this database like the refused case above: keep the node stopped and restore or escalate. Only after the hashes match, check the local head with `SELECT max(number) FROM blocks;` and inspect `SELECT fork_name, applied, applied_at_block FROM fork_state;` in that same database against the announced `N`.

Only if the local head is non-null and below N, and neither migration has been recorded, may a validator that missed the schedule edit correct the genesis file it actually uses and restart as in §4.2. If the local head is at or above N without both migrations recorded as `applied=true` and `applied_at_block=N`, keep the validator stopped; restore a verified backup from the intended chain using the database-restore step below, or escalate if no suitable backup exists. Do not restart that database with a corrected schedule: the hooks will not replay block N. If both migrations are recorded at N but the schedule still differs, or the head or migration rows are otherwise unexpected, keep it stopped and escalate before changing it. If the stored-schedule guard refuses an allowed restart, confirm the refusal's digest is the agreed schedule, then restart with `DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST` set to that digest (for Compose, set it in the container environment and recreate the node). Remove it from the environment once the node runs (INSTALL.md). Verify the §4.3 loader lines and `getNetworkInfo` schedule digest against healthy peers.

If a validator database must be reset, stop the validator and restore a known-good backup from the intended chain using the database-restore step in the [migration runbook](../docs/runbooks/database-migrations.md#roll-back). Never drop the database by hand. If there is no suitable backup, stop and contact the core team. After restoring, use the agreed fork binary and check the agreed genesis hash (§2.3). Before restarting, run the block 0, head and `fork_state` checks above on the restored database and apply the same rule. Then restart as in §4.2 and verify the §4.3 loader lines and `getNetworkInfo` schedule digest against healthy peers. For Compose, restart the reaper only if it was running before the stop, as described in §4.2. Require the §4.6 head check against a healthy peer after restart.

If the restart passes the loader, digest, block 0 and `fork_state` checks but its head does not advance and come within three blocks of a healthy peer in five minutes, it is not in sync. A head that keeps advancing toward the peer is catching up (for example after a backup restore); fix the peerlist only if it does not advance. If the head does not advance, inspect the log's `Finished checking N offline and N quiet peers` count and correct the peer list file the node reads, found and edited as described in §4.6. Restart and repeat §4.6 before declaring recovery.

### 6.2 Crash during migration

Both migrations run inside the block-insert TypeORM transaction. On a mid-migration crash (kill, OOM, Postgres drop), the transaction rolls back; `fork_state` stays empty for both forks; on restart the gates return false; the hooks fire again and run to completion. Run 5 Scenario 8 confirmed this for osDenomination; the same atomicity applies to gasFeeSeparation by construction.

On persistent crash-loop: capture last 200 lines of node + Postgres logs, halt the validator, escalate. **Do NOT bypass migrations manually.**

### 6.3 Cap policy fires

If any pre-fork legacy GCR account exceeds the cap, the migration logs the CAP banner and persists `capped_count > 0`. **Intentional**. `capped_count` and `total_value_lost_os` MUST be bit-identical across all validators. If they differ, the network is forked — escalate.

### 6.4 Fresh validator post-fork

A validator joining after `T-0` on a chain with an unchanged genesis spins up with the agreed binary + the sealed genesis at the file §2.3 selects for its setup. Sync replay processes block `N`; both hooks fire automatically. Run 5 Scenario 3 confirms end-to-end. If the schedule was added or changed after block 0, follow the warning in §6.1 before booting an empty-database node.

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

- **Don't change `data/genesis.json` `balances` mid-run.** Balances are inside `BlockContent` and will invalidate every existing `chain.db`. The `forks` entries and `properties.id` are the exception on a running chain: a node's peers answer the genesis data hash from the genesis block stored when the chain was created, so an edited file never matches it. A node on a build with the two-hash handling (`genesisMismatch.ts`) compares the data a peer serves, finds that only the schedule and chain id differ, and keeps its file. A node on an older build overwrites the file with the stored version at boot and drops the schedule at the next restart, so put the newer build on every node before editing the genesis file. See `testing/forks/REHEARSAL.md`.
- **Don't boot an empty database on an edited genesis file.** Block 0 embeds the raw genesis JSON (`chainGenesis.ts`, `extra.genesisData`) and its hash feeds the common validator seed, so a node that creates its chain from the edited file ends up with a block 0 different from the network's, and fast sync refuses the peers (`Sync.ts`, `verifyLastBlockIntegrity`). If the fork schedule was added or changed after block 0, do not wipe the database or start a new node with an empty database from that file; follow §6.1's backup/snapshot or escalation guidance. A validator with an intact database can correct its file and restart as described in §6.1.
- **Don't treat `web2ProofBinding` as enforced at block validation.** It is an admission policy: `verifyWeb2Proof` consults the gate (tip + 1) when a web2 proof is verified for the mempool, the Telegram path returns before the gate, and no code judges a proof at an explicit block height. Transaction signatures under `signatureDomain` can be judged at a block's own height: `verifyBlock` re-checks them (`txSignatureContext(block.number)`) when it is given the block's transactions. A legacy-shaped proof admitted by a node whose tip lags the network, or included by a proposer that ignores the gate, can still land at or after H. Treat the height as a client migration deadline, not a consensus rule, until a validation-time check exists (recommended as a follow-up; not implemented).
- **Don't schedule `xmProofBinding` before wallets and SDKs sign the bound message.** From the height on, `IdentityManager.verifyPayload` refuses an xm identity whose `signedData` is not `demos-xm:v1:<chain>:<targetAddress>:<demosSender>:<issuedAt>` (epoch milliseconds, at most ten minutes old; evm and aptos addresses and the sender lower-cased). Like `web2ProofBinding` it is an admission policy judged at tip + 1, not a block-validation rule. The SDK's xm identity builder does not produce that message yet; until it does, scheduling the fork blocks every xm link.
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
