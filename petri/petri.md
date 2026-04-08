I'll convert this pitch deck into a clean text-only document for you.

---

# PETRI CONSENSUS
## A Continuous-Forge Consensus Protocol for High-Throughput Blockchain Infrastructure

**DEMOS NETWORK · INTERNAL PITCH DOCUMENT · SEED STAGE**

---

Named after the petri dish: a controlled environment where independent cultures grow, interact, and produce observable results. Petri Consensus treats each shard as a biological culture — autonomous, self-verifying, and deterministically orchestrated.

---

## EXECUTIVE SUMMARY

### The Problem

Current blockchain consensus mechanisms force a fundamental trade-off: either every validator processes every transaction (limiting throughput), or the network fragments into isolated execution environments (breaking composability). BFT-based systems achieve safety but at the cost of per-transaction coordination overhead that grows with validator count. The result is an industry stuck between ~1,000 TPS with full security or opaque scaling solutions that reintroduce trust assumptions.

### The Insight

Most transactions in a well-functioning blockchain do not actually conflict. BFT consensus is essential for safety, but using it as the primary execution engine is wasteful — it should be an exception handler, not the main loop. If nodes can independently execute non-conflicting transactions and only invoke heavyweight consensus when disagreements arise, throughput scales dramatically while maintaining full Byzantine fault tolerance.

### Petri Consensus

Petri Consensus implements this insight through a three-phase architecture: instant cryptographic validation at the RPC layer, continuous-forge execution within rotating 10-node shards that sync and verify state deltas every 1–2 seconds, and BFT arbitration only for conflicting transactions at the 10-second block boundary. The result: the vast majority of transactions reach finality without ever triggering BFT, while the small minority of conflicts are resolved with full Byzantine safety guarantees.

| Metric | Value |
|--------|-------|
| Target TPS per shard (testnet milestone) | 5,000–15,000 |
| Soft finality (pre-approval) | 1–2s |
| Hard finality (block confirmation) | 10s |

---

## PROTOCOL MECHANISM

Petri Consensus operates in three temporal phases, each optimized for its specific role in the transaction lifecycle.

### PHASE 1 — INSTANT VALIDATION

**01 Transaction Submission**
Client submits a signed transaction to any RPC endpoint in the network. The RPC node is stateless and serves as a cryptographic gatekeeper.

**02 Cryptographic Validation & Routing**
The RPC node verifies the transaction signature, checks format validity, and deterministically routes to two members of the assigned shard. Shard assignment is derived from the transaction's address space.

**03 Shard-Level Verification & Classification**
Each receiving shard member independently verifies cryptography and classifies the transaction: read-only / non-state-changing transactions are immediately marked as PRE-APPROVED. State-changing transactions are executed speculatively, producing a state delta, and marked as TO-APPROVE.

### PHASE 2 — CONTINUOUS FORGE (1–2 second cycle)

**04 Mempool Synchronization**
Every 1–2 seconds, shard members synchronize their local mempools using the Continuous-Forge merge algorithm. This produces a deterministic ordering of all pending transactions across the shard.

**05 Parallel Re-execution & Delta Verification**
Each shard member re-executes all TO-APPROVE transactions against the merged, ordered mempool and produces a state delta. Deltas are compared across the shard. If ≥7/10 members agree (BFT threshold: ⌊2n/3⌋ + 1), the transaction is promoted to PRE-APPROVED.

**06 Conflict Detection**
Transactions that fail to reach delta agreement are flagged as PROBLEMATIC. These are quarantined from the happy path and deferred to Phase 3 for BFT arbitration.

### PHASE 3 — BLOCK FINALIZATION (10-second boundary)

**07 Block Compilation**
At the 10-second mark, shard members compile all PRE-APPROVED transactions into a candidate block. Transaction ordering is deterministic, derived from the merge algorithm's output. This is the happy path — for most blocks, this step completes without requiring any additional consensus overhead.

**08 BFT Arbitration (Exception Path)**
PROBLEMATIC transactions enter a standard BFT round (⌊2n/3⌋ + 1 = 7/10 agreement). If consensus is reached, the transaction is included in the block. If not, the transaction is rejected — the chain never stalls. This fail-safe design means BFT latency only affects conflicting transactions, not overall throughput.

---

## SHARD ROTATION MECHANISM

Shard composition is deterministic, rotating, and democratic. Every block, shard membership is recalculated using a PRNG seeded with the hash of the previous block. This guarantees:

- **Unpredictability** — No party can predict shard composition more than one block ahead, preventing targeted attacks
- **Determinism** — Every node independently computes identical shard assignments from the same block hash — no coordination required
- **Democratic Rotation** — Over time, every validator participates in every shard with uniform probability, preventing power concentration
- **Verifiability** — Any observer can verify that shard assignments are correct by rerunning the PRNG with the public block hash

**Shard size:** 10 validators — chosen to balance BFT quorum efficiency (7/10 threshold), network overhead (manageable sync every 1–2s), and security (tolerates up to 3 Byzantine actors per shard per block).

---

## TRANSACTION LIFECYCLE

```
CLIENT → RPC → SHARD (Verify) → MEMPOOL SYNC → [STATE DELTA]
                                      ↓
                              pre-approved → BLOCK COMPILE → FINAL BLOCK
                                      ↓
                              problematic → BFT (if needed) → [rejected or included]
```

**Timeline:**
- ~instant: Client to Shard verification
- 1-2s sync: Mempool synchronization and state delta verification
- 10s block: Block compilation and finalization

*Happy path (majority of transactions): solid lines*
*Exception handling for conflicting state: dashed lines*

---

## SECURITY PROPERTIES

### Byzantine Fault Tolerance
Each shard tolerates up to 3 malicious validators (f < n/3 where n = 10). Both the continuous-forge state verification and the BFT arbitration phase use the same ⌊2n/3⌋ + 1 threshold, ensuring consistent safety guarantees.

### Anti-Collusion via Rotation
Deterministic shard rotation makes it economically infeasible to coordinate attacks: an adversary would need to control ≥4 of 10 randomly selected validators every block, with assignments changing every 10 seconds.

### Liveness Guarantee
The chain never stalls. Conflicting transactions are rejected rather than retried, ensuring block production continues on schedule regardless of Byzantine behavior within the shard.

### Dual Finality
Soft finality at 1–2 seconds (pre-approval) enables responsive UX for applications, while hard finality at 10 seconds (block inclusion) provides settlement-grade security.

---

## PERFORMANCE TARGETS

Performance projections are based on 10-node shard architecture with 1–2 second sync cycles and 10-second block times. These are conservative testnet targets — mainnet optimizations (parallel shard execution, adaptive block sizing, pipelined verification) can significantly increase throughput.

| Metric | Target |
|--------|--------|
| TPS per shard (testnet target) | 5,000–15,000 |
| Horizontal scaling with additional shards | 10x+ |

---

## COMPETITIVE LANDSCAPE

| Protocol | Consensus | TPS | Finality | BFT Role | Validator Load |
|----------|-----------|-----|----------|----------|----------------|
| Ethereum 2.0 | Gasper (LMD+Casper) | ~30–100 | ~12 min (epoch) | Primary engine | Full chain processing |
| Solana | Tower BFT + PoH | ~4,000 (theoretical 65k) | ~0.4s (slot) | Primary engine | Full chain processing |
| Sui / Aptos | Narwhal & Bullshark/Tusk | ~5,000–10,000 | ~2–3s | DAG-based ordering | Object-level parallel |
| Cosmos Zones | Tendermint BFT | ~1,000 per zone | ~6s | Primary engine | Per-zone processing |
| **Demos (Petri)** | **Continuous-Forge + BFT** | **5,000–15,000 per shard** | **1–2s soft / 10s hard** | **Exception handler only** | **Shard-scoped (10 nodes)** |

**Demos' key differentiator:** BFT as exception handler, not primary engine. This architecture decouples throughput from consensus overhead — as shard count grows, the network scales horizontally without increasing per-validator load.

---

## SUMMARY

### SPEED
- 1–2s soft finality
- 10s hard finality  
- 5,000–15,000 TPS/shard

### SECURITY
- Full BFT safety
- Rotating 10-node shards
- 3 Byzantine fault tolerance

### SCALABILITY
- Horizontal shard scaling
- Constant validator load
- Democratic rotation

---

**demos.sh**

*Demos Network · Unified Identity · Cross-Chain Interoperability*

**PETRI CONSENSUS: Where BFT becomes the exception, not the rule.**