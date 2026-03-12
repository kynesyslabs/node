# Better Testing Framework Assessment

**Date**: 2026-03-07
**Branch**: stabilisation
**Epic**: node-2t7 (Take the better testing approach from tokens branch)

---

## 1. How It Works

### Architecture Overview

```
main.ts (scenario router — 46 scenarios via SCENARIO env var)
  │
  ├── Smoke Tests ──→ Single operation + cross-node validation
  ├── Load Tests  ──→ Sustained throughput (configurable duration/concurrency)
  ├── Ramp Tests  ──→ Concurrency sweeps to find performance "knee"
  └── Matrix Tests ──→ Permission/ACL state exploration

Shared Infrastructure:
  ├── token_shared.ts (48KB) — wallets, tokens, consistency checks, tx builders
  ├── im_shared.ts (8KB) — WebSocket messaging, sampling, encryption
  └── run_io.ts (1KB) — JSON/JSONL output to runs/ directory
```

### How a Test Runs

1. **Config**: Everything is environment variables (no YAML/JSON). Docker-friendly, git-friendly.
2. **Setup**: Read wallet mnemonics → derive addresses → bootstrap token (create + distribute)
3. **Execute**: Multi-worker concurrency with inflight queues per wallet
4. **Collect**: ReservoirSampler (Algorithm R) for latency p50/p95/p99, per-second timeseries
5. **Validate**: Cross-node consistency (all nodes agree on balances/state)
6. **Output**: `runs/<RUN_ID>/scenario.summary.json` + `scenario.timeseries.jsonl`

### How to Run

```bash
# Docker (recommended)
cd devnet && docker compose up -d --build
docker compose -f docker-compose.yml -f ../better_testing/docker-compose.perf.yml \
  run --rm --no-deps --build loadgen

# Host (quick)
TARGETS=http://localhost:53551 SCENARIO=token_smoke bun better_testing/loadgen/src/main.ts

# CI scripts
./better_testing/scripts/run-scenario.sh token_edge_cases --build
./better_testing/scripts/token-perf-baseline.sh --build
```

---

## 2. Efficiency Assessment

### Strengths

| Aspect | Rating | Details |
|--------|--------|---------|
| **Zero config files** | Excellent | All env vars — no secrets in git, easy Docker compose |
| **Statistical sampling** | Excellent | Reservoir sampling (O(1) per sample) for latency percentiles |
| **Cross-node validation** | Excellent | Polls all nodes in parallel, detailed mismatch reports |
| **Modular scenarios** | Good | Each scenario is a standalone file, shared infra in `*_shared.ts` |
| **Artifact capture** | Good | JSON summaries + JSONL timeseries per run |
| **Ramp analysis** | Good | Automatically finds "knee point" (where p95 spikes) |
| **Docker integration** | Good | Runs in devnet image, non-root, proper isolation |

### Weaknesses

| Aspect | Rating | Details |
|--------|--------|---------|
| **Code duplication** | Needs work | `ReservoirSampler` duplicated across files, `envInt`/`sleep` helpers too |
| **token_shared.ts is 48KB** | Needs work | God-module — should be split (wallets, tokens, consistency, tx-builders) |
| **No performance gates** | Missing | Framework generates data but nothing fails CI if TPS regresses |
| **No baseline comparison** | Missing | No automated "compare this run to last known good" |
| **No failure artifact capture** | Missing | Node logs/state not exported on test failure |
| **4-node only** | Limited | No scaling tests (8/16 nodes) |
| **Console capture hack** | Brittle | Ramp tests capture console output to extract summaries (fragile) |

### Verdict

**The framework is solid and well-designed for what it covers.** The env-var approach, statistical sampling, and cross-node validation are production-quality patterns. The main efficiency issue is the monolithic `token_shared.ts` and some code duplication — both fixable.

---

## 3. Can We Use It as a Base to Test Everything?

### Yes, with caveats

**What makes it a good base:**
- The pattern (setup → execute → validate → report) is universal
- `run_io.ts` works for any scenario type
- Docker compose overlay approach scales to new services
- env-var config is flexible for any test type
- Scripts (`run-scenario.sh`) are already generic

**What needs to happen to extend it:**

The framework currently tests **tokens and RPC** thoroughly. To cover "everything," we need new `*_shared.ts` modules for each domain:

| Domain | Current Coverage | Needed |
|--------|-----------------|--------|
| Tokens (mint/burn/transfer/ACL/scripts) | ✅ Comprehensive | Maintenance only |
| RPC baseline | ✅ Complete | — |
| IM messaging | ⚠️ Basic | More scenarios |
| Native transfers | ✅ Complete | — |
| GCR/Identity operations | ❌ None | New `gcr_shared.ts` |
| Consensus finality | ❌ None | New `consensus_shared.ts` |
| Peer network resilience | ❌ None | New `peer_shared.ts` |
| OmniProtocol P2P | ❌ None | New `omni_shared.ts` |
| L2PS parallel networks | ❌ None | New `l2ps_shared.ts` |
| ZK proofs | ❌ None | New `zk_shared.ts` |
| TLS Notary | ❌ None | New `tlsn_shared.ts` |
| Bridges/XM | ❌ None | New `bridge_shared.ts` |
| FHE | ❌ None | New `fhe_shared.ts` |
| Incentives/Points | ❌ None | New `points_shared.ts` |
| MCP tools | ❌ None | New `mcp_shared.ts` |
| ActivityPub | ❌ None | New `activitypub_shared.ts` |

---

## 4. Suggested Tasks (for beads)

### P0 — Framework Foundation (before writing new tests)

1. **Split `token_shared.ts` into modules**
   - `shared/wallets.ts` — mnemonic reading, address derivation
   - `shared/rpc.ts` — nodeCall, rpcPost, waitForRpcReady
   - `shared/consistency.ts` — cross-node checks, holder pointer validation
   - `shared/sampling.ts` — ReservoirSampler, percentile (deduplicate from im_shared)
   - `shared/io.ts` — merge with run_io.ts
   - Keep `token_shared.ts` as re-export for backward compat

2. **Add performance gate infrastructure**
   - Store baseline results (JSON) in git
   - Script that compares current run to baseline
   - Fail CI if TPS drops >15% or p95 latency increases >25%
   - Start with token_transfer baseline only

3. **Add failure artifact capture**
   - On test failure: dump node logs, mempool state, last N blocks
   - Docker compose wrapper that captures `docker logs` on exit code != 0

### P1 — Stabilisation-Critical Test Scenarios

4. **GCR/Identity smoke tests**
   - Create GCR account, add XM identity, add Web2 identity
   - Verify cross-node consistency of GCR state
   - Test concurrent identity operations
   - Priority: HIGH (GCR is core to the network)

5. **Consensus finality verifier**
   - After N blocks: verify all nodes have same block hash at height H
   - Verify transaction ordering is deterministic
   - Verify no stalled nodes under moderate load

6. **Peer network resilience**
   - Node restart mid-operation → verify recovery + re-sync
   - Node join/leave during consensus → verify no state corruption
   - Extend existing chaos script to cover more scenarios

7. **Soak test (long-running stability)**
   - 1-hour sustained load at moderate TPS
   - Monitor memory usage, TPS drift, p95 drift
   - Detect memory leaks or performance degradation

### P2 — Feature Coverage Expansion

8. **OmniProtocol baseline**
   - Node-to-node message latency measurement
   - Verify serialization round-trips for all message types
   - Measure throughput under concurrent connections

9. **L2PS test harness**
   - Basic L2PS operation: create parallel network, execute transactions
   - Verify batch aggregation correctness
   - Cross-node L2PS state consistency

10. **ZK proof test harness**
    - Commitment submission → Merkle tree update → Proof verification
    - Verify proof validity across all nodes
    - Measure proof generation/verification throughput

### P3 — Nice to Have

11. **Multi-topology testing** — 8 and 16 node devnets
12. **Network partition injection** — iptables-based fault injection
13. **Performance dashboard** — Grafana template consuming timeseries JSONL
14. **Flakiness tracking** — Run each scenario 5x, track pass rate

---

## 5. Summary

| Question | Answer |
|----------|--------|
| **How does it work?** | Env-var configured, Docker-based, scenario-per-file, JSON/JSONL output |
| **Is it efficient?** | Yes — solid patterns, good statistical sampling, clean Docker integration. Needs refactoring of shared modules. |
| **Can we use it for everything?** | Yes — the pattern is universal. Need new `*_shared.ts` modules per domain. |
| **What should we do first?** | Split token_shared.ts → Add perf gates → GCR tests → Consensus verifier → Soak test |
