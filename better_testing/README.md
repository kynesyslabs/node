# better_testing

This folder contains the **devnet test/load harness** used to validate correctness (cross-node convergence) and measure performance (TPS/latency). It’s designed to be runnable without changing node code, but it will often *surface* node bugs that we then fix upstream.

For deeper investigation notes and past runs, see `better_testing/research.md`.

## Quick start

1) Start devnet (4 nodes + postgres):
```bash
cd devnet
docker compose up -d
```

2) Run a scenario (recommended wrapper):
```bash
better_testing/scripts/run-scenario.sh token_smoke
better_testing/scripts/run-scenario.sh token_script_transfer_ramp --env SCRIPT_SET_STORAGE=true --env RAMP_INFLIGHT_PER_WALLET=1,2,4,8
```

Chaos/resync run (restart a follower mid-load, then verify convergence):
```bash
better_testing/scripts/run-chaos-token-script-transfer.sh --reset --build --duration-sec 30 --delay-sec 8 --env SCRIPT_SET_STORAGE=true
```
Notes:
- `--reset` starts from a clean devnet state (`docker compose down -v` + `up -d`).
- The chaos wrapper disables `token_settle_check`’s mempool-drain gate and uses longer settle timeouts by default, because the network may take a while to apply committed state after a follower restart under load.

Committed-read probe under load (task `node-y3g.9.13`):
```bash
better_testing/scripts/run-token-observe-under-load.sh --reset --plain --load-sec 30 --concurrency 4 --observe-sec 120 --settle-sec 180 --tail 10
better_testing/scripts/run-token-observe-under-load.sh --reset --scripted --load-sec 60 --concurrency 8 --observe-sec 170 --settle-sec 180 --tail 10
```
This produces `token_observe.timeseries.jsonl` and runs a local analysis pass (`better_testing/scripts/analyze-token-observe.ts`) to assert “no divergence on non-null hashes” + tail convergence.
Verified example RUN_IDs:
- `token-observe-under-load-plain-20260302-130537`
- `token-observe-under-load-scripted-20260302-132018`

3) Inspect artifacts:
- `better_testing/runs/<RUN_ID>/*.summary.json`
- `better_testing/runs/<RUN_ID>/*.timeseries.jsonl` (when enabled; good input for future Grafana/Prometheus)

Notes:
- In loadgens, `ok` only counts transactions accepted (`result===200`); rejected txs are counted in `error` with `errorSamples`.
- Token read probes prefer committed-only endpoints (`token.getCommitted`, `token.getBalanceCommitted`, `token.callViewCommitted`). During sync/consensus the node may respond with `result===409` (`STATE_IN_FLUX`); scenarios treat those samples as transient and retry/skip as appropriate.

## When to rebuild

The `loadgen` runs **inside Docker** using the same image as devnet (`demos-devnet-node`).

- If you changed `better_testing/loadgen/src/**`, run the scenario with `--build` to rebuild the image:
  - `better_testing/scripts/run-scenario.sh token_edge_cases --build`

## Scenario catalog (what they do)

The scenario is selected via `SCENARIO=...` (the wrapper script sets it for you).

**RPC / baseline**
- `rpc`: generic RPC call loop (configurable method/path).
- `rpc_ramp`: ramp RPC load over multiple steps.

**Native transfers**
- `transfer`: native transfer loadgen.
- `transfer_ramp`: ramp native transfer load.

**Tokens (no scripts)**
- `token_smoke`: deploy/bootstrap + one transfer + cross-node consistency + holder-pointer check.
- `token_transfer`: token transfer loadgen.
- `token_transfer_ramp`: ramp token transfers.
- `token_mint_smoke`: owner mints; asserts supply/balance deltas + cross-node checks.
- `token_burn_smoke`: owner burns; asserts supply/balance deltas + cross-node checks.
- `token_mint`: mint loadgen.
- `token_burn`: burn loadgen.
- `token_mint_ramp`: ramp mint load.
- `token_burn_ramp`: ramp burn load.
- `token_consensus_consistency`: small sequence (transfer + mint + burn) then waits for consensus and asserts identical state on all nodes.
- `token_query_coverage`: exercises read APIs (`token.get`, `token.getBalance`, `token.getHolderPointers`, missing-token behavior).
- `token_edge_cases`: negative cases (0 amounts, insufficient balance, missing token) + explicit **self-transfer no-op** invariant.

**Token ACL**
- `token_acl_smoke`: minimal grant + action + negative “attacker cannot mint/burn” checks, with cross-node settle + holder pointers.
- `token_acl_matrix`: permission grant/revoke matrix for a single permission.
- `token_acl_burn_matrix`, `token_acl_pause_matrix`, `token_acl_transfer_ownership_matrix`, `token_acl_multi_permission_matrix`, `token_acl_updateacl_compat`: broader ACL matrices.

**Token scripting**
- `token_script_smoke`: install/upgrade script and verify `token.callView` works across nodes.
- `token_script_hooks_correctness`: verifies before/after hooks for transfer/mint/burn and script `customState` counters converge across nodes.
- `token_script_rejects`: script-enforced reject (oversized transfer rejected; state unchanged) + valid transfer accepted.
- `token_script_transfer`: scripted transfer loadgen (hooks on every transfer).
- `token_script_transfer_ramp`: ramp scripted transfer load across steps.
- `token_script_mint`: scripted mint loadgen (owner mints; hooks execute on mint).
- `token_script_mint_ramp`: ramp scripted mint load.
- `token_script_burn`: scripted burn loadgen (owner burns; hooks execute on burn).
- `token_script_burn_ramp`: ramp scripted burn load.
- `token_settle_check`: reusable post-run verifier (cross-node convergence for balances + optional script counters) for an existing `TOKEN_ADDRESS`.
- `token_observe`: time-series probe for an existing `TOKEN_ADDRESS` (per-node: last block number/hash, mempool size, balances, and stable state hashes). Useful to debug “nodes agree on last block but disagree on token state”.

**IM / messaging**
- `im_online`: IM “online” workload (when enabled).
- `im_online_ramp`: ramp IM workload.

## Common env knobs

You can pass env vars via the wrapper: `--env KEY=VALUE`.

**Harness / run control**
- `RUN_ID`: output folder name under `better_testing/runs/` (auto-generated if omitted).
- `TARGETS`: comma-separated internal RPC URLs (defaults to node-1..4).
- `QUIET`: `true|false` (quiet reduces stdout noise).

**Load shape**
- `DURATION_SEC`, `CONCURRENCY`
- Ramp: `RAMP_CONCURRENCY=1,2,4,8`, `RAMP_INFLIGHT_PER_WALLET=1,2,4`, `STEP_DURATION_SEC`, `COOLDOWN_SEC`

**Token bootstrap**
- `TOKEN_ADDRESS` (reuse an existing token)
- `TOKEN_BOOTSTRAP=true|false`, `TOKEN_DISTRIBUTE=true|false`
- `TOKEN_INITIAL_SUPPLY`, `TOKEN_DISTRIBUTE_AMOUNT`, `TOKEN_TRANSFER_AMOUNT`, `TOKEN_MINT_AMOUNT`, `TOKEN_BURN_AMOUNT`

**Token scripting perf**
- `SCRIPT_WORK_ITERS` (CPU loop inside hooks)
- `SCRIPT_SET_STORAGE=true|false` (whether hooks write to `customState`)

## Post-run consistency checks (recommended)

Most load scenarios will create/reuse a token and then emit a `*.summary.json`. For performance runs, it’s often useful to run an explicit post-run verifier against the resulting `TOKEN_ADDRESS`.

Example (verify balances + holder pointers + script counters across all nodes):
```bash
better_testing/scripts/run-scenario.sh token_settle_check \
  --env TOKEN_ADDRESS=0x... \
  --env EXPECT_SCRIPT=true \
  --env SETTLE_WALLETS=4
```

Example (observe over time after a load run):
```bash
better_testing/scripts/run-scenario.sh token_observe \
  --env TOKEN_ADDRESS=0x... \
  --env OBSERVE_SEC=180 \
  --env OBSERVE_POLL_MS=1000 \
  --env OBSERVE_WALLETS=4
```

**token_settle_check knobs**
- `ADDRESSES`: comma-separated list of addresses to check balances for (in addition to derived wallets).
- `SETTLE_WALLETS`: derive first N wallets from `WALLETS_MNEMONICS` (default `4`).
- Optional preflight (helps avoid “pending tx” skew):
  - `BLOCK_SYNC_ENABLE=1` with `BLOCK_SYNC_TIMEOUT_SEC`, `BLOCK_SYNC_POLL_MS`, `BLOCK_MAX_SKEW`, `BLOCK_STABLE_POLLS`
  - `MEMPOOL_DRAIN_ENABLE=1` with `MEMPOOL_DRAIN_TIMEOUT_SEC`, `MEMPOOL_DRAIN_POLL_MS`, `MEMPOOL_DRAIN_STABLE_POLLS`
  - `REQUIRE_MEMPOOL_DRAIN=true|false` (default `true`): fail fast if mempool doesn’t drain, since `token.*` reads may include pending tx effects.
- `CROSS_NODE_TIMEOUT_SEC`, `CROSS_NODE_POLL_MS`: balance/totalSupply cross-node convergence.
- `HOLDER_POINTER_CHECK=true|false`, `HOLDER_POINTER_TIMEOUT_SEC`, `HOLDER_POINTER_POLL_MS`
- Script convergence (when `EXPECT_SCRIPT=true`):
  - `SCRIPT_HOOKCOUNTS_VIEW` (default `getHookCounts`)
  - `SCRIPT_SETTLE_TIMEOUT_SEC`, `SCRIPT_SETTLE_POLL_MS`
  - `SCRIPT_STABLE_POLLS` (default `3`): require N consecutive identical reads across nodes before passing.

**token_observe knobs**
- `OBSERVE_SEC`, `OBSERVE_POLL_MS`
- `OBSERVE_WALLETS` (default `4`) or `ADDRESSES=0x...,0x...`
- `INCLUDE_MEMPOOL=true|false`, `INCLUDE_TOKEN_GET=true|false`, `INCLUDE_SCRIPT_STATE=true|false`
- `INCLUDE_RAW=true|false` (can get large; keep off unless needed)
