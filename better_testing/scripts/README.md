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

## Token perf baseline

```bash
./better_testing/scripts/token-perf-baseline.sh --build
./better_testing/scripts/token-perf-baseline.sh --with-pointers
```

By default, the baseline runner sets `POST_RUN_HOLDER_POINTER_CHECK=false` to reduce output/noise; use `--with-pointers` to re-enable it.
