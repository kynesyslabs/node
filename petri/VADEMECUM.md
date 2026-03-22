# Petri Consensus — Vademecum

> This file is the operational bible for building Petri Consensus.
> Read this BEFORE starting any Petri work. Keep it in mind at all times.
> It covers: how to work, how to test, how to report, how to stay safe.

---

## 1. How You Work: Team Mode

You are operating in **Team Mode** (see `TEAM.md`). You are the Tech Lead.

- **Delegate** boilerplate and well-scoped features to Senior/Junior agents
- **Do yourself** architecture decisions, integration, anything cross-cutting
- **Verify** every agent output before integrating
- **Never** delegate integration — assembly is always your job

### Dispatch by blast radius

| If wrong, what breaks? | Who does it? |
|------------------------|-------------|
| Nothing important | Junior |
| The feature, but contained | Senior |
| Other features / architecture / data | You (Lead) |

---

## 2. How You Test: better_testing Style

Every phase produces tests **before** moving to the next phase. Tests go in:

```
better_testing/petri/
```

### Test naming convention

Follow existing `better_testing/` patterns:
- `classifier.test.ts` — unit tests for TransactionClassifier
- `speculativeExecutor.test.ts` — delta determinism tests
- `canonicalJson.test.ts` — serialization edge cases
- `deltaTracker.test.ts` — agreement/flagging logic
- `continuousForge.test.ts` — forge lifecycle
- `blockCompiler.test.ts` — block compilation
- `routing.test.ts` — PetriRouter + ShardMapper
- `finality.test.ts` — finality API
- `integration/` — multi-component tests (Phase 6)

### Test requirements per phase

| Phase | Required Tests |
|-------|---------------|
| P0 | Types compile (`bun run lint:fix`) — no runtime tests needed |
| P1 | Classifier covers all tx types; SpeculativeExecutor determinism; Mempool classification queries |
| P2 | Canonical JSON edge cases; DeltaAgreementTracker promotion/flagging; ContinuousForge round lifecycle |
| P3 | Block compilation from PRE_APPROVED; BFT arbitration resolve/reject; Consensus dispatch switching |
| P4 | Router determinism (same tx → same 2 members); Routing flag gating |
| P5 | Finality timestamps; RPC method response format |
| P6 | Full integration suite (happy, conflict, Byzantine, liveness, rollback, benchmark) |
| P7 | Secretary deprecation verified; feature flag removal clean |
| P8 | Soft finality SDK endpoint; subscription delivery; backward compat (SDK work — ask user first) |

### How to run tests

```bash
# Lint check (primary validation method per CLAUDE.md)
bun run lint:fix

# Run specific test file
bun test better_testing/petri/classifier.test.ts

# NEVER start the node directly during development
```

---

## 3. How You Report: Mycelium Updates

All Petri work is tracked in **Epic #9** in Mycelium.

### Before starting a task
```bash
myc task list --epic 9           # See what's ready
myc task list --blocked          # See what's blocked
```

### While working
- Mark task in-progress: update your TodoWrite list
- Report status to user at each phase boundary

### After completing a task
```bash
myc task close <task-id>
```

### Status format for user updates
```
[PHASE X] Starting: <phase name>
[TASK #NN] <status> — <brief description>
[DONE] Phase X complete. Tests passing. Moving to Phase Y.
```

---

## 4. How You Stay Safe: Guardrails

### Feature flag
- All Petri code paths gated by `getSharedState.petriConsensus`
- Default: `true` — Petri is the default consensus as of Phase 7
- Set `PETRI_CONSENSUS=false` to fall back to PoRBFT v2

### Delta determinism is critical
- Same transaction MUST produce identical `deltaHash` on every node
- Use `canonicalJSON()` from `petri/utils/canonicalJson.ts` for all hashing
- Use `BigInt` for all numeric operations (never float)
- Test determinism as a first-class property

### The chain never stalls
- PROBLEMATIC transactions are rejected after 5 forge rounds
- Rejection is the fail-safe — never retry indefinitely
- Empty blocks are valid — block production continues on schedule
- BFT latency only affects conflicting transactions, not throughput

### Speculative execution is side-effect-free
- SpeculativeExecutor MUST NOT mutate GCR state
- Use `simulate=true` flag on GCR routines
- Always verify: run same tx twice → same delta

---

## 5. Design Decisions (Locked)

These were discussed and finalized. Don't revisit unless explicitly asked.

| Decision | Value | Why |
|----------|-------|-----|
| Forge interval | 2 seconds | Conservative start, optimize later |
| Delta topology | All-to-all | 10 nodes = manageable; test gossip too |
| PROBLEMATIC TTL | 5 rounds (10s) | Generous; aligns with block boundary |
| Speculative depth | Confirmed state only | No chained speculation; simplicity |
| Read-only detection | GCR edits check | `GCRGeneration.generate(tx)` returns empty = read-only |
| Read-only tx types | dahr, tlsn, identity attestation | Non-state-changing by nature |

---

## 6. File Paths Quick Reference

### Petri Code (NEW — we build these)
```
src/libs/consensus/petri/
  index.ts                          # petriConsensusRoutine()
  types/*.ts                        # All Petri types
  utils/canonicalJson.ts            # Deterministic serialization
  classifier/transactionClassifier.ts
  execution/speculativeExecutor.ts
  forge/continuousForge.ts
  forge/deltaAgreementTracker.ts
  block/petriBlockCompiler.ts
  block/petriBlockFinalizer.ts
  arbitration/bftArbitrator.ts
  routing/petriRouter.ts
  routing/shardMapper.ts
  coordination/petriSecretary.ts      # Secretary election + accept-and-sign
```

### Existing Code We Touch
```
src/utilities/sharedState.ts              # Add petri flag + config
src/model/entities/Mempool.ts             # Add classification columns
src/libs/blockchain/mempool_v2.ts         # Add classification queries
src/libs/network/endpointValidation.ts    # Wire classifier
src/libs/network/endpointExecution.ts     # Wire Petri routing
src/libs/network/rpcDispatch.ts           # Consensus dispatch switch
src/libs/network/manageConsensusRoutines.ts  # Delta exchange RPC
src/libs/consensus/v2/routines/mergeMempools.ts  # Adapt for repeated calls
```

### Existing Code Modified for Petri
```
src/libs/consensus/v2/routines/orderTransactions.ts    # Hash tiebreaker for deterministic ordering
src/libs/consensus/v2/routines/broadcastBlockHash.ts   # Promise.allSettled + sequential sig verification
src/libs/consensus/v2/routines/manageProposeBlockHash.ts # Accept-and-sign model for Petri
src/libs/communications/broadcastManager.ts            # Removed signer filter so members receive finalized block
src/libs/blockchain/chainBlocks.ts                     # Savepoint-based error isolation for TX inserts
src/libs/network/manageConsensusRoutines.ts            # Petri consensus gate
```

### Existing Code Reused (Not Modified)
```
src/libs/consensus/v2/routines/getShard.ts
src/libs/consensus/v2/routines/getCommonValidatorSeed.ts
src/libs/consensus/v2/routines/createBlock.ts
src/libs/consensus/v2/PoRBFT.ts           # isBlockValid() reused
src/libs/peer/Peer.ts                      # RPC calls
src/libs/peer/PeerManager.ts               # Peer management
src/libs/crypto/hashing.ts                 # SHA-256
```

---

## 7. Autonomy & Transparency

### Be autonomous
- Move through phases without asking permission for obvious steps
- Close myc tasks as you complete them
- Write tests as you build, not after

### Be transparent
- Report phase transitions to the user
- Report when you hit a genuine decision fork
- Report when tests fail and what you did about it
- Never silently skip a test

### Escalate decisions, not problems
- Don't say "the agent had trouble with X"
- Say "there are two approaches to X: [A] does Y, [B] does Z. Which do you prefer?"
- If stuck: describe what you tried, what failed, and what you'd try next

---

## 8. Architecture Diagram Agent

After **every phase completion**, dispatch a dedicated agent to update the Petri architecture diagram.

### File: `petri/architecture-diagram.md`

This diagram is the living map of Petri Consensus. It must be updated after each phase to reflect:
- All implemented modules and their relationships
- Source file references (`src/libs/consensus/petri/...`)
- Data flow between components (arrows with labels)
- Phase number annotations showing when each part was built

### Agent instructions (dispatch after each phase)

```
@senior OBJECTIVE: Update petri/architecture-diagram.md
SCOPE: petri/architecture-diagram.md + all src/libs/consensus/petri/ files built so far
CONTEXT: Phase N just completed. The diagram must reflect the current state of the Petri
  implementation — modules, data flow, file paths, and which phase introduced each component.
APPROACH: Read all implemented Petri source files. Build/update an ASCII/Unicode block diagram
  showing modules, connections, data flow arrows. Each block must include:
  - Module name
  - Source file path
  - Phase number (Pn)
  - Key method names
  Connections must show data types flowing between modules.
  Include a legend. Keep it readable at 120 columns width.
ACCEPTANCE: Diagram compiles the full current state. No future/unbuilt modules shown.
  Every source file in src/libs/consensus/petri/ is represented.
```

### Why this matters

The diagram is the fastest way to onboard, debug, or reason about the system.
It prevents "where does X happen?" questions by making flow visible at a glance.

---

## 9. Phase Execution Checklist

For every phase:

1. Read the phase in `petri/01-implementation-plan.md`
2. Check `myc task list --epic 9` for the specific tasks
3. Mark task in-progress
4. Implement
5. Write tests in `better_testing/petri/`
6. Run `bun run lint:fix`
7. Run tests
8. Close myc task
9. **Dispatch diagram agent** to update `petri/architecture-diagram.md`
10. Report to user: what was done, what tests pass
11. Wait for confirmation before starting next phase
