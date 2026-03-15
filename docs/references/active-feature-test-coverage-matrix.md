---
type: reference
title: Active Feature Test Coverage Matrix
date: 2026-03-14
status: active
tags: [testing, coverage, better_testing, prod-gate]
author: agent
---

# Active Feature Test Coverage Matrix

This is the authoritative coverage snapshot for the node repository.

It answers a narrow question:

- which node features are active and implemented today
- which of those features have dedicated test scenarios
- how those scenarios are run
- whether they have been executed at least once on the local devnet

It does **not** claim exhaustive correctness, exhaustive stress validation, or complete release confidence for every subsystem.

## Scope Rules

- Count coverage only for active, implemented node features.
- Do not count placeholder or stub surfaces as required coverage.
- Do not propose new tests for inactive areas such as native bridges, storage-program runtime, or contract runtime stubs.
- Treat historical notes in the journal as evidence, not as the canonical coverage contract.

## Primary Run Entrypoints

- Deterministic release gate:
  - `bun run testenv:prod-gate:local`
- L2PS live validation:
  - `bun better_testing/scripts/run-suite.ts l2ps-live --local`
- Other suite runners:
  - `bun better_testing/scripts/run-suite.ts cluster-health --local`
  - `bun better_testing/scripts/run-suite.ts gcr-focus --local`
- Single-scenario execution:
  - `RUNS_DIR=better_testing/runs RUN_ID=<id> SCENARIO=<name> bun better_testing/loadgen/src/main.ts`
- Docker wrapper:
  - `better_testing/scripts/run-scenario.sh <scenario> [--build]`

## Active Feature Families

| Feature family | Active now | Dedicated scenarios | Latest known evidence | Gate status | Notes |
|---|---|---|---|---|---|
| Token runtime and token scripting | Yes | `token_*` family including smoke, load, ramp, ACL, script, settle, observe, invariants | `better_testing/runs/verify-token-smoke-20260225-113925/token_smoke.summary.json` and related token artifacts | Not in `prod-gate` | Broadest scenario family in the repo |
| Native transactions | Yes | `transfer`, `transfer_ramp`, plus `consensus_block_production` indirectly exercises native tx flow | token/native transfer artifacts under `better_testing/runs/verify-token-transfer-20260225-113956/token_transfer.summary.json` and consensus suite artifacts | Not directly gated as standalone family | Covered, but not summarized in one dedicated modern gate doc |
| GCR / identity | Yes | `gcr_identity_smoke`, `gcr_identity_remove`, `gcr_identity_loadgen`, `gcr_identity_matrix`, `gcr_identity_xm_smoke`, `gcr_points_smoke` | `better_testing/runs/_latest/prod-gate.latest.md` and GCR artifacts in `better_testing/runs/validate-gcr-*` | `gcr_identity_remove` and `gcr_identity_xm_smoke` are gated | Concurrent SDK contamination is tracked separately and does not invalidate node-local coverage |
| Consensus | Yes | `consensus_block_production`, `consensus_tx_inclusion`, `consensus_secretary_rotation`, `consensus_rollback_smoke`, `consensus_partition_recovery` | `better_testing/runs/_latest/prod-gate.latest.md` | `consensus_block_production` is gated | Deeper consensus cases exist but are not all in the must-pass gate |
| Peer sync / discovery | Yes | `peer_discovery_smoke`, `sync_catchup_smoke`, `sync_consistency`, `sync_under_load` | `better_testing/runs/_latest/prod-gate.latest.md` and `better_testing/runs/sync-*-local-*` artifacts | `peer_discovery_smoke` is gated | Load and catch-up coverage exists outside the release gate |
| OmniProtocol | Yes | `omni_connection_smoke`, `omni_message_roundtrip`, `omni_reconnection`, `omni_throughput` | `better_testing/runs/_latest/prod-gate.latest.md` and `better_testing/runs/suite-custom-omni_connection_smoke-2026-03-11T08-59-45-041Z-01/features/omni/omni_connection_smoke.summary.json` | `omni_connection_smoke` is gated | Transport breadth exists beyond the gate |
| ZK | Yes | `zk_commitment_smoke`, `zk_attestation_smoke`, `zk_merkle_inclusion`, `zk_proof_loadgen` | `better_testing/runs/_latest/prod-gate.latest.md` and journal revalidation entries | `zk_proof_loadgen` is gated | Good active-path coverage; only one scenario is currently part of the must-pass gate |
| TLSNotary | Yes | `tlsnotary_routes_smoke`, `tlsnotary_verify_rejects` | `better_testing/runs/_latest/prod-gate.latest.md` and `better_testing/runs/tlsnotary-verify-reval-20260313-02/features/tlsnotary/tlsnotary_verify_rejects.summary.json` | `tlsnotary_routes_smoke` is gated | Reject semantics are covered; positive verify-path depth can still improve |
| Web2 / DAHR | Yes | `web2_url_validation_smoke`, `web2_sanitization_smoke`, `web2_dahr_rejects` | `better_testing/runs/_latest/prod-gate.latest.md` and `better_testing/runs/web2-url-reval-20260313-01/features/web2/web2_url_validation_smoke.summary.json` | `web2_url_validation_smoke` is gated | Current automated emphasis is on safety and reject behavior |
| Multichain / XM parser and dispatcher | Yes | `multichain_parser_rejects`, `multichain_parser_execute_smoke`, `multichain_dispatcher_aggregation` | `better_testing/runs/_latest/prod-gate.latest.md` and local multichain artifacts from 2026-03-12 plus the 2026-03-15 prod-gate revalidation | `multichain_parser_rejects` and `multichain_parser_execute_smoke` are gated | Reject and execute happy-path coverage are both part of the must-pass gate; dispatcher aggregation remains outside it |
| IM / signaling | Yes | `im_online`, `im_online_ramp`, `im_register_discover_smoke`, `im_message_roundtrip` | `better_testing/runs/_latest/prod-gate.latest.md` and `better_testing/runs/im-register-local-20260311-01/features/im/im_register_discover_smoke.summary.json` | `im_message_roundtrip` is gated | Healthy delivery path is gated; load path exists outside the gate |
| FHE | Yes | `fhe_scalar_smoke`, `fhe_arithmetic_smoke` | `better_testing/runs/fhe-scalar-local-20260311-01/features/fhe/fhe_scalar_smoke.summary.json` and matching arithmetic artifact | Not gated | Covered and executed, but not part of the current release gate |
| Incentives / referral points | Yes | `incentive_referral_code_smoke`, `incentive_referral_eligibility`, `incentive_point_score_matrix` | `better_testing/runs/incentive-refcode-local-20260312-01/features/incentive/incentive_referral_code_smoke.summary.json` and related artifacts | Not gated | Active feature coverage exists but is not in the core must-pass suite |
| MCP factory / registry / creation | Yes | `mcp_tool_factory_smoke`, `mcp_server_registry_smoke`, `mcp_server_creation_smoke` | `better_testing/runs/mcp-tools-local-20260312-01/features/mcp/mcp_tool_factory_smoke.summary.json` and related artifacts | Not gated | Covered and executed |
| L2PS | Yes | Broad family plus dedicated live suite, including `l2ps_live_participation_smoke` and `l2ps_live_submission_relay_smoke` | `better_testing/runs/_latest/l2ps-live.latest.md` | Dedicated `l2ps-live` gate, separate from `prod-gate` | Live-path coverage is strong and has fresh passing evidence |
| Storage handler surface | Limited active surface only | `storage_handler_smoke` | `better_testing/runs/storage-handler-smoke-check/features/storage/storage_handler_smoke.summary.json` | Not gated | This covers the currently exposed mocked handler semantics only |

## Explicitly Excluded From “Active Feature Coverage” Claims

| Surface | Why excluded |
|---|---|
| Native bridge / bridge execution | Node has bridge-related code paths, but there is no dedicated active scenario family and parts of the path remain unimplemented or non-production-ready |
| `storageProgram` transaction runtime | The existing `storage_program_apply_smoke` deliberately locks in placeholder `Not implemented` semantics; that is not active feature coverage |
| Contract runtime / storage contracts | The node-side runtime is explicitly documented as unimplemented and should not drive test-expansion claims yet |

## Operational And Quality Coverage

| Dimension | Current status | Runnable now | Evidence | Notes |
|---|---|---|---|---|
| Feature smoke coverage across active families | Broad but not exhaustive | Yes | Scenario registry in `better_testing/loadgen/src/main.ts` plus run artifacts | Good breadth |
| Deterministic release gate | Present | Yes | `better_testing/runs/_latest/prod-gate.latest.md` | Covers a representative subset, not all families |
| L2PS live gate | Present | Yes | `better_testing/runs/_latest/l2ps-live.latest.md` | Separate from core prod gate |
| Startup / cold-boot validation | Partial | Partially | Historical fixes and journal entries, plus healthy suite runs imply startup works | No single first-class cold-boot suite document yet |
| Load / stress validation | Partial | Yes | loadgen, ramp, `sync_under_load`, `zk_proof_loadgen`, token and IM load scenarios | Not every family has a performance baseline or stress gate |
| Long soak testing | Limited | Ad hoc only | no authoritative always-run soak report | Gap |
| Repository-wide TypeScript verification | Partial / noisy | Yes, but not universally green | documented in journal as still noisy outside scoped gate | Do not claim this is fully clean |
| Documentation and easy run paths | Present | Yes | suite runner, wrapper scripts, README docs | Good, but previously inconsistent before this cleanup |

## Bottom-Line Statement

The node repo has strong and well-documented automated coverage for many active feature families, with fresh evidence for the current release gate and for the L2PS live suite.

The correct claim is:

- active implemented features are broadly covered
- many scenarios have already been executed on the local devnet
- the suites are runnable and documented

The incorrect claim is:

- every active feature is fully gated
- every operational dimension is comprehensively covered
- placeholder or stub surfaces should count toward active-feature completeness
