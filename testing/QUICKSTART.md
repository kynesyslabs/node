# Quickstart

Get a local devnet running and validated in under 5 minutes.

## Prerequisites

- **Bun** installed
- **Docker** running (the devnet spins up containers)
- Node repo dependencies installed (`bun install` from repo root)

## 1. One-time devnet setup

This generates node identities, peerlists, and the `.env` file:

```bash
testing/devnet/scripts/setup.sh
```

You only need to do this once (or after wiping `testing/devnet/identities/`).

## 2. Health check

```bash
bun run testenv:doctor
```

This verifies Docker, Bun, ports, and config are ready. Fix anything it flags before continuing.

## 3. Boot the devnet and run the release gate

```bash
bun run testenv:prod-gate:local -- --build-first
```

This single command:
1. Builds the node Docker image from source
2. Spins up a local 4-node devnet (via `testing/devnet/docker-compose.yml`)
3. Waits for consensus health
4. Runs the must-pass release gate suite (consensus, GCR, transfers, ZK, web2, omni, etc.)
5. Produces a report in `testing/runs/_latest/prod-gate.latest.md`

If this passes, your local build is in good shape.

## 4. Run a single scenario (optional)

```bash
testing/scripts/run-scenario.sh <scenario> [--build]
```

Examples:

```bash
testing/scripts/run-scenario.sh consensus_tx_inclusion --build
testing/scripts/run-scenario.sh gcr_identity_smoke
testing/scripts/run-scenario.sh zk_commitment_smoke
```

The full scenario list is in `testing/loadgen/src/main.ts`.

## 5. Check the report

```bash
bun run testenv:latest
```

Reports land in `testing/runs/_latest/`.

## Directory layout

Everything lives under `testing/`:

- `testing/devnet/` - Docker infrastructure (compose, identities, postgres, node images)
- `testing/scripts/` - Host-side runners and wrappers
- `testing/loadgen/` - Scenario implementations
- `testing/runs/` - Report artifacts

The `testenv:` commands manage the devnet lifecycle and run the test scenarios.

## What's next

For the full guide -- run order, coverage matrix, scope rules, and one-off scenario details -- see [README.md](./README.md).
