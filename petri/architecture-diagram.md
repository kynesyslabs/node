# Petri Consensus — Living Architecture Diagram

**Last updated:** 2026-03-20 (Phase 2 — Continuous Forge & Delta Agreement)

---

## Architecture Diagram

```
                                PETRI CONSENSUS — PHASE 0 + PHASE 1 + PHASE 2
                                ================================================

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
    │  src/libs/consensus/petri/index.ts                                                 [P0→P2]  │
    │                                                                                              │
    │    Re-exports all types from ./types/*                                                       │
    │    Re-exports ContinuousForge, DeltaAgreementTracker from ./forge/*              ── NEW P2  │
    │    petriConsensusRoutine(shard): Promise<void>  ── creates & starts forge         ── NEW P2  │
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
    │  MEMPOOL ENTITY (MODIFIED)                                                             [P1]  │
    │  src/model/entities/Mempool.ts                                                               │
    │                                                                                              │
    │    MempoolTx entity — existing columns + 2 new:                                             │
    │                                                                                              │
    │    + classification: text (nullable)    ── PRE_APPROVED | TO_APPROVE | PROBLEMATIC          │
    │    + delta_hash: text (nullable)        ── sha256 of canonical GCR edits                    │
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


    COMPLETE DATA FLOW — FORGE ROUND (summary)
    ───────────────────────────────────────────

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

    ┌──────────────┐
    │  [P0→P2]     │    Modified across multiple phases
    └──────────────┘

    ╔══════════╗
    ║  HEADER  ║    Double-line box — phase section header
    ╚══════════╝

        │
        ▼           Arrow — data flow / import direction (points toward dependency)

        ────►       Horizontal arrow — type reference (labelled with type name)

    ── NEW (P1)     Inline note — method added in Phase 1

    ── NEW P2       Inline note — added/changed in Phase 2

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
| `src/libs/consensus/petri/index.ts` | P0→P2 | Active | `petriConsensusRoutine(shard)` creates ContinuousForge, registers singleton, starts loop. Re-exports all types + forge classes. |
| `src/libs/consensus/petri/types/classificationTypes.ts` | P0 | Complete | `TransactionClassification` (enum: PRE_APPROVED, TO_APPROVE, PROBLEMATIC), `ClassifiedTransaction` (interface) |
| `src/libs/consensus/petri/types/stateDelta.ts` | P0 | Complete | `StateDelta` (interface, uses `GCREdit` from SDK), `PeerDelta` (interface) |
| `src/libs/consensus/petri/types/continuousForgeTypes.ts` | P0 | Complete | `ContinuousForgeRound` (interface), `ForgeConfig` (interface), `ForgeState` (interface) |
| `src/libs/consensus/petri/types/petriConfig.ts` | P0 | Complete | `PetriConfig` (interface, extends `ForgeConfig`), `DEFAULT_PETRI_CONFIG` (const) |
| `src/libs/consensus/petri/types/deltaComparison.ts` | P0 | Complete | `DeltaComparison` (interface), `RoundDeltaResult` (interface) |
| `src/libs/consensus/petri/classifier/transactionClassifier.ts` | P1 | Complete | `classifyTransaction(tx, precomputedEdits?)` returns `ClassificationResult` (classification + gcrEdits). Filters fee/nonce-only edits to distinguish PRE_APPROVED vs TO_APPROVE. |
| `src/libs/consensus/petri/execution/speculativeExecutor.ts` | P1 | Complete | `executeSpeculatively(tx, gcrEdits)` returns `SpeculativeResult` (success + delta). Runs GCR edits in simulate mode via Balance/Nonce/Identity routines, then hashes with `canonicalJson` + `Hashing.sha256`. |
| `src/libs/consensus/petri/utils/canonicalJson.ts` | P1 | Complete | `canonicalJson(value)` deterministic JSON serialization with sorted keys, BigInt/Map/Set handling. |
| `src/model/entities/Mempool.ts` | P1 | Modified | Added `classification: text` and `delta_hash: text` nullable columns + `idx_mempooltx_classification` index. |
| `src/libs/blockchain/mempool_v2.ts` | P1 | Modified | Added `getByClassification()`, `getPreApproved()`, `updateClassification()` methods for Petri classification queries. |
| `src/libs/network/endpointValidation.ts` | P1 | Modified | Wired classifier + speculative executor after validation, gated by `petriConsensus` flag. Fire-and-forget `updateClassification` call. |
| `src/libs/consensus/petri/forge/continuousForge.ts` | P2 | Complete | `ContinuousForge` class: `start(shard)`, `stop()`, `pause()`, `resume()`, `reset()`, `getCurrentDeltas()`, `getState()`. Private: `runForgeRound()` (7-step cycle), `exchangeDeltas()` (all-to-all RPC), `scheduleNextRound()` (2s timer loop). |
| `src/libs/consensus/petri/forge/deltaAgreementTracker.ts` | P2 | Complete | `DeltaAgreementTracker` class: `recordDelta(txHash, deltaHash, memberKey, round)`, `evaluate(shardSize, round)` returns `{promoted[], flagged[]}`, `getComparison()` for diagnostics, `reset()`, `trackedCount`. |
| `src/libs/consensus/petri/forge/forgeInstance.ts` | P2 | Complete | `petriForgeInstance` (global singleton, `ContinuousForge | null`), `setPetriForgeInstance()`. Bridges forge loop and RPC handler. |
| `src/libs/network/manageConsensusRoutines.ts` | P2 | Modified | Added `petri_exchangeDeltas` RPC case: receives peer deltas, returns local deltas via `petriForgeInstance.getCurrentDeltas()`. Gated by `petriConsensus` flag. |

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
- **Phase 3 placeholder:** `petriConsensusRoutine` includes a `// REVIEW:` comment noting that Phase 3 will add block finalization logic.
