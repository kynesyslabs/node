# testing/scripts

This folder contains the **host-side** commands that drive the local devnet test harness.

Read `testing/README.md` first. This file is the narrower runner reference.

## Main Commands

| Command | What it does |
|---|---|
| `bun run testenv:doctor` | checks local RPC/Omni health and prints recommended next commands |
| `bun run testenv:startup:local -- --build-first` | cold-boots the local devnet and validates startup |
| `bun run testenv:cluster:local -- --build-first` | runs scheduled cluster-health checks |
| `bun run testenv:prod-gate:local -- --build-first` | runs the must-pass local release gate |
| `bun run testenv:tokens:local -- --build-first` | runs the maintained token core suite |
| `bun run testenv:gcr:routine:local` | runs deterministic single-wallet GCR routine validation |
| `bun run testenv:l2ps:local -- --build-first` | runs the L2PS live suite |
| `bun run testenv:perf:baseline:local -- --build` | records the active-core baseline |
| `bun run testenv:soak:local -- --build` | runs the mixed active-feature soak |
| `testing/scripts/run-scenario.sh <scenario>` | runs one specific scenario |

## Rebuild Rule

Rebuild when you changed:

- `src/**`
- `testing/loadgen/src/**`
- `testing/devnet/**`
- `package.json`
- `bun.lock`
- `tsconfig.json`

The local runners now block unsafe no-build execution when those image inputs are dirty.

## Artifacts

Primary report outputs:

- `testing/runs/_latest/startup-cold-boot.latest.md`
- `testing/runs/_latest/cluster-health.latest.md`
- `testing/runs/_latest/prod-gate.latest.md`
- `testing/runs/_latest/gcr-routine.latest.md`
- `testing/runs/_latest/l2ps-live.latest.md`
- `testing/runs/_latest/active-core-baseline.latest.md`
- `testing/runs/_latest/cluster-soak.latest.md`
- `testing/runs/_latest/token-core.latest.md`

## Notes

- `run-scenario.sh` is for one-off execution, not for deciding what counts as active feature coverage.
- Token coverage is now maintained through the `token-core` suite.
- Broader token ramp, matrix, and complex-policy scenarios remain available through the wrapper, but they are not yet part of the maintained core suite.
