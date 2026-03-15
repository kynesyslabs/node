# better_testing/scripts

Small host-side helpers to run `better_testing/loadgen` scenarios against the devnet Docker network.

Notes:
- The devnet compose files assume you run from `devnet/` so identity mounts resolve correctly.
- If you change `better_testing/loadgen/src/**`, rebuild the image with `--build` (slow).

## Run a scenario

```bash
./better_testing/scripts/run-scenario.sh token_edge_cases
./better_testing/scripts/run-scenario.sh token_acl_matrix --build
./better_testing/scripts/run-scenario.sh token_transfer_ramp --env RAMP_CONCURRENCY=1,2,4,8 --env STEP_DURATION_SEC=15
```

Artifacts land in `better_testing/runs/$RUN_ID/`.

## Run the cold-boot startup suite

```bash
bun run testenv:startup:local
```

This is a host-side suite, not a single loadgen scenario. It:
- tears down the local devnet with volumes
- starts it again
- waits for RPC and tx readiness
- verifies peer discovery and block production

Artifacts land in:
- `better_testing/runs/suite-startup-cold-boot-*/suite.summary.json`
- `better_testing/runs/_latest/startup-cold-boot.latest.md`

## Run the routine single-wallet GCR suite

```bash
bun run testenv:gcr:routine:local
```

This suite keeps GCR validation on the node-local deterministic path and avoids deferred SDK multi-instance concurrency work.

Artifacts land in:
- `better_testing/runs/_latest/gcr-routine.latest.md`

## Run the scheduled cluster-health suite

```bash
bun run testenv:cluster:local
```

This suite is the regular operational evidence set for local cluster health. It now includes the deeper `consensus_tx_inclusion` scenario because it forces a real on-chain state transition, while `sync_catchup_smoke` can be inconclusive when the cluster starts already converged.

Artifacts land in:
- `better_testing/runs/_latest/cluster-health.latest.md`

## Token perf baseline

```bash
./better_testing/scripts/token-perf-baseline.sh --build
./better_testing/scripts/token-perf-baseline.sh --with-pointers
```

By default, the baseline runner sets `POST_RUN_HOLDER_POINTER_CHECK=false` to reduce output/noise; use `--with-pointers` to re-enable it.
