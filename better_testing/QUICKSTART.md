# Quickstart

Get a local devnet running and validated in under 5 minutes.

## Prerequisites

- **Bun** installed
- **Docker** running (the devnet spins up containers)
- Node repo dependencies installed (`bun install` from repo root)

## 1. Health check

```bash
bun run testenv:doctor
```

This verifies Docker, Bun, ports, and config are ready. Fix anything it flags before continuing.

## 2. Boot the devnet and run the release gate

```bash
bun run testenv:prod-gate:local -- --build-first
```

This single command:
1. Builds the node from source
2. Spins up a local multi-node devnet
3. Runs the must-pass release gate suite (consensus, GCR, transfers, ZK, web2, omni, etc.)
4. Produces a report in `better_testing/runs/_latest/prod-gate.latest.md`

If this passes, your local build is in good shape.

## 3. Run a single scenario (optional)

```bash
better_testing/scripts/run-scenario.sh <scenario> [--build]
```

Examples:

```bash
better_testing/scripts/run-scenario.sh consensus_tx_inclusion --build
better_testing/scripts/run-scenario.sh gcr_identity_smoke
better_testing/scripts/run-scenario.sh zk_commitment_smoke
```

The full scenario list is in `better_testing/loadgen/src/main.ts`.

## 4. Check the report

```bash
bun run testenv:latest
```

Reports land in `better_testing/runs/_latest/`.

## What's next

For the full guide — run order, coverage matrix, scope rules, and one-off scenario details — see [README.md](./README.md).
