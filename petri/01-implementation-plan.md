# Petri Consensus — Implementation Plan

> Phased plan for integrating Petri Consensus into the Demos Network node.
> Each phase is self-contained with clear acceptance criteria.
> Phases are sequential — each builds on the previous.

---

## Guiding Principles

1. **Feature-flagged**: Petri runs alongside PoRBFT v2 via config flag. No breaking changes until validated.
2. **Incremental**: Each phase produces testable, deployable code.
3. **Minimal blast radius**: Reuse existing infrastructure wherever possible.
4. **Safety first**: BFT guarantees are never weakened, even during migration.
5. **No over-engineering**: Build the minimum viable Petri, then iterate.

---

## Phase 0: Foundation & Types

**Goal**: Define all new types and interfaces. No behavioral changes.

### Tasks

1. Create `src/libs/consensus/petri/types/` directory structure
2. Define `TransactionClassification` enum: `PRE_APPROVED | TO_APPROVE | PROBLEMATIC`
3. Define `StateDelta` interface: serializable representation of GCR edit results
4. Define `ContinuousForgeRound` interface: round number, timestamp, merged txs, deltas
5. Define `PetriConfig` interface: forge interval (1-2s), block interval (10s), agreement threshold (7/10)
6. Define `DeltaComparison` interface: tx hash, delta hash, agreeing members, disagreeing members
7. Add `petriConsensus` feature flag to `sharedState.ts`
8. Create `src/libs/consensus/petri/index.ts` entry point (stub)

### Acceptance Criteria
- All types compile with `bun run lint:fix`
- No runtime changes
- Feature flag defaults to `false`

### Files Created
```
src/libs/consensus/petri/
  types/
    classificationTypes.ts
    stateDelta.ts
    continuousForgeTypes.ts
    petriConfig.ts
  index.ts
```

### Risk: Low

---

## Phase 1: Transaction Classification

**Goal**: Classify incoming transactions as PRE-APPROVED, TO-APPROVE, or read-only at the shard level.

### Tasks

1. Create `TransactionClassifier` class in `src/libs/consensus/petri/classifier/`
   - Method: `classify(tx: Transaction): TransactionClassification`
   - Read-only / non-state-changing → PRE_APPROVED immediately
   - State-changing → TO_APPROVE (needs delta verification)
   - Determination based on `tx.content.type` and `tx.content.amount`

2. Create `SpeculativeExecutor` class in `src/libs/consensus/petri/execution/`
   - Method: `executeSpeculatively(tx: Transaction): Promise<StateDelta>`
   - Wraps existing `executeNativeTransaction()` + `GCRGeneration.generate(tx)` in simulation mode
   - Produces a `StateDelta` without mutating actual GCR state
   - Uses existing `GCRBalanceRoutines.apply()` with `simulate=true` flag

3. Extend `MempoolTx` entity with optional `classification` field
   - Add `classification: text | null` column
   - Add `delta_hash: text | null` column (hash of speculative execution result)

4. Wire classifier into `handleValidateTransaction()` flow
   - After validation passes, classify the transaction
   - Store classification in mempool entry

### Acceptance Criteria
- Unit tests: classifier correctly categorizes each tx type
- Speculative executor produces deterministic deltas for same input
- Mempool stores classification without breaking existing flow
- `bun run lint:fix` passes

### Dependencies on Existing Code
- `executeNativeTransaction()` at `src/libs/blockchain/routines/executeNativeTransaction.ts`
- `GCRGeneration.generate(tx)` from SDK
- `HandleGCR.apply()` with simulate flag (may need minor extension)
- `MempoolTx` entity at `src/model/entities/Mempool.ts`

### Risk: Medium
- Speculative execution must be side-effect-free
- Delta determinism is critical — same tx must produce same delta on all nodes

---

## Phase 2: Continuous Forge Loop

**Goal**: Implement the 1–2 second continuous forge cycle within a shard.

### Tasks

1. Create `ContinuousForge` class in `src/libs/consensus/petri/forge/`
   - Singleton per active shard participation
   - Method: `start(shard: Shard): void` — begins the 1–2s loop
   - Method: `stop(): void` — halts the loop
   - Method: `runForgeRound(): Promise<ContinuousForgeRound>` — single cycle

2. Implement forge round logic:
   a. **Mempool sync** — reuse `mergeMempools()` but on 1–2s timer
   b. **Re-execute TO-APPROVE txs** — call `SpeculativeExecutor` for each
   c. **Hash deltas** — deterministic hash of each tx's state delta
   d. **Exchange delta hashes** — new RPC method `consensus_routine/exchangeDeltas`
   e. **Compare** — count agreeing members per tx
   f. **Promote** — if 7/10 agree: TO_APPROVE → PRE_APPROVED
   g. **Flag** — if disagreement persists: TO_APPROVE → PROBLEMATIC

3. Create delta exchange RPC handler
   - New method in `manageConsensusRoutines.ts`: `"petri_exchangeDeltas"`
   - Request: `{ roundNumber, deltas: { [txHash]: deltaHash } }`
   - Response: `{ roundNumber, deltas: { [txHash]: deltaHash } }`

4. Create `DeltaAgreementTracker` utility
   - Tracks per-tx agreement counts across forge rounds
   - Promotes or flags based on threshold (configurable, default 7/10)
   - Handles edge cases: tx appears mid-round, member goes offline

### Acceptance Criteria
- Continuous forge runs on configurable interval (default 1.5s)
- Delta hashes are deterministic across shard members
- Transactions correctly transition: TO_APPROVE → PRE_APPROVED or PROBLEMATIC
- Forge loop handles member disconnection gracefully
- `bun run lint:fix` passes

### Architecture Note
```
┌─────────────────────────────────────────────┐
│            Continuous Forge Loop             │
│                 (1–2s cycle)                 │
│                                             │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Mempool  │→│ Speculate │→│ Exchange   │  │
│  │  Sync    │  │ & Delta  │  │  Deltas   │  │
│  └─────────┘  └──────────┘  └─────┬─────┘  │
│                                    │        │
│                              ┌─────▼─────┐  │
│                              │  Compare   │  │
│                              │  & Decide  │  │
│                              └─────┬─────┘  │
│                         ┌──────────┼────────┐
│                         ▼          ▼        │
│                   PRE_APPROVED  PROBLEMATIC │
│                                             │
└─────────────────────────────────────────────┘
```

### Risk: High
- This is the core innovation — no existing code to lean on
- Timer management and race conditions need careful design
- Network latency during delta exchange could cause false disagreements

---

## Phase 3: Block Finalization (10s Boundary)

**Goal**: Compile PRE-APPROVED transactions into blocks at the 10-second boundary, with BFT arbitration for PROBLEMATIC transactions.

### Tasks

1. Create `PetriBlockCompiler` in `src/libs/consensus/petri/block/`
   - Method: `compileBlock(): Promise<Block>`
   - Gathers all PRE_APPROVED transactions from mempool
   - Orders using existing `orderTransactions()` (timestamp-based)
   - Creates block using adapted `createBlock()` logic

2. Create `PetriBlockFinalizer` in `src/libs/consensus/petri/block/`
   - Method: `finalizeBlock(block: Block, shard: Shard): Promise<boolean>`
   - Happy path: broadcast block hash, collect 7/10 signatures → finalize
   - Reuses existing `broadcastBlockHash()` and `manageProposeBlockHash()` adapted

3. Create `BFTArbitrator` in `src/libs/consensus/petri/arbitration/`
   - Method: `arbitrate(problematicTxs: Transaction[], shard: Shard): Promise<Transaction[]>`
   - Runs standard BFT round on PROBLEMATIC txs only
   - If 7/10 agree on a tx → include in block
   - If consensus not reached → reject tx (return to sender as failed)
   - The chain never stalls — rejection is the fail-safe

4. Wire the 10-second timer
   - At block boundary: stop Continuous Forge → compile → arbitrate → finalize → restart
   - Reuse `checkConsensusTime()` logic with Petri's 10s interval

5. Adapt block broadcast
   - `BroadcastManager.broadcastNewBlock()` works as-is for announcing finalized blocks

### Acceptance Criteria
- Blocks produced every 10 seconds containing PRE_APPROVED txs
- PROBLEMATIC txs either resolved via BFT or rejected
- Block finalization uses 7/10 threshold (same as existing `isBlockValid()`)
- Chain never stalls even with Byzantine actors
- Rejected txs return meaningful error to sender
- `bun run lint:fix` passes

### Risk: Medium
- Timing coordination between Continuous Forge stop and block compilation
- Edge case: tx promoted to PRE_APPROVED during block compilation

---

## Phase 4: RPC Routing Refactor

**Goal**: Modify the RPC layer to route validated transactions to exactly 2 shard members.

### Tasks

1. Create `PetriRouter` in `src/libs/consensus/petri/routing/`
   - Method: `routeToShard(tx: Transaction): Promise<[Peer, Peer]>`
   - Determines shard from transaction's address space (tx.content.from)
   - Selects 2 members from shard using deterministic selection
   - Sends validated transaction to both members

2. Modify `endpointHandlers.ts` routing logic
   - When Petri flag is active:
     - After `handleValidateTransaction()` succeeds
     - Call `PetriRouter.routeToShard(tx)` instead of DTR relay
     - Return PRE-APPROVED status for read-only txs immediately
     - Return pending status for state-changing txs

3. Add address-space → shard mapping
   - For single-shard testnet: all addresses map to the one shard
   - Design the mapping interface for future multi-shard support
   - `ShardMapper.getShardForAddress(address: string): ShardId`

### Acceptance Criteria
- Validated txs routed to exactly 2 shard members
- Non-validator nodes relay correctly via the new routing
- Read-only txs get immediate PRE-APPROVED response
- State-changing txs get pending + confirmation block estimate
- `bun run lint:fix` passes

### Risk: Medium
- Must not break existing DTR flow when Petri flag is off
- Address-space mapping needs to be extensible for multi-shard

---

## Phase 5: Finality & Status API

**Goal**: Expose dual finality model (soft/hard) to clients.

### Tasks

1. Extend transaction status tracking
   - Add `soft_finality_at` timestamp to transaction records
   - PRE-APPROVED timestamp = soft finality
   - Block inclusion timestamp = hard finality

2. Add RPC methods for finality queries
   - `getTransactionFinality(hash)`: returns `{ soft: timestamp | null, hard: timestamp | null }`
   - `subscribeFinality(hash)`: WebSocket/SSE stream for finality updates

3. Update existing status endpoints
   - `statusOf(address)` should reflect soft-finalized state changes
   - Clearly distinguish "soft-final" from "hard-final" in responses

### Acceptance Criteria
- Clients can query soft vs hard finality
- Soft finality available within 1–2s of submission
- Hard finality available within 10s
- Existing RPC methods still work (backward compatible)

### Risk: Low

---

## Phase 6: Integration Testing & Hardening

**Goal**: Validate Petri Consensus on testnet with multiple nodes.

### Tasks

1. Create integration test suite in `tests/petri/`
   - Happy path: submit tx → PRE-APPROVED in 1–2s → block inclusion in 10s
   - Conflict path: submit conflicting txs → PROBLEMATIC → BFT resolution
   - Byzantine simulation: 3/10 nodes return wrong deltas → system still works
   - Liveness: block production continues even with PROBLEMATIC txs
   - Edge cases: tx submitted during block compilation, member goes offline mid-forge

2. Performance benchmarking
   - Measure actual TPS per shard
   - Measure soft finality latency
   - Measure hard finality latency
   - Compare with PoRBFT v2 baseline

3. Feature flag validation
   - Verify clean switch between PoRBFT v2 and Petri
   - Verify both can run on different nodes in same network (migration path)

### Acceptance Criteria
- All integration tests pass
- TPS target: >1000 per shard on testnet (conservative first milestone)
- Soft finality <2s, hard finality <12s
- No chain stalls under any test scenario
- Clean rollback to PoRBFT v2 possible

### Risk: High (integration complexity)

---

## Phase 7: Secretary Deprecation & Cleanup

**Goal**: Remove PoRBFT v2 Secretary-based coordination once Petri is validated.

### Tasks

1. Mark `SecretaryManager` as deprecated
2. Remove Secretary-specific RPC methods (greenlight, setValidatorPhase)
3. Remove `ValidationPhase` 7-phase tracking
4. Remove feature flag — Petri becomes the only consensus
5. Update documentation
6. Clean up dead code paths

### Acceptance Criteria
- `SecretaryManager` fully removed
- No dead code paths
- All tests pass without Secretary
- Documentation updated

### Risk: Medium (must be fully confident in Petri first)

---

## File Structure (Final)

```
src/libs/consensus/petri/
  index.ts                          # Entry point, feature flag check
  types/
    classificationTypes.ts          # PRE_APPROVED, TO_APPROVE, PROBLEMATIC
    stateDelta.ts                   # StateDelta interface
    continuousForgeTypes.ts         # ContinuousForgeRound, ForgeConfig
    petriConfig.ts                  # PetriConfig interface
  classifier/
    transactionClassifier.ts        # Classify txs by type
  execution/
    speculativeExecutor.ts          # Execute txs without mutating state
  forge/
    continuousForge.ts              # 1–2s forge loop
    deltaAgreementTracker.ts        # Track delta agreement across shard
  block/
    petriBlockCompiler.ts           # Compile PRE_APPROVED into blocks
    petriBlockFinalizer.ts          # Finalize blocks with BFT
  arbitration/
    bftArbitrator.ts                # BFT round for PROBLEMATIC txs
  routing/
    petriRouter.ts                  # Route txs to 2 shard members
    shardMapper.ts                  # Address → shard mapping
```

---

## Dependency Graph

```
Phase 0 (Types)
    │
    ▼
Phase 1 (Classification)
    │
    ▼
Phase 2 (Continuous Forge)  ←── core innovation, highest risk
    │
    ▼
Phase 3 (Block Finalization)
    │
    ▼
Phase 4 (RPC Routing)
    │
    ▼
Phase 5 (Finality API)
    │
    ▼
Phase 6 (Integration Testing)
    │
    ▼
Phase 7 (Secretary Deprecation)
```

---

## Timeline Considerations

- **Phase 0–1**: Low risk, can move fast. Foundation work.
- **Phase 2**: Core innovation. Needs careful design, thorough testing. Allocate most time here.
- **Phase 3**: Builds on Phase 2. Medium complexity.
- **Phase 4**: Can partially parallelize with Phase 3 (routing is independent of block finalization).
- **Phase 5**: Small scope, low risk.
- **Phase 6**: Integration testing drives confidence. Don't rush.
- **Phase 7**: Only after testnet validation. No pressure.
