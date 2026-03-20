# Petri Consensus — Living Architecture Diagram

**Last updated:** 2026-03-20 (Phase 1 — Classification & Speculative Execution)

---

## Architecture Diagram

```
                                PETRI CONSENSUS — PHASE 0 + PHASE 1
                                ====================================

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
    │  src/libs/consensus/petri/index.ts                                                     [P0]  │
    │                                                                                              │
    │    Re-exports all types from ./types/*                                                       │
    │    petriConsensusRoutine(): Promise<void>  ── STUB (empty, awaits Phase 2)                   │
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
    │  MEMPOOL (MODIFIED)                                                                    [P1]  │
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
```

### Legend

```
    ┌──────────┐
    │  [P0]    │    Box with phase annotation — implemented in Phase 0
    └──────────┘

    ┌──────────┐
    │  [P1]    │    Box with phase annotation — implemented in Phase 1
    └──────────┘

    ╔══════════╗
    ║  HEADER  ║    Double-line box — phase section header
    ╚══════════╝

        │
        ▼           Arrow — data flow / import direction (points toward dependency)

        ────►       Horizontal arrow — type reference (labelled with type name)

    ── STUB         Inline note — function is declared but body is empty

    ── NEW (P1)     Inline note — method added in Phase 1

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
| `src/libs/consensus/petri/index.ts` | P0 | Stub | `petriConsensusRoutine()` (empty async fn), re-exports all types |
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

### Notes

- All type files are **complete for Phase 0** — they define the full type surface that later phases will consume.
- `petriConsensusRoutine()` is the only runtime function from P0; it is an **empty stub** pending Phase 2 (Continuous Forge).
- The sole external dependency is `GCREdit` from `@kynesyslabs/demosdk/types`, imported by `stateDelta.ts`.
- `PetriConfig` extends `ForgeConfig`, adding `enabled`, `blockIntervalMs`, and `shardSize` on top of the forge-specific fields (`forgeIntervalMs`, `agreementThreshold`, `problematicTTLRounds`).
- `DEFAULT_PETRI_CONFIG` ships with `enabled: false` — the feature is off by default.
- **Phase 1 data flow:** `endpointValidation` calls `classifyTransaction` with pre-computed GCR edits. If the result is `TO_APPROVE`, it calls `executeSpeculatively` which runs GCR routines in simulate mode (no DB mutation), serializes edits via `canonicalJson`, and hashes them with `Hashing.sha256` to produce a deterministic `deltaHash`. The classification and delta hash are then persisted to the mempool entity via `Mempool.updateClassification`.
- **Feature flag gate:** The entire Phase 1 pipeline in `endpointValidation.ts` is gated behind `getSharedState.petriConsensus`. When the flag is `false` (default), no classification or speculative execution occurs.
- **Mempool columns:** `classification` and `delta_hash` are nullable to maintain backward compatibility — existing transactions without classification continue to work normally.
