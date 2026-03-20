# Petri Consensus — Living Architecture Diagram

**Last updated:** 2026-03-20 (Phase 0 — Types and Stubs)

---

## Architecture Diagram

```
                                    PETRI CONSENSUS — PHASE 0 (TYPES & STUBS)
                                    =========================================

    ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
    │  FEATURE FLAG ENTRY POINT                                                                      │
    │  src/utilities/sharedState.ts                                                             [P0]  │
    │                                                                                                 │
    │    petriConsensus: boolean = false        ──── master on/off switch                             │
    │    petriConfig: PetriConfig = {...}       ──── imports DEFAULT_PETRI_CONFIG                     │
    │                                                                                                 │
    └──────────────────────────────┬──────────────────────────────────────────────────────────────────┘
                                   │
                                   │ imports PetriConfig, DEFAULT_PETRI_CONFIG
                                   │
    ┌──────────────────────────────▼──────────────────────────────────────────────────────────────────┐
    │  BARREL / ENTRY POINT                                                                          │
    │  src/libs/consensus/petri/index.ts                                                       [P0]  │
    │                                                                                                 │
    │    Re-exports all types from ./types/*                                                          │
    │    petriConsensusRoutine(): Promise<void>  ──── STUB (empty, awaits Phase 2)                    │
    │                                                                                                 │
    └──┬──────────────┬──────────────┬──────────────┬─────────────────────────────────────────────────┘
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
    ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
    │  TYPE DEPENDENCY GRAPH                                                                         │
    │                                                                                                 │
    │                                                                                                 │
    │  ┌────────────────────┐         ┌────────────────────┐                                          │
    │  │ petriConfig.ts     │         │classificationTypes │                                          │
    │  │                    │         │        .ts         │                                          │
    │  │  PetriConfig       │         │                    │                                          │
    │  │    extends         │         │ TransactionClassi- │                                          │
    │  │    ForgeConfig ────┼────┐    │   fication (enum)  │                                          │
    │  │                    │    │    │ ClassifiedTrans-   │                                          │
    │  │  DEFAULT_PETRI_    │    │    │   action (iface)   │                                          │
    │  │    CONFIG (const)  │    │    └────────┬───────────┘                                          │
    │  └────────────────────┘    │             │                                                      │
    │                            │             │ ClassifiedTransaction                                │
    │                            │             │                                                      │
    │                            │    ┌────────▼───────────┐      ┌────────────────────┐              │
    │                            │    │continuousForge     │      │ deltaComparison.ts │              │
    │                            │    │       Types.ts     │      │                    │              │
    │                            │    │                    │      │ DeltaComparison    │              │
    │                            ├───►│ ForgeConfig(iface) │      │   (iface)          │              │
    │                            │    │ ForgeState (iface) │      │ RoundDeltaResult   │              │
    │                            │    │ ContinuousForge-   │      │   (iface)          │              │
    │                            │    │   Round (iface)    │      └────────────────────┘              │
    │                            │    └────────┬───────────┘                                          │
    │                            │             │                                                      │
    │                            │             │ StateDelta, PeerDelta                                │
    │                            │             │                                                      │
    │                            │    ┌────────▼───────────┐                                          │
    │                            │    │ stateDelta.ts      │                                          │
    │                            │    │                    │      ┌──────────────────────────┐         │
    │                            │    │ StateDelta (iface) │─────►│ @kynesyslabs/demosdk/   │         │
    │                            │    │ PeerDelta  (iface) │      │   types :: GCREdit      │         │
    │                            │    └────────────────────┘      └──────────────────────────┘         │
    │                                                                   (external dep)                │
    │                                                                                                 │
    └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Legend

```
    ┌──────────┐
    │  [P0]    │    Box with phase annotation — implemented module
    └──────────┘

        │
        ▼           Arrow — data flow / import direction (points toward dependency)

        ────►       Horizontal arrow — type reference (labelled with type name)

    ─── STUB        Inline note — function is declared but body is empty

    (external dep)  Dependency outside this repository (SDK package)
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

### Notes

- All type files are **complete for Phase 0** — they define the full type surface that later phases will consume.
- `petriConsensusRoutine()` is the only runtime function; it is an **empty stub** pending Phase 2 (Continuous Forge).
- The sole external dependency is `GCREdit` from `@kynesyslabs/demosdk/types`, imported by `stateDelta.ts`.
- `PetriConfig` extends `ForgeConfig`, adding `enabled`, `blockIntervalMs`, and `shardSize` on top of the forge-specific fields (`forgeIntervalMs`, `agreementThreshold`, `problematicTTLRounds`).
- `DEFAULT_PETRI_CONFIG` ships with `enabled: false` — the feature is off by default.
