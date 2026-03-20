# Petri Consensus — Implementation Plan (v2)

> Phased plan for integrating Petri Consensus into the Demos Network node.
> Each phase is self-contained with clear acceptance criteria.
> Phases are sequential — each builds on the previous.
> **Updated**: file paths corrected after stabilisation merge; design decisions finalized.

---

## Design Decisions (Finalized)

| Decision | Answer | Rationale |
|----------|--------|-----------|
| Forge interval | **2 seconds** | Start conservative, optimize down after benchmarking |
| Delta exchange topology | **All-to-all** | 10 nodes = 90 msgs/round, simple and fast. Test gossip-style too |
| PROBLEMATIC TTL | **5 rounds** (= 10s) | Generous window; matches block boundary |
| Speculative execution depth | **Confirmed state only** | No chained speculation; dependent txs wait for next block |
| Read-only detection | **Option B** | `GCRGeneration.generate(tx)` returns empty → read-only. Also explicit: dahr, tlsn, identity attestation |

---

## Current Codebase Structure (Post-Stabilisation)

The stabilisation merge refactored key files. This plan uses the **current** paths:

| Concern | File | Notes |
|---------|------|-------|
| RPC dispatch | `src/libs/network/rpcDispatch.ts` | `processPayload()` lives here now |
| Transaction validation | `src/libs/network/endpointValidation.ts` | `handleValidateTransaction()` |
| Transaction execution | `src/libs/network/endpointExecution.ts` | `handleExecuteTransaction()` |
| Consensus RPC | `src/libs/network/endpointConsensus.ts` | Consensus request handler |
| Facade | `src/libs/network/endpointHandlers.ts` | Delegates to above modules |
| Consensus routine | `src/libs/network/manageConsensusRoutines.ts` | Switch for consensus methods |
| Chain (core) | `src/libs/blockchain/chain.ts` | Singleton, ~196 lines |
| Chain (blocks) | `src/libs/blockchain/chainBlocks.ts` | `insertBlock()`, `getBlockByNumber()` etc |
| Chain (txs) | `src/libs/blockchain/chainTransactions.ts` | `getTxByHash()`, `insertTransaction()` |
| Chain (status) | `src/libs/blockchain/chainStatus.ts` | `statusOf()`, `statusHashAt()` |
| Shared state | `src/utilities/sharedState.ts` | ~408 lines, no petri flag yet |
| PoRBFT v2 | `src/libs/consensus/v2/PoRBFT.ts` | `consensusRoutine()`, 627 lines |
| Secretary | `src/libs/consensus/v2/types/secretaryManager.ts` | 1019 lines |
| Shard selection | `src/libs/consensus/v2/routines/getShard.ts` | Alea PRNG, 65 lines |
| CVSA seed | `src/libs/consensus/v2/routines/getCommonValidatorSeed.ts` | SHA-256 of last 3 blocks |
| Mempool merge | `src/libs/consensus/v2/routines/mergeMempools.ts` | 44 lines |
| Tx ordering | `src/libs/consensus/v2/routines/orderTransactions.ts` | Timestamp sort, 33 lines |
| Block creation | `src/libs/consensus/v2/routines/createBlock.ts` | 74 lines |
| Block voting | `src/libs/consensus/v2/routines/broadcastBlockHash.ts` | 130 lines |
| Mempool | `src/libs/blockchain/mempool_v2.ts` | 258 lines |
| DTR | `src/libs/network/dtr/dtrmanager.ts` | 712 lines |

---

## Guiding Principles

1. **Feature-flagged**: Petri runs alongside PoRBFT v2 via config flag. No breaking changes until validated.
2. **Incremental**: Each phase produces testable, deployable code.
3. **Test-as-you-build**: Every phase includes tests in `better_testing/` style before moving on.
4. **Minimal blast radius**: Reuse existing infrastructure wherever possible.
5. **Safety first**: BFT guarantees are never weakened, even during migration.
6. **No over-engineering**: Build the minimum viable Petri, then iterate.

---

## Phase 0: Foundation & Types

**Goal**: Define all new types and interfaces. No behavioral changes.

### Tasks

1. Create `src/libs/consensus/petri/` directory structure with subdirs: `types/`, `classifier/`, `execution/`, `forge/`, `block/`, `arbitration/`, `routing/`, `utils/`
2. Define `TransactionClassification` enum: `PRE_APPROVED | TO_APPROVE | PROBLEMATIC`
3. Define `StateDelta` interface: serializable representation of GCR edit results
4. Define `ContinuousForgeRound` and `ForgeConfig` interfaces
5. Define `PetriConfig` interface with defaults: `forgeIntervalMs: 2000`, `blockIntervalMs: 10000`, `agreementThreshold: 7`, `problematicTTLRounds: 5`
6. Define `DeltaComparison` interface
7. Add `petriConsensus` feature flag + `petriConfig` to `src/utilities/sharedState.ts`
8. Create `src/libs/consensus/petri/index.ts` entry point (stub)

### Acceptance Criteria
- All types compile with `bun run lint:fix`
- No runtime changes
- Feature flag defaults to `false`

### Files Created
```
src/libs/consensus/petri/
  index.ts
  types/
    classificationTypes.ts
    stateDelta.ts
    continuousForgeTypes.ts
    petriConfig.ts
  utils/           (empty, for Phase 2)
  classifier/      (empty, for Phase 1)
  execution/       (empty, for Phase 1)
  forge/           (empty, for Phase 2)
  block/           (empty, for Phase 3)
  arbitration/     (empty, for Phase 3)
  routing/         (empty, for Phase 4)
```

### Risk: Low

---

## Phase 1: Transaction Classification

**Goal**: Classify incoming transactions at the shard level. Detect read-only transactions using GCR edit generation.

### Tasks

1. **Create `TransactionClassifier`** in `src/libs/consensus/petri/classifier/transactionClassifier.ts`
   - Method: `classify(tx: Transaction): Promise<TransactionClassification>`
   - Call `GCRGeneration.generate(tx)` from SDK
   - If returns empty array → `PRE_APPROVED` (read-only: dahr, tlsn, identity attestation, etc.)
   - If returns non-empty → `TO_APPROVE` (state-changing: native transfers, storage, XM, etc.)

2. **Create `SpeculativeExecutor`** in `src/libs/consensus/petri/execution/speculativeExecutor.ts`
   - Method: `executeSpeculatively(tx: Transaction): Promise<StateDelta>`
   - Wraps `GCRGeneration.generate(tx)` + simulates GCR application
   - Uses `GCRBalanceRoutines.apply()` with `simulate=true` (at `src/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines.ts`)
   - Produces deterministic `StateDelta` without mutating state
   - Hashes delta with canonical JSON + `Hashing.sha256()`

3. **Extend `MempoolTx` entity** at `src/model/entities/Mempool.ts`
   - Add `classification: text | null` column
   - Add `delta_hash: text | null` column
   - Add index on `classification`

4. **Add Mempool classification queries** in `src/libs/blockchain/mempool_v2.ts`
   - `getByClassification(classification, blockNumber?)`
   - `updateClassification(txHash, classification, deltaHash?)`
   - `getPreApproved(blockNumber?)`

5. **Wire classifier into validation flow** in `src/libs/network/endpointValidation.ts`
   - After `handleValidateTransaction()` passes, classify when Petri flag is on
   - For `TO_APPROVE`: run speculative execution to get delta hash
   - Store classification + delta_hash in mempool entry
   - Gated by `getSharedState.petriConsensus`

6. **Write tests** in `better_testing/petri/` for classifier and speculative executor
   - Test each tx type classification
   - Test delta determinism (same tx → same deltaHash)

### Dependencies on Existing Code
- `GCRGeneration.generate(tx)` from `@kynesyslabs/demosdk`
- `GCRBalanceRoutines.apply()` at `src/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines.ts`
- `Hashing.sha256()` at `src/libs/crypto/hashing.ts`
- `handleValidateTransaction()` at `src/libs/network/endpointValidation.ts`
- `MempoolTx` entity at `src/model/entities/Mempool.ts`

### Risk: Medium
- Speculative execution must be side-effect-free
- Delta determinism is critical — same tx must produce same delta on all nodes

---

## Phase 2: Continuous Forge Loop

**Goal**: Implement the 2-second continuous forge cycle within a shard.

### Tasks

1. **Create canonical JSON utility** in `src/libs/consensus/petri/utils/canonicalJson.ts`
   - Deterministic JSON serialization with sorted keys
   - BigInt handling (convert to string with 'n' suffix)
   - Map handling (convert to sorted entries)
   - Critical for delta hash determinism

2. **Create `DeltaAgreementTracker`** in `src/libs/consensus/petri/forge/deltaAgreementTracker.ts`
   - Tracks per-tx delta agreement across forge rounds
   - `recordDelta(txHash, deltaHash, memberPubkey)` — record one member's delta
   - `evaluate(shardSize)` → `{ promoted: string[], flagged: string[] }`
   - Promotion: majority >= 7 agreeing members
   - Flagging: 5 rounds without agreement (= 10s at 2s interval)
   - Handles: mid-round tx arrival, offline members

3. **Create delta exchange RPC handler** in `src/libs/network/manageConsensusRoutines.ts`
   - New case: `"petri_exchangeDeltas"`
   - Request: `{ roundNumber, deltas: Record<txHash, deltaHash> }`
   - Response: `{ roundNumber, deltas: Record<txHash, deltaHash> }`
   - Also add OmniProtocol handler (opcode `0x39`) in `src/libs/omniprotocol/protocol/handlers/consensus.ts`
   - Gated by `petriConsensus` flag

4. **Adapt `mergeMempools`** at `src/libs/consensus/v2/routines/mergeMempools.ts`
   - Make safe for repeated calls (idempotent)
   - Add optional classification filter + timeout parameter
   - Keep backward compatible when Petri flag is off

5. **Create `ContinuousForge`** in `src/libs/consensus/petri/forge/continuousForge.ts`
   - Singleton per shard participation
   - `start(shard)` — begins 2s loop
   - `stop()` — halts loop (called at block boundary)
   - `runForgeRound()` — single cycle:
     a. Sync mempools (reuse `mergeMempools()`)
     b. Get TO_APPROVE txs from mempool
     c. Run `SpeculativeExecutor` on each
     d. Exchange delta hashes with shard (all-to-all via `petri_exchangeDeltas` RPC)
     e. Feed into `DeltaAgreementTracker`
     f. Promote (TO_APPROVE → PRE_APPROVED) or flag (→ PROBLEMATIC)
     g. Update mempool classifications
   - `getCurrentDeltas()` — return current round's delta map (for RPC handler)
   - `reset()` — clear tracker, restart round counter

6. **Write tests** in `better_testing/petri/` for forge components
   - Canonical JSON determinism tests
   - DeltaAgreementTracker promotion/flagging logic
   - ContinuousForge round lifecycle

### Architecture
```
┌─────────────────────────────────────────────────┐
│            Continuous Forge Loop (2s)            │
│                                                 │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐ │
│  │ Mempool   │→│ Speculate  │→│ Exchange      │ │
│  │ Sync      │  │ & Delta   │  │ Deltas (A2A) │ │
│  └──────────┘  └───────────┘  └──────┬───────┘ │
│                                       │         │
│                                 ┌─────▼──────┐  │
│                                 │ Agreement   │  │
│                                 │ Tracker     │  │
│                                 └─────┬──────┘  │
│                          ┌────────────┼────────┐│
│                          ▼            ▼        ││
│                    PRE_APPROVED   PROBLEMATIC  ││
│                    (7/10 agree)  (5 rounds,    ││
│                                  no agree)     ││
└─────────────────────────────────────────────────┘
```

### Risk: High — This is the core innovation

---

## Phase 3: Block Finalization (10s Boundary)

**Goal**: Compile PRE-APPROVED transactions into blocks at the 10-second boundary, with BFT arbitration for PROBLEMATIC transactions.

### Tasks

1. **Create `PetriBlockCompiler`** in `src/libs/consensus/petri/block/petriBlockCompiler.ts`
   - `compileBlock(shard, blockRef)` → `Promise<Block>`
   - Get all PRE_APPROVED txs from mempool (`Mempool.getPreApproved()`)
   - Order with existing `orderTransactions()` (from `src/libs/consensus/v2/routines/orderTransactions.ts`)
   - Create block with existing `createBlock()` (from `src/libs/consensus/v2/routines/createBlock.ts`)

2. **Create `PetriBlockFinalizer`** in `src/libs/consensus/petri/block/petriBlockFinalizer.ts`
   - `finalizeBlock(block, shard)` → `Promise<boolean>`
   - Broadcast block hash (reuse `broadcastBlockHash()` from `src/libs/consensus/v2/routines/broadcastBlockHash.ts`)
   - Check BFT threshold: `floor(2n/3) + 1` (reuse `isBlockValid()` from PoRBFT.ts)
   - Insert block via `insertBlock()` from `src/libs/blockchain/chainBlocks.ts`
   - Broadcast via `BroadcastManager.broadcastNewBlock()`

3. **Create `BFTArbitrator`** in `src/libs/consensus/petri/arbitration/bftArbitrator.ts`
   - `arbitrate(problematicTxs, shard)` → `Promise<{ resolved, rejected }>`
   - One final BFT round per PROBLEMATIC tx
   - Resolved → include in block
   - Rejected → remove from mempool, return error to sender
   - Chain **never** stalls

4. **Wire petriConsensusRoutine()** in `src/libs/consensus/petri/index.ts`
   - Get shard (reuse `getShard()` + `getCommonValidatorSeed()`)
   - Start ContinuousForge
   - Wait for 10s block boundary
   - Stop forge → compile → arbitrate → finalize → restart
   - Full lifecycle in one function

5. **Add consensus dispatch** — modify `src/libs/network/rpcDispatch.ts` or where consensus is triggered
   - When `petriConsensus` flag is on: call `petriConsensusRoutine()`
   - When off: call existing `consensusRoutine()` (PoRBFT v2)

6. **Write tests** in `better_testing/petri/` for block compilation and finalization

### Risk: Medium

---

## Phase 4: RPC Routing Refactor

**Goal**: Modify the RPC layer to route validated transactions to exactly 2 shard members.

### Tasks

1. **Create `ShardMapper`** in `src/libs/consensus/petri/routing/shardMapper.ts`
   - `getShardForAddress(address)` → `ShardId`
   - Single-shard testnet: always returns `'default'`
   - Interface designed for future multi-shard

2. **Create `PetriRouter`** in `src/libs/consensus/petri/routing/petriRouter.ts`
   - `routeToShard(tx)` → `Promise<[Peer, Peer]>`
   - Deterministic: Alea PRNG seeded with tx hash
   - `relay(tx, validityData)` → send to both selected members

3. **Modify routing in `src/libs/network/endpointExecution.ts`**
   - When Petri flag is on: use `PetriRouter.relay()` instead of DTR
   - Return immediate PRE_APPROVED for read-only txs
   - Return pending for state-changing txs
   - When flag is off: existing DTR flow unchanged

4. **Write tests** in `better_testing/petri/` for routing logic

### Risk: Medium

---

## Phase 5: Finality & Status API

**Goal**: Expose dual finality model (soft/hard) to clients.

### Tasks

1. **Add `soft_finality_at` field** to `MempoolTx` and `Transactions` entities
2. **Add `getTransactionFinality` RPC method** in `src/libs/network/rpcDispatch.ts`
   - Returns `{ soft: timestamp | null, hard: timestamp | null, classification }`
3. **Write tests** in `better_testing/petri/`

### Risk: Low

---

## Phase 6: Integration Testing & Hardening

**Goal**: Validate Petri Consensus on testnet with multiple nodes.

### Tasks

1. Happy-path integration test
2. Conflict-path integration test (double-spend → PROBLEMATIC → BFT)
3. Byzantine minority simulation (3/10 bad deltas)
4. Liveness guarantee test (chain never stalls)
5. Feature flag rollback test (Petri ↔ PoRBFT v2)
6. Performance benchmarking (TPS, soft/hard finality latency)

### Acceptance Criteria
- TPS target: >1000/shard (testnet first milestone)
- Soft finality <2s, hard finality <12s
- No chain stalls
- Clean rollback possible

### Risk: High (integration complexity)

---

## Phase 7: Secretary Deprecation & Cleanup

**Goal**: Remove PoRBFT v2 Secretary-based coordination once Petri is validated.

### Tasks
1. Deprecate `SecretaryManager` (mark with @deprecated)
2. Remove Secretary RPC methods (greenlight, setValidatorPhase, etc.)
3. Remove feature flag — Petri becomes sole consensus
4. Clean dead code paths

### Risk: Medium (only after extensive testnet validation)

---

## File Structure (Final)

```
src/libs/consensus/petri/
  index.ts                          # Entry point, petriConsensusRoutine()
  types/
    classificationTypes.ts          # PRE_APPROVED, TO_APPROVE, PROBLEMATIC
    stateDelta.ts                   # StateDelta interface
    continuousForgeTypes.ts         # ContinuousForgeRound, ForgeConfig, DeltaComparison
    petriConfig.ts                  # PetriConfig, DEFAULT_PETRI_CONFIG
  utils/
    canonicalJson.ts                # Deterministic JSON serialization
  classifier/
    transactionClassifier.ts        # Classify txs via GCR edit generation
  execution/
    speculativeExecutor.ts          # Execute txs without mutating state
  forge/
    continuousForge.ts              # 2s forge loop
    deltaAgreementTracker.ts        # Track delta agreement across shard
  block/
    petriBlockCompiler.ts           # Compile PRE_APPROVED into blocks
    petriBlockFinalizer.ts          # Finalize blocks with BFT
  arbitration/
    bftArbitrator.ts                # BFT round for PROBLEMATIC txs
  routing/
    petriRouter.ts                  # Route txs to 2 shard members
    shardMapper.ts                  # Address → shard mapping

better_testing/petri/
    classifier.test.ts              # Classification tests
    speculativeExecutor.test.ts     # Delta determinism tests
    canonicalJson.test.ts           # Serialization tests
    deltaTracker.test.ts            # Agreement tracker tests
    continuousForge.test.ts         # Forge lifecycle tests
    blockCompiler.test.ts           # Block compilation tests
    routing.test.ts                 # Routing tests
    finality.test.ts                # Finality API tests
    integration/
      happyPath.test.ts
      conflictPath.test.ts
      byzantineFault.test.ts
      liveness.test.ts
      rollback.test.ts
      benchmark.test.ts
```

---

## Dependency Graph

```
Phase 0 (Types)
    │
    ▼
Phase 1 (Classification + Tests)
    │
    ▼
Phase 2 (Continuous Forge + Tests)  ←── core innovation, highest risk
    │
    ▼
Phase 3 (Block Finalization + Tests)
    │
    ▼
Phase 4 (RPC Routing + Tests)
    │
    ▼
Phase 5 (Finality API + Tests)
    │
    ▼
Phase 6 (Integration Testing)
    │
    ▼
Phase 7 (Secretary Deprecation)
```
