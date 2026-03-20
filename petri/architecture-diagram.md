# Petri Consensus — Living Architecture Diagram

**Last updated:** 2026-03-20 (Phase 5 — Finality & Status API)

---

## Architecture Diagram

```
                      PETRI CONSENSUS — PHASE 0 + PHASE 1 + PHASE 2 + PHASE 3 + PHASE 4 + PHASE 5
                      ============================================================================

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  FEATURE FLAG ENTRY POINT                                                                    │
    │  src/utilities/sharedState.ts                                                           [P0] │
    │                                                                                              │
    │    petriConsensus: boolean = false        ── master on/off switch                            │
    │    petriConfig: PetriConfig = {...}       ── imports DEFAULT_PETRI_CONFIG                    │
    │                                                                                              │
    └──────────────────────────────┬───────────────────────────────────────────────────────────────┘
                                   │
                                   │ imports PetriConfig, DEFAULT_PETRI_CONFIG
                                   │
    ┌──────────────────────────────▼───────────────────────────────────────────────────────────────┐
    │  BARREL / ENTRY POINT                                                                        │
    │  src/libs/consensus/petri/index.ts                                                 [P0→P5]  │
    │                                                                                              │
    │    Re-exports all types from ./types/*                                                       │
    │    Re-exports ContinuousForge, DeltaAgreementTracker from ./forge/*              ── NEW P2  │
    │    Re-exports block/* and arbitration/* modules                                   ── NEW P3  │
    │    Re-exports routing/* (petriRouter, shardMapper)                                ── NEW P4  │
    │    Re-exports finality/* (getTransactionFinality)                                 ── NEW P5  │
    │    petriConsensusRoutine(shard): Promise<void>  ── full block lifecycle           ── UPD P3  │
    │      1. forge.start(shard)                                                                   │
    │      2. sleep(blockIntervalMs)                                                               │
    │      3. forge.pause()                                                                        │
    │      4. arbitrate(shard)                                                                     │
    │      5. compileBlock(shard, resolved)                                                        │
    │      6. finalizeBlock(block, shard)                                                          │
    │      7. cleanRejectedFromMempool(rejectedHashes)                                            │
    │      8. forge.reset() → forge.resume()                                                      │
    │                                                                                              │
    └──┬──────────────┬──────────────┬──────────────┬──────────────────────────────────────────────┘
       │              │              │              │
       │ re-exports   │ re-exports   │ re-exports   │ re-exports
       │              │              │              │
       ▼              ▼              ▼              ▼
    ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐
    │  classif │  │  state   │  │  contin  │  │  delta       │
    │  ication │  │  Delta   │  │  uous    │  │  Comparison  │
    │  Types   │  │          │  │  Forge   │  │              │
    │          │  │          │  │  Types   │  │              │
    │    [P0]  │  │    [P0]  │  │    [P0]  │  │        [P0]  │
    └──────────┘  └──────────┘  └─────┬────┘  └──────────────┘
         │              │             │              │
         │              │             │              │
         ▼              ▼             ▼              ▼
    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  TYPE DEPENDENCY GRAPH                                                                       │
    │                                                                                              │
    │                                                                                              │
    │  ┌────────────────────┐         ┌────────────────────┐                                       │
    │  │ petriConfig.ts     │         │classificationTypes │                                       │
    │  │                    │         │        .ts         │                                       │
    │  │  PetriConfig       │         │                    │                                       │
    │  │    extends         │         │ TransactionClassi- │                                       │
    │  │    ForgeConfig ────┼────┐    │   fication (enum)  │                                       │
    │  │                    │    │    │ ClassifiedTrans-   │                                       │
    │  │  DEFAULT_PETRI_    │    │    │   action (iface)   │                                       │
    │  │    CONFIG (const)  │    │    └────────┬───────────┘                                       │
    │  └────────────────────┘    │             │                                                   │
    │                            │             │ ClassifiedTransaction                             │
    │                            │             │                                                   │
    │                            │    ┌────────▼───────────┐      ┌────────────────────┐           │
    │                            │    │continuousForge     │      │ deltaComparison.ts │           │
    │                            │    │       Types.ts     │      │                    │           │
    │                            │    │                    │      │ DeltaComparison    │           │
    │                            ├───►│ ForgeConfig(iface) │      │   (iface)          │           │
    │                            │    │ ForgeState (iface) │      │ RoundDeltaResult   │           │
    │                            │    │ ContinuousForge-   │      │   (iface)          │           │
    │                            │    │   Round (iface)    │      └────────────────────┘           │
    │                            │    └────────┬───────────┘                                       │
    │                            │             │                                                   │
    │                            │             │ StateDelta, PeerDelta                             │
    │                            │             │                                                   │
    │                            │    ┌────────▼───────────┐                                       │
    │                            │    │ stateDelta.ts      │                                       │
    │                            │    │                    │      ┌──────────────────────────┐      │
    │                            │    │ StateDelta (iface) │─────►│ @kynesyslabs/demosdk/   │      │
    │                            │    │ PeerDelta  (iface) │      │   types :: GCREdit      │      │
    │                            │    └────────────────────┘      └──────────────────────────┘      │
    │                                                                   (external dep)             │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘


    ╔═══════════════════════════════════════════════════════════════════════════════════════════════╗
    ║  PHASE 1 — CLASSIFICATION & SPECULATIVE EXECUTION DATA FLOW                                  ║
    ╚═══════════════════════════════════════════════════════════════════════════════════════════════╝

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  VALIDATION ENTRY POINT                                                                [P1]  │
    │  src/libs/network/endpointValidation.ts                                                      │
    │                                                                                              │
    │    handleValidateTransaction(tx, sender)                                                     │
    │      1. confirmTransaction(tx, sender)         ── existing validation                       │
    │      2. GCRGeneration.generate(tx)             ── existing GCR edit generation              │
    │      3. GCR edit hash match check              ── existing integrity check                  │
    │      4. Balance sufficiency check              ── existing fee check                        │
    │                                                                                              │
    │      ┌──── if (getSharedState.petriConsensus) ────────────────── FEATURE FLAG GATE ────┐     │
    │      │                                                                                  │     │
    │      │  5. classifyTransaction(tx, gcrEdits)                                      [P1] │     │
    │      │  6. if TO_APPROVE → executeSpeculatively(tx, edits)                        [P1] │     │
    │      │  7. Mempool.updateClassification(hash, classification, deltaHash)          [P1] │     │
    │      │                                                                                  │     │
    │      └──────────────────────────────────────────────────────────────────────────────────┘     │
    │                                                                                              │
    └──────────────────────────────┬───────────────────────────────────────────────────────────────┘
                                   │
          ┌────────────────────────┼────────────────────────────────┐
          │                        │                                │
          ▼                        ▼                                ▼
    ┌─────────────────┐  ┌──────────────────────┐  ┌──────────────────────────────────┐
    │  CLASSIFIER     │  │  SPECULATIVE         │  │  CANONICAL JSON UTILITY          │
    │           [P1]  │  │  EXECUTOR      [P1]  │  │                            [P1]  │
    │                 │  │                       │  │                                  │
    │  petri/         │  │  petri/               │  │  petri/                          │
    │   classifier/   │  │   execution/          │  │   utils/                         │
    │    transaction   │  │    speculative        │  │    canonicalJson.ts              │
    │    Classifier.ts │  │    Executor.ts        │  │                                  │
    │                 │  │                       │  │  canonicalJson(value): string     │
    │  classifyTrans- │  │  executeSpeculatively │  │    - sorted keys                 │
    │    action(tx,   │  │    (tx, gcrEdits)     │  │    - BigInt → "Nn"               │
    │    precomputed  │  │                       │  │    - Map → sorted entries         │
    │    Edits?)      │  │  Returns:             │  │    - Set → sorted values          │
    │                 │  │    SpeculativeResult   │  │                                  │
    │  Returns:       │  │    { success, delta?, │  │  Guarantees: identical objects    │
    │   Classification│  │      error? }         │  │   produce identical strings       │
    │   Result        │  │                       │  │                                  │
    │   { classifi-   │  │  Internals:           │  └──────────────────────────────────┘
    │     cation,     │  │   GCRBalanceRoutines  │
    │     gcrEdits }  │  │     .apply(simulate)  │
    │                 │  │   GCRNonceRoutines    │
    │  Logic:         │  │     .apply(simulate)  │
    │   fee/nonce     │  │   GCRIdentityRoutines │
    │   only edits    │  │     .apply(simulate)  │
    │   → PRE_APPROVED│  │                       │
    │   else          │  │                       │
    │   → TO_APPROVE  │  │                       │
    └────────┬────────┘  └───────────┬───────────┘
             │                       │
             │                       │ uses canonicalJson + Hashing.sha256
             │                       │ to produce deterministic delta hash
             │                       │
             │                       ▼
             │           ┌───────────────────────┐
             │           │  Hashing.sha256  [P0]  │  (existing crypto utility)
             │           │  src/libs/crypto/      │
             │           │   hashing.ts           │
             │           └───────────┬───────────┘
             │                       │
             │                       │ deltaHash
             ▼                       ▼
    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  MEMPOOL (MODIFIED)                                                                [P1→P2]  │
    │  src/libs/blockchain/mempool_v2.ts                                                           │
    │                                                                                              │
    │    Existing methods: getMempool, addTransaction, removeTransactionsByHashes, ...             │
    │                                                                                              │
    │    + getByClassification(classification, blockNumber?)           ── NEW (P1)                 │
    │    + getPreApproved(blockNumber?)                                ── NEW (P1)                 │
    │    + updateClassification(txHash, classification, deltaHash?)    ── NEW (P1)                 │
    │                                                                                              │
    └──────────────────────────────┬───────────────────────────────────────────────────────────────┘
                                   │
                                   │ persists to
                                   ▼
    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  MEMPOOL ENTITY (MODIFIED)                                                          [P1→P5]  │
    │  src/model/entities/Mempool.ts                                                               │
    │                                                                                              │
    │    MempoolTx entity — existing columns + 3 new:                                             │
    │                                                                                              │
    │    + classification: text (nullable)    ── PRE_APPROVED | TO_APPROVE | PROBLEMATIC          │
    │    + delta_hash: text (nullable)        ── sha256 of canonical GCR edits                    │
    │    + soft_finality_at: datetime (nullable) ── when tx first reached PRE_APPROVED   ── P5   │
    │                                                                                              │
    │    + idx_mempooltx_classification       ── new index for classification queries              │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘


    ╔═══════════════════════════════════════════════════════════════════════════════════════════════╗
    ║  PHASE 2 — CONTINUOUS FORGE & DELTA AGREEMENT                                                ║
    ╚═══════════════════════════════════════════════════════════════════════════════════════════════╝


    FORGE LOOP — CYCLIC FLOW (2s interval)
    ───────────────────────────────────────

    petriConsensusRoutine(shard)                                                             [P2]
    src/libs/consensus/petri/index.ts
        │
        │  1. new ContinuousForge(config)
        │  2. setPetriForgeInstance(forge)
        │  3. forge.start(shard)
        │
        ▼
    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  CONTINUOUS FORGE                                                                      [P2]  │
    │  src/libs/consensus/petri/forge/continuousForge.ts                                          │
    │                                                                                              │
    │    start(shard) / stop() / pause() / resume() / reset()                                     │
    │    getCurrentDeltas(): Record<txHash, deltaHash>   ── exposed for RPC handler               │
    │    getState(): ForgeState                          ── diagnostics                            │
    │                                                                                              │
    │    ┌─────────────────────────────────────────────────────────────────────────────────────┐   │
    │    │  scheduleNextRound() ──► setTimeout(forgeIntervalMs) ──► runForgeRound()           │   │
    │    │       ▲                                                        │                    │   │
    │    │       └────────────────────── loop ────────────────────────────┘                    │   │
    │    └─────────────────────────────────────────────────────────────────────────────────────┘   │
    │                                                                                              │
    └──────────────────────────────────────────────────────────────────────────────────────────────┘

    runForgeRound() — detailed step-by-step:

    ┌──── Step 1 ──────────────────────────────────────────────────────────────────────────────────┐
    │  MEMPOOL SYNC                                                                                │
    │  mergeMempools(ourMempool, shard)    ── reuses existing v2 merge routine                    │
    └──────────────────────────┬───────────────────────────────────────────────────────────────────┘
                               │
                               ▼
    ┌──── Step 2 ──────────────────────────────────────────────────────────────────────────────────┐
    │  GET CANDIDATES                                                                              │
    │  Mempool.getByClassification(TO_APPROVE)    ── from Phase 1 mempool additions               │
    └──────────────────────────┬───────────────────────────────────────────────────────────────────┘
                               │
                               ▼
    ┌──── Step 3 ──────────────────────────────────────────────────────────────────────────────────┐
    │  SPECULATIVE EXECUTION                                                                       │
    │  For each TO_APPROVE tx:                                                                     │
    │    - Use existing delta_hash if present (computed at mempool insertion, P1)                  │
    │    - Otherwise: classifyTransaction → executeSpeculatively → update mempool                  │
    │  Build localDeltas: Record<txHash, deltaHash>                                               │
    └──────────────────────────┬───────────────────────────────────────────────────────────────────┘
                               │
                               ▼
    ┌──── Step 4 ──────────────────────────────────────────────────────────────────────────────────┐
    │  DELTA EXCHANGE (all-to-all within shard)                                                    │
    │                                                                                              │
    │  exchangeDeltas(round, localDeltas)                                                         │
    │    For each peer in shard:                                                                   │
    │      peer.longCall({ method: "petri_exchangeDeltas", params: [{ roundNumber, deltas }] })   │
    │      ──► receives peer's deltas in response                                                 │
    │    Returns: Record<peerKey, Record<txHash, deltaHash>>                                      │
    └──────────────────────────┬───────────────────────────────────────────────────────────────────┘
                               │
                               ▼
    ┌──── Step 5 ──────────────────────────────────────────────────────────────────────────────────┐
    │  RECORD DELTAS                                                                               │
    │  tracker.recordDelta(txHash, deltaHash, memberKey, round)   ── for local + all peers        │
    └──────────────────────────┬───────────────────────────────────────────────────────────────────┘
                               │
                               ▼
    ┌──── Step 6 ──────────────────────────────────────────────────────────────────────────────────┐
    │  EVALUATE AGREEMENT                                                                          │
    │  tracker.evaluate(shardSize, round)                                                         │
    │    Returns: { promoted: txHash[], flagged: txHash[] }                                       │
    │    - promoted: delta hash reached agreement threshold                                       │
    │    - flagged:  TTL rounds expired without agreement                                         │
    └──────────────────────────┬───────────────────────────────────────────────────────────────────┘
                               │
                               ▼
    ┌──── Step 7 ──────────────────────────────────────────────────────────────────────────────────┐
    │  UPDATE MEMPOOL CLASSIFICATIONS                                                              │
    │  promoted txs: Mempool.updateClassification(txHash, PRE_APPROVED)                           │
    │  flagged  txs: Mempool.updateClassification(txHash, PROBLEMATIC)                            │
    └──────────────────────────────────────────────────────────────────────────────────────────────┘


    DELTA AGREEMENT TRACKER
    ───────────────────────

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  DELTA AGREEMENT TRACKER                                                               [P2]  │
    │  src/libs/consensus/petri/forge/deltaAgreementTracker.ts                                    │
    │                                                                                              │
    │    constructor(threshold, ttlRounds)                                                         │
    │                                                                                              │
    │    recordDelta(txHash, deltaHash, memberKey, round)                                         │
    │      └── stores memberKey → deltaHash per tx                                                │
    │                                                                                              │
    │    evaluate(shardSize, currentRound) → { promoted[], flagged[] }                            │
    │      ├── majority vote: hash count >= threshold → PROMOTED                                  │
    │      ├── roundsTracked >= ttlRounds             → FLAGGED                                   │
    │      └── cleans up decided txs from tracking map                                            │
    │                                                                                              │
    │    getComparison(txHash, localDeltaHash, totalMembers) → DeltaComparison | null             │
    │      └── diagnostics: agree/disagree/missing counts                                         │
    │                                                                                              │
    │    reset()          ── clears all tracking state                                             │
    │    trackedCount     ── number of txs currently tracked                                       │
    │                                                                                              │
    │    Internal state: Map<txHash, TxDeltaState>                                                │
    │      TxDeltaState { memberHashes: Map<memberKey, deltaHash>,                                │
    │                     firstSeenRound, roundsTracked }                                         │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘


    FORGE INSTANCE SINGLETON & RPC BRIDGE
    ──────────────────────────────────────

    ┌────────────────────────────┐           ┌──────────────────────────────────────────────────────┐
    │  FORGE INSTANCE      [P2] │           │  RPC HANDLER (MODIFIED)                        [P2] │
    │  petri/forge/             │           │  src/libs/network/manageConsensusRoutines.ts        │
    │   forgeInstance.ts        │           │                                                      │
    │                           │           │  case "petri_exchangeDeltas":                        │
    │  petriForgeInstance       │◄──────────│    1. Check petriConsensus flag                      │
    │    (global singleton)     │  reads    │    2. petriForgeInstance.getCurrentDeltas()           │
    │                           │           │    3. Return { deltas: ourDeltas }                   │
    │  setPetriForgeInstance()  │           │                                                      │
    │    called by              │           │  Receives from caller:                               │
    │    petriConsensusRoutine  │           │    { roundNumber, deltas: Record<txHash, deltaHash> }│
    │                           │           │                                                      │
    └────────────────────────────┘           └──────────────────────────────────────────────────────┘
             ▲                                            ▲
             │ setPetriForgeInstance(forge)                │ peer.longCall(...)
             │                                            │
    ┌────────┴────────────┐              ┌────────────────┴──────────────────┐
    │  petriConsensus-    │              │  ContinuousForge.exchangeDeltas() │
    │  Routine()    [P2]  │              │  (private method)           [P2]  │
    │  index.ts           │              │  continuousForge.ts               │
    └─────────────────────┘              └───────────────────────────────────┘


    COMPLETE DATA FLOW — FORGE ROUND (summary, P2)
    ───────────────────────────────────────────────

    ┌──────────┐    merge     ┌──────────┐  TO_APPROVE  ┌──────────────┐  specExec  ┌────────────┐
    │  Shard   │─────────────►│  Mempool │─────────────►│ ContinuousF. │──────────►│ Speculative │
    │  Peers   │              │   (P1)   │              │  (P2)        │           │ Executor(P1)│
    └──────────┘              └──────────┘              └──────┬───────┘           └──────┬──────┘
         ▲                         ▲                          │                          │
         │                         │                          │ localDeltas              │ deltaHash
         │  petri_exchangeDeltas   │  updateClassification    │                          │
         │  (longCall RPC)         │  (promoted/flagged)      ▼                          │
         │                         │                   ┌──────────────┐                  │
         │                         └───────────────────│ DeltaAgreem. │◄─────────────────┘
         │                                             │ Tracker (P2) │
         │              peerDeltas                     │              │
         └─────────────────────────────────────────────│  recordDelta │
                                                       │  evaluate    │
                                                       └──────────────┘


    ╔═══════════════════════════════════════════════════════════════════════════════════════════════╗
    ║  PHASE 3 — BLOCK FINALIZATION (Arbitration → Compilation → Finalization)                     ║
    ╚═══════════════════════════════════════════════════════════════════════════════════════════════╝


    FULL BLOCK LIFECYCLE — petriConsensusRoutine(shard)
    ───────────────────────────────────────────────────

    ┌──── Step 1 (P2) ───────────────────────────────────────────────────────────────────────────┐
    │  forge.start(shard)        ── begins ContinuousForge loop (2s rounds)                     │
    └─────────────────────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
    ┌──── Step 2 (P3) ───────────────────────────────────────────────────────────────────────────┐
    │  sleep(blockIntervalMs)    ── default 10s, txs accumulate in mempool                      │
    └─────────────────────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
    ┌──── Step 3 (P3) ───────────────────────────────────────────────────────────────────────────┐
    │  forge.pause()             ── stops forge rounds, no new delta exchange                    │
    └─────────────────────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
    ┌──── Step 4 (P3) ───────────────────────────────────────────────────────────────────────────┐
    │  ARBITRATE                                                                                 │
    │  arbitrate(shard) → { resolved: ClassifiedTransaction[], rejectedHashes: string[] }       │
    │    - Gets PROBLEMATIC txs from mempool                                                     │
    │    - Runs BFT round to resolve disputes                                                    │
    │    - Returns resolved txs (reclassified) + rejected hashes                                 │
    └─────────────────────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ resolved[], rejectedHashes[]
                                  ▼
    ┌──── Step 5 (P3) ───────────────────────────────────────────────────────────────────────────┐
    │  COMPILE BLOCK                                                                             │
    │  compileBlock(shard, resolved) → CompilationResult                                        │
    │    1. Mempool.getPreApproved()        ── get PRE_APPROVED txs from mempool                │
    │    2. Merge PRE_APPROVED + resolved   ── combine into candidate list                      │
    │    3. orderTransactions()             ── deterministic ordering (reused PoRBFTv2)          │
    │    4. createBlock()                   ── assemble block structure (reused PoRBFTv2)        │
    │    Returns: { block, txCount }                                                            │
    └─────────────────────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ block
                                  ▼
    ┌──── Step 6 (P3) ───────────────────────────────────────────────────────────────────────────┐
    │  FINALIZE BLOCK                                                                            │
    │  finalizeBlock(block, shard) → FinalizationResult                                         │
    │    1. broadcastBlockHash()            ── announce hash to shard   (reused PoRBFTv2)       │
    │    2. isBlockValid()                  ── BFT validity check                               │
    │    3. insertBlock()                   ── persist to chain         (reused chainBlocks)     │
    │    4. BroadcastManager.broadcastNewBlock()  ── full block to network (reused)              │
    │    Returns: { success, blockHash }                                                        │
    └─────────────────────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
    ┌──── Step 7 (P3) ───────────────────────────────────────────────────────────────────────────┐
    │  CLEANUP & RESUME                                                                          │
    │  cleanRejectedFromMempool(rejectedHashes)   ── remove rejected txs                        │
    │  forge.reset()                               ── clear delta tracker state                  │
    │  forge.resume()                              ── restart forge rounds for next block        │
    └─────────────────────────────────────────────────────────────────────────────────────────────┘


    PHASE 3 MODULES — DETAIL
    ─────────────────────────

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  BFT ARBITRATOR                                                                        [P3]  │
    │  src/libs/consensus/petri/arbitration/bftArbitrator.ts                                       │
    │                                                                                              │
    │    arbitrate(shard)                                                                          │
    │      1. Mempool.getByClassification(PROBLEMATIC)    ── get disputed txs                    │
    │      2. BFT round among shard validators            ── consensus on resolution              │
    │      3. Returns: { resolved: ClassifiedTransaction[],                                      │
    │                     rejectedHashes: string[] }                                              │
    │                                                                                              │
    │    resolved txs  → forwarded to compileBlock()                                              │
    │    rejectedHashes → forwarded to cleanRejectedFromMempool()                                 │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  BLOCK COMPILER                                                                        [P3]  │
    │  src/libs/consensus/petri/block/petriBlockCompiler.ts                                       │
    │                                                                                              │
    │    compileBlock(shard, resolvedTxs) → CompilationResult                                    │
    │      1. Mempool.getPreApproved()              ── PRE_APPROVED txs                          │
    │      2. Merge PRE_APPROVED + resolvedTxs      ── full candidate set                       │
    │      3. orderTransactions(candidates)          ── deterministic sort (reused PoRBFTv2)     │
    │      4. createBlock(ordered, shard)            ── block assembly     (reused PoRBFTv2)     │
    │      Returns: CompilationResult { block, txCount }                                        │
    │                                                                                              │
    │    cleanRejectedFromMempool(rejectedHashes)                                                │
    │      └── Mempool.removeTransactionsByHashes(rejectedHashes)                                │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  BLOCK FINALIZER                                                                       [P3]  │
    │  src/libs/consensus/petri/block/petriBlockFinalizer.ts                                      │
    │                                                                                              │
    │    finalizeBlock(block, shard) → FinalizationResult                                        │
    │      1. broadcastBlockHash(block, shard)      ── hash announcement   (reused PoRBFTv2)    │
    │      2. isBlockValid(block, shard)            ── BFT validity check                       │
    │      3. insertBlock(block)                    ── chain persistence    (reused chainBlocks)  │
    │      4. BroadcastManager.broadcastNewBlock(block)  ── network broadcast (reused)           │
    │      Returns: FinalizationResult { success, blockHash }                                   │
    │                                                                                              │
    │    isBlockValid(block, shard) → boolean                                                    │
    │      └── BFT round: validators vote on block validity                                     │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘


    REUSED PoRBFT v2 INFRASTRUCTURE                                                          [P3]
    ───────────────────────────────

    ┌──────────────────────────────────┐    ┌──────────────────────────────────┐
    │  createBlock()             [v2]  │    │  orderTransactions()       [v2]  │
    │  src/libs/consensus/v2/          │    │  src/libs/consensus/v2/          │
    │   routines/createBlock.ts        │    │   routines/orderTransactions.ts  │
    └──────────────────────────────────┘    └──────────────────────────────────┘

    ┌──────────────────────────────────┐    ┌──────────────────────────────────┐
    │  broadcastBlockHash()      [v2]  │    │  getCommonValidatorSeed()  [v2]  │
    │  src/libs/consensus/v2/          │    │  src/libs/consensus/v2/          │
    │   routines/broadcastBlockHash.ts │    │   routines/getCommonValidator-   │
    └──────────────────────────────────┘    │   Seed.ts                        │
                                            └──────────────────────────────────┘
    ┌──────────────────────────────────┐    ┌──────────────────────────────────┐
    │  insertBlock()        [existing] │    │  BroadcastManager        [exist] │
    │  src/libs/blockchain/            │    │  src/libs/communications/        │
    │   chainBlocks.ts                 │    │   broadcastManager.ts            │
    │                                  │    │                                  │
    │  Persists block to DB            │    │  broadcastNewBlock(block)        │
    └──────────────────────────────────┘    └──────────────────────────────────┘

    ┌──────────────────────────────────┐
    │  getShard()              [v2]    │
    │  src/libs/consensus/v2/          │
    │   routines/getShard.ts           │
    └──────────────────────────────────┘


    CONSENSUS DISPATCH SWITCHING                                                             [P3]
    ────────────────────────────

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  MAIN LOOP (MODIFIED)                                                                  [P3]  │
    │  src/utilities/mainLoop.ts                                                                   │
    │                                                                                              │
    │    if (petriConsensus) → petriConsensusRoutine(shard)                                       │
    │    else                → existing PoRBFTv2 consensus routine                                │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  RPC CONSENSUS HANDLER (MODIFIED)                                                    [P2→P3] │
    │  src/libs/network/manageConsensusRoutines.ts                                                 │
    │                                                                                              │
    │    case "petri_exchangeDeltas":                                                     [P2]    │
    │      1. Check petriConsensus flag                                                           │
    │      2. petriForgeInstance.getCurrentDeltas()                                                │
    │      3. Return { deltas: ourDeltas }                                                        │
    │                                                                                              │
    │    Consensus dispatch switching:                                                    [P3]    │
    │      if (petriConsensus) → route to Petri handlers                                         │
    │      else                → route to PoRBFTv2 handlers                                      │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘


    COMPLETE DATA FLOW — FULL BLOCK LIFECYCLE (summary, P0–P3)
    ──────────────────────────────────────────────────────────

                                    ┌─────────────┐
                                    │  mainLoop   │
                                    │    (P3)     │
                                    └──────┬──────┘
                                           │ petriConsensus?
                                           ▼
                                    ┌─────────────┐
                                    │  petriCon-  │
                                    │  sensus-    │
                                    │  Routine    │
                                    │  (P0→P3)   │
                                    └──────┬──────┘
                          ┌────────────────┼─────────────────────┐
                          │                │                      │
                          ▼                ▼                      ▼
                   ┌────────────┐  ┌─────────────┐       ┌─────────────┐
                   │ Continuous │  │  sleep(10s) │       │ forge.reset │
                   │ Forge (P2) │  │  then pause │       │ forge.resume│
                   │ start/     │  └──────┬──────┘       └─────────────┘
                   │ pause/     │         │                      ▲
                   │ resume/    │         ▼                      │
                   │ reset      │  ┌─────────────┐              │
                   └────────────┘  │  arbitrate  │              │
                                   │    (P3)     │              │
                                   └──┬───────┬──┘              │
                        resolved[]    │       │ rejectedHashes  │
                          ┌───────────┘       └────────┐        │
                          ▼                            ▼        │
                   ┌─────────────┐          ┌──────────────┐    │
                   │ compileBlock│          │ cleanRejected│    │
                   │    (P3)     │          │ FromMempool  │    │
                   └──────┬──────┘          │    (P3)      │    │
                          │ block           └──────────────┘    │
                          ▼                                     │
                   ┌─────────────┐                              │
                   │ finalizeBlk │                              │
                   │    (P3)     │──────────────────────────────┘
                   │ broadcast → │
                   │ validate →  │
                   │ insert →    │
                   │ broadcast   │
                   └─────────────┘


    ╔═══════════════════════════════════════════════════════════════════════════════════════════════╗
    ║  PHASE 4 — RPC ROUTING REFACTOR (Shard Mapping & Petri Relay)                               ║
    ╚═══════════════════════════════════════════════════════════════════════════════════════════════╝


    CLIENT TX SUBMISSION — PETRI RELAY FLOW
    ────────────────────────────────────────

    ┌──── Step 1 ──────────────────────────────────────────────────────────────────────────────────┐
    │  CLIENT SENDS TRANSACTION                                                                    │
    │  → src/libs/network/endpointHandlers.ts                        (existing, unmodified)        │
    │  → src/libs/network/endpointValidation.ts                      (existing, validates tx)      │
    └──────────────────────────┬───────────────────────────────────────────────────────────────────┘
                               │
                               │ validityData (validated tx + GCR edits)
                               ▼
    ┌──── Step 2 ──────────────────────────────────────────────────────────────────────────────────┐
    │  ENDPOINT EXECUTION (MODIFIED)                                                         [P4]  │
    │  src/libs/network/endpointExecution.ts                                                       │
    │                                                                                              │
    │    ┌──── if (getSharedState.petriConsensus) ────────────── FEATURE FLAG GATE ────────┐       │
    │    │                                                                                  │       │
    │    │  petriRelay(validityData)                                                   [P4] │       │
    │    │  EARLY RETURN — skips validator check + existing DTR flow                        │       │
    │    │  Returns: { success, routing: "petri" }                                         │       │
    │    │                                                                                  │       │
    │    └──────────────────────────────────────────────────────────────────────────────────┘       │
    │                                                                                              │
    │    else → existing DTR flow (unchanged)                                                     │
    │                                                                                              │
    └──────────────────────────┬───────────────────────────────────────────────────────────────────┘
                               │
                               │ calls petriRouter.relay(validityData)
                               ▼
    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  PETRI ROUTER                                                                          [P4]  │
    │  src/libs/consensus/petri/routing/petriRouter.ts                                            │
    │                                                                                              │
    │    relay(validityData)                                                                       │
    │      1. getCurrentShard()               ── returns 'default' (single-shard testnet)        │
    │      2. selectMembers(txHash, shard, 2) ── picks 2 members via Alea PRNG                  │
    │      3. For each selected member:                                                           │
    │           peer.longCall({                                                                   │
    │             method: "nodeCall",                                                              │
    │             params: [{ message: "RELAY_TX", data: [validityData] }]                        │
    │           })                                                                                │
    │      Returns: { success, routing: "petri" }                                                │
    │                                                                                              │
    │    selectMembers(txHash, shard, membersPerTx=2) → peerKey[]                                │
    │      └── deterministic selection using Alea PRNG seeded with txHash                        │
    │                                                                                              │
    │    getCurrentShard() → string                                                               │
    │      └── delegates to shardMapper.getShardForAddress()                                     │
    │                                                                                              │
    └──────────────────────────┬───────────────────────────────────────────────────────────────────┘
                               │
                               │ delegates shard lookup
                               ▼
    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  SHARD MAPPER                                                                          [P4]  │
    │  src/libs/consensus/petri/routing/shardMapper.ts                                            │
    │                                                                                              │
    │    getShardForAddress(address?) → string                                                    │
    │      └── single-shard testnet: always returns 'default'                                    │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘


    COMPLETE DATA FLOW — PETRI RELAY (summary, P4)
    ───────────────────────────────────────────────

    ┌──────────┐  validate  ┌──────────────┐  petriConsensus?  ┌──────────────┐
    │  Client  │───────────►│ endpointValid│─────────────────►│ endpointExec │
    │          │            │  ation (P1)  │                   │  ution (P4)  │
    └──────────┘            └──────────────┘                   └──────┬───────┘
                                                                      │
                                        ┌─────────────────────────────┘
                                        │ petriRelay()
                                        ▼
                                 ┌─────────────┐  getCurrentShard()  ┌─────────────┐
                                 │ petriRouter  │◄──────────────────►│ shardMapper  │
                                 │    (P4)      │                    │    (P4)      │
                                 └──────┬───────┘                    └──────────────┘
                                        │
                                        │ selectMembers(txHash, shard, 2)
                                        │ via Alea PRNG
                                        ▼
                              ┌───────────────────┐
                              │  2 shard members  │
                              │  (peer.longCall)  │
                              │                   │
                              │  method: nodeCall │
                              │  msg: RELAY_TX    │
                              └───────────────────┘


    ╔═══════════════════════════════════════════════════════════════════════════════════════════════╗
    ║  PHASE 5 — FINALITY & STATUS API (Soft/Hard Finality + RPC Endpoint)                        ║
    ╚═══════════════════════════════════════════════════════════════════════════════════════════════╝


    DUAL FINALITY MODEL
    ────────────────────

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  FINALITY TIMELINE                                                                     [P5]  │
    │                                                                                              │
    │    tx submitted ──► classified ──► forge rounds ──► PRE_APPROVED ──► block finalized         │
    │         t=0           t≈0            ~2s rounds       SOFT FINALITY     HARD FINALITY        │
    │                                                       (~2s)             (~12s)               │
    │                                                                                              │
    │    Soft finality:  tx reaches PRE_APPROVED via forge delta agreement                        │
    │                    recorded as soft_finality_at timestamp on MempoolTx + Transactions        │
    │                                                                                              │
    │    Hard finality:  tx confirmed in a finalized block on chain                               │
    │                    determined by chain lookup (block inclusion)                              │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘


    ENTITY MODIFICATIONS
    ─────────────────────

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  MEMPOOL ENTITY (MODIFIED)                                                        [P1→P5]   │
    │  src/model/entities/Mempool.ts                                                               │
    │                                                                                              │
    │    + soft_finality_at: datetime (nullable)    ── when tx first reached PRE_APPROVED  [P5]   │
    │      Set when forge promotes tx to PRE_APPROVED (updateClassification)                      │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  TRANSACTIONS ENTITY (MODIFIED)                                                        [P5]  │
    │  src/model/entities/Transactions.ts                                                          │
    │                                                                                              │
    │    + soft_finality_at: datetime (nullable)    ── preserved from mempool on block insert [P5]│
    │      Carries soft finality timestamp into permanent chain record                            │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘


    FINALITY SERVICE
    ─────────────────

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  TRANSACTION FINALITY                                                                  [P5]  │
    │  src/libs/consensus/petri/finality/transactionFinality.ts                                   │
    │                                                                                              │
    │    getTransactionFinality(txHash) → TransactionFinalityResult                              │
    │                                                                                              │
    │      1. Check chain (Transactions entity) first                                             │
    │         └── found → status: "confirmed"                                                     │
    │                     hardFinality: block timestamp                                           │
    │                     softFinality: soft_finality_at (if recorded)                            │
    │                     blockHash, blockNumber                                                  │
    │                                                                                              │
    │      2. Check mempool (MempoolTx entity) if not on chain                                   │
    │         └── found → status: "pending"                                                       │
    │                     classification: PRE_APPROVED | TO_APPROVE | PROBLEMATIC                 │
    │                     softFinality: soft_finality_at (if PRE_APPROVED)                        │
    │                                                                                              │
    │      3. Not found anywhere                                                                  │
    │         └── status: "unknown"                                                               │
    │                                                                                              │
    │    Returns: TransactionFinalityResult                                                      │
    │      { status, softFinality?, hardFinality?,                                               │
    │        classification?, blockHash?, blockNumber? }                                         │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘


    RPC ENDPOINT
    ─────────────

    ┌───────────────────────────────────────────────────────────────────────────────────────────────┐
    │  RPC DISPATCH (MODIFIED)                                                            [P4→P5] │
    │  src/libs/network/rpcDispatch.ts                                                            │
    │                                                                                              │
    │    case "getTransactionFinality":                                                   [P5]    │
    │      1. Extract txHash from params                                                          │
    │      2. getTransactionFinality(txHash)                                                     │
    │      3. Return TransactionFinalityResult                                                   │
    │                                                                                              │
    └───────────────────────────────────────────────────────────────────────────────────────────────┘


    COMPLETE DATA FLOW — FINALITY QUERY (summary, P5)
    ──────────────────────────────────────────────────

    ┌──────────┐  getTransactionFinality  ┌──────────────┐  chain lookup  ┌──────────────────┐
    │  Client  │─────────────────────────►│ rpcDispatch  │──────────────►│ Transactions     │
    │  (RPC)   │                          │    (P4→P5)   │               │ entity (chain)   │
    └──────────┘                          └──────┬───────┘               └────────┬─────────┘
                                                 │                                │
                                                 │ if not on chain                │ found?
                                                 ▼                                │
                                          ┌─────────────┐                         │
                                          │ transaction  │                         │
                                          │ Finality.ts  │◄────────────────────────┘
                                          │    (P5)      │
                                          └──────┬───────┘
                                                 │ mempool fallback
                                                 ▼
                                          ┌─────────────┐
                                          │  MempoolTx  │
                                          │  entity     │
                                          │  (P1→P5)    │
                                          └─────────────┘

                                          Returns: TransactionFinalityResult
                                            status: "confirmed" | "pending" | "unknown"
                                            softFinality?: Date    (PRE_APPROVED timestamp)
                                            hardFinality?: Date    (block confirmation)
```

### Legend

```
    ┌──────────┐
    │  [P0]    │    Box with phase annotation — implemented in Phase 0
    └──────────┘

    ┌──────────┐
    │  [P1]    │    Box with phase annotation — implemented in Phase 1
    └──────────┘

    ┌──────────┐
    │  [P2]    │    Box with phase annotation — implemented in Phase 2
    └──────────┘

    ┌──────────┐
    │  [P3]    │    Box with phase annotation — implemented in Phase 3
    └──────────┘

    ┌──────────┐
    │  [P4]    │    Box with phase annotation — implemented in Phase 4
    └──────────┘

    ┌──────────┐
    │  [P5]    │    Box with phase annotation — implemented in Phase 5
    └──────────┘

    ┌──────────┐
    │  [v2]    │    Reused from PoRBFT v2 consensus (existing infrastructure)
    └──────────┘

    ┌──────────────┐
    │  [P0→P5]     │    Modified across multiple phases
    └──────────────┘

    ╔══════════╗
    ║  HEADER  ║    Double-line box — phase section header
    ╚══════════╝

        │
        ▼           Arrow — data flow / import direction (points toward dependency)

        ────►       Horizontal arrow — type reference (labelled with type name)

    ── NEW (P1)     Inline note — method added in Phase 1

    ── NEW P2       Inline note — added/changed in Phase 2

    ── NEW P3       Inline note — added in Phase 3

    ── NEW P4       Inline note — added in Phase 4

    ── NEW P5       Inline note — added in Phase 5

    ── UPD P3       Inline note — updated in Phase 3

    ── UPD P4       Inline note — updated in Phase 4

    ── UPD P5       Inline note — updated in Phase 5

    (external dep)  Dependency outside this repository (SDK package)

    ┌── if (flag) ──── FEATURE FLAG GATE ──┐
    │                                       │    Gated block — only runs when flag is true
    └───────────────────────────────────────┘
```

---

## Module Inventory

| File | Phase | Status | Key Exports |
|---|---|---|---|
| `src/utilities/sharedState.ts` | P0 | Modified | `petriConsensus: boolean`, `petriConfig: PetriConfig` (feature flag + config instance) |
| `src/libs/consensus/petri/index.ts` | P0→P5 | Active | `petriConsensusRoutine(shard)` full block lifecycle: start forge → sleep → pause → arbitrate → compile → finalize → cleanup → reset → resume. Re-exports all types, forge, block, arbitration, routing, and finality modules. |
| `src/libs/consensus/petri/types/classificationTypes.ts` | P0 | Complete | `TransactionClassification` (enum: PRE_APPROVED, TO_APPROVE, PROBLEMATIC), `ClassifiedTransaction` (interface) |
| `src/libs/consensus/petri/types/stateDelta.ts` | P0 | Complete | `StateDelta` (interface, uses `GCREdit` from SDK), `PeerDelta` (interface) |
| `src/libs/consensus/petri/types/continuousForgeTypes.ts` | P0 | Complete | `ContinuousForgeRound` (interface), `ForgeConfig` (interface), `ForgeState` (interface) |
| `src/libs/consensus/petri/types/petriConfig.ts` | P0 | Complete | `PetriConfig` (interface, extends `ForgeConfig`), `DEFAULT_PETRI_CONFIG` (const) |
| `src/libs/consensus/petri/types/deltaComparison.ts` | P0 | Complete | `DeltaComparison` (interface), `RoundDeltaResult` (interface) |
| `src/libs/consensus/petri/classifier/transactionClassifier.ts` | P1 | Complete | `classifyTransaction(tx, precomputedEdits?)` returns `ClassificationResult` (classification + gcrEdits). Filters fee/nonce-only edits to distinguish PRE_APPROVED vs TO_APPROVE. |
| `src/libs/consensus/petri/execution/speculativeExecutor.ts` | P1 | Complete | `executeSpeculatively(tx, gcrEdits)` returns `SpeculativeResult` (success + delta). Runs GCR edits in simulate mode via Balance/Nonce/Identity routines, then hashes with `canonicalJson` + `Hashing.sha256`. |
| `src/libs/consensus/petri/utils/canonicalJson.ts` | P1 | Complete | `canonicalJson(value)` deterministic JSON serialization with sorted keys, BigInt/Map/Set handling. |
| `src/model/entities/Mempool.ts` | P1→P5 | Modified | Added `classification: text` and `delta_hash: text` nullable columns + `idx_mempooltx_classification` index (P1). Added `soft_finality_at: datetime` nullable column — records when tx first reaches PRE_APPROVED (P5). |
| `src/libs/blockchain/mempool_v2.ts` | P1 | Modified | Added `getByClassification()`, `getPreApproved()`, `updateClassification()` methods for Petri classification queries. |
| `src/libs/network/endpointValidation.ts` | P1 | Modified | Wired classifier + speculative executor after validation, gated by `petriConsensus` flag. Fire-and-forget `updateClassification` call. |
| `src/libs/consensus/petri/forge/continuousForge.ts` | P2 | Complete | `ContinuousForge` class: `start(shard)`, `stop()`, `pause()`, `resume()`, `reset()`, `getCurrentDeltas()`, `getState()`. Private: `runForgeRound()` (7-step cycle), `exchangeDeltas()` (all-to-all RPC), `scheduleNextRound()` (2s timer loop). |
| `src/libs/consensus/petri/forge/deltaAgreementTracker.ts` | P2 | Complete | `DeltaAgreementTracker` class: `recordDelta(txHash, deltaHash, memberKey, round)`, `evaluate(shardSize, round)` returns `{promoted[], flagged[]}`, `getComparison()` for diagnostics, `reset()`, `trackedCount`. |
| `src/libs/consensus/petri/forge/forgeInstance.ts` | P2 | Complete | `petriForgeInstance` (global singleton, `ContinuousForge | null`), `setPetriForgeInstance()`. Bridges forge loop and RPC handler. |
| `src/libs/network/manageConsensusRoutines.ts` | P2→P3 | Modified | Added `petri_exchangeDeltas` RPC case (P2). Consensus dispatch switching: routes to Petri or PoRBFTv2 handlers based on `petriConsensus` flag (P3). |
| `src/libs/consensus/petri/arbitration/bftArbitrator.ts` | P3 | Complete | `arbitrate(shard)` gets PROBLEMATIC txs from mempool, runs BFT round among shard validators, returns `{ resolved: ClassifiedTransaction[], rejectedHashes: string[] }`. |
| `src/libs/consensus/petri/block/petriBlockCompiler.ts` | P3 | Complete | `compileBlock(shard, resolvedTxs)` merges PRE_APPROVED + resolved txs, calls `orderTransactions()` and `createBlock()` (reused PoRBFTv2), returns `CompilationResult { block, txCount }`. `cleanRejectedFromMempool(rejectedHashes)` removes rejected txs. |
| `src/libs/consensus/petri/block/petriBlockFinalizer.ts` | P3 | Complete | `finalizeBlock(block, shard)` calls `broadcastBlockHash()`, `isBlockValid()` (BFT validity), `insertBlock()`, `BroadcastManager.broadcastNewBlock()`. Returns `FinalizationResult { success, blockHash }`. |
| `src/utilities/mainLoop.ts` | P3 | Modified | Consensus dispatch switching: if `petriConsensus` flag is set, calls `petriConsensusRoutine(shard)` instead of PoRBFTv2 routine. |
| `src/libs/consensus/petri/routing/shardMapper.ts` | P4 | Complete | `getShardForAddress(address?)` returns shard identifier. Single-shard testnet: always returns `'default'`. |
| `src/libs/consensus/petri/routing/petriRouter.ts` | P4 | Complete | `selectMembers(txHash, shard, membersPerTx=2)` deterministic member selection via Alea PRNG. `getCurrentShard()` delegates to shardMapper. `relay(validityData)` routes validated tx to 2 selected shard members via `peer.longCall({ method: "nodeCall", params: [{ message: "RELAY_TX", data: [validityData] }] })`. |
| `src/libs/network/endpointExecution.ts` | P4 | Modified | When `petriConsensus` flag is on, calls `petriRelay(validityData)` instead of existing DTR flow. Early return before validator check. Returns `{ success, routing: "petri" }`. |
| `src/model/entities/Transactions.ts` | P5 | Modified | Added `soft_finality_at: datetime` nullable column — preserves soft finality timestamp from mempool when tx is included in a block. |
| `src/libs/consensus/petri/finality/transactionFinality.ts` | P5 | Complete | `getTransactionFinality(txHash)` checks chain first (confirmed with hard finality), then mempool (pending with soft finality if PRE_APPROVED), returns `TransactionFinalityResult { status, softFinality?, hardFinality?, classification?, blockHash?, blockNumber? }`. |
| `src/libs/network/rpcDispatch.ts` | P4→P5 | Modified | Added `getTransactionFinality` RPC endpoint (P5). Extracts txHash from params, calls `getTransactionFinality(txHash)`, returns `TransactionFinalityResult`. |

### Notes

- All type files are **complete for Phase 0** — they define the full type surface that later phases consume.
- The sole external dependency is `GCREdit` from `@kynesyslabs/demosdk/types`, imported by `stateDelta.ts`.
- `PetriConfig` extends `ForgeConfig`, adding `enabled`, `blockIntervalMs`, and `shardSize` on top of the forge-specific fields (`forgeIntervalMs`, `agreementThreshold`, `problematicTTLRounds`).
- `DEFAULT_PETRI_CONFIG` ships with `enabled: false` — the feature is off by default.
- **Phase 1 data flow:** `endpointValidation` calls `classifyTransaction` with pre-computed GCR edits. If the result is `TO_APPROVE`, it calls `executeSpeculatively` which runs GCR routines in simulate mode (no DB mutation), serializes edits via `canonicalJson`, and hashes them with `Hashing.sha256` to produce a deterministic `deltaHash`. The classification and delta hash are then persisted to the mempool entity via `Mempool.updateClassification`.
- **Feature flag gate:** The entire Petri pipeline (Phase 1 classification in `endpointValidation.ts` and Phase 2 forge loop) is gated behind `getSharedState.petriConsensus`. When the flag is `false` (default), no classification, speculative execution, or forge activity occurs.
- **Mempool columns:** `classification` and `delta_hash` are nullable to maintain backward compatibility — existing transactions without classification continue to work normally.
- **Phase 2 forge loop:** `petriConsensusRoutine(shard)` creates a `ContinuousForge`, registers it as a global singleton via `setPetriForgeInstance`, and starts the 2-second interval loop. Each `runForgeRound` syncs mempools, speculatively executes TO_APPROVE transactions, exchanges delta hashes with shard peers via `petri_exchangeDeltas` RPC, feeds results into `DeltaAgreementTracker`, and promotes or flags transactions based on agreement threshold / TTL expiry.
- **RPC bridge:** The `petri_exchangeDeltas` handler in `manageConsensusRoutines.ts` reads the global `petriForgeInstance` singleton to call `getCurrentDeltas()`, returning local delta hashes to the requesting peer. This decouples the RPC layer from the forge loop lifecycle.
- **Phase 3 block lifecycle:** `petriConsensusRoutine` now implements the full block lifecycle: (1) start forge, (2) sleep for `blockIntervalMs` (default 10s) while txs accumulate, (3) pause forge, (4) arbitrate PROBLEMATIC txs via BFT, (5) compile block from PRE_APPROVED + resolved txs, (6) finalize block (broadcast hash → validate → insert → broadcast block), (7) clean rejected txs from mempool, (8) reset and resume forge for the next block cycle.
- **Reused PoRBFT v2 infrastructure:** Phase 3 reuses `createBlock()`, `orderTransactions()`, `broadcastBlockHash()`, `getCommonValidatorSeed()`, and `getShard()` from `src/libs/consensus/v2/routines/`, plus `insertBlock()` from `src/libs/blockchain/chainBlocks.ts` and `BroadcastManager.broadcastNewBlock()` from `src/libs/communications/broadcastManager.ts`. This avoids duplicating battle-tested block assembly and broadcast logic.
- **Consensus dispatch switching:** Both `mainLoop.ts` and `manageConsensusRoutines.ts` now check the `petriConsensus` flag to route consensus operations to either the Petri pipeline or the existing PoRBFTv2 routine.
- **Phase 4 RPC routing refactor:** `endpointExecution.ts` now checks the `petriConsensus` flag early. When enabled, it calls `petriRelay(validityData)` and returns immediately, bypassing the validator check and existing DTR flow entirely. When disabled, the existing DTR flow is unchanged.
- **Shard mapping:** `shardMapper.ts` provides `getShardForAddress()` which currently returns `'default'` for single-shard testnet. This is the extension point for future multi-shard support.
- **Deterministic member selection:** `petriRouter.selectMembers()` uses Alea PRNG seeded with the transaction hash to deterministically select `membersPerTx` (default 2) shard members for relay. This ensures any node given the same txHash and shard membership list will select the same members.
- **Relay transport:** Selected members receive the validated transaction via `peer.longCall()` with `method: "nodeCall"` and `message: "RELAY_TX"`, reusing the existing node call infrastructure.
- **Dual finality model (P5):** Petri consensus introduces two finality tiers. **Soft finality** (~2s) occurs when a transaction reaches `PRE_APPROVED` status via forge delta agreement — the `soft_finality_at` timestamp is recorded on both `MempoolTx` and `Transactions` entities. **Hard finality** (~12s) occurs when the transaction is confirmed in a finalized block on chain, determined by block inclusion lookup.
- **`soft_finality_at` column (P5):** Added to both `MempoolTx` (mempool entity) and `Transactions` (chain entity) as a nullable datetime. On `MempoolTx`, it is set when the forge promotes a tx to `PRE_APPROVED` via `updateClassification`. On `Transactions`, the value is preserved from the mempool record when the tx is inserted into a block.
- **Transaction finality service (P5):** `getTransactionFinality(txHash)` in `finality/transactionFinality.ts` implements a chain-first lookup strategy: (1) check the `Transactions` entity — if found, the tx is `"confirmed"` with hard finality from the block timestamp and optional soft finality from `soft_finality_at`; (2) check `MempoolTx` — if found, the tx is `"pending"` with classification and optional soft finality; (3) if neither, return `"unknown"`.
- **Finality RPC endpoint (P5):** The `getTransactionFinality` method is exposed as an RPC endpoint in `rpcDispatch.ts`, allowing clients to query the finality status of any transaction by hash.
