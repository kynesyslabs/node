# better_testing/loadgen

Local perf harness scripts intended to run **inside the devnet docker network**.

## RPC baseline loadgen (Phase 1)

Runs a high-throughput RPC client against one or more nodes and reports:
- total requests
- ok/error counts
- RPS (overall)
- latency p50/p95/p99 (based on sampled requests)

### Run inside devnet network (recommended)

```bash
cd devnet
docker compose up -d --build

# Phase 1: run loadgen service (overlay compose)
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit loadgen
```

## Transfer loadgen (Phase 2)

Benchmarks native token transfer TPS using the same public RPC surface as clients:
- builds a `native` transaction with `nativeOperation: "send"`
- `confirmTx` (gas + validity)
- `broadcastTx` (execution)

Run (inside devnet network):
```bash
cd devnet
docker compose up -d --build

SCENARIO=transfer docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit loadgen
```

Required env when `SCENARIO=transfer`:
- `RECIPIENTS`: comma-separated `0x...` addresses to send to

Optional env (recommended):
- `WAIT_FOR_RPC_SEC`: wait up to N seconds for each target RPC to become reachable (default 120)
- `QUIET`: silence noisy dependency logs (default true)
- `AVOID_SELF_RECIPIENT`: avoid sending to self if the sender address appears in `RECIPIENTS` (default true)
- `INFLIGHT_PER_WALLET`: number of concurrent in-flight txs per wallet (default 1)
- `EMIT_TIMESERIES`: append per-second JSONL points to the run folder (default true)
- `RUN_ID`: optional run identifier (default: ISO timestamp)

Wallet sourcing (defaults to devnet identities):
- `MNEMONICS_DIR=/wallets` (set by `better_testing/docker-compose.perf.yml`)
- `WALLET_FILES=node1.identity,node2.identity,node3.identity,node4.identity`

## Run artifacts

When running via the overlay compose, the loadgen container writes artifacts to the host:
- `better_testing/runs/<RUN_ID>/transfer.summary.json`
- `better_testing/runs/<RUN_ID>/transfer.timeseries.jsonl`

## Transfer ramp (Phase 2.1)

Runs a small step ramp to find the knee point quickly (prints a `transfer_ramp_summary` JSON):

```bash
cd devnet
docker compose up -d --build

SCENARIO=transfer_ramp \
RAMP_CONCURRENCY=1,2,4 \
STEP_DURATION_SEC=15 \
COOLDOWN_SEC=3 \
INFLIGHT_PER_WALLET=1 \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit loadgen
```

### Run from host (less stable due to host<->docker NAT)

```bash
TARGETS=http://localhost:53551 DURATION_SEC=15 CONCURRENCY=50 bun better_testing/loadgen/src/rpc_loadgen.ts
```
