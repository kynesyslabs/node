---
type: discovery
title: Test Environment Journal
date: 2026-03-10
status: active
tags: [testing, observability, loadgen, devnet, bugs]
author: agent
---

# Test Environment Journal

This file is the running observability journal for the current testing hardening phase.

## Purpose

- Keep findings, fixes, operational issues, and validated bugs in one readable place.
- Separate test-environment problems from real node or SDK bugs.
- Provide a quick handoff surface without needing to reconstruct state from chat or tracker comments.

## Current Recommended Workflow

- Prefer local suite execution for quick validation:
  - `bun run testenv:doctor`
  - `bun run testenv:doctor:verbose` when transport-level Omni logs are needed
  - `bun run testenv:latest` to read the latest markdown suite recap
  - `bun run testenv:verify:local` for the deterministic release gate
  - `bun run testenv:sanity:local`
  - `bun run testenv:cluster:local`
  - `bun run testenv:prod-gate:local`
  - `bun run testenv:gcr:local`
  - read the latest suite markdown summaries in `better_testing/runs/_latest/`
- Use direct local scenario execution when investigating a single failure:
  - `RUNS_DIR=better_testing/runs RUN_ID=<id> SCENARIO=<name> bun better_testing/loadgen/src/main.ts`
- If one node is degraded, prefer a healthy subset with:
  - `bun better_testing/scripts/run-suite.ts cluster-health --local --targets http://localhost:53551,http://localhost:53553,http://localhost:53554`
- Keep product bugs in `br` / Mycelium.
- Keep environment findings and operational observations here as well.

## Current Prod-Readiness Position

- The local prod-gate suite is now green on the healthy 4-node devnet.
- The missing piece is no longer the core gate path; it is cleanup of the remaining non-gate readiness items.
- A real `prod-gate` suite now exists in `better_testing/scripts/run-suite.ts`. It is intentionally stricter than `sanity` or `cluster-health` and includes:
  - healthy transport/core success paths
  - at least one IM delivery path
  - TLSNotary route/service readiness
  - Web2 safety rejects
  - multichain structured-error behavior
- As of 2026-03-13, that gate passes cleanly on localhost.

## 2026-03-14 - Coverage Documentation Normalized

- Added a single authoritative coverage reference:
  - `docs/references/active-feature-test-coverage-matrix.md`
- Added a constrained proposal for additional test work:
  - `docs/specs/active-feature-test-addition-proposal.md`
- Replaced stale coverage docs in:
  - `better_testing/ASSESSMENT.md`
  - `better_testing/AUDIT_REPORT.md`
- Clarified the active-feature boundary:
  - native bridge paths are not part of the active test-coverage completeness claim
  - `storageProgram` remains placeholder-only and should not be counted as active feature coverage
  - contract runtime / storage-contract execution remains out of scope until node-side implementation exists
- Current fresh gate evidence remains:
  - `better_testing/runs/_latest/prod-gate.latest.md`
  - `better_testing/runs/_latest/l2ps-live.latest.md`

- Practical result:
  - broad active-feature coverage exists and is runnable
  - but the correct claim is still “broad and evidenced,” not “exhaustive across every active feature and every operational dimension”

## Coverage Matrix Snapshot

This is the practical feature-coverage snapshot as of 2026-03-14. It is not a statement of exhaustive correctness; it is a statement of what has dedicated scenario coverage, what is release-gated, and what is still missing.

### Gate-Backed And Currently Healthy

- Omni basic connectivity:
  - `omni_connection_smoke`
- Consensus core path:
  - `consensus_block_production`
- Peer discovery core path:
  - `peer_discovery_smoke`
- GCR baseline healthy paths:
  - `gcr_identity_remove`
  - `gcr_identity_xm_smoke`
- ZK proof path:
  - `zk_proof_loadgen`
- IM healthy delivery path:
  - `im_message_roundtrip`
- TLSNotary route and reject semantics:
  - `tlsnotary_routes_smoke`
  - `tlsnotary_verify_rejects`
- Web2 safety baseline:
  - `web2_url_validation_smoke`
- Multichain structured reject baseline:
  - `multichain_parser_rejects`
- Release gate entrypoint:
  - `bun run testenv:verify:local`

### Broadly Covered But Not In The Prod Gate

- RPC/load behavior:
  - `rpc`, `rpc_ramp`
- Native transfer/load behavior:
  - `transfer`, `transfer_ramp`
- Token lifecycle and scripting:
  - token smoke, mint, burn, transfer, ACL matrices, query coverage, edge cases, settle/invariant checks, scripted policy scenarios
- GCR broader matrix/load behavior:
  - `gcr_identity_smoke`
  - `gcr_identity_loadgen`
  - `gcr_identity_matrix`
  - `gcr_points_smoke`
- Omni non-gate integration behavior:
  - `omni_message_roundtrip`
  - `omni_reconnection`
  - `omni_throughput`
- Consensus and sync deeper behavior:
  - `consensus_tx_inclusion`
  - `consensus_secretary_rotation`
  - `consensus_rollback_smoke`
  - `consensus_partition_recovery`
  - `sync_catchup_smoke`
  - `sync_consistency`
  - `sync_under_load`
- ZK broader path coverage:
  - `zk_commitment_smoke`
  - `zk_attestation_smoke`
  - `zk_merkle_inclusion`
- FHE:
  - `fhe_scalar_smoke`
  - `fhe_arithmetic_smoke`
- Incentive:
  - `incentive_referral_code_smoke`
  - `incentive_referral_eligibility`
  - `incentive_point_score_matrix`
- MCP:
  - `mcp_tool_factory_smoke`
  - `mcp_server_registry_smoke`
  - `mcp_server_creation_smoke`
- Multichain beyond rejects:
  - `multichain_parser_execute_smoke`
  - `multichain_dispatcher_aggregation`
- L2PS local internals plus live integration:
  - full local L2PS scenario family
  - `l2ps_live_participation_smoke`
  - `l2ps_live_submission_relay_smoke`
- Storage surfaces that currently exist in node code:
  - `storage_handler_smoke`
  - `storage_program_apply_smoke`

### Covered But Still Known-Bugged

- No currently tracked items in this bucket.

### Not Yet Represented By A Dedicated Scenario Family

- Bridges / native bridge:
  - node has bridge and native-bridge code paths, but there is no dedicated loadgen scenario family registered in `better_testing/loadgen/src/main.ts`
- ActivityPub / demoswork activitypub path:
  - code exists in transaction handling, but there is no dedicated scenario family
- Storage / storageProgram transaction surfaces:
  - `storage_handler_smoke` now locks in the current mocked `EndpointHandlers.handleStorage()` semantics that exist in node code today
  - `storage_program_apply_smoke` now locks in the current `HandleGCR.apply(... type="storageProgram")` placeholder semantics (`success: true`, `message: "Not implemented"`)
- Contract deploy / contract call:
  - intentionally not covered yet because the advertised contract runtime files and endpoint wiring are not present in the live node codebase
  - `src/features/contracts/CONTRACT_PHASES.md` is now an explicit status note that marks node-side contract runtime as unimplemented
- D402 payment:
  - transaction type exists, but no dedicated scenario family is registered
- Escrow as a first-class transaction surface:
  - there is token-script escrow-policy coverage, but not a dedicated `escrow` transaction scenario family
- IPFS as a feature surface:
  - configuration and metrics exist, but no dedicated feature scenarios are registered

### Practical Reading Of This Matrix

- Coverage breadth is high.
- Coverage depth is strong for tokens, L2PS, core node paths, and several integration surfaces.
- “Full coverage of all features” is still false because some whole product surfaces do not yet have dedicated scenarios at all, and some covered areas still carry active bugs.

### Remaining Readiness Gaps

- `bun run type-check-ts` still fails on a real repository-wide TypeScript backlog, so it remains a debt signal rather than the release gate itself.
- Mycelium needs occasional manual cleanup when duplicate tasks are created during rapid bug handoff.

## 2026-03-14

### L2PS Hash Persistence Fixed

- Resolved Mycelium `#68`: relayed `l2ps_hash_update` transactions now update validator `l2ps_hashes` during live DTR receipt.
- Root cause:
  - validator `RELAY_TX` receipt validated and enqueued relayed `l2ps_hash_update` transactions, but never executed the `handleL2PSHashUpdate()` storage side effect
  - an intermediate fix attempt used the wrong dynamic import shape for `endpointHandlers.ts`, which made the validator path throw at runtime instead of storing the hash
- Fix:
  - `src/libs/network/dtr/dtrmanager.ts` now applies relayed `l2ps_hash_update` transactions immediately on validator receipt before mempool insertion
  - the relay path assigns the expected next-block default when a relayed hash-update transaction arrives with `blockNumber: null`
  - the validator-side dynamic import now uses the default export from `endpointHandlers.ts`
- Supporting hardening that was required during the investigation:
  - `src/libs/l2ps/L2PSHashService.ts` now imports and uses the missing `confirmTransaction` and `DTRManager` paths correctly
  - the hash relay path now normalizes malformed SDK-produced nonces before relay, using authoritative local GCR state
  - `src/libs/blockchain/l2ps_hashes.ts` now lazy-initializes its repository instead of depending on eager startup ordering
- Validation:
  - rerun:
    - `RUNS_DIR=better_testing/runs RUN_ID=l2ps-hash-fix-reval5 SCENARIO=l2ps_live_submission_relay_smoke bun better_testing/loadgen/src/main.ts`
  - artifact:
    - `better_testing/runs/l2ps-hash-fix-reval5/features/l2ps/l2ps_live_submission_relay_smoke.summary.json`
  - direct SQL check after rerun:
    - all four DBs (`node1_db` .. `node4_db`) converged on `live_local_001|2c383d31e6938bb4884446a4c1ec4db29b88511a2996bd99f829034b9206404c|1|42125`
  - validator log evidence:
    - `Stored hash for L2PS live_local_001: 2c383d31e6938bb4... (1 txs)`
    - `Successfully added relayed transaction to mempool: 86274f9ec65ca15c5cfb26810099af84cb921d410f1f98be09a5fd896a3c1861`
  - result:
    - remote hash changed: true
    - remote batch changed: true
    - strict live L2PS relay smoke: pass

## 2026-03-13

### ZK Commitment Path Fixed

- Resolved the end-to-end ZK commitment blocker that had been tracked as duplicate Mycelium tasks `#66` and `#67`.
- Fixed normalized commitment parsing and proof lookup in `src/features/zk/merkle/MerkleTreeManager.ts`.
- Fixed a post-sign transaction mutation bug in `src/libs/network/endpointHandlers.ts` that was invalidating `validityData` signatures on broadcast.
- Fixed stale Merkle singleton behavior in `src/libs/network/server_rpc.ts` so `/zk/merkle-root` and proof routes reflect persisted DB state.
- Fixed dynamic GET route matching in `src/libs/network/bunServer.ts`, which restored param routes like `/zk/merkle/proof/:commitment`.
- Aligned containerized loadgen with the local SDK fix by mounting the local `@kynesyslabs/demosdk` package in `better_testing/docker-compose.perf.yml`.
- Final validation artifact:
  - `better_testing/runs/zk-commitment-reval-20260313-13/features/zk/zk_commitment_smoke.summary.json`
  - result: full pass, including add, confirm, Merkle root convergence, proof fetch, and proof verification across all 4 nodes

### Current Prod-Gate Result

- Latest passing gate recap:
  - `better_testing/runs/_latest/prod-gate.latest.md`
  - `better_testing/runs/_latest/prod-gate-2026-03-13T19-37-15-116Z.md`
- Current passing scenarios:
  - `omni_connection_smoke`
  - `consensus_block_production`
  - `peer_discovery_smoke`
  - `gcr_identity_remove`
  - `gcr_identity_xm_smoke`
  - `zk_proof_loadgen`
  - `im_message_roundtrip`
  - `tlsnotary_routes_smoke`
  - `web2_url_validation_smoke`
  - `multichain_parser_rejects`

### Current Interpretation

- The local release gate is now healthy enough to act as a meaningful must-pass suite.
- The suite is close to production-ready for local signoff, but not fully complete as a broader project-wide release system because:
  - repository-wide TypeScript verification is still noisy/failing outside the scoped release-gate project
  - some non-gate product bugs remain open outside the current prod-gate path

### Live L2PS Integration Coverage

- Added deterministic host-mounted live L2PS subnet config for devnet:
  - `devnet/l2ps/live_local_001/config.json`
  - `devnet/l2ps/live_local_001/private_key.txt`
  - `devnet/l2ps/live_local_001/iv.txt`
- Devnet nodes now mount `./l2ps:/app/data/l2ps:ro`, so `ParallelNetworks.loadAllL2PS()` sees a real joined UID on startup.
- Added a narrow local relay toggle:
  - `L2PS_HASH_RELAY_NON_PROD=true`
  - this enables live validator-relay coverage for the L2PS hash service without switching the full node into `PROD=true`
- Added live scenarios:
  - `l2ps_live_participation_smoke`
  - `l2ps_live_submission_relay_smoke`
- Added a dedicated suite:
  - `bun run testenv:l2ps:local`
- Stable rerun path:
  - preflight:
    - `bun run testenv:doctor`
  - run the full live suite:
    - `bun run testenv:l2ps:local`
  - inspect the latest recap:
    - `bun run testenv:latest l2ps-live`
  - rerun only the live scenarios directly when isolating failures:
    - `RUNS_DIR=better_testing/runs RUN_ID=l2ps-live-participation-recheck SCENARIO=l2ps_live_participation_smoke bun better_testing/loadgen/src/main.ts`
    - `RUNS_DIR=better_testing/runs RUN_ID=l2ps-live-submission-recheck SCENARIO=l2ps_live_submission_relay_smoke bun better_testing/loadgen/src/main.ts`
  - if node or compose wiring changed, rebuild and recreate the devnet first:
    - `docker compose -f devnet/docker-compose.yml build node-1 node-2 node-3 node-4`
    - `docker compose -f devnet/docker-compose.yml up -d --force-recreate node-1 node-2 node-3 node-4`
- Coverage intent:
  - prove real joined participation over HTTP and Omni
  - submit a real encrypted L2PS transaction into the devnet
  - observe transaction-history growth in Postgres
  - observe confirmed remote `l2psBatch` propagation on validator databases
  - retain `l2ps_hashes` state as a diagnostic signal
  - require explicit relay evidence from node logs (`Successfully relayed ... hash update`)
- L2PS hash relay implementation hardening:
  - `src/libs/l2ps/L2PSHashService.ts` now hashes executed L2PS mempool entries, excludes self-relay, and uses signed DTR `ValidityData` for HTTP validator fallback instead of sending a bare transaction-shaped payload
  - `src/libs/blockchain/l2ps_mempool.ts`, `src/libs/network/manageNodeCall.ts`, and `src/libs/omniprotocol/protocol/handlers/l2ps.ts` now read `executed` entries where that is the real post-execution lifecycle state
- Final live-path validation pass on 2026-03-14:
  - suite recap:
    - `better_testing/runs/_latest/l2ps-live.latest.md`
    - `better_testing/runs/_latest/l2ps-live-2026-03-14T13-10-43-357Z.md`
  - passing artifacts:
    - `better_testing/runs/suite-l2ps-live-l2ps_live_participation_smoke-2026-03-14T13-10-43-357Z-01/features/l2ps/l2ps_live_participation_smoke.summary.json`
    - `better_testing/runs/suite-l2ps-live-l2ps_live_submission_relay_smoke-2026-03-14T13-10-43-357Z-02/features/l2ps/l2ps_live_submission_relay_smoke.summary.json`
  - validated behavior:
    - all 4 HTTP and Omni targets report joined participation for `live_local_001`
    - node-1 live submission advances local `l2ps_transactions`
    - node-1 emits explicit remote hash-relay log lines
    - remote validator databases confirm the propagated `l2psBatch`
  - remaining non-gate issue:
    - none in the validator hash-persistence path after the `#68` fix

### Deterministic Verification Command

- Added a single deterministic verification entrypoint:
  - `bun run testenv:verify:local`
- It runs, in order:
  - `bun run type-check`
  - `./node_modules/.bin/tsc --noEmit -p tsconfig.release-gate.json`
  - `bun better_testing/scripts/run-suite.ts prod-gate --local`
- Scope note:
  - `tsconfig.release-gate.json` intentionally type-checks the release-gate orchestration surface (`run-suite`, `show-latest-report`, `verify-release-gate`) instead of the full historical TypeScript backlog.
  - scenario/runtime correctness is enforced by the must-pass `prod-gate` suite rather than pretending repo-wide `tsc --noEmit` is currently green.
- Fresh full verification pass:
  - `better_testing/runs/_latest/prod-gate.latest.md`
  - timestamped gate recap:
    - `better_testing/runs/_latest/prod-gate-2026-03-14T12-31-39-091Z.md`

## 2026-03-10

### Environment/Tooling Fixes

- `gcr_identity_loadgen` now classifies transport-side `Rate limit exceeded` and `IP blocked due to rate limiting` responses as `RATE_LIMIT` instead of hiding them under generic confirm failures.
- `gcr_identity_loadgen` summaries now include `operatorSummary` with:
  - `primaryIssues`
  - `counterWarnings`
  - `sampleCodeCounts`
- Added `better_testing/scripts/run-suite.ts` as a compact suite runner with:
  - built-in suites: `sanity`, `cluster-health`, `gcr-focus`
  - custom `--scenarios`
  - `--local` mode for localhost-backed runs
  - per-scenario timeout via `--scenario-timeout-sec`
  - target override via `--targets`
  - automatic healthy-target selection for local `cluster-health` when no explicit targets are provided
- Added package shortcuts:
  - `bun run testenv:doctor`
  - `bun run testenv:doctor:verbose`
  - `bun run testenv:latest`
  - `bun run testenv:sanity`
  - `bun run testenv:sanity:local`
  - `bun run testenv:cluster:local`
  - `bun run testenv:gcr`
  - `bun run testenv:gcr:local`
  - `bun run testenv:gcr-health:local`
- `testenv:doctor` now suppresses Omni transport debug chatter by default.
- `testenv:doctor --verbose` restores the low-level Omni state transition output for debugging.
- Local `gcr-focus` now auto-selects the healthy RPC subset when no explicit `--targets` are provided, matching `cluster-health`.
- `run-suite.ts` now emits human-readable markdown reports to:
  - `better_testing/runs/_latest/<suite>-<timestamp>.md`
  - `better_testing/runs/_latest/<suite>.latest.md`
- Added TLSNotary loadgen scenarios:
  - `tlsnotary_routes_smoke`
  - `tlsnotary_verify_rejects`

### Validated Findings

- The local devnet is stable enough that recent failures are meaningful rather than pure environment noise.
- The Docker-based suite path is still less reliable for rapid iteration than local `bun` execution.
- Some scenarios can continue running until externally bounded, so suite-level per-scenario timeouts are necessary for operator usability.
- The original `sanity` suite was too broad for degraded-cluster conditions.
- The reliable quick local sanity set is now intentionally narrow: `omni_connection_smoke` and `zk_proof_loadgen`.
- Broader RPC-dependent checks now live in `cluster-health`.

### Fresh Confirmed Product Bugs

- `node-16j`: Demos SDK multi-instance signer bleed still contaminates concurrent GCR runs.
- `node-3qp`: rate limiting still triggers under concurrent GCR.
- `node-uag`: serialized PQC identity removal visibility lag remains real.
- `node-22q`: dynamic GET ZK routes still return `200` + `Not Found`.
- `node-2k3`: ZK commitment assignment is still being shaped into malformed GCR edits.
- Mycelium task `#47`: TLSNotary HTTP routes return `200 Not Found` on healthy nodes.

## 2026-03-14

### GCR Identity Settle Window

- Revalidated `#27` on a rebuilt healthy local devnet after fixing the unrelated identity rate-limit path.
- The original serialized repro shape still fails when `SETTLE_TIMEOUT_SEC=8`:
  - `RUNS_DIR=better_testing/runs RUN_ID=gcr-pqc-remove-fix-27 SCENARIO=gcr_identity_loadgen TARGETS=http://localhost:53554 CONCURRENCY=1 DURATION_SEC=6 MIN_LOOP_DELAY_MS=300 SETTLE_TIMEOUT_SEC=8 SETTLE_POLL_MS=250 GCR_OP_TIMEOUT_MS=15000 bun better_testing/loadgen/src/main.ts`
  - artifact: `better_testing/runs/gcr-pqc-remove-fix-27/features/gcr/gcr_identity_loadgen.summary.json`
  - observed failure: `settle failed: identity still visible after 8s`
- The same serialized repro passes cleanly when the settle window is widened to 20s:
  - `RUNS_DIR=better_testing/runs RUN_ID=gcr-pqc-remove-fix-27-20s SCENARIO=gcr_identity_loadgen TARGETS=http://localhost:53554 CONCURRENCY=1 DURATION_SEC=6 MIN_LOOP_DELAY_MS=300 SETTLE_TIMEOUT_SEC=20 SETTLE_POLL_MS=250 GCR_OP_TIMEOUT_MS=15000 bun better_testing/loadgen/src/main.ts`
  - artifact: `better_testing/runs/gcr-pqc-remove-fix-27-20s/features/gcr/gcr_identity_loadgen.summary.json`
  - observed elapsed iteration latency: about `19.6s`
- The important context is that node default block time is `10s` (`src/utilities/constants.ts`), and the visibility contract for PQC identity add/remove is block-driven rather than immediate.
- Conclusion:
  - this is not a node-side persistence bug on current behavior
  - the previous default `SETTLE_TIMEOUT_SEC=8` was undersized for the actual committed-state timing envelope
  - `gcr_identity_loadgen` now defaults `SETTLE_TIMEOUT_SEC` to `20` so the scenario enforces the real convergence contract instead of a sub-block assumption

### Contract Runtime Status

- Resolved Mycelium `#69` by reconciling the contract phase doc with the live node repository.
- `src/features/contracts/CONTRACT_PHASES.md` no longer claims completed node-side smart-contract phases.
- Current verified node status:
  - `src/features/contracts/` contains no runtime implementation files beyond the status document
  - `src/libs/network/routines/transactions/` contains no `handleContractDeploy.ts` or `handleContractCall.ts`
  - the live node endpoint wiring does not expose `contractDeploy` / `contractCall`
  - `src/model/entities/GCRv2/GCR_Main.ts` does not contain the contract JSONB column claimed by the old phase plan
- Operational consequence:
  - contract deploy/call remains intentionally out of test coverage until the runtime is actually implemented in node `src/`

### Useful Artifact References

- First explicit `prod-gate` validation:
  - markdown recap:
    - `better_testing/runs/_latest/prod-gate.latest.md`
    - `better_testing/runs/_latest/prod-gate-2026-03-13T13-28-01-616Z.md`
  - passing scenarios:
    - `better_testing/runs/suite-prod-gate-omni_connection_smoke-2026-03-13T13-28-01-616Z-01/features/omni/omni_connection_smoke.summary.json`
    - `better_testing/runs/suite-prod-gate-consensus_block_production-2026-03-13T13-28-01-616Z-02/features/consensus/consensus_block_production.summary.json`
    - `better_testing/runs/suite-prod-gate-peer_discovery_smoke-2026-03-13T13-28-01-616Z-03/features/peersync/peer_discovery_smoke.summary.json`
    - `better_testing/runs/suite-prod-gate-gcr_identity_remove-2026-03-13T13-28-01-616Z-04/features/gcr/gcr_identity_remove.summary.json`
    - `better_testing/runs/suite-prod-gate-gcr_identity_xm_smoke-2026-03-13T13-28-01-616Z-05/features/gcr/gcr_identity_xm_smoke.summary.json`
    - `better_testing/runs/suite-prod-gate-zk_proof_loadgen-2026-03-13T13-28-01-616Z-06/features/zk/zk_proof_loadgen.summary.json`
  - failing blocker scenarios:
    - `better_testing/runs/suite-prod-gate-im_message_roundtrip-2026-03-13T13-28-01-616Z-07/features/im/im_message_roundtrip.summary.json`
    - `better_testing/runs/suite-prod-gate-tlsnotary_routes_smoke-2026-03-13T13-28-01-616Z-08/features/tlsnotary/tlsnotary_routes_smoke.summary.json`
    - `better_testing/runs/suite-prod-gate-web2_url_validation_smoke-2026-03-13T13-28-01-616Z-09/features/web2/web2_url_validation_smoke.summary.json`
    - `better_testing/runs/suite-prod-gate-multichain_parser_rejects-2026-03-13T13-28-01-616Z-10/features/multichain/multichain_parser_rejects.summary.json`
  - current gate interpretation:
    - the suite shape is now production-oriented
    - the product is not release-green because the above four blocker scenarios fail on a healthy local devnet
- Concurrent local GCR validation:
  - `better_testing/runs/validate-gcr-concurrent-local-20260310-01/features/gcr/gcr_identity_loadgen.summary.json`
- First bounded local suite pass on the old broad `sanity` set:
  - `omni_connection_smoke`: pass
  - `zk_proof_loadgen`: pass
  - `consensus_block_production`: timed out
  - `gcr_identity_remove`: timed out
  - `peer_discovery_smoke`: timed out
  - contributing condition: `http://localhost:53552` was degraded / IP-blocked during the run
- Narrowed local `sanity` suite validation:
  - `omni_connection_smoke`: pass
  - `zk_proof_loadgen`: pass
  - artifacts:
    - `better_testing/runs/suite-sanity-omni_connection_smoke-2026-03-10T09-57-00-624Z-01/features/omni/omni_connection_smoke.summary.json`
    - `better_testing/runs/suite-sanity-zk_proof_loadgen-2026-03-10T09-57-00-624Z-02/features/zk/zk_proof_loadgen.summary.json`
- `cluster-health` validation against healthy subset `53551,53553,53554`:
  - `consensus_block_production`: pass
  - `gcr_identity_remove`: pass
  - `peer_discovery_smoke`: pass
  - artifacts:
    - `better_testing/runs/suite-cluster-health-consensus_block_production-2026-03-10T09-57-57-752Z-01/features/consensus/consensus_block_production.summary.json`
    - `better_testing/runs/suite-cluster-health-gcr_identity_remove-2026-03-10T09-57-57-752Z-02/features/gcr/gcr_identity_remove.summary.json`
    - `better_testing/runs/suite-cluster-health-peer_discovery_smoke-2026-03-10T09-57-57-752Z-03/features/peersync/peer_discovery_smoke.summary.json`
- `cluster-health --local` auto-target validation:
  - auto-selected targets: `http://localhost:53551,http://localhost:53553,http://localhost:53554`
  - all three scenarios passed without manual `--targets`
  - artifacts:
    - `better_testing/runs/suite-cluster-health-consensus_block_production-2026-03-10T10-34-05-366Z-01/features/consensus/consensus_block_production.summary.json`
    - `better_testing/runs/suite-cluster-health-gcr_identity_remove-2026-03-10T10-34-05-366Z-02/features/gcr/gcr_identity_remove.summary.json`
    - `better_testing/runs/suite-cluster-health-peer_discovery_smoke-2026-03-10T10-34-05-366Z-03/features/peersync/peer_discovery_smoke.summary.json`
- `testenv:doctor` added as a fast preflight command for:
  - RPC ping / tx readiness
  - derived Omni TCP reachability
  - recommended next commands based on the currently healthy subset
- `testenv:doctor` now defaults to human-readable output, with `--json` available for machine consumption
- Markdown suite report validation:
  - `omni_connection_smoke` custom local suite pass generated:
    - `better_testing/runs/_latest/custom.latest.md`
    - `better_testing/runs/_latest/custom-2026-03-11T08-59-45-041Z.md`
    - `better_testing/runs/suite-custom-omni_connection_smoke-2026-03-11T08-59-45-041Z-01/features/omni/omni_connection_smoke.summary.json`
- TLSNotary scenario validation:
  - `tlsnotary_routes_smoke`: fail
    - `better_testing/runs/tlsnotary-routes-local-20260311-01/features/tlsnotary/tlsnotary_routes_smoke.summary.json`
  - `tlsnotary_verify_rejects`: skip due no healthy TLSNotary-enabled targets, but confirms route absence on healthy nodes
    - `better_testing/runs/tlsnotary-verify-local-20260311-01/features/tlsnotary/tlsnotary_verify_rejects.summary.json`
  - TLSNotary route-registration fix validation on rebuilt devnet:
    - `tlsnotary_routes_smoke`: still fails, but for a new reason
      - `better_testing/runs/tlsnotary-routes-local-20260311-02/features/tlsnotary/tlsnotary_routes_smoke.summary.json`
      - all 4 nodes now return structured JSON for `/tlsnotary/health` and `/tlsnotary/info`
      - current state is `status: "unhealthy"` with `error: "Docker container not accessible"`
    - `tlsnotary_verify_rejects`: skips because no healthy TLSNotary-enabled targets are available
      - `better_testing/runs/tlsnotary-verify-local-20260311-02/features/tlsnotary/tlsnotary_verify_rejects.summary.json`
  - IM feature batch validation:
    - `im_register_discover_smoke`: pass on all 4 local signaling ports
      - `better_testing/runs/im-register-local-20260311-01/features/im/im_register_discover_smoke.summary.json`
    - `im_message_roundtrip`: fail on `ws://localhost:3005`
      - `better_testing/runs/im-roundtrip-local-20260311-02/features/im/im_message_roundtrip.summary.json`
      - registration/presence works, but online message delivery does not complete
      - corroborating node logs show `Failed to store message on blockchain` and `INTERNAL_ERROR - Failed to store message`
    - local devnet now exposes signaling ports `3005..3008` for host-side IM scenario runs
  - FHE feature batch validation:
    - `fhe_scalar_smoke`: pass
      - `better_testing/runs/fhe-scalar-local-20260311-01/features/fhe/fhe_scalar_smoke.summary.json`
      - validated FHE init, parameter setup, key/encoder creation, scalar encrypt/decrypt
    - `fhe_arithmetic_smoke`: pass
      - `better_testing/runs/fhe-arithmetic-local-20260311-01/features/fhe/fhe_arithmetic_smoke.summary.json`
      - validated chained encrypted arithmetic behavior for add, multiply, and negate against plaintext expectations
    - batch initially failed on a harness import path bug in `better_testing/loadgen/src/features/fhe/shared.ts`, then passed after correcting the path to `src/features/fhe/FHE`
  - Web2 feature batch validation:
    - `web2_sanitization_smoke`: pass
      - `better_testing/runs/web2-sanitize-local-20260311-01/features/web2/web2_sanitization_smoke.summary.json`
      - validated log redaction, storage stripping, and non-sensitive metadata preservation
    - `web2_url_validation_smoke`: fail after loopback case was added
      - `better_testing/runs/web2-url-local-20260311-02/features/web2/web2_url_validation_smoke.summary.json`
      - `http://127.0.0.1/admin` is incorrectly accepted and normalized instead of rejected
    - `web2_dahr_rejects`: fail on the same loopback target
      - `better_testing/runs/web2-dahr-local-20260311-01/features/web2/web2_dahr_rejects.summary.json`
      - DAHR startup rejects localhost and private IPv4 targets, but unexpectedly succeeds for `127.0.0.1`
    - this exposed a real Web2 SSRF-hardening gap:
      - Mycelium task `#53`: `Web2 URL validator does not reject IPv4 loopback targets`
  - Incentive feature batch validation:
    - `incentive_referral_code_smoke`: pass
      - `better_testing/runs/incentive-refcode-local-20260312-01/features/incentive/incentive_referral_code_smoke.summary.json`
      - validated deterministic referral code generation, configurable length, checksum variation, prefix handling, and invalid-key rejection
    - `incentive_referral_eligibility`: pass
      - `better_testing/runs/incentive-eligibility-local-20260312-01/features/incentive/incentive_referral_eligibility.summary.json`
      - validated eligibility and already-referred logic across representative GCR-shaped account states
    - `incentive_point_score_matrix`: pass
      - `better_testing/runs/incentive-points-local-20260312-01/features/incentive/incentive_point_score_matrix.summary.json`
      - validated Nomis and Ethos threshold bucketing at edge values
  - MCP feature batch validation:
    - `mcp_tool_factory_smoke`: pass
      - `better_testing/runs/mcp-tools-local-20260312-01/features/mcp/mcp_tool_factory_smoke.summary.json`
      - validated default and flag-gated tool composition
    - `mcp_server_registry_smoke`: pass
      - `better_testing/runs/mcp-registry-local-20260312-01/features/mcp/mcp_server_registry_smoke.summary.json`
      - validated offline registry add/remove/status behavior
    - `mcp_server_creation_smoke`: pass
      - `better_testing/runs/mcp-creation-local-20260312-01/features/mcp/mcp_server_creation_smoke.summary.json`
      - validated default and override transport config on created server managers
  - Multichain feature batch validation:
    - `multichain_parser_execute_smoke`: pass
      - `better_testing/runs/multichain-execute-local-20260312-01/features/multichain/multichain_parser_execute_smoke.summary.json`
      - validated mixed per-operation result handling and exception capture in `XMParser.execute`
    - `multichain_dispatcher_aggregation`: pass
      - `better_testing/runs/multichain-dispatch-local-20260312-01/features/multichain/multichain_dispatcher_aggregation.summary.json`
      - validated dispatcher envelopes for all-failed, partial-success, and all-success result sets
    - `multichain_parser_rejects`: fail
      - `better_testing/runs/multichain-rejects-local-20260312-02/features/multichain/multichain_parser_rejects.summary.json`
      - unknown task rejection is structured as expected
      - invalid EVM chain/subchain input throws a `TypeError` instead of returning the intended `Invalid chain or subchain` error payload
    - this exposed a real multichain parser bug:
      - Mycelium task `#57`: `XMParser invalid EVM chain input throws instead of returning structured error`
  - L2PS feature batch validation:
    - `l2ps_transaction_shape_smoke`: pass
      - `better_testing/runs/l2ps-shape-local-20260312-01/features/l2ps/l2ps_transaction_shape_smoke.summary.json`
      - validated L2PS transaction detection and UID extraction over valid, non-L2PS, and malformed payloads
    - `l2ps_service_status_smoke`: pass
      - `better_testing/runs/l2ps-status-local-20260312-01/features/l2ps/l2ps_service_status_smoke.summary.json`
      - validated `L2PSHashService` and `L2PSBatchAggregator` status envelopes and joined-UID counting
    - `l2ps_statistics_snapshot`: pass
      - `better_testing/runs/l2ps-stats-local-20260312-01/features/l2ps/l2ps_statistics_snapshot.summary.json`
      - validated statistics snapshot copying behavior for both L2PS services
    - `l2ps_registry_state_smoke`: pass
      - `better_testing/runs/l2ps-registry-local-20260312-01/features/l2ps/l2ps_registry_state_smoke.summary.json`
      - validated `ParallelNetworks` local registry/config/load-state behavior with safe stubbed loading
    - this batch intentionally stayed on low-dependency invariants and did not yet attempt live multi-node `L2PSConcurrentSync` coverage
  - L2PS concurrent sync feature batch validation:
    - `l2ps_participant_cache_smoke`: pass
      - `better_testing/runs/l2ps-cache-local-20260312-02/features/l2ps/l2ps_participant_cache_smoke.summary.json`
      - validated cached-participant short-circuit behavior plus mixed cached/live discovery for `discoverL2PSParticipants`
    - `l2ps_participant_discovery_resilience`: pass
      - `better_testing/runs/l2ps-discovery-local-20260312-02/features/l2ps/l2ps_participant_discovery_resilience.summary.json`
      - validated that participating peers are included, non-participants are excluded, and thrown peer errors do not abort discovery
    - `l2ps_incremental_sync_smoke`: pass
      - `better_testing/runs/l2ps-sync-local-20260312-02/features/l2ps/l2ps_incremental_sync_smoke.summary.json`
      - validated `syncL2PSWithPeer` high-watermark request shaping, `since_timestamp` propagation, structural filtering, and tolerant processing of duplicate/insertion-error outcomes
    - `l2ps_exchange_participation_smoke`: pass
      - `better_testing/runs/l2ps-exchange-local-20260312-02/features/l2ps/l2ps_exchange_participation_smoke.summary.json`
      - validated `exchangeL2PSParticipation` delegation through shared-state UID discovery and cache seeding for subsequent lookups
    - this second batch now covers the main behavior seams in `L2PSConcurrentSync` without depending on a live multi-node L2PS network
  - L2PS hash and aggregation boundary batch validation:
    - `l2ps_consolidated_hash_smoke`: pass
      - `better_testing/runs/l2ps-consolidated-local-20260312-01/features/l2ps/l2ps_consolidated_hash_smoke.summary.json`
      - validated deterministic consolidated hash generation, empty/error hash fallbacks, processed-status filtering, and block-number propagation in `L2PSMempool.getHashForL2PS`
    - `l2ps_batch_grouping_smoke`: pass
      - `better_testing/runs/l2ps-grouping-local-20260312-01/features/l2ps/l2ps_batch_grouping_smoke.summary.json`
      - validated UID grouping, GCR edit flattening, affected-account aggregation, and zeroed initial statistics in `L2PSBatchAggregator`
    - `l2ps_batch_payload_smoke`: pass
      - `better_testing/runs/l2ps-payload-local-20260312-01/features/l2ps/l2ps_batch_payload_smoke.summary.json`
      - validated deterministic batch-hash construction, base64 payload packaging, ZK-proof attachment, and authentication-tag generation for `createBatchPayload`
    - `l2ps_hash_service_cycle_smoke`: pass
      - `better_testing/runs/l2ps-hashsvc-local-20260312-01/features/l2ps/l2ps_hash_service_cycle_smoke.summary.json`
      - validated `L2PSHashService` cycle accounting for success, failure, skip-on-reentrancy, and stopped-service no-op behavior
    - this third batch closes most remaining completed L2PS service logic that can be exercised without a live subnet or validator relay path
  - L2PS execution and validator-surface batch validation:
    - `l2ps_batch_nonce_progression_smoke`: pass
      - `better_testing/runs/l2ps-nonce-local-20260312-01/features/l2ps/l2ps_batch_nonce_progression_smoke.summary.json`
      - validated persistent nonce monotonicity and timestamp-derived batch nonce progression
    - `l2ps_batch_submission_smoke`: pass
      - `better_testing/runs/l2ps-submit-local-20260312-03/features/l2ps/l2ps_batch_submission_smoke.summary.json`
      - validated main-mempool submission shape, self-directed identity fields, nonce propagation, batch envelope encoding, and signature domain attachment
    - `l2ps_batch_submission_zk_rejects`: pass
      - `better_testing/runs/l2ps-submit-zk-local-20260312-01/features/l2ps/l2ps_batch_submission_zk_rejects.summary.json`
      - validated ZK-gated submission rejection for missing prover, invalid bigint fields, and failed proof verification
    - `l2ps_process_batch_for_uid_smoke`: pass
      - `better_testing/runs/l2ps-process-local-20260312-01/features/l2ps/l2ps_process_batch_for_uid_smoke.summary.json`
      - validated threshold gating, proof creation, batched-status propagation, and transaction-history status updates in `processBatchForUID`
    - `l2ps_hash_process_network_smoke`: pass
      - `better_testing/runs/l2ps-hashproc-local-20260312-01/features/l2ps/l2ps_hash_process_network_smoke.summary.json`
      - validated skip behavior for invalid/empty hash paths plus successful hash-update creation and relay invocation in `processL2PSNetwork`
    - `l2ps_hashes_store_smoke`: pass
      - `better_testing/runs/l2ps-hashes-local-20260312-01/features/l2ps/l2ps_hashes_store_smoke.summary.json`
      - validated validator-side hash upsert, lookup, pagination, and aggregate statistics in `L2PSHashes`
    - `l2ps_hash_update_handler_smoke`: pass
      - `better_testing/runs/l2ps-hashupdate-local-20260312-01/features/l2ps/l2ps_hash_update_handler_smoke.summary.json`
      - validated validator hash-update endpoint rejection and success paths, including block-number enforcement and joined-network checks
    - `l2ps_nodecall_queries_smoke`: pass
      - `better_testing/runs/l2ps-nodecall-local-20260312-02/features/l2ps/l2ps_nodecall_queries_smoke.summary.json`
      - validated the L2PS NodeCall query surface for participation, mempool summary, and incremental transaction sync
    - with these batches, the completed L2PS code surfaces in this repo now have dedicated local scenario coverage; what remains beyond this is true live transport/integration behavior against real validator discovery and relay infrastructure

### Current Live Snapshot

- Latest `testenv:doctor` result:
  - RPC healthy: `4/4`
  - unhealthy RPC target: `<none>`
  - Omni healthy: `4/4`
  - recommended cluster-health target set: `http://localhost:53551/,http://localhost:53552/,http://localhost:53553/,http://localhost:53554/`
- Latest operator UX change:
  - `bun run testenv:doctor` is now meant to be copy-paste friendly by default
  - `bun run testenv:gcr:local` no longer needs manual `TARGETS=...` when at least one local RPC target is healthy
  - validated on 2026-03-10:
    - quiet `testenv:doctor` now prints only the summary and next commands
    - `testenv:doctor:verbose` still exposes Omni state-transition logs
    - `testenv:gcr:local -- --scenario-timeout-sec 5` auto-selected `http://localhost:53551,http://localhost:53553,http://localhost:53554`
  - suite runs now leave a scan-friendly markdown recap in `better_testing/runs/_latest/` so operators do not need to inspect raw run directories first

### Notes

- This journal is for observability and recap.
- Canonical bug ownership and fix planning still live in `br` / Mycelium.

## 2026-03-15 - XM execute path promoted into prod-gate

- Task completed:
  - `myc` `#72` `Promote multichain execute-path routine validation`
  - Beads `node-7v8.3`
- Decision:
  - promoted `multichain_parser_execute_smoke` into the must-pass `prod-gate` suite rather than creating a separate XM-only routine
  - rationale: the scenario is deterministic, active, local, and directly closes the execute-vs-reject imbalance called out in the active-feature matrix
- Scope guardrails preserved:
  - no native bridge work
  - no SDK multi-instance concurrency expansion
  - no inactive storage-contract or contract-runtime work
- Validation:
  - `bun run testenv:prod-gate:local`
- Expected artifact:
  - `better_testing/runs/_latest/prod-gate.latest.md`
- Outcome:
  - multichain reject semantics and execute happy-path coverage now both live inside the release gate
  - the promoted execute scenario passed inside the gate run
  - the overall local `prod-gate` run remained red because `tlsnotary_routes_smoke` still fails with `Docker container not accessible`
  - follow-up tracking:
    - reopened `myc` `#48` `TLSNotary service stays unhealthy because backing notary container is inaccessible`
    - created Beads bug `node-f7d` `TLSNotary service unhealthy on local prod-gate validation`

## 2026-03-15 - Deeper consensus scenario promoted into scheduled cluster-health validation

- Task completed:
  - `myc` `#73` `Promote one deeper peer or consensus scheduled scenario`
  - Beads `node-7v8.4`
- Decision:
  - promoted `consensus_tx_inclusion` into the regular `cluster-health` suite
  - did not choose `sync_catchup_smoke` because it can be operationally useful yet still inconclusive when the cluster starts already converged and no lag is present to recover from
- Why this candidate won:
  - it forces a real transaction submission
  - it verifies nonce advancement, block advancement, and transaction visibility
  - it gives stronger scheduled evidence than a purely observational health check
- Validation:
  - `bun run testenv:cluster:local`
- Expected artifact:
  - `better_testing/runs/_latest/cluster-health.latest.md`

## 2026-03-15 - Active-core baseline narrowed to implemented node features

- Startup blocker `#78` reduced to code fixes and green startup artifacts:
  - `src/index.ts` now initializes genesis before peer bootstrap on cold boot
  - `src/libs/network/manageNodeCall.ts` now returns `503 STATE_NOT_READY` for `getGenesisDataHash` before genesis is available
  - fresh local validation produced a green startup suite:
    - `better_testing/runs/suite-startup-cold-boot-2026-03-15T15-09-43-586Z/suite.summary.json`
- During follow-up on the token baseline blocker, the node/source boundary was rechecked against the active-feature rule.
- Current repo evidence:
  - `src/libs/blockchain/gcr/handleGCR.ts` has no `token` GCR edit handler
  - `src/libs/network/manageNodeCall.ts` has no token query handlers
  - `src/libs/assets/FungibleToken.ts` remains stub-level
  - SDK-side token transaction types exist, but node-side `src/` does not currently expose a matching implemented runtime/query surface
- Practical consequence:
  - token scenarios remain historical evidence only
  - token throughput no longer belongs in the active-core baseline or soak decisions for this repo
  - the authoritative active-feature matrix was updated to exclude token coverage from current active-feature claims until implementation status changes

## 2026-03-15 - Token runtime scope reconciled for active-feature coverage

- Task completed:
  - `myc` `#80` `Reconcile token runtime implementation status with historical better_testing scenarios`
  - Beads `node-3vf`
- Recheck performed against current source, not historical test inventory:
  - `src/libs/blockchain/gcr/handleGCR.ts` still has no token apply branch
  - `src/libs/network/manageNodeCall.ts` still has no node-side token query surface beyond unrelated TLSNotary access tokens
  - `src/libs/assets/FungibleToken.ts` still contains TODO/stub-level management and transfer logic
- Decision:
  - token scenarios in `better_testing/loadgen` remain historical harness inventory only
  - they do not count toward current active-feature completeness claims for this node repo
  - no new token test work should be proposed until node-side token runtime/query implementation actually exists
- Coverage consequence:
  - with token scope formally excluded, the repo now has at least one dedicated automated scenario for every currently active implemented feature family tracked in the authoritative matrix
  - remaining open work after this decision is about runtime bugs, local gate health, or maintainability noise, not a missing active-feature test family
