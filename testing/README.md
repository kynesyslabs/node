# testing

This is the human entrypoint for the node test harness.

If you only read one file in this folder, read this one.

## What This Folder Is

`testing/` is the local devnet validation harness for the node repo. It covers:

- feature smoke validation
- local release gating
- cluster-health checks
- performance baselines
- soak runs
- one-off scenario execution

It is intentionally scoped to **active, implemented node features**.

It is **not** a claim that every registered scenario in `loadgen/` is part of current active-feature coverage.

## Coverage Status

Current status for this repo:

- active implemented feature families are covered at the feature-family level
- remaining open items are runtime bugs, local gate-health issues, or maintenance cleanup
- tokens are **not** part of the active-feature claim today because the node repo does not currently expose an implemented token runtime/query surface in `src/`

Authoritative docs:

- `docs/references/active-feature-test-coverage-matrix.md`
- `docs/discoveries/test-environment-journal.md`

Historical rationale:

- `docs/specs/active-feature-test-addition-proposal.md` `superseded`

Visual map:

- `testing/TESTING_MAP.md`

## Scope Rules

Count as active coverage:

- active and implemented node features
- suites and scenarios that exercise those features on the current repo/runtime

Do not count as active coverage:

- native bridge paths
- `storageProgram` placeholder behavior
- contract-runtime / storage-contract stubs
- historical token scenarios retained in the harness
- deferred SDK-repo concurrency work

## Start Here

### 1. Check local health

```bash
bun run testenv:doctor
```

### 2. If you changed node, devnet, or harness code, rebuild

Use rebuild-backed commands when you changed:

- `src/**`
- `testing/loadgen/src/**`
- `testing/devnet/**`
- `package.json`
- `bun.lock`
- `tsconfig.json`

Example:

```bash
bun run testenv:startup:local -- --build-first
```

### 3. Pick the right command for the job

| Goal | Command |
|---|---|
| Cold boot the cluster and verify startup | `bun run testenv:startup:local -- --build-first` |
| Run the must-pass local release gate | `bun run testenv:prod-gate:local -- --build-first` |
| Run scheduled operational cluster checks | `bun run testenv:cluster:local -- --build-first` |
| Run deterministic single-wallet GCR validation | `bun run testenv:gcr:routine:local` |
| Run L2PS live validation | `bun run testenv:l2ps:local -- --build-first` |
| Record active-core performance baseline | `bun run testenv:perf:baseline:local -- --build` |
| Run mixed active-feature soak | `bun run testenv:soak:local -- --build` |
| Run one specific scenario | `testing/scripts/run-scenario.sh <scenario> [--build]` |
| Show latest report links | `bun run testenv:latest` |

## Feature Coverage At A Glance

This is the practical human summary. For the canonical contract, use the matrix in `docs/references/active-feature-test-coverage-matrix.md`.

| Feature family | Covered now | Primary scenarios / suites | Normal evidence path |
|---|---|---|---|
| Native transfers | Yes | `transfer`, `transfer_ramp`, startup/consensus flows | active-core baseline, cluster suites |
| GCR / identity | Yes | `gcr_identity_smoke`, `gcr_identity_remove`, `gcr_identity_xm_smoke`, `gcr_points_smoke` | `gcr-routine`, `prod-gate` |
| Consensus | Yes | `consensus_block_production`, `consensus_tx_inclusion`, rollback/rotation/recovery scenarios | `startup-cold-boot`, `cluster-health`, `prod-gate` |
| Peer sync / discovery | Yes | `peer_discovery_smoke`, `sync_catchup_smoke`, `sync_consistency`, `sync_under_load` | `startup-cold-boot`, `cluster-health`, baseline |
| Multichain / XM | Yes | `multichain_parser_rejects`, `multichain_parser_execute_smoke`, `multichain_dispatcher_aggregation` | `prod-gate`, one-off |
| Omni | Yes | `omni_connection_smoke`, `omni_message_roundtrip`, `omni_reconnection`, `omni_throughput` | `prod-gate`, baseline |
| ZK | Yes | `zk_commitment_smoke`, `zk_attestation_smoke`, `zk_merkle_inclusion`, `zk_proof_loadgen` | `prod-gate`, baseline, soak |
| TLSNotary | Yes | `tlsnotary_routes_smoke`, `tlsnotary_verify_rejects` | `prod-gate`, one-off |
| Web2 / DAHR | Yes | `web2_url_validation_smoke`, `web2_sanitization_smoke`, `web2_dahr_rejects` | `prod-gate`, one-off |
| IM / signaling | Yes | `im_register_discover_smoke`, `im_message_roundtrip`, `im_online` | `prod-gate`, one-off |
| FHE | Yes | `fhe_scalar_smoke`, `fhe_arithmetic_smoke` | one-off |
| Incentives | Yes | referral and score scenarios | one-off |
| MCP factory / registry | Yes | MCP smoke scenarios | one-off |
| L2PS | Yes | broad L2PS family plus live-path smokes | `testenv:l2ps:local` |
| Storage handler mocked surface | Limited active surface only | `storage_handler_smoke` | one-off |

Historical but **not** part of current active-feature coverage:

- all `token_*` scenarios
- placeholder storage-program behavior
- inactive bridge / contract-runtime surfaces

## Recommended Run Order

For a local confidence pass:

1. `bun run testenv:doctor`
2. `bun run testenv:startup:local -- --build-first`
3. `bun run testenv:cluster:local -- --build-first`
4. `bun run testenv:prod-gate:local -- --build-first`
5. `bun run testenv:perf:baseline:local -- --build`
6. `bun run testenv:soak:local -- --build`

For a faster targeted pass:

1. `bun run testenv:doctor`
2. `bun run testenv:prod-gate:local -- --build-first`

## One-Off Scenario Runs

Use the wrapper:

```bash
testing/scripts/run-scenario.sh <scenario> [--build] [--env KEY=VALUE]
```

Examples:

```bash
testing/scripts/run-scenario.sh consensus_tx_inclusion --build
testing/scripts/run-scenario.sh multichain_parser_execute_smoke --build
testing/scripts/run-scenario.sh zk_commitment_smoke
```

The full scenario registry lives in:

- `testing/loadgen/src/main.ts`

Important boundary:

- scenario registration does not automatically mean “active coverage”
- many token scenarios are intentionally retained for archaeology and future reactivation only

## Reports And Artifacts

Artifacts land under:

- `testing/runs/<RUN_ID>/`
- `testing/runs/_latest/`

Most useful reports:

- `testing/runs/_latest/startup-cold-boot.latest.md`
- `testing/runs/_latest/cluster-health.latest.md`
- `testing/runs/_latest/prod-gate.latest.md`
- `testing/runs/_latest/gcr-routine.latest.md`
- `testing/runs/_latest/l2ps-live.latest.md`
- `testing/runs/_latest/active-core-baseline.latest.md`
- `testing/runs/_latest/cluster-soak.latest.md`

## Folder Guide

- `testing/README.md`
  - primary human guide
- `testing/TESTING_MAP.md`
  - visual overview
- `testing/scripts/README.md`
  - host-side runners and wrappers
- `testing/loadgen/README.md`
  - individual scenario runner details

Archived outdated snapshots:

- `history/testing/ASSESSMENT.2026-03-snapshot.md`
- `history/testing/AUDIT_REPORT.2026-03-snapshot.md`

## Outdated Material Policy

Live documentation in `testing/` should do one of two things:

- explain the current active harness
- explicitly mark itself as historical

If a doc cannot do that clearly, it should be archived instead of left in the live surface.
