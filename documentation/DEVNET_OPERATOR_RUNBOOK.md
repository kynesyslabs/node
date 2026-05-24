# Demos Node — Devnet Operator Runbook

Step-by-step for standing up a Demos node from nothing, running a
multi-node devnet, restoring live chain state from a snapshot, wiring
L2PS subnets, driving network-parameter governance upgrades, and stress
testing — single-node and multi-node.

Audience: node operators and engineers running the devnet → testnet →
beta-mainnet rollout and the live stress sessions.

---

## 1. Prerequisites

- **Docker** 20.10+ with the Compose v2 plugin (`docker compose`, not
  legacy `docker-compose`)
- **Bun** ≥ 1.1 — `curl -fsSL https://bun.sh/install | bash`
- **jq**, **curl** — `apt install -y jq curl`
- ~8 GB RAM, ~6 cores recommended; ~5 GB free disk
- Open ports if joining a network: `53550` (RPC), `53551` (OmniProtocol)

Clone:

```bash
git clone https://github.com/kynesyslabs/node.git
cd node
bun install
```

---

## 2. Single node from scratch

The `./run` wrapper provisions a PostgreSQL sidecar, optional
TLSNotary + monitoring, and starts the node.

```bash
cp .env.example .env          # defaults work for local dev
./run --no-tui                # ALWAYS pass --no-tui in non-interactive shells
```

> **Footgun:** the default TUI display silently exits when stdout is not
> a real TTY (wrapper scripts, CI, piped output). If `./run` exits
> instantly with `Stopping L2PS services... Cleanup complete`, that is
> the symptom. Always use `--no-tui` (or `-t`) outside an interactive
> terminal.

First boot generates the node identity at `.demos_identity` and prints
the public key. Verify:

```bash
curl -s http://localhost:53550/info | jq .
```

Key `./run` flags: `-p <rpc-port>` · `-d <pg-port>` · `-c` (clean DB) ·
`-v` (verbose) · `--no-tui` · `-e` (external DB) · `-m` (no monitoring).

`.env` essentials:

| Var | Default | Notes |
|-----|---------|-------|
| `RPC_PORT` | `53550` | HTTP RPC |
| `EXPOSED_URL` | `http://localhost:53550` | **Change for any non-local deploy** — peers use this to reach you |
| `CONSENSUS_TIME` | `10` | Seconds per block |
| `TLSNOTARY_ENABLED` | `true` | Set `false` to skip the TLSNotary sidecar |

---

## 3. Multi-node devnet

A 4-node dockerised devnet (plus an optional 5th rehearsal node) lives
under `testing/devnet/`.

```bash
cd testing/devnet
./scripts/setup.sh            # generates node identities + demos_peerlist.json
docker compose up --build     # boots postgres + 4 nodes
# safer ordering (avoids the genesis-sync race):
./start-staggered.sh
```

RPC endpoints once healthy: node-1 `:53551`, node-2 `:53553`,
node-3 `:53555`, node-4 `:53557`.

Observability:

```bash
./scripts/logs.sh             # tail all nodes
./scripts/logs.sh node-2      # tail one
./scripts/watch-all.sh        # tmux 4-pane live view
./scripts/attach.sh node-2    # shell into a container
```

Node count is configurable — `NODE_COUNT=5 ./scripts/generate-identities.sh`
then regenerate the peerlist. The 5th node is profile-gated:
`docker compose --profile rehearsal up -d` (used for post-fork join
testing).

Teardown: `docker compose down -v --remove-orphans`.

---

## 4. Restore from snapshot — run a node solo with live chain state

This is the path for "bring node2 down and run it solo with all the
live testnet data". A committed snapshot in `data/snapshot/` is restored
into a fresh database at genesis (block 0); the `osDenomination` and
`gasFeeSeparation` forks are pre-applied at block 0 so the node boots
post-fork immediately without waiting for quorum.

`data/snapshot/` holds `gcr_main.jsonl`, `gcr_storageprogram.jsonl`,
`identity_commitments.jsonl`, and `manifest.json` (integrity checksums +
the source block height/hash).

### 4.1 Pre-flight

```bash
bun snapshot:verify                       # exits 0 if checksums match manifest
bun snapshot:dry-run                      # rehearse the restore, no DB write
jq '.source' data/snapshot/manifest.json  # source block height + hash
jq '.balances | length' data/genesis.json # expect 0 — balances come from the snapshot
```

If `snapshot:verify` fails, do not boot — `git checkout data/snapshot/`
to restore the committed files.

### 4.2 Boot

The genesis builder auto-detects `data/snapshot/` on an **empty**
database and restores it.

```bash
./run --no-tui -c             # -c wipes the DB first → triggers a fresh genesis
```

Watch the logs for, in order:

```
[GENESIS][SNAPSHOT] snapshot present: block=<N> hash=<...>
[GENESIS][SNAPSHOT] gcr_main: inserted .../...
[GENESIS][SNAPSHOT] restore complete: gcr_main=<N>, ...
[forks][osDenomination] sum invariant verified: ...
[GENESIS][FORKS] pre-apply complete: osDenomination=true gasFeeSeparation=true
```

The `sum invariant verified` line is the critical one — its absence
means the migration rolled back. If genesis aborts, the DB is left
empty for a clean retry (`./run --no-tui -c`).

### 4.3 Re-joining the others

Once the solo node is healthy, bring the remaining nodes up pointed at
its `EXPOSED_URL` in their peerlist. They sync from the solo node's
chain head. Repeat per node.

---

## 5. L2PS subnet provisioning

An L2PS subnet is three files on disk under `data/l2ps/<uid>/`. The node
scans that directory at boot (`ParallelNetworks.loadAllL2PS()`).

### 5.1 Provision

```bash
SUBNET=my_subnet_001
mkdir -p data/l2ps/$SUBNET
openssl rand -hex 32 > data/l2ps/$SUBNET/private_key.txt   # AES-256 key
openssl rand -hex 16 > data/l2ps/$SUBNET/iv.txt            # AES-GCM IV
chmod 600 data/l2ps/$SUBNET/private_key.txt data/l2ps/$SUBNET/iv.txt
cat > data/l2ps/$SUBNET/config.json <<EOF
{
  "uid": "$SUBNET",
  "enabled": true,
  "config": { "created_at_block": 0, "known_rpcs": ["http://127.0.0.1:53550"] },
  "keys": {
    "private_key_path": "data/l2ps/$SUBNET/private_key.txt",
    "iv_path": "data/l2ps/$SUBNET/iv.txt"
  }
}
EOF
```

Both halves of a subnet (e.g. two nodes that share it) must hold the
**same** key + IV — distribute them out-of-band.

### 5.2 Verify

Restart the node; the load is confirmed by:

```
[MULTICHAIN] Loaded L2PS: my_subnet_001
```

The devnet ships a pre-baked subnet `live_local_001`
(`testing/devnet/l2ps/`, mounted read-only into every node) — used by
the multi-node stress test below.

To disable a subnet without deleting it: set `"enabled": false` in its
`config.json` and restart.

> **Known SDK gap (HIGH):** the SDK reuses a static IV for every
> `encryptTx` call — repeated encryption under one subnet key is an
> AES-GCM nonce-reuse break. Track the SDK fix before anchoring
> sensitive data through L2PS in production.

---

## 6. Upgradable-network governance

Network parameters (`networkFee`, `rpcFee`, `minValidatorStake`,
`featureFlags`) change through an on-chain stake → propose → vote →
tally → activate cycle. The manual CLI is `scripts/upgradable-network/cli.ts`.

```bash
bun run upgradable:cli new-wallet                 # generates .manual-test-mnemonic
# fund that address in data/genesis.json, then boot fresh

bun run upgradable:cli stake                      # stake the default 1e18
bun run upgradable:cli validators                 # list the validator set
bun run upgradable:cli propose networkFee 12      # → prints a proposalId
bun run upgradable:cli vote <proposalId> yes
bun run upgradable:cli votes <proposalId>         # live tally
bun run upgradable:cli params                     # current parameters
```

Lifecycle: a proposal opens for a **voting window** (100 blocks
default), is **tallied** (≥ 2/3 stake approves → `activating`), waits a
**grace period** (50 blocks), then takes effect at `effectiveAtBlock`.

`RPC_URL` and `MNEMONIC_FILE` env vars override the CLI defaults — point
`RPC_URL` at a specific devnet node to drive governance from any node.

Genesis seeds the founding validator set from `data/genesis.json`
(`validators[]`, `status: "2"` = ACTIVE).

Full reference: `documentation/devs/upgradable-network-testing.md`.

---

## 7. Stress testing

### 7.1 One-command suites (devnet must be running)

```bash
bun run testenv:doctor      # RPC + block-height health probe
bun run testenv:sanity:local      # 2-scenario smoke
bun run testenv:cluster:local     # consensus + peer-sync + gcr
bun run testenv:l2ps:local        # L2PS live participation + relay
bun run testenv:prod-gate:local   # 11-scenario release gate
bun run testenv:soak:local        # sustained mixed-load soak
bun run testenv:perf:baseline:local  # throughput + latency baseline
```

Single scenario with custom load:

```bash
testing/scripts/run-scenario.sh consensus_tx_inclusion \
  --env CONCURRENCY=200 --env DURATION_SEC=120
```

`SCENARIO=__list__ bun testing/loadgen/src/main.ts` lists all 130+
scenarios. Loadgen is multi-node aware via the `TARGETS` env var
(comma-separated RPC URLs).

### 7.2 Governance — functional E2E + stress

**Functional E2E** — one upgrade cycle, asserts the new fee lands in a
freshly persisted transaction:

```bash
bun run test:upgradable:e2e         # full windows, ~25 min
bun run test:upgradable:e2e:fast    # shrunk windows, ~5 min
```

**Stress** — repeated propose → vote → tally → activate cycles run
under concurrent background tx load, with a strict cross-node
consistency assertion every round:

```bash
scripts/governance-multinode-stress.sh
ROUNDS=5 scripts/governance-multinode-stress.sh
NO_LOAD=1 scripts/governance-multinode-stress.sh   # governance-only, no load
```

Boots its own FAST-window devnet. Env: `ROUNDS` (default 3),
`BASE_FEE`, `CONSENSUS_TIME`, `NO_LOAD`, `KEEP_DEVNET`. Both write
artifacts to `./e2e-runs/<timestamp>/`.

### 7.3 L2PS multi-node stress

```bash
# devnet must already be up (section 3)
scripts/l2ps-multinode-stress.sh
COUNT=500 scripts/l2ps-multinode-stress.sh
L2PS_UID=live_local_001 TARGETS=http://127.0.0.1:53551,http://127.0.0.1:53553 \
  scripts/l2ps-multinode-stress.sh
```

Hammers one L2PS subnet across every node in parallel and aggregates
per-node throughput + failure counts into a single verdict. Env:
`TARGETS`, `L2PS_UID`, `COUNT` (tx/node), `DELAY`, `FAIL_THRESHOLD_PCT`.
Per-node logs + `SUMMARY.txt` in `testing/runs/l2ps-multinode-<ts>/`.

### 7.4 Live stress session battery

A practical sequence for a 1–2 h session:

```bash
# 1. fresh 4-node devnet
cd testing/devnet && ./scripts/setup.sh && docker compose up -d --build && cd ../..

# 2. health gate
bun run testenv:doctor

# 3. consensus under ramped load
testing/scripts/run-scenario.sh consensus_tx_inclusion \
  --env CONCURRENCY=50,100,200 --env STEP_DURATION_SEC=30

# 4. L2PS multi-node stress
COUNT=500 scripts/l2ps-multinode-stress.sh

# 5. governance stress — repeated cycles under tx load
ROUNDS=5 scripts/governance-multinode-stress.sh

# 6. sustained soak
bun run testenv:soak:local

# 7. release gate
bun run testenv:prod-gate:local
```

All step output lands in `testing/runs/` and `./e2e-runs/`;
`bun run testenv:latest` points at the most recent reports.

---

## 8. Testing deployed nodes (remote cluster)

For checks against a running cluster you do **not** boot yourself
(devnet on a remote host, testnet, beta-mainnet). All commands below
take a list of RPC URLs via `TARGETS` / `NODES` env or `RPC_URL` for
single-node tools. Public Demos nodes are reverse-proxied on `:443` —
use bare hostnames, not `:53550`.

```bash
NODES="https://node2.demos.sh https://node3.demos.sh https://node4.demos.sh"
```

### 8.1 Read-only health (no keys, plain curl)

```bash
# liveness + version + identity per node
for n in $NODES; do
  echo "=== $n ==="
  curl -s $n/info | jq '{block: .peerlist[0].sync.block, version, identity}' \
    2>/dev/null || echo "DOWN"
done

# block-height drift (spot a lagging node)
for n in $NODES; do
  b=$(curl -s $n/info | jq -r '.peerlist[0].sync.block')
  echo "$b  $n"
done | sort -n

# L2PS subnet enabled on each node (yes/no per uid)
for n in $NODES; do
  for uid in testnet_l2ps_001 live_local_001; do
    r=$(curl -s -X POST $n/ -H "Content-Type: application/json" \
      -d "{\"method\":\"nodeCall\",\"params\":[{\"message\":\"getL2PSParticipationById\",\"data\":{\"l2psUid\":\"$uid\"},\"muid\":\"c\"}]}" \
      | jq -r .response.participating)
    echo "$n / $uid → $r"
  done
done
```

### 8.2 testenv suites against the deployed cluster

Drop `:local` and pass `TARGETS`:

```bash
TARGETS="https://node2.demos.sh,https://node3.demos.sh,https://node4.demos.sh"

TARGETS=$TARGETS bun run testenv:doctor
TARGETS=$TARGETS bun run testenv:prod-gate
TARGETS=$TARGETS bun run testenv:soak

# single scenario
TARGETS=$TARGETS testing/scripts/run-scenario.sh consensus_tx_inclusion \
  --env CONCURRENCY=50 --env DURATION_SEC=60
```

### 8.3 Governance read-only

Read-only `upgradable:cli` commands do not sign; `MNEMONIC_FILE` is
not required.

```bash
RPC_URL=https://node2.demos.sh bun run upgradable:cli params
RPC_URL=https://node2.demos.sh bun run upgradable:cli validators
RPC_URL=https://node2.demos.sh bun run upgradable:cli proposals
RPC_URL=https://node2.demos.sh bun run upgradable:cli history
RPC_URL=https://node2.demos.sh bun run upgradable:cli block
```

### 8.4 Provision funded stress creds (run **once on the VPS**)

The writes in §§ 8.5–8.6 need a funded mnemonic + the subnet's AES
key/IV. Generate everything in one shot:

```bash
# on the VPS, in the node repo root:
bash scripts/provision-l2ps-test-env.sh

# customise:
L2PS_UID=stress_v2 AMOUNT=5000000000000000000 \
PUBLIC_RPC=https://node2.demos.sh \
  bash scripts/provision-l2ps-test-env.sh
```

What it does, on the VPS, one command:
1. Provisions a fresh L2PS subnet under `data/l2ps/<uid>/` (or reuses
   if it exists)
2. Generates a fresh BIP-39 mnemonic
3. Funds that mnemonic from the node's own `.demos_identity` (a
   genesis-funded validator wallet)
4. Writes a copy-pasteable env block to `./stress-env-<uid>-<ts>.txt`

Output is the **constant** that local devs paste into
`agent-commerce-demo/.env.local`:

```
DEMOS_RPC_URL=https://node2.demos.sh
LIVE_DEMO_BASE_MNEMONIC="<12-word>"
LIVE_DEMO_TEST_ADDRESS=<hex>
L2PS_UID=<uid>
L2PS_AES_KEY=<64 hex>
L2PS_IV=<32 hex>
```

After running: restart the node so the subnet loads (look for
`[MULTICHAIN] Loaded L2PS: <uid>`), then share the env block over a
**secure channel** (Slack DM, age, 1Password) — mnemonic + AES key are
secrets.

After this one VPS run, ALL stress (§§ 8.5–8.6) runs locally with zero
further VPS access.

### 8.5 L2PS multi-node stress against deployed

Requires the env block from §8.4. Paste those vars (or export them),
then:

```bash
LIVE_DEMO_BASE_MNEMONIC="$LIVE_DEMO_BASE_MNEMONIC" \
TARGETS=https://node2.demos.sh,https://node3.demos.sh,https://node4.demos.sh \
L2PS_UID="$L2PS_UID" \
COUNT=200 \
  scripts/l2ps-multinode-stress.sh
```

### 8.6 Single live tx (sanity)

```bash
MNEMONIC_FILE=.demos_identity \
RPC_URL=https://node2.demos.sh \
  bunx tsx -e '
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { readFileSync } from "fs"
const d = new Demos()
await d.connect(process.env.RPC_URL)
await d.connectWallet(readFileSync(process.env.MNEMONIC_FILE, "utf8").trim())
const tx = await d.pay("0x10bf4da38f753d53d811bcad22e0d6daa99a82f0ba0dbbee59830383ace2420c", 1, d)
const r = await d.confirm(tx)
console.log({ hash: tx.hash, fee: tx.content.transaction_fee, result: r.result })
'
```

### 8.7 What does NOT work against a deployed cluster

- `scripts/governance-multinode-stress.sh` — boots its **own** devnet
- `bun run test:upgradable:e2e[:fast]` — same
- `./run` — full node-host stack, not a client tool

§§ 8.1–8.3 are read-only and safe to run anywhere. §8.4 must run on the
VPS (one time). §§ 8.5–8.6 write real transactions; require the env
block produced by §8.4.

---

## 9. Known footguns

- **TUI exits on non-TTY** — always `./run --no-tui` outside an
  interactive terminal (section 2).
- **Port collisions** — a killed `./run` can leave the PostgreSQL
  sidecar bound. `docker ps | grep postgres` then `docker stop`, or
  `docker compose down` from the postgres folder. TLSNotary on `7047`
  collides with any standalone notary on the host.
- **Snapshot is one-shot** — once block 0 is inserted, the snapshot is
  consumed; switching snapshots needs a DB wipe (`./run --no-tui -c`).
- **`./run` git-pull** — `./run` pulls latest by default; pass `-n` to
  skip when on a feature branch.
- **L2PS nonce reuse (HIGH)** — see section 5.2; SDK-side fix pending.
- **Validators table migration** — devnet relies on `synchronize:true`;
  production needs a hand-written migration for the staking columns.

---

## Appendix — port reference

| Port | Service | Expose? |
|------|---------|---------|
| 53550 | Node RPC (HTTP) | yes (network participation) |
| 53551 | OmniProtocol (P2P binary RPC) | yes |
| 7047 | TLSNotary attestation | only if others use your notary |
| 9090 / 9091 | node metrics / Prometheus | no — firewall/VPN |
| 3000 | Grafana | no — firewall/VPN |
| 5432 / 5332 | PostgreSQL (compose / bare-metal) | no — never |

Devnet RPC ports: node-1 `53551`, node-2 `53553`, node-3 `53555`,
node-4 `53557`.
