# Better Testing Framework - Audit Report

**Date**: 2026-03-07
**Branch**: stabilisation
**Epic**: node-2t7 (Take the better testing approach from tokens branch)

---

## TL;DR

The better_testing framework is a **solid performance harness** (6.5/10) that's great at measuring throughput but weak at detecting failures. It covers tokens thoroughly (39 scenarios) but nothing else. The architecture is sound and extensible - with targeted improvements, it can become the testing backbone for the entire node.

---

## 1. How It Works

### Architecture

```
main.ts (scenario router - reads SCENARIO env var)
  |
  +-- rpc_loadgen.ts / rpc_ramp.ts          (RPC baseline)
  +-- transfer_loadgen.ts / transfer_ramp.ts (native transfers)
  +-- token_smoke.ts                         (single-tx correctness)
  +-- token_transfer_loadgen.ts              (sustained throughput)
  +-- token_*_ramp.ts                        (concurrency sweeps)
  +-- token_acl_*.ts                         (permission matrices)
  +-- token_script_*.ts                      (smart contract hooks)
  +-- im_online_*.ts                         (WebSocket messaging)
  |
  Shared Infrastructure:
  +-- token_shared.ts  (48KB - wallets, tokens, consistency checks)
  +-- im_shared.ts     (8KB  - WebSocket, sampling)
  +-- run_io.ts        (1KB  - JSON/JSONL output)
```

### Key Design Decisions

| Aspect | Choice | Verdict |
|--------|--------|---------|
| Configuration | 100% env vars, no config files | Good (Docker-friendly) |
| Execution | Bun, runs in devnet Docker container | Good (reproducible) |
| Results | JSON summaries + JSONL timeseries | Good (plottable) |
| Metrics | ReservoirSampler (Algorithm R) for p50/p95/p99 | Excellent |
| Validation | Cross-node consistency polling | Excellent pattern |
| SDK usage | @kynesyslabs/demosdk for wallets/crypto | Correct |

### Test Types

1. **Smoke tests** - Single transaction + state validation (correctness)
2. **Loadgen tests** - Sustained throughput for N seconds (performance)
3. **Ramp tests** - Sweep concurrency levels to find knee point (capacity)
4. **Matrix tests** - Exhaustive permission/ACL combinations (coverage)

---

## 2. Efficiency Assessment

### What's Good

- **token_transfer_loadgen.ts** is excellent - 76% test logic, minimal boilerplate
- **Metrics infrastructure** - ReservoirSampler gives bounded-memory latency tracking
- **Cross-node consistency** - Proven pattern that polls all nodes until they agree
- **research.md** - Documents real-world findings and tuning decisions

### What's Not

| Problem | Severity | Location |
|---------|----------|----------|
| **50% of tests have ZERO assertions** | CRITICAL | rpc_loadgen, token_transfer_ramp |
| **Console.log hijacking** in ramp tests | HIGH | token_transfer_ramp.ts:83-112 |
| **Silent error absorption** | HIGH | Ramp tests catch errors but don't fail |
| **Code duplication** (~7%) | MEDIUM | envInt/envBool/sleep/ReservoirSampler copied 2-3x |
| **No per-transaction timeout** | MEDIUM | Loadgen can hang indefinitely |
| **No test isolation** | MEDIUM | Tokens/wallets leak between runs |
| **token_shared.ts is 48KB** | LOW | Hard to navigate, should be split |

### Quality Rating: 6.5/10

| Aspect | Score | Notes |
|--------|-------|-------|
| Metrics Collection | 8/10 | Excellent in loadgen tests |
| Error Handling | 5/10 | Silent failures in ramp/rpc |
| Assertions | 5/10 | Half the tests can't detect failure |
| Code Duplication | 7/10 | 7% - manageable but growing |
| Boilerplate Ratio | 6/10 | Ramp tests are 65% setup |
| Documentation | 7/10 | research.md is great |

**Would jump to 8/10 with**: assertions in all tests, console hijack removal, utility extraction

---

## 3. Can We Test Everything With It?

**Short answer: YES, with caveats.**

The framework's pattern (setup -> execute -> validate -> report) works for any RPC-testable feature. The main work is creating domain-specific `*_shared.ts` modules.

### Feature Testability Matrix

| Feature | Current | Can Test? | Effort | What's Needed |
|---------|---------|-----------|--------|---------------|
| **Tokens** | 39 scenarios | Done | - | Already complete |
| **RPC (all methods)** | ping only | Yes | Small | Extend rpc_loadgen with all 11 handlers |
| **GCR operations** | None | Yes | Medium | gcr_shared.ts + 4-5 scenarios |
| **Consensus finality** | None | Yes | Medium | Block agreement verification |
| **ZK identity** | None | Yes | Medium | zk_shared.ts + commitment/proof tests |
| **OmniProtocol** | None | Yes | Small-Med | Transport throughput testing |
| **L2PS batching** | None | Yes | Large | Resource-heavy, smoke test only |
| **P2P networking** | None | Partial | Large | Can test convergence, not timing |
| **DB under load** | None | Partial | Medium | Stress via RPC, can't inject faults |
| **Bridges/XM** | None | Partial | Large | Needs bridge-specific adapters |

### What's Reusable vs Token-Specific

**Reusable (any feature can use these):**
- Demos SDK wallet management (withDemosWallet())
- nodeCall() wrapper with retries
- Cross-node consistency polling pattern
- ReservoirSampler + percentile calculations
- Run I/O (JSON/JSONL artifacts)
- Docker deployment model
- Env var configuration approach

**Token-specific (needs equivalent per feature):**
- ensureTokenAndBalances() -> needs ensureGCRAccount(), ensureZKCommitment(), etc.
- sendTokenTransferTxWithDemos() -> needs per-feature tx builders
- Token balance checks -> needs per-feature state validators

---

## 4. Suggested Tasks

### Priority 0: Fix Framework Quality (before extending)

**Task 1: Add failure assertions to all tests**
- rpc_loadgen: fail if error rate > threshold (e.g., 5%)
- ramp tests: fail if ANY step has 100% error rate
- Add exit code 1 on failure (currently always exits 0)
- Effort: Small (1 day)

**Task 2: Remove console.log hijacking anti-pattern**
- Refactor ramp tests to return results directly
- Make runLoadgen() return a structured result object
- Remove console capture/parse pattern entirely
- Effort: Small (1 day)

**Task 3: Extract shared utilities**
- Create testing_utils.ts with: envInt, envBool, sleep, ReservoirSampler, percentile
- Remove duplicates from 5+ files
- Effort: Small (half day)

### Priority 1: Core Feature Testing

**Task 4: RPC full coverage test**
- Extend rpc_loadgen to test all 11 nodeCall handlers
- Add response validation (not just "did it respond")
- Add latency SLAs per endpoint type
- Effort: Small (1 day)

**Task 5: GCR integration tests**
- Create gcr_shared.ts (account creation, identity ops, state reads)
- Scenarios: gcr_smoke, gcr_identity_load, gcr_points_ramp
- Cross-node GCR state consistency checks
- Effort: Medium (2-3 days)

**Task 6: Consensus finality verifier**
- Create consensus_shared.ts (block hash agreement, block rate)
- Scenario: Run transfers, verify all nodes agree on block hashes
- Detect stalled validators or forks
- Effort: Medium (2 days)

### Priority 2: Advanced Feature Testing

**Task 7: ZK identity integration tests**
- Create zk_shared.ts (commitment submission, proof verification)
- Scenarios: zk_smoke (submit commitment, verify proof)
- Handle slow proof generation (custom timeouts)
- Effort: Medium (2-3 days)

**Task 8: OmniProtocol transport load test**
- Create omni_shared.ts (message throughput, serialization)
- Measure node-to-node message latency under load
- Effort: Small-Medium (1-2 days)

**Task 9: Refactor token_shared.ts**
- Split 48KB file into: wallets.ts, rpc.ts, consistency.ts, sampling.ts
- Better separation of concerns
- Easier onboarding for new test authors
- Effort: Medium (2 days)

### Priority 3: Resilience & Long-term

**Task 10: Performance baselines in git**
- Store baseline TPS/latency values in git
- Script to compare current run against baseline
- CI gate: fail if TPS drops > 20%
- Effort: Medium (2 days)

**Task 11: Soak test (12+ hours)**
- Long-running stability test with memory monitoring
- Detect slow memory leaks or connection exhaustion
- Effort: Medium (2 days)

**Task 12: L2PS smoke test**
- Create l2ps_shared.ts (network creation, batch submission)
- Smoke test only (too resource-heavy for CI)
- Effort: Large (4-5 days)

---

## 5. Recommended Phases

### Phase 1: Foundation (fix what exists)
Tasks 1-3: Fix assertions, remove anti-patterns, extract utils

### Phase 2: Breadth (test core features)
Tasks 4-6: RPC coverage, GCR, consensus

### Phase 3: Depth (advanced features)
Tasks 7-9: ZK, OmniProtocol, refactor shared code

### Phase 4: Confidence (long-term quality)
Tasks 10-12: Baselines, soak tests, L2PS

---

## Appendix: File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| main.ts | ~180 | Scenario router (46 scenarios) |
| token_shared.ts | ~1507 | Token test infrastructure |
| im_shared.ts | ~250 | WebSocket test infrastructure |
| run_io.ts | ~45 | Artifact I/O |
| token_smoke.ts | ~200 | Single-tx correctness |
| token_transfer_loadgen.ts | ~414 | Transfer throughput |
| token_transfer_ramp.ts | ~153 | Concurrency sweep |
| rpc_loadgen.ts | ~367 | RPC throughput |
| (38 more scenario files) | ~16K | Various token/script/ACL tests |
| **Total** | ~18,266 | |
