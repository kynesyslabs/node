# testing/loadgen

This folder contains the **scenario implementations**.

Read `testing/README.md` first. This file explains the narrow question: how individual scenarios are executed.

## What Runs Here

The loadgen registry lives in:

- `testing/loadgen/src/main.ts`

Scenarios are selected with:

```bash
SCENARIO=<name> bun testing/loadgen/src/main.ts
```

Normally you should prefer the wrapper:

```bash
testing/scripts/run-scenario.sh <scenario> [--build] [--env KEY=VALUE]
```

## Run Modes

### From the host through the wrapper

```bash
testing/scripts/run-scenario.sh consensus_tx_inclusion --build
testing/scripts/run-scenario.sh multichain_parser_execute_smoke
```

### Directly inside the devnet image

```bash
cd devnet
docker compose up -d --build

SCENARIO=peer_discovery_smoke \
docker compose -f docker-compose.yml -f ../testing/docker-compose.perf.yml \
run --rm --no-deps --build loadgen
```

## Important Boundary

`loadgen/` contains more scenarios than the current active-feature coverage contract.

That is intentional.

Interpret the registry like this:

- active implemented feature scenarios
- historical token scenarios kept for archaeology and future reactivation
- helper / observation / settle scenarios

Do **not** assume:

- every registered scenario is part of the current release gate
- every registered scenario counts toward active-feature completeness

For that decision, use:

- `docs/references/active-feature-test-coverage-matrix.md`

## Scenario Families

Current registry includes families such as:

- native transfers
- GCR
- consensus
- peer sync
- multichain / XM
- omni
- ZK
- TLSNotary
- Web2 / DAHR
- IM
- FHE
- incentives
- MCP
- L2PS
- token historical scenarios

## Artifacts

Each run writes under:

- `testing/runs/<RUN_ID>/`

Typical outputs:

- `*.summary.json`
- `*.timeseries.jsonl`

## Historical Status

Token-related scenarios are still documented by the registry because they exist and are runnable in the harness, but they are not currently part of the active-feature claim for this repo.
