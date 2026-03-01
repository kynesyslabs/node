# better_testing

This folder contains the **devnet test/load harness** used to validate correctness (cross-node convergence) and measure performance (TPS/latency) without modifying node code.

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

3) Inspect artifacts:
- `better_testing/runs/<RUN_ID>/*.summary.json`
- `better_testing/runs/<RUN_ID>/*.timeseries.jsonl` (when enabled; good input for future Grafana/Prometheus)

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

