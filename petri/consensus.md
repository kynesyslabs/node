# Petri Consensus — How It Actually Works

> Source-level reference for the current Petri consensus implementation.
> Every statement points to a file and line number you can verify.

---

## Overview

Petri runs a **secretary-driven, accept-and-sign** consensus model. Every ~10 seconds, the deterministically elected secretary compiles a block from the mempool, broadcasts its hash to shard peers, collects BFT signatures, and inserts the finalized block. Members sign the secretary's hash without independent verification (accept-and-sign), then wait for the finalized block via sync.

```
mainLoop (1s tick)
    |
    v  (consensus time reached)
petriConsensusRoutine(shard)
    |
    +-- ContinuousForge.start(shard)     [2s cycles, background]
    |
    +-- sleep(10s)                        [wait for block boundary]
    |
    +-- forge.pause()
    |
    +-- arbitrate(shard)                  [resolve PROBLEMATIC txs]
    |
    +-- compileBlock(shard, resolved)     [filter + order + create]
    |
    +-- finalizeBlock(block, shard)
    |       |
    |       +-- [SECRETARY]: broadcastBlockHash -> collect sigs -> insertBlock
    |       |
    |       +-- [MEMBER]: sign when asked, wait for finalized block via sync
    |
    +-- cleanRejectedFromMempool()
    |
    +-- forge.reset() + forge.resume()    [next cycle starts]
```

---

## Step-by-Step Flow

### 1. Main Loop Dispatch

**File:** `src/utilities/mainLoop.ts`

The main event loop ticks every second. When consensus time is reached (10s boundary), it:

1. Computes the `commonValidatorSeed` from the last 3 block hashes
2. Derives the `shard` (list of peers) from the seed
3. Calls `petriConsensusRoutine(shard)` if `getSharedState.petriConsensus === true`

PoRBFT v2's `consensusRoutine()` is only called when the flag is `false`.

### 2. Petri Consensus Routine

**File:** `src/libs/consensus/petri/index.ts` — `petriConsensusRoutine()`

Entry point for one block period. Guards against concurrent runs via `inConsensusLoop` flag.

1. Creates a `ContinuousForge` instance with config (`forgeIntervalMs: 2000`, etc.)
2. Starts forge in background — syncs mempools every 2s across the shard
3. Calls `runBlockPeriod()` which orchestrates the three phases:
   - **Arbitration**: resolve any PROBLEMATIC transactions via BFT vote
   - **Compilation**: assemble the block from filtered mempool
   - **Finalization**: collect signatures and insert
4. In `finally`: stops forge, resets `inConsensusLoop = false`

The `finally` block guarantees the consensus flag is always reset, even on error. This was a bug fix — previously, a crash would leave `inConsensusLoop = true` forever, preventing future rounds.

### 3. Secretary Election

**File:** `src/libs/consensus/petri/coordination/petriSecretary.ts` — `isWeSecretary()`

Deterministic election computed identically on all nodes:

1. Collect all identities: shard peer identities + our own public key
2. Sort alphabetically
3. First identity = secretary

Currently **static** — the same node (lowest sorted identity) is always secretary. Rotation from block seed is planned for P9.

### 4. Block Compilation

**File:** `src/libs/consensus/petri/block/petriBlockCompiler.ts` — `compileBlock()`

Assembles a deterministic block from the mempool:

1. **Get mempool**: `Mempool.getMempool()` — all pending transactions
2. **Timestamp cutoff**: Only include TXs with `timestamp <= blockBoundaryMs - forgeIntervalMs`
   - `blockBoundaryMs = floor(currentUTCTime / blockIntervalSec) * blockIntervalSec * 1000`
   - This gives 2s buffer for propagation — TXs arriving in the last 2s are deferred
   - Both boundary and TX timestamps use **milliseconds** (bug fix: was comparing ms vs seconds)
3. **Merge resolved TXs**: any PROBLEMATIC txs that passed BFT arbitration are added
4. **Order deterministically**: `orderTransactions()` sorts by timestamp ASC, hash ASC tiebreaker
5. **Quantize consensus timestamp**: `floor(currentUTCTime / blockIntervalSec) * blockIntervalSec` — ensures all nodes produce identical block hashes
6. **Create block**: `createBlock()` with ordered TX hashes, seed, previous block hash, block number

### 5. Deterministic TX Ordering

**File:** `src/libs/consensus/v2/routines/orderTransactions.ts` — `orderTransactions()`

Sorts the mempool deterministically so all nodes compile the same block:

- **Primary**: timestamp ascending (`a.content.timestamp - b.content.timestamp`)
- **Tiebreaker**: hash lexicographic (`a.hash < b.hash ? -1 : 1`)

Every node with the same mempool state produces the same ordering.

### 6. Block Finalization

**File:** `src/libs/consensus/petri/block/petriBlockFinalizer.ts` — `finalizeBlock()`

Branches based on secretary election:

#### Secretary Path (`secretaryFinalize`):

1. Set `candidateBlock = block` on shared state
2. Call `broadcastBlockHash(block, shard)` — sends hash to all peers via RPC
3. Each peer runs `manageProposeBlockHash()` and returns their signature
4. Check threshold: `signatures >= floor((totalMembers * 2) / 3) + 1`
   - For 4-node devnet: threshold = 4 (all must agree)
   - For 10-node production shard: threshold = 7
5. If passed: `insertBlock(block)` + `BroadcastManager.broadcastNewBlock(block)`
6. If failed: log error, clear candidate, return failure

#### Member Path (`memberFinalize`):

1. Set `candidateBlock = block` on shared state
2. Wait up to 15s for `lastBlockNumber` to advance (block arrives via sync)
3. If block arrives: return success
4. If timeout: log warning, return failure (next round will retry)

### 7. Signature Collection (broadcastBlockHash)

**File:** `src/libs/consensus/v2/routines/broadcastBlockHash.ts` — `broadcastBlockHash()`

Secretary broadcasts block hash to all shard peers in parallel:

1. Build RPC params: `[block.hash, block.validation_data, ourIdentity]`
2. Send `proposeBlockHash` to all peers via `Promise.allSettled` — one failure doesn't abort others
3. For each successful response:
   - Extract signatures from `response.extra.signatures`
   - Verify each signature against the block hash
   - Add valid signatures to `block.validation_data.signatures`
4. Return `[proCount, conCount]`

### 8. Accept-and-Sign Handler

**File:** `src/libs/consensus/v2/routines/manageProposeBlockHash.ts` — `manageProposeBlockHash()`

RPC handler invoked when secretary broadcasts. Dual-mode:

**Petri mode** (`getSharedState.petriConsensus === true`):
- Sign the secretary's hash directly without verification
- Return signature in response — **accept-and-sign model**
- Trusts the secretary because only one deterministic secretary proposes per round

**PoRBFT v2 mode** (fallback):
- Compile own candidate block, compare hashes
- Only sign if hashes match — **verify-then-sign model**

### 9. Block Insertion with Savepoints

**File:** `src/libs/blockchain/chainBlocks.ts` — `insertBlock()`

Inserts the finalized block into PostgreSQL with per-TX savepoints:

1. Create `QueryRunner`, start DB transaction
2. Save block entity
3. **For each transaction** in the block:
   - `SAVEPOINT tx_insert_N` — mark recovery point
   - Try: save TX + persist L2PS projection + `RELEASE SAVEPOINT`
   - Catch: `ROLLBACK TO SAVEPOINT` — rolls back only this TX, outer transaction stays valid
   - This prevents **DB transaction poisoning** — previously, one duplicate TX would abort the entire block insert
4. Remove committed TXs from mempool
5. Update identity commitments
6. Update Merkle tree
7. Commit DB transaction

---

## Key Invariants

| Invariant | Mechanism | File |
|-----------|-----------|------|
| Secretary is deterministic | Sorted identity list, first = secretary | `petriSecretary.ts:99-104` |
| Block hash is identical across nodes | Quantized timestamp + deterministic TX ordering + cutoff filter | `petriBlockCompiler.ts:57-101` |
| TX ordering is deterministic | Sort by timestamp ASC, hash ASC tiebreaker | `orderTransactions.ts:22-29` |
| TX cutoff prevents non-determinism | Exclude TXs from last 2s (propagation buffer) | `petriBlockCompiler.ts:63-65` |
| DB insert never poisons | Per-TX savepoints with ROLLBACK TO SAVEPOINT on failure | `chainBlocks.ts:234-262` |
| BFT threshold | `floor((n * 2) / 3) + 1` signatures required | `petriBlockFinalizer.ts:57` |
| Consensus never stalls | Empty blocks are valid; PROBLEMATIC txs are rejected after TTL | `petriBlockCompiler.ts`, `bftArbitrator.ts` |
| PoRBFT v2 cannot run | All dispatch points gated by `petriConsensus` flag | `mainLoop.ts:130`, `manageConsensusRoutines.ts:84` |

---

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PETRI_CONSENSUS` | `true` | Enable Petri (set `false` for PoRBFT v2 fallback) |
| `PETRI_FORGE_INTERVAL_MS` | `2000` | Continuous forge cycle interval |
| `PETRI_BLOCK_INTERVAL_MS` | `10000` | Block boundary interval |
| `OMNI_ENABLED` | `true` | Enable OmniProtocol for peer communication |
| `OMNI_MODE` | `OMNI_PREFERRED` | Use OmniProtocol with HTTP fallback |

Defaults in `src/config/defaults.ts`.

---

## Soak Test Results (2026-03-22)

| Metric | Value |
|--------|-------|
| Devnet size | 4 nodes |
| TXs submitted | 10/10 (0% error) |
| Blocks produced | 25 (9 -> 34) |
| Block rate | ~11.5s per block |
| Hard finality observed | 4 TXs confirmed in blocks |
| PoRBFT activity | Zero — fully suppressed |
| Test verdict | `ok: true` |
