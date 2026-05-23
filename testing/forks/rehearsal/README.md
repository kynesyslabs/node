# DEM → OS Fork Activation Rehearsal Harness

Implementation of the 8 rehearsal scenarios specified in
`forking/REHEARSAL_RESULTS.md`. Drives the existing 4-node devnet
(`testing/devnet/`) under fork activation against PostgreSQL, exercising
the migration on a real database instead of the in-memory SQLite that
the unit tests use.

## Prerequisites

1. Docker + Docker Compose installed and running.
2. Bun installed.
3. `pg` client library is already a node-modules dependency of the repo —
   `bun install` is enough.
4. Postgres host port 5432 must be free (override with
   `POSTGRES_HOST_PORT=5532` in `testing/devnet/.env` if it conflicts).

The harness queries Postgres directly from the host. The host port is
exposed by the devnet docker-compose (added together with the rehearsal
infra under the `chore(devnet)` commit).

### Required free host ports

The devnet (and therefore every rehearsal scenario) binds the following
host ports. All of them must be free on the host before running. Each
one is overridable via `testing/devnet/.env` (or `export VAR=...` in the
shell that launches the rehearsal):

| Port | Service | Override variable | Default |
|---|---|---|---|
| Postgres | shared postgres-16 | `POSTGRES_HOST_PORT` | `5432` |
| tlsnotary | notary-server | `TLSNOTARY_HOST_PORT` | `7047` |
| node-1 RPC | HTTP RPC | `NODE1_PORT` | `53551` |
| node-1 omni | P2P | `NODE1_OMNI_PORT` | `53552` |
| node-2 RPC | HTTP RPC | `NODE2_PORT` | `53553` |
| node-2 omni | P2P | `NODE2_OMNI_PORT` | `53554` |
| node-3 RPC | HTTP RPC | `NODE3_PORT` | `53555` |
| node-3 omni | P2P | `NODE3_OMNI_PORT` | `53556` |
| node-4 RPC | HTTP RPC | `NODE4_PORT` | `53557` |
| node-4 omni | P2P | `NODE4_OMNI_PORT` | `53558` |
| node-5 RPC (rehearsal profile only) | HTTP RPC | `NODE5_PORT` | `53559` |
| node-5 omni (rehearsal profile only) | P2P | `NODE5_OMNI_PORT` | `53560` |
| node-1 signaling | WebRTC signaling | `NODE1_SIGNALING_PORT` | `3005` |
| node-2 signaling | WebRTC signaling | `NODE2_SIGNALING_PORT` | `3006` |
| node-3 signaling | WebRTC signaling | `NODE3_SIGNALING_PORT` | `3007` |
| node-4 signaling | WebRTC signaling | `NODE4_SIGNALING_PORT` | `3008` |
| node-5 signaling (rehearsal profile only) | WebRTC signaling | `NODE5_SIGNALING_PORT` | `3009` |

Quick check: `lsof -nP -iTCP -sTCP:LISTEN | grep -E '5432|7047|5355[1-9]|5356[0-9]|3005|3006|3007|3008|3009'`.

### Troubleshooting: port conflicts

If a port above is already taken by another local service (e.g. you keep
a long-running standalone `tlsnotary` at `0.0.0.0:7047`, or a developer
Postgres at `0.0.0.0:5432`), set the corresponding `*_HOST_PORT` env var
(or `.env` value) to a free port. Only the host side of the mapping
changes; the in-container ports and inter-container hostnames are
unaffected, so the rehearsal harness, the node containers, and the
postgres readiness checks all continue to work without any further code
change. The rehearsal driver reads `POSTGRES_HOST_PORT` from the
environment to point its `pg` client at the right host port; the other
variables only affect docker-compose's host-side bind.

## Running

```bash
# Run every scenario in dependency order.
bash testing/forks/rehearsal/run-all.sh

# Run a single scenario.
bun run testing/forks/rehearsal/scenarios/01-all-cross-fork.ts

# On failure, keep the devnet running for inspection.
bun run testing/forks/rehearsal/scenarios/01-all-cross-fork.ts --keep-state
```

Each scenario brings the devnet up from a clean state (its own
`docker compose down -v`), runs assertions, and tears down. There is no
state chained across scenarios.

## What the harness does NOT do

- It does not modify `data/genesis.json` permanently. Each scenario
  stages a rehearsal genesis at that path before building, then restores
  the production genesis (saved to `data/genesis.json.rehearsal-backup`)
  on teardown — even on failure. If a scenario crashes hard, run
  `git checkout -- data/genesis.json` to be safe.
- It does not push to remote. Local runs only.
- It does not run any scenario as a CI job. Wall-clock per scenario is
  several minutes; the full suite is ~40 minutes. Keep it operator-driven
  for now.

## Scenario index

| # | File | Stakes | Validates |
|---|---|---|---|
| 4 | `04-genesis-hash-invariance.ts` | High | `BlockContent` does not include `forks` |
| 1 | `01-all-cross-fork.ts` | Base case | Postgres migration runs; peer convergence |
| 7 | `07-sum-invariant-audit.ts` | Medium | All 3 backends migrated, invariant holds |
| 8 | `08-idempotent-restart.ts` | **HIGHEST** | No double-migration on crash recovery |
| 5 | `05-cap-policy-fires-loud.ts` | High | Fail-loud cap contract on Postgres |
| 6 | `06-mid-flight-tx.ts` | Medium | Boundary-block tx handling |
| 2 | `02-validator-desync-recovery.ts` | High | Wipe + re-sync; loud failure on stale binary |
| 3 | `03-fresh-node-post-fork.ts` | **HIGHEST** | Migration runs during historical replay |

`run-all.sh` runs them in this exact order (per REHEARSAL_PLAN §4).

## Layout

```
testing/forks/rehearsal/
  README.md
  run-all.sh
  lib/
    devnetControl.ts       # docker compose wrappers, wait helpers
    nodeQueries.ts         # RPC + Postgres queries
    fixtures.ts            # cap-overflow seed helpers
    assertions.ts          # cross-node convergence checks
    composeOverrides.ts    # transient docker-compose overrides
    scenario.ts            # scenario lifecycle harness
  genesis/
    genesis-pre-fork.json  # no `forks` field
    genesis-fork-low.json  # activationHeight = 5  (scenarios 1, 2, 5, 8)
    genesis-fork-mid.json  # activationHeight = 10 (scenarios 6, 7)
  scenarios/
    01-all-cross-fork.ts
    02-validator-desync-recovery.ts
    03-fresh-node-post-fork.ts
    04-genesis-hash-invariance.ts
    05-cap-policy-fires-loud.ts
    06-mid-flight-tx.ts
    07-sum-invariant-audit.ts
    08-idempotent-restart.ts
```

## Adapters used

Three minimal adapters from the rehearsal-readiness audit
(`forking/REHEARSAL_RESULTS.md`):

1. **Genesis adapter — strategy (a) "stage at the build path"**.
   The image bakes `data/genesis.json` at build time. The harness
   copies one of the rehearsal genesis files over `data/genesis.json`
   before each `docker compose up --build`, with a backup at
   `data/genesis.json.rehearsal-backup`. Restored on teardown. Strategy
   (b), an env-var override, was rejected because it couples test
   infra to runtime config that production must never read.
2. **Postgres host port mapping**. Added to
   `testing/devnet/docker-compose.yml` as `5432:5432` (override with
   `POSTGRES_HOST_PORT` if needed).
3. **Node-5 service under the `rehearsal` profile**. Default
   `docker compose up` is unaffected; `docker compose --profile
   rehearsal up` brings up node-5. Generates 5 identities + a 5-entry
   peerlist via `NODE_COUNT=5 ./scripts/generate-{identities,peerlist}.sh`.

## Pre-fork binary simulation

The `DEMOS_DISABLE_FORK_MACHINERY` env var (added under the
`feat(forks)` commit) makes the loader and migration hook no-ops. The
harness uses it to simulate a pre-fork binary in scenario 2 (validator
desync) and scenario 4 (genesis hash invariance) without maintaining a
separate branch / image tag. **Production must never set this flag** —
its sole purpose is rehearsal.

## What is NOT exercised

- SDK v3 contract tests at the boundary — covered separately in the
  SDK repo (Session 13, `wireFormat.spec.ts`).
- Multi-day stability past the fork — out of scope for P5b; covered by
  P6 sustained testnet.
- Network partitions / Byzantine peers — accepted risk, see
  REHEARSAL_PLAN §5.
