# Petri Consensus — Risks & Considerations

> Critical design decisions, open questions, and risk mitigations.

---

## 1. Delta Determinism (Critical)

**Risk**: If two honest nodes produce different state deltas for the same transaction, they'll disagree and flag it as PROBLEMATIC — false positives degrade throughput.

**Causes of non-determinism**:
- Floating point arithmetic in fee calculations
- Timestamp-dependent logic in execution
- Database read order differences
- JSON serialization key ordering

**Mitigation**:
- Use `BigInt` for all numeric operations (already the case for balances)
- Delta hashing must use canonical JSON serialization (sorted keys)
- Speculative execution must be pure — no side effects, no I/O
- Test delta determinism as a first-class property (Phase 1 acceptance criteria)

**Existing advantage**: GCR edits are already deterministic (SDK generates them from tx content only)

---

## 2. Network Latency in Delta Exchange

**Risk**: 1–2s forge cycle is tight. If delta exchange takes >500ms, there's limited time for comparison and promotion.

**Mitigation**:
- Exchange delta *hashes* (32 bytes each), not full deltas
- Use OmniProtocol binary encoding for minimal overhead
- Allow configurable forge interval (start at 2s, optimize to 1s)
- If a member doesn't respond in time, continue with available responses
- Threshold is 7/10 — missing 1–2 responses is tolerable

---

## 3. Race Condition: Tx Arrives During Block Compilation

**Risk**: A transaction arrives and gets PRE-APPROVED during the 10s block compilation window. Does it go in the current block or next?

**Design decision**: Cut-off. Any tx not PRE-APPROVED before block compilation starts goes into the next block. The Continuous Forge stops during compilation (Phase 3, Task 4).

**Implementation**: Use a mutex/flag. When block compilation starts, the forge loop yields. New txs go to mempool for next round.

---

## 4. Secretary vs Leaderless Trade-off

**Risk**: Petri is described as leaderless, but coordinating the 10s block boundary still needs some synchronization.

**Design decision**: Use the block timestamp as the coordinator. All nodes independently know when the 10s boundary is because they share the same block history and averaged timestamps. No leader needed for timing — just clock sync (already exists via `averageTimestamps.ts`).

**For Continuous Forge**: Each node runs the loop independently. Delta exchange is peer-to-peer within the shard. No single point of failure.

---

## 5. Multi-Shard Address Routing (Future)

**Risk**: The pitch describes address-space-based shard assignment. With a single shard (testnet), this is trivial. With multiple shards, cross-shard transactions become complex.

**Design decision for now**: Single-shard implementation. All addresses map to one shard. The `ShardMapper` interface is designed for extensibility but only implements single-shard.

**Future considerations**:
- Cross-shard atomic transactions need a 2-phase commit protocol
- Address-space partitioning needs to handle hot addresses (popular contracts)
- Rebalancing shards when load is uneven

---

## 6. L2PS Interaction

**Risk**: L2PS has its own mempool and execution model. How does it interact with Petri's classification?

**Design decision**: L2PS transactions are classified as TO-APPROVE (they produce state changes). L2PS proofs are applied at the 10s block boundary (same as current). The Continuous Forge handles L2PS transaction deltas like any other state-changing tx.

**No change needed** to `L2PSMempool`, `L2PSTransactionExecutor`, or `L2PSConsensus` core logic. Only the timing of `applyPendingProofs()` changes slightly.

---

## 7. Backward Compatibility During Migration

**Risk**: During migration, some nodes run PoRBFT v2 and some run Petri. They must coexist.

**Mitigation**:
- Feature flag controls which consensus routine runs
- Both produce blocks in the same format (same `Block` class, same `Chain.insertBlock()`)
- Shard selection is identical (same CVSA, same Alea PRNG)
- Migration is coordinated: all validators switch at a specific block number
- Fallback: if Petri fails, nodes can restart with PoRBFT v2 flag

---

## 8. Byzantine Behavior in Continuous Forge

**Risk**: A Byzantine node could deliberately return wrong deltas every round, causing transactions to be flagged PROBLEMATIC.

**Mitigation**:
- The 7/10 threshold means up to 3 Byzantine nodes can't prevent agreement
- If 7+ honest nodes agree, the tx is promoted regardless of 3 bad actors
- A node consistently producing wrong deltas can be detected and reputation-penalized
- PROBLEMATIC txs still go through BFT arbitration — they're not lost, just delayed

---

## 9. Mempool Size During Continuous Forge

**Risk**: With 1–2s sync cycles, the mempool grows continuously. At high TPS, memory and DB pressure could be significant.

**Mitigation**:
- Existing mempool is DB-backed (TypeORM/PostgreSQL) — handles scale
- PRE-APPROVED txs are cleaned from mempool after block inclusion
- PROBLEMATIC txs have a TTL — rejected after N forge rounds without resolution
- Mempool already has duplicate detection (hash-based)

---

## 10. Testing Strategy

**Critical test scenarios**:

1. **Happy path**: 10 honest nodes, no conflicts → all txs PRE-APPROVED in <2s
2. **Conflict path**: 2 txs spending same balance → one PROBLEMATIC → BFT resolves
3. **Byzantine minority**: 3/10 nodes return bad deltas → 7/10 still agree → system works
4. **Byzantine threshold**: 4/10 nodes collude → system detects, flags txs as PROBLEMATIC
5. **Network partition**: 2 members temporarily unreachable → forge continues with 8
6. **Clock skew**: Members have ±500ms clock difference → forge still converges
7. **Load test**: Sustained 5000 TPS → soft finality <2s, hard finality <12s
8. **Liveness**: PROBLEMATIC txs never stall block production
9. **Rollback**: Feature flag off → PoRBFT v2 resumes cleanly

---

## 11. Design Decisions (Finalized)

All questions from the design phase have been resolved. These decisions are locked unless explicitly revisited.

| # | Decision | Value | Rationale |
|---|----------|-------|-----------|
| 1 | **Forge interval** | 2 seconds | Conservative start. Gives ample time for delta exchange even on high-latency networks. Can be optimized to 1s later once benchmarked. |
| 2 | **Delta exchange topology** | All-to-all (primary), gossip tested too | 10 nodes is small enough for all-to-all. Both topologies will be tested; all-to-all is the default. |
| 3 | **PROBLEMATIC TTL** | 5 forge rounds (10s) | Generous window aligned with block boundary. A PROBLEMATIC tx gets 5 chances to reach agreement before auto-rejection. |
| 4 | **Speculative execution depth** | Confirmed state only | No chained speculation. Txs are only executed against the last confirmed block's state. Simplicity and correctness over throughput. |
| 5 | **Read-only detection** | GCR edits check via `GCRGeneration.generate(tx)` | If the SDK's GCR generation returns an empty edit array, the tx is read-only (PRE-APPROVED immediately). Known read-only types: `dahr`, `tlsn`, identity attestation. |
