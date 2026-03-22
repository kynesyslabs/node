# Phase 9: Secretary-Coordinated Block Signing

**Goal**: Replace the accept-and-sign model with a secretary-coordinated verification round where all shard members independently compile the block, sign its hash, and submit to an elected secretary for collection and finalization.

**Motivation**: The current accept-and-sign model (Phase 3) has a trust gap — non-proposers sign the block hash without independently verifying it. This phase adds independent verification: every member compiles, every member signs, the secretary only assembles.

---

## Design

### Flow

```
All 10 shard members compile block independently (deterministic)
    |
    v
Each member hashes block -> signs hash -> sends (hash, signature) to secretary
    |
    v
Secretary collects signed hashes (timeout: 5s)
    |
    +-- 7/10 hashes match -> assemble block with all signatures -> finalize
    |
    +-- <7/10 match -> REJECT -> re-sync mempools -> retry once
                                  |
                                  +-- retry succeeds (7/10) -> finalize
                                  +-- retry fails -> skip block (empty block next round)
```

### Secretary Election

Reuse existing algorithm: first peer in shard from `getShard()` (sorted by identity + Alea PRNG seeded with CVSA). If secretary goes offline, next peer in shard order becomes secretary (same as `handleSecretaryGoneOffline()` pattern).

### Block Structure

- **Hashed content**: transactions, metadata, ordering (unchanged)
- **Outside hash**: `validation_data.signatures` — map of `pubkey -> signature` from all agreeing members
- **Secretary seal**: secretary's own signature is included in `validation_data.signatures` (no separate field needed — the secretary is a shard member who also compiled and signed)

### Disagreement Handling

If <7/10 hashes match:
1. Reject block
2. Trigger mempool re-sync across shard (`mergeMempools()`)
3. All members recompile after re-sync
4. Secretary collects signatures again (retry)
5. If still <7/10 -> skip block, chain produces empty block on next boundary

### RPC Protocol

New consensus submethod: `petri_submitBlockHash`
- **Direction**: member -> secretary
- **Request params**: `[blockHash, signature, blockNumber]`
- **Response**: `{ status: "collected" | "mismatch" | "error" }`

Secretary broadcasts finalized block using existing `BroadcastManager.broadcastNewBlock()`.

---

## Files to Create

| File | Purpose |
|------|---------|
| `src/libs/consensus/petri/coordination/petriSecretary.ts` | Secretary election, hash collection, retry logic |

## Files to Modify

| File | Change |
|------|--------|
| `src/libs/consensus/petri/block/petriBlockFinalizer.ts` | Replace `broadcastBlockHash()` with secretary coordination flow |
| `src/libs/consensus/petri/index.ts` | Wire secretary election, pass secretary role into `runBlockPeriod()` |
| `src/libs/network/manageConsensusRoutines.ts` | Add `petri_submitBlockHash` case + add to ConsensusMethod type |
| `src/libs/consensus/v2/routines/manageProposeBlockHash.ts` | Replace Petri accept-and-sign branch with compile-and-verify |
| `src/libs/consensus/v2/routines/ensureCandidateBlockFormed.ts` | Keep Petri wait logic (still needed for non-secretary members) |

## Files to Create (Tests)

| File | Purpose |
|------|---------|
| `better_testing/petri/secretaryCoordination.test.ts` | Unit tests for secretary election, hash collection, retry, offline fallback |

---

## Implementation Tasks

### Task 1: Create `petriSecretary.ts`

New module `src/libs/consensus/petri/coordination/petriSecretary.ts`:

```typescript
// Key exports:
electSecretary(shard: Peer[]): Peer
  // Returns shard[0] (first in deterministic order — same algo as SecretaryManager)

isWeSecretary(shard: Peer[]): boolean
  // Returns electSecretary(shard).identity === getSharedState.publicKeyHex

collectBlockHashes(shard: Peer[], block: Block, timeoutMs: number): Promise<CollectionResult>
  // Secretary-only: wait for petri_submitBlockHash RPCs from members
  // Also include our own hash+signature
  // Returns { signatures, matchCount, mismatchCount, timedOut }

submitBlockHash(secretary: Peer, block: Block): Promise<SubmitResult>
  // Non-secretary: compile block, sign hash, send to secretary via petri_submitBlockHash RPC
  // Returns { accepted: boolean }

handleMempoolResync(shard: Peer[]): Promise<void>
  // Calls mergeMempools() to re-sync, used on hash mismatch retry

CollectionResult {
  signatures: Record<string, string>  // pubkey -> signature (only matching hashes)
  matchCount: number
  mismatchCount: number
  timedOutCount: number
  agreed: boolean  // matchCount >= threshold
}
```

### Task 2: Rewrite `petriBlockFinalizer.ts`

Replace `broadcastBlockHash()` call with:

```
if (isWeSecretary(shard)):
    result = await collectBlockHashes(shard, block, 5000)
    if (!result.agreed):
        await handleMempoolResync(shard)
        // Signal members to recompile (via RPC or just re-collect)
        retryResult = await collectBlockHashes(shard, block, 5000)
        if (!retryResult.agreed):
            return { success: false, ... }

    block.validation_data.signatures = result.signatures
    await insertBlock(block)
    await BroadcastManager.broadcastNewBlock(block)
else:
    await submitBlockHash(electSecretary(shard), block)
    // Wait for secretary to broadcast finalized block
    // (handled by existing block sync/broadcast mechanisms)
```

### Task 3: Add `petri_submitBlockHash` RPC handler

In `manageConsensusRoutines.ts`:
- Add `"petri_submitBlockHash"` to `ConsensusMethod.method` union type
- Add case handler that stores the incoming hash+signature in a collection map
- The collection map is accessed by `collectBlockHashes()` in the secretary

### Task 4: Wire into `petri/index.ts`

In `runBlockPeriod()`:
- After `compileBlock()`, determine if we are secretary
- If secretary: run `finalizeBlock()` which now handles collection
- If non-secretary: submit hash to secretary, then wait for finalized block via broadcast

### Task 5: Update `manageProposeBlockHash.ts`

Replace the Petri accept-and-sign branch (lines 50-69):
- When Petri active: compile own candidate block, compare hash with proposed hash
- If match: sign and return signature (verify-then-sign, like PoRBFT but without secretary phase coordination)
- If mismatch: return 401

This makes `manageProposeBlockHash` a fallback/compat path. The primary Petri flow uses `petri_submitBlockHash` instead.

### Task 6: Write tests

Test cases:
1. Secretary election (first in shard)
2. Hash collection — happy path (10/10 agree)
3. Hash collection — BFT threshold (7/10 agree, 3 mismatch)
4. Hash collection — below threshold, retry succeeds
5. Hash collection — below threshold, retry fails (skip block)
6. Secretary offline — fallback to next peer
7. Timeout handling — some members don't respond

---

## Dependency Graph

```
Task 1 (petriSecretary.ts)
    |
    +---> Task 2 (petriBlockFinalizer.ts rewrite)
    |         |
    |         +---> Task 4 (petri/index.ts wiring)
    |
    +---> Task 3 (RPC handler)
    |
    +---> Task 5 (manageProposeBlockHash update)

Task 6 (tests) -- depends on all above
```

Tasks 3 and 5 are independent and can run in parallel.
Task 2 depends on Task 1.
Task 4 depends on Task 2.
Task 6 depends on all.

---

## Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Deterministic compilation divergence | HIGH | All members include ALL mempool txs (existing design), same ordering algo |
| Secretary bottleneck | MEDIUM | Secretary only collects signatures, doesn't compute — lightweight |
| Secretary offline during collection | MEDIUM | Reuse handleSecretaryGoneOffline pattern — next peer takes over |
| Network latency causing timeouts | MEDIUM | 5s collection timeout, 1 retry with re-sync |
| Race condition: members at different block heights | MEDIUM | Block number check in petri_submitBlockHash handler |
