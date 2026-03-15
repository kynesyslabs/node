---
type: spec
title: Active Feature Test Addition Proposal
date: 2026-03-14
status: active
tags: [testing, proposal, coverage, better_testing]
author: agent
---

# Active Feature Test Addition Proposal

This proposal is intentionally constrained by one rule:

> add tests only for active and implemented node features

That means:

- do add tests for active node behavior that lacks sufficient confidence
- do not add new test work for inactive, stubbed, or placeholder surfaces

## Non-Goals

Do **not** add new coverage right now for:

- native bridge execution paths
- storage-program runtime behavior beyond its current placeholder note
- contract runtime / storage contract execution
- SDK-repo behavior that belongs in `demosdk` rather than this repo

## Highest-Value Additions

### 1. Add a first-class cold-boot startup suite

Why:

- startup bugs were important enough to generate multiple tracker items
- current confidence is based on fixes plus successful follow-on suites, not a dedicated startup gate

Add:

- a `startup-cold-boot` suite that resets devnet state, brings the cluster up, and verifies:
  - all nodes answer health probes
  - genesis persists cleanly
  - peer discovery converges
  - block production begins

### 2. Promote one additional GCR happy-path scenario into a routine suite

Why:

- GCR is core
- the current gate covers XM identity remove/XM path, but broader single-wallet GCR correctness should remain visible without SDK-concurrency contamination

Add:

- a stable single-wallet GCR scenario selection for routine verification:
  - likely `gcr_identity_smoke` or `gcr_points_smoke`

Do not add:

- new concurrent multi-wallet GCR tests in this repo until the SDK isolation fix lands

### 3. Add a multichain execute-path gate candidate

Why:

- multichain reject semantics are gated today
- execute happy-path coverage exists, but is not part of the must-pass story

Add:

- promote `multichain_parser_execute_smoke` into a non-flaky suite once its runtime contract is confirmed stable on local devnet

### 4. Add a positive DAHR happy-path smoke only if it is locally deterministic

Why:

- current Web2 coverage is safety-heavy
- that is valuable, but it is still mostly reject-path coverage

Add:

- a positive DAHR scenario only if it can run without external nondeterminism

Do not add:

- internet-dependent DAHR happy-path tests that make local validation flaky

### 5. Add a TLSNotary successful verify-path smoke if the local backend can support it reliably

Why:

- route readiness and reject semantics are covered
- successful verification depth would materially improve confidence

Add:

- a deterministic local success-path scenario for TLSNotary verification

Do not add:

- brittle tests that depend on unstable remote attestation inputs

### 6. Promote one deeper peer/consensus resilience scenario into scheduled verification

Why:

- `consensus_tx_inclusion`, `sync_catchup_smoke`, and `sync_under_load` exist
- they are useful, but not currently treated as regular must-run evidence

Add:

- one regular cluster-health extension:
  - `sync_catchup_smoke`
  - or `consensus_tx_inclusion`

Choose whichever remains most stable under local-suite repetition.

### 7. Define performance baselines for active high-value paths

Why:

- load generators exist
- baseline enforcement is still weaker than the scenario surface

Add baseline targets for:

- native transfer throughput
- `zk_proof_loadgen`
- `sync_under_load`
- optionally `omni_throughput`

Do not attempt:

- one baseline per every scenario family
- token throughput while the node repo still lacks an implemented token runtime/query path in `src/`

### 8. Add one long-running soak profile for the active cluster path

Why:

- the current harness is strong on smoke/load/ramp
- soak confidence remains limited

Add:

- one long-running scenario mix focused on active core behavior:
  - consensus block production
  - peer discovery stability
  - one transaction-producing workload
  - one read/verification workload

## Medium-Value Additions

### 9. Clarify the storage testing boundary

Current state:

- `storage_handler_smoke` covers current mocked handler semantics
- `storage_program_apply_smoke` covers placeholder `Not implemented` semantics

Recommended action:

- keep the handler smoke
- explicitly treat `storage_program_apply_smoke` as a placeholder-contract check, not active feature coverage
- avoid adding more storage-program tests until runtime work actually exists

### 10. Add feature-family coverage metadata to suites

Why:

- coverage is broad, but the mental mapping from scenario names to product features is still manual

Add:

- suite metadata or documentation grouping that tags scenarios by feature family and gate level

This is a documentation and maintainability improvement, not a runtime feature.

## Recommended Order

1. cold-boot startup suite
2. one extra GCR single-wallet happy-path suite candidate
3. multichain execute-path gate candidate
4. one deeper peer/consensus scheduled scenario
5. performance baselines for active core paths
6. one soak profile

## Summary

The right next testing work is not “test every code path.”

The right next testing work is:

- strengthen startup and operational confidence for the active cluster
- deepen positive-path coverage for active core features that are already implemented
- avoid spending effort on bridges, storage-program runtime, or contract runtime until those surfaces are genuinely active
