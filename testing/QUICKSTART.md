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

## 4. Run a single scenario

List all available scenarios:

```bash
testing/scripts/run-scenario.sh --list
```

Run a specific scenario:

```bash
testing/scripts/run-scenario.sh <scenario> [--build]
```

Examples:

```bash
testing/scripts/run-scenario.sh consensus_tx_inclusion --build
testing/scripts/run-scenario.sh gcr_identity_smoke
testing/scripts/run-scenario.sh zk_commitment_smoke
testing/scripts/run-scenario.sh web2_url_validation_smoke --build
testing/scripts/run-scenario.sh omni_connection_smoke
```

**Note:** If you have uncommitted changes in `src/`, `testing/devnet/`, `testing/loadgen/src/`, `package.json`, `bun.lock`, or `tsconfig.json`, you must pass `--build` to rebuild the Docker image. Otherwise the script will refuse to run against a potentially stale image. Alternatively, commit your changes first.

## 5. Check the report

```bash
bun run testenv:latest
```

This prints the most recent report files. It does **not** run any tests -- it only shows previous results from `testing/runs/_latest/`.

## Available scenarios

### Core infrastructure
- `rpc` / `rpc_ramp` -- RPC endpoint load testing
- `transfer` / `transfer_ramp` -- Native transfer load testing

### Consensus
- `consensus_block_production` -- Block production validation
- `consensus_tx_inclusion` -- Transaction inclusion verification
- `consensus_secretary_rotation` -- Secretary rotation handling
- `consensus_rollback_smoke` -- Rollback recovery
- `consensus_partition_recovery` -- Network partition recovery

### Peer sync
- `peer_discovery_smoke` -- Peer discovery validation
- `sync_catchup_smoke` / `sync_consistency` / `sync_under_load` -- Sync scenarios

### GCR / Identity
- `gcr_identity_smoke` / `gcr_identity_remove` / `gcr_identity_loadgen`
- `gcr_identity_matrix` / `gcr_identity_xm_smoke` / `gcr_points_smoke`

### Omni protocol
- `omni_connection_smoke` / `omni_message_roundtrip`
- `omni_reconnection` / `omni_throughput`

### ZK
- `zk_commitment_smoke` / `zk_attestation_smoke`
- `zk_merkle_inclusion` / `zk_proof_loadgen`

### Multichain / XM
- `multichain_parser_rejects` / `multichain_parser_execute_smoke`
- `multichain_dispatcher_aggregation`

### Web2 / DAHR
- `web2_url_validation_smoke` / `web2_sanitization_smoke` / `web2_dahr_rejects`

### TLSNotary
- `tlsnotary_routes_smoke` / `tlsnotary_verify_rejects`

### IM / Signaling
- `im_register_discover_smoke` / `im_message_roundtrip`
- `im_online` / `im_online_ramp`

### FHE
- `fhe_scalar_smoke` / `fhe_arithmetic_smoke`

### Incentives
- `incentive_referral_code_smoke` / `incentive_referral_eligibility`
- `incentive_point_score_matrix`

### MCP
- `mcp_tool_factory_smoke` / `mcp_server_registry_smoke` / `mcp_server_creation_smoke`

### L2PS
- `l2ps_live_participation_smoke` / `l2ps_live_submission_relay_smoke`
- `l2ps_service_status_smoke` / `l2ps_statistics_snapshot`
- `l2ps_batch_submission_smoke` / `l2ps_batch_grouping_smoke`
- And many more L2PS scenarios (run `--list` for the full set)

### Token core suite
```bash
bun run testenv:tokens:local -- --build-first
```

Maintained token-core scenarios:

- `token_smoke`
- `token_mint_smoke`
- `token_burn_smoke`
- `token_acl_smoke`
- `token_query_coverage`
- `token_consensus_consistency`
- `token_edge_cases`
- `token_script_smoke`
- `token_script_rejects`
- `token_script_hooks_correctness`

Additional token load, matrix, and complex-policy scenarios remain runnable through `testing/scripts/run-scenario.sh`, but they are not yet part of the maintained core suite.

## Directory layout

Everything lives under `testing/`:

- `testing/devnet/` -- Docker infrastructure (compose, identities, postgres, node images)
- `testing/scripts/` -- Host-side runners and wrappers
- `testing/loadgen/` -- Scenario implementations
- `testing/runs/` -- Report artifacts

The `testenv:` commands manage the devnet lifecycle and run the test scenarios.

## What's next

For the full guide -- run order, coverage matrix, scope rules, and one-off scenario details -- see [README.md](./README.md).
