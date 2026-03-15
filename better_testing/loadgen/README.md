# better_testing/loadgen

Local perf harness scripts intended to run **inside the devnet docker network**.

For the current coverage contract and the active-feature boundary, use:

- `docs/references/active-feature-test-coverage-matrix.md`
- `docs/specs/active-feature-test-addition-proposal.md`
- `docs/discoveries/test-environment-journal.md` for historical execution notes

This README explains how to run scenarios. It should not be treated as the authoritative statement that every registered scenario counts toward active feature coverage.

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

Tip: for repeated runs without touching the node containers, prefer:

```bash
cd devnet
docker compose up -d --build
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml run --rm --no-deps --build loadgen
```

Note: `loadgen` runs inside the `demos-devnet-node` image. If you change `better_testing/loadgen/*`, rebuild the image first:
```bash
cd devnet
docker compose build node-1
```

## RPC ramp (Phase 1.1)

Quickly sweeps concurrency to find the HTTP/RPC knee point:

```bash
cd devnet
docker compose up -d --build

RUN_ID=rpc-ramp-$(date +%Y%m%d-%H%M%S) \
SCENARIO=rpc_ramp \
RAMP_CONCURRENCY=10,50,100,200 \
STEP_DURATION_SEC=10 \
COOLDOWN_SEC=2 \
RPC_METHOD=ping \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit --build loadgen
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
- `WAIT_FOR_TX_SEC`: wait up to N seconds for the tx pipeline to be ready (via `nodeCall` `crypto.getIdentity`) (default 120)
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
- `better_testing/runs/<RUN_ID>/rpc.summary.json`
- `better_testing/runs/<RUN_ID>/rpc.timeseries.jsonl`
- `better_testing/runs/<RUN_ID>/transfer.summary.json`
- `better_testing/runs/<RUN_ID>/transfer.timeseries.jsonl`
- `better_testing/runs/<RUN_ID>/token_smoke.summary.json`
- `better_testing/runs/<RUN_ID>/token_transfer.summary.json`
- `better_testing/runs/<RUN_ID>/token_transfer.timeseries.jsonl`
- `better_testing/runs/<RUN_ID>/token_transfer_ramp.summary.json`
- `better_testing/runs/<RUN_ID>/token_mint.summary.json`
- `better_testing/runs/<RUN_ID>/token_mint.timeseries.jsonl`
- `better_testing/runs/<RUN_ID>/token_mint_ramp.summary.json`
- `better_testing/runs/<RUN_ID>/token_burn.summary.json`
- `better_testing/runs/<RUN_ID>/token_burn.timeseries.jsonl`
- `better_testing/runs/<RUN_ID>/token_burn_ramp.summary.json`

Note: `loadgen` runs as a non-root user by default (`LOADGEN_UID=1000`, `LOADGEN_GID=1000`) so run outputs are host-writable.

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

## Token smoke (Phase 3)

Creates a token (unless `TOKEN_ADDRESS` is provided), optionally distributes balances to the first 2 wallets, then performs a single token transfer and checks balances.

```bash
cd devnet
docker compose up -d --build

RUN_ID=token-smoke-$(date +%Y%m%d-%H%M%S) \
SCENARIO=token_smoke \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit --build loadgen
```

Notes:
- Token creation/distribution are consensus-applied, so on fresh devnet starts you may need higher waits:
  - `TOKEN_WAIT_EXISTS_SEC` (default 120)
  - `TOKEN_WAIT_DISTRIBUTION_SEC` (default 120)
- Token transactions are sent with `tx.content.type="native"` (not `demoswork`) to avoid the demosWork script engine trying to interpret token payloads as `DemoScript` (which caused occasional `script.operationOrder` errors in responses).
- Smoke scenarios also run an optional **cross-node consistency gate** (default enabled) after the tx is applied on the primary target:
  - `CROSS_NODE_CHECK` (default true)
  - `CROSS_NODE_TIMEOUT_SEC` (default 120)
  - `CROSS_NODE_POLL_MS` (default 500)
- Smoke scenarios also run an optional **holder-pointer gate** (default enabled) to ensure holder token pointers match balances:
  - `HOLDER_POINTER_CHECK` (default true)
  - `HOLDER_POINTER_TIMEOUT_SEC` (default 120)
  - `HOLDER_POINTER_POLL_MS` (default 500)
  - Requires nodeCall `token.getHolderPointers` (ensure your devnet image is rebuilt).

## Token mint/burn smoke (Phase 3.3)

Owner-only mint (deployer mints to wallet-2) and burn (wallet-1 burns own balance):

```bash
cd devnet
docker compose up -d --build

RUN_ID=token-mint-smoke-$(date +%Y%m%d-%H%M%S) \
SCENARIO=token_mint_smoke \
TOKEN_MINT_AMOUNT=1 \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml run --rm --no-deps --build loadgen
```

```bash
cd devnet
docker compose up -d --build

RUN_ID=token-burn-smoke-$(date +%Y%m%d-%H%M%S) \
SCENARIO=token_burn_smoke \
TOKEN_BURN_AMOUNT=1 \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml run --rm --no-deps --build loadgen
```

## Token transfer loadgen (Phase 3.1)

Benchmarks token `transfer` transactions through the same public RPC surface as clients.

```bash
cd devnet
docker compose up -d --build

RUN_ID=token-transfer-$(date +%Y%m%d-%H%M%S) \
SCENARIO=token_transfer \
CONCURRENCY=4 \
INFLIGHT_PER_WALLET=2 \
TOKEN_TRANSFER_AMOUNT=1 \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit --build loadgen
```

Post-run convergence checks (recommended to keep on, strict mode optional):
- `POST_RUN_SETTLE_CHECK` (default true)
- `POST_RUN_SETTLE_STRICT` (default false)
- `POST_RUN_SETTLE_TIMEOUT_SEC` (default 120)
- `POST_RUN_SETTLE_POLL_MS` (default 500)
- `POST_RUN_SETTLE_SAMPLE_ADDRESSES` (default 8)
- `POST_RUN_HOLDER_POINTER_CHECK` (default true)
- `POST_RUN_HOLDER_POINTER_STRICT` (default false)
- `POST_RUN_HOLDER_POINTER_TIMEOUT_SEC` (default 120)
- `POST_RUN_HOLDER_POINTER_POLL_MS` (default 500)

Optional networking hygiene:
- `FETCH_TIMEOUT_MS` (default unset/disabled): if set, wraps `fetch()` with an AbortController timeout to avoid hung RPC calls stalling a loadgen step.

## Token transfer ramp (Phase 3.2)

```bash
cd devnet
docker compose up -d --build

RUN_ID=token-transfer-ramp-$(date +%Y%m%d-%H%M%S) \
SCENARIO=token_transfer_ramp \
RAMP_CONCURRENCY=1,2,4 \
STEP_DURATION_SEC=15 \
COOLDOWN_SEC=3 \
INFLIGHT_PER_WALLET=2 \
TOKEN_TRANSFER_AMOUNT=1 \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit --build loadgen
```

Inflight ramp (keeps `CONCURRENCY` fixed and sweeps `INFLIGHT_PER_WALLET`):

```bash
cd devnet
docker compose up -d --build

RUN_ID=token-transfer-inflight-ramp-$(date +%Y%m%d-%H%M%S) \
SCENARIO=token_transfer_ramp \
CONCURRENCY=4 \
RAMP_INFLIGHT_PER_WALLET=1,2,4,6,8 \
STEP_DURATION_SEC=20 \
COOLDOWN_SEC=5 \
TOKEN_TRANSFER_AMOUNT=1 \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit --build loadgen
```

Note: `token_transfer_ramp` bootstraps/distributes a token once, then reuses the same `TOKEN_ADDRESS` for the remaining steps for more stable results.

## Token mint loadgen (Phase 3.4)

Owner-only mint throughput. Uses **wallet-1 (deployer/owner)** for all txs, mints to `RECIPIENTS` (defaults to all loaded wallets).

```bash
cd devnet
docker compose up -d --build

RUN_ID=token-mint-$(date +%Y%m%d-%H%M%S) \
SCENARIO=token_mint \
CONCURRENCY=4 \
INFLIGHT_PER_WALLET=4 \
TOKEN_MINT_AMOUNT=1 \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit --build loadgen
```

Note: because this is owner-only, increasing throughput mostly comes from `INFLIGHT_PER_WALLET` (single-account nonce stream), not adding more wallets.

The same post-run convergence checks as `token_transfer` apply.

## Token mint ramp (Phase 3.5)

```bash
cd devnet
docker compose up -d --build

RUN_ID=token-mint-ramp-$(date +%Y%m%d-%H%M%S) \
SCENARIO=token_mint_ramp \
RAMP_CONCURRENCY=1,2,4,8 \
STEP_DURATION_SEC=15 \
COOLDOWN_SEC=3 \
INFLIGHT_PER_WALLET=4 \
TOKEN_MINT_AMOUNT=1 \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit --build loadgen
```

## Token burn loadgen (Phase 3.6)

Owner-only burn throughput. Uses **wallet-1 (owner)** and burns from its own balance.

```bash
cd devnet
docker compose up -d --build

RUN_ID=token-burn-$(date +%Y%m%d-%H%M%S) \
SCENARIO=token_burn \
CONCURRENCY=4 \
INFLIGHT_PER_WALLET=4 \
TOKEN_BURN_AMOUNT=1 \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit --build loadgen
```

The same post-run convergence checks as `token_transfer` apply.

## Token burn ramp (Phase 3.7)

```bash
cd devnet
docker compose up -d --build

RUN_ID=token-burn-ramp-$(date +%Y%m%d-%H%M%S) \
SCENARIO=token_burn_ramp \
RAMP_CONCURRENCY=1,2,4,8 \
STEP_DURATION_SEC=15 \
COOLDOWN_SEC=3 \
INFLIGHT_PER_WALLET=4 \
TOKEN_BURN_AMOUNT=1 \
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml up --abort-on-container-exit --build loadgen
```

### Run from host (less stable due to host<->docker NAT)

```bash
TARGETS=http://localhost:53551 DURATION_SEC=15 CONCURRENCY=50 bun better_testing/loadgen/src/rpc_loadgen.ts
```
