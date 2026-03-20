# Petri Consensus — Codebase Mapping

> Maps existing PoRBFT v2 code to Petri Consensus concepts.
> Generated from deep codebase research. Reference for implementation phases.

---

## Legend

- **KEEP** — Existing code works as-is for Petri
- **REFACTOR** — Existing code needs modification
- **NEW** — No existing code; must be built
- **REPLACE** — Existing code is superseded by Petri

---

## 1. Shard Formation & Rotation

| Component | Status | Current File | Notes |
|-----------|--------|-------------|-------|
| Shard interface | KEEP | `src/libs/consensus/v2/types/shardTypes.ts` | Already has CVSA, members, secretaryKey, blockRef |
| Shard selection (Alea PRNG) | KEEP | `src/libs/consensus/v2/routines/getShard.ts` | Deterministic, seeded, selects up to 10 peers |
| CVSA seed generation | KEEP | `src/libs/consensus/v2/routines/getCommonValidatorSeed.ts` | SHA-256 of last 3 blocks + genesis. Tamper-proof |
| Validator check | KEEP | `src/libs/consensus/v2/routines/isValidator.ts` | `isValidatorForNextBlock()` already works |
| Shard size config | KEEP | `src/utilities/sharedState.ts` | `getSharedState.shardSize` (default 10) |

**Petri delta**: Minimal. The existing shard system is already Petri-compatible. The PRNG rotation, determinism, and 10-node size all match.

---

## 2. RPC Layer (Phase 1 — Instant Validation)

| Component | Status | Current File | Notes |
|-----------|--------|-------------|-------|
| HTTP server | KEEP | `src/libs/network/server_rpc.ts` | Bun-based, stateless |
| Signature verification | KEEP | `src/libs/network/verifySignature.ts` | ed25519, falcon, ml-dsa |
| Transaction validation | KEEP | `src/libs/blockchain/routines/validateTransaction.ts` | `confirmTransaction()` |
| GCR edit validation | KEEP | `src/libs/network/endpointHandlers.ts` | Hash comparison + balance check |
| Rate limiting | KEEP | `src/libs/network/middleware/rateLimiter.ts` | IP + identity rate limits |
| Auth context | KEEP | `src/libs/network/authContext.ts` | WeakMap per request |
| **Routing to 2 shard members** | NEW | — | RPC must route to exactly 2 shard members (not all validators) |
| **Address-space shard assignment** | NEW | — | Derive shard from tx address space, not just block-based |
| **Transaction classification** | NEW | — | PRE-APPROVED (read-only) vs TO-APPROVE (state-changing) |
| DTR relay | REPLACE | `src/libs/network/dtr/dtrmanager.ts` | Petri Phase 1 routing supersedes DTR for validators |

### Key Refactoring Notes

- `handleValidateTransaction()` in `endpointHandlers.ts` currently validates then either relays (DTR) or executes locally
- Petri replaces this with: validate → classify → route to 2 shard members
- DTR still needed for non-validator nodes relaying to the network, but shard routing is different
- The `processPayload()` switch in `server_rpc.ts` (method="execute") needs a new flow

---

## 3. Transaction Classification (NEW)

No existing code. Must create:

| Component | Status | Notes |
|-----------|--------|-------|
| Transaction classifier | NEW | Determine if tx is read-only (PRE-APPROVED) or state-changing (TO-APPROVE) |
| Speculative execution engine | NEW | Execute TO-APPROVE txs speculatively, produce state delta |
| State delta type | NEW | Represent the diff produced by speculative execution |
| Classification result type | NEW | `{ status: 'PRE-APPROVED' | 'TO-APPROVE' | 'PROBLEMATIC', delta?: StateDelta }` |

### Existing Building Blocks

- `Transaction.isCoherent()` — hash validation (reuse)
- `executeNativeTransaction()` — executes tx and returns operations (extend for speculative mode)
- `GCRGeneration.generate(tx)` from SDK — generates expected GCR edits (reuse for delta generation)
- `HandleGCR.apply()` — applies GCR edits (extend with `simulate` flag)

---

## 4. Continuous Forge (Phase 2 — NEW core mechanism)

| Component | Status | Current File | Notes |
|-----------|--------|-------------|-------|
| Mempool sync | REFACTOR | `src/libs/consensus/v2/routines/mergeMempools.ts` | Currently once per consensus. Petri needs 1–2s cycle |
| Mempool storage | KEEP | `src/libs/blockchain/mempool_v2.ts` | TypeORM-backed, ordered by timestamp |
| Transaction ordering | KEEP | `src/libs/consensus/v2/routines/orderTransactions.ts` | Timestamp-based deterministic sort |
| **Continuous Forge loop** | NEW | — | 1–2s timer: sync mempools → re-execute → compare deltas |
| **Delta comparison** | NEW | — | Compare state deltas across shard members (7/10 agreement) |
| **Delta agreement protocol** | NEW | — | RPC method for shard members to exchange/compare deltas |
| **Promotion logic** | NEW | — | TO-APPROVE → PRE-APPROVED (on 7/10 agreement) |
| **Conflict flagging** | NEW | — | TO-APPROVE → PROBLEMATIC (on delta disagreement) |

### Key Design Decisions

- The Continuous Forge replaces the Secretary's phase-by-phase coordination
- Instead of 7 sequential phases with greenlight barriers, Petri has a continuous 1–2s merge loop
- `SecretaryManager` (1018 lines) is the biggest code casualty — its coordination model is replaced
- The mempool merge algorithm in `mergeMempools.ts` (43 lines) is reusable but needs to run on a timer

---

## 5. Block Finalization (Phase 3 — 10s boundary)

| Component | Status | Current File | Notes |
|-----------|--------|-------------|-------|
| Block creation | REFACTOR | `src/libs/consensus/v2/routines/createBlock.ts` | Compile PRE-APPROVED txs only (happy path) |
| Block hash voting | REFACTOR | `src/libs/consensus/v2/routines/broadcastBlockHash.ts` | Only for block confirmation, not individual tx voting |
| Vote handler | REFACTOR | `src/libs/consensus/v2/routines/manageProposeBlockHash.ts` | Verify block of PRE-APPROVED txs |
| BFT threshold | KEEP | `PoRBFT.ts:isBlockValid()` | `floor(2n/3) + 1` — already correct |
| Block entity | KEEP | `src/model/entities/Blocks.ts` | Schema works for Petri blocks |
| Chain insertion | KEEP | `src/libs/blockchain/chain.ts` | `insertBlock()` with finality |
| **BFT arbitration for PROBLEMATIC** | NEW | — | Separate BFT round for conflicting txs only |
| **Block compilation from PRE-APPROVED** | NEW | — | Gather all PRE-APPROVED txs at 10s mark |
| **Rejection of unresolvable conflicts** | NEW | — | PROBLEMATIC txs that fail BFT → rejected, never stall |

### Key Design Decisions

- The existing BFT voting (`broadcastBlockHash` + `manageProposeBlockHash`) can be adapted
- Currently votes on entire block hash — Petri also votes on entire block (PRE-APPROVED compilation)
- The new part is the exception-path BFT for PROBLEMATIC txs — a separate, smaller round
- `isBlockValid()` threshold logic is already correct for both paths

---

## 6. GCR State Management

| Component | Status | Current File | Notes |
|-----------|--------|-------------|-------|
| GCR edit application | KEEP | `src/libs/blockchain/gcr/handleGCR.ts` | apply(), applyToTx() |
| Balance routines | KEEP | `src/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines.ts` | add/remove with rollback |
| Nonce routines | KEEP | `src/libs/blockchain/gcr/gcr_routines/GCRNonceRoutines.ts` | increment/decrement |
| GCR generation | KEEP | SDK: `GCRGeneration.generate(tx)` | Generates expected edits |
| GCR state hash | KEEP | `createBlock.ts` → `hashNativeTables()` | State snapshot per block |
| **Speculative GCR application** | NEW | — | Apply edits in simulation mode for delta generation |
| **Delta serialization** | NEW | — | Serialize state deltas for cross-shard comparison |
| **Rollback on disagreement** | REFACTOR | Existing rollback in PoRBFT.ts | Extend to handle per-tx rollback (not just per-block) |

---

## 7. Secretary → Petri Coordinator Transition

| PoRBFT v2 (Current) | Petri (Target) |
|----------------------|----------------|
| Secretary = first shard member | No single coordinator |
| 7 sequential phases with greenlight barriers | Continuous 1–2s forge cycles |
| Secretary collects phase completions | All members independently sync and compare |
| Secretary distributes block timestamp | Averaged timestamp (existing `averageTimestamps.ts`) |
| Secretary detects offline members | All members detect via sync heartbeat |
| Secretary re-election on failure | No election needed — protocol is leaderless |
| `SecretaryManager` (1018 lines) | **DEPRECATED** by Petri |
| `ValidationPhase` (7 phases) | Replaced by tx classification states |

### Migration Strategy

- Don't delete `SecretaryManager` immediately — keep for fallback/testing
- Build Petri's continuous forge as a new module alongside
- Feature-flag switch between PoRBFT v2 and Petri
- Deprecate Secretary once Petri is validated on testnet

---

## 8. P2P & Communication

| Component | Status | Current File | Notes |
|-----------|--------|-------------|-------|
| Peer class | KEEP | `src/libs/peer/Peer.ts` | RPC calls, identity, sync |
| PeerManager | KEEP | `src/libs/peer/PeerManager.ts` | Peer list management |
| Peer gossip | KEEP | `src/libs/peer/routines/peerGossip.ts` | Hash-based peer list sync |
| Peer bootstrap | KEEP | `src/libs/peer/routines/peerBootstrap.ts` | Genesis peer verification |
| Broadcast manager | REFACTOR | `src/libs/communications/broadcastManager.ts` | Block broadcast stays, add delta broadcast |
| OmniProtocol | KEEP | `src/libs/omniprotocol/` | Binary transport for efficiency |
| **Delta exchange RPC** | NEW | — | New RPC method for shard members to exchange state deltas |
| **Continuous sync heartbeat** | NEW | — | 1–2s heartbeat replacing secretary greenlight |
| **Shard-internal messaging** | REFACTOR | Existing RPC | Add new consensus_routine methods for Petri |

---

## 9. L2PS Integration

| Component | Status | Notes |
|-----------|--------|-------|
| L2PS Mempool | KEEP | Separate encrypted mempool, unaffected by Petri |
| L2PS Consensus | REFACTOR | `L2PSConsensus.applyPendingProofs()` — timing changes (apply at 10s boundary) |
| L2PS Execution | KEEP | `L2PSTransactionExecutor` — independent of consensus model |

---

## 10. Finality Model

| Finality | PoRBFT v2 (Current) | Petri (Target) |
|----------|---------------------|----------------|
| Soft | Block "derived" status | PRE-APPROVED at 1–2s (Continuous Forge agreement) |
| Hard | Block "confirmed" on next round | Block inclusion at 10s boundary |
| Mechanism | 2/3+1 vote on block hash | 7/10 delta agreement (soft) + 2/3+1 block vote (hard) |
| Latency | One consensus interval | 1–2s soft, 10s hard |

---

## Summary: Impact Assessment

| Category | Files Affected | Complexity |
|----------|---------------|------------|
| **KEEP (no changes)** | ~15 files | None |
| **REFACTOR (modify)** | ~8 files | Medium |
| **NEW (create)** | ~6-8 new files | High |
| **REPLACE (deprecate)** | ~2 files (SecretaryManager, DTR) | Medium |

**Biggest risk**: The Continuous Forge loop is entirely new and is the core innovation. Everything else is evolution of existing code.

**Biggest opportunity**: The existing shard infrastructure (CVSA, Alea PRNG, getShard, 10-node size) maps almost perfectly to Petri's requirements.
