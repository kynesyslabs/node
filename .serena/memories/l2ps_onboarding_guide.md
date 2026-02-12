# L2PS Onboarding Guide for Future Sessions

**Purpose**: Help new LLM sessions quickly understand the L2PS system architecture and implementation
**Last Updated**: 2025-01-31
**Branch**: l2ps_simplified

---

## What is L2PS?

**L2PS (Layer 2 Privacy Subnets)** is a privacy-preserving transaction system for the Demos Network that enables encrypted transactions with content-blind validator consensus.

### Core Concept

L2PS creates isolated private transaction networks where:
- **Participants** store full encrypted transactions
- **Validators** store ONLY hash mappings (content-blind)
- **Privacy preserved** end-to-end (validators never see transaction content)

### Privacy Model

```
L2PS Participant Flow:
User → Encrypt TX → Send to L2PS → Store in L2PS Mempool → Generate Hash → Relay to Validator

Validator Flow:
Receive Hash Update → Store Hash ONLY → Never Access Transaction Content → Participate in Consensus
```

**Key Privacy Guarantee**: Validators participate in consensus without ever seeing what they're validating.

---

## System Architecture

### Three-Tier Architecture

1. **L2PS Participants** (Private Nodes)
   - Store encrypted transactions in L2PS Mempool
   - Generate consolidated hashes every 5 seconds
   - Relay hashes to validators via DTR (Distributed Transaction Routing)
   - Sync mempools with other participants

2. **Validators** (Public Nodes)
   - Store ONLY hash mappings (L2PS UID → Hash)
   - Never store encrypted transactions
   - Participate in consensus using hashes
   - Content-blind to actual transaction data

3. **Sync Layer** (Automatic)
   - Participants discover other participants
   - Incremental mempool synchronization
   - Redundancy and fault tolerance
   - Non-blocking blockchain sync integration

---

## Implementation Phases (All Complete)

### Phase 1: Core Infrastructure
- L2PS Mempool for encrypted transaction storage
- Transaction handler for L2PS transactions
- Basic L2PS network management

### Phase 2: Hash Generation Service
- 5-second interval hash generation
- Consolidated hash computation
- Automatic hash updates

### Phase 3a: DTR Integration
- Validator relay implementation
- Hash update handler
- Participation query endpoint

### Phase 3b: Validator Hash Storage
- L2PS UID → Hash mapping storage
- Content-blind validator consensus
- Statistics and monitoring

### Phase 3c: Mempool Synchronization
- Peer discovery for L2PS networks
- Incremental mempool sync
- Blockchain sync integration

---

## File Organization

### Core L2PS Files

**Entities** (Database Models):
- `src/model/entities/L2PSMempool.ts` - Encrypted transaction storage
- `src/model/entities/L2PSHashes.ts` - Validator hash mappings

**Managers** (Business Logic):
- `src/libs/blockchain/l2ps_mempool.ts` - L2PS mempool CRUD operations
- `src/libs/blockchain/l2ps_hashes.ts` - Hash storage management

**Services** (Background Processes):
- `src/libs/l2ps/L2PSHashService.ts` - Hash generation every 5 seconds
- `src/libs/l2ps/L2PSConcurrentSync.ts` - Peer discovery and sync

**Handlers** (Network Endpoints):
- `src/libs/network/routines/transactions/handleL2PS.ts` - L2PS transaction processing
- `src/libs/network/endpointHandlers.ts` - handleL2PSHashUpdate (line 731-772)
- `src/libs/network/manageNodeCall.ts` - NodeCall endpoints (lines 345-421)

**Integration** (Blockchain):
- `src/libs/blockchain/routines/Sync.ts` - L2PS sync hooks (lines 116-130, 383-396, 478-493)

### Documentation Files

- `L2PS_PHASES.md` - Implementation phases and completion status
- `L2PS_TESTING.md` - Testing and validation guide (17 test scenarios)

---

## Key Data Structures

### L2PSMempool Entity
```typescript
{
    hash: string              // Transaction hash (primary key)
    l2ps_uid: string          // L2PS network identifier
    original_hash: string     // Original transaction hash
    encrypted_tx: JSONB       // Encrypted transaction data
    status: string            // "pending" | "processed"
    timestamp: bigint         // When transaction was stored
    block_number: bigint      // Associated block number
}
```

### L2PSHash Entity
```typescript
{
    l2ps_uid: string          // L2PS network identifier (primary key)
    hash: string              // Consolidated hash of all transactions
    transaction_count: number // Number of transactions in hash
    block_number: bigint      // Block number when hash was stored
    timestamp: bigint         // When hash was stored
}
```

---

## Important Concepts

### L2PS UID
- Unique identifier for each L2PS network
- Format: String (e.g., "network_1", "private_subnet_alpha")
- Used to isolate different L2PS networks
- Stored in `getSharedState.l2psJoinedUids` (always defined as string[])

### Consolidated Hash
- SHA-256 hash of all transaction hashes in L2PS network
- Generated every 5 seconds by L2PSHashService
- Deterministic (same transactions = same hash)
- Used by validators for consensus

### DTR (Distributed Transaction Routing)
- Mechanism for relaying hash updates to validators
- Discovers validators from network
- Random ordering for load distribution
- Tries all validators until one accepts

### Content-Blind Consensus
- Validators store ONLY hashes, never transaction content
- Privacy preserved: validators can't decrypt transactions
- Trust model: validators validate without seeing data
- Participant-only access to encrypted transactions

---

## Code Flow Examples

### L2PS Transaction Submission Flow
```
1. User encrypts transaction
2. Transaction sent to L2PS participant node
3. handleL2PS() validates and decrypts (handleL2PS.ts:41-95)
4. L2PSMempool.addTransaction() stores encrypted TX (l2ps_mempool.ts:107-158)
5. L2PSHashService generates hash every 5s (L2PSHashService.ts:101-168)
6. Hash relayed to validators via DTR (L2PSHashService.ts:250-311)
7. Validators store hash in L2PSHashes (l2ps_hashes.ts:63-99)
```

### L2PS Mempool Sync Flow
```
1. Node joins L2PS network
2. exchangeL2PSParticipation() broadcasts to peers (L2PSConcurrentSync.ts:221-251)
3. discoverL2PSParticipants() finds other participants (L2PSConcurrentSync.ts:29-84)
4. syncL2PSWithPeer() fetches missing transactions (L2PSConcurrentSync.ts:105-199)
5. Incremental sync using since_timestamp filter
6. Duplicate detection and prevention
7. Local mempool updated with new transactions
```

### Blockchain Sync Integration
```
1. Node starts syncing blocks (Sync.ts:340-405)
2. mergePeerlist() exchanges L2PS participation (Sync.ts:478-493)
3. getHigestBlockPeerData() discovers participants (Sync.ts:116-130)
4. requestBlocks() syncs mempools alongside blocks (Sync.ts:383-396)
5. All L2PS ops run in background (non-blocking)
6. Errors isolated (L2PS failures don't break blockchain sync)
```

---

## NodeCall Endpoints

### getL2PSParticipationById
**Purpose**: Check if peer participates in specific L2PS network
**Location**: manageNodeCall.ts (lines 318-343)
**Request**: `{ l2psUid: string }`
**Response**: `{ participates: boolean }`

### getL2PSMempoolInfo
**Purpose**: Query mempool statistics for L2PS network
**Location**: manageNodeCall.ts (lines 345-376)
**Request**: `{ l2psUid: string }`
**Response**: 
```typescript
{
    l2psUid: string
    transactionCount: number
    lastTimestamp: bigint
    oldestTimestamp: bigint
}
```

### getL2PSTransactions
**Purpose**: Sync encrypted transactions from peer
**Location**: manageNodeCall.ts (lines 378-421)
**Request**: `{ l2psUid: string, since_timestamp?: bigint }`
**Response**:
```typescript
{
    l2psUid: string
    transactions: Array<{
        hash: string
        l2ps_uid: string
        original_hash: string
        encrypted_tx: object
        timestamp: bigint
        block_number: bigint
    }>
    count: number
}
```

---

## Critical Implementation Details

### Auto-Initialization Pattern
Both L2PSMempool and L2PSHashes use auto-initialization on import:
```typescript
// At end of file
L2PSHashes.init().catch(error => {
    log.error("[L2PS Hashes] Failed to initialize during import:", error)
})
```
**Why**: Ensures managers are ready before endpoint handlers use them

### Non-Blocking Background Operations
All L2PS operations in Sync.ts use `.then()/.catch()` pattern:
```typescript
// Non-blocking (correct)
syncL2PSWithPeer(peer, l2psUid)
    .then(() => log.debug("Synced"))
    .catch(error => log.error("Failed"))

// Blocking (incorrect - never do this)
await syncL2PSWithPeer(peer, l2psUid)
```
**Why**: L2PS operations must never block blockchain sync

### Error Isolation
L2PS errors are caught and logged but never propagate:
```typescript
try {
    await L2PSHashes.updateHash(...)
} catch (error: any) {
    log.error("Failed to store hash:", error)
    // Error handled, doesn't break caller
}
```
**Why**: L2PS failures shouldn't crash node or break blockchain operations

### Incremental Sync Strategy
Sync uses `since_timestamp` to fetch only new transactions:
```typescript
const txResponse = await peer.call({
    message: "getL2PSTransactions",
    data: {
        l2psUid,
        since_timestamp: localLastTimestamp // Only get newer
    }
})
```
**Why**: Reduces bandwidth, faster sync, efficient for frequent updates

---

## Common Patterns

### Checking L2PS Participation
```typescript
if (getSharedState.l2psJoinedUids?.length > 0) {
    // Node participates in at least one L2PS network
}
```
**Note**: `l2psJoinedUids` is always defined (default: `[]`), so `?.` is redundant but safe

### Getting L2PS Transactions
```typescript
// Get all processed transactions for specific L2PS UID
const transactions = await L2PSMempool.getByUID(l2psUid, "processed")
```

### Storing Hash Updates
```typescript
await L2PSHashes.updateHash(
    l2psUid,
    consolidatedHash,
    transactionCount,
    BigInt(blockNumber)
)
```

### Parallel Peer Operations
```typescript
const promises = peers.map(async (peer) => {
    // Operation for each peer
})
await Promise.allSettled(promises) // Graceful failure handling
```

---

## Testing Checklist

When validating L2PS implementation, check:

1. **Database**: l2ps_hashes table exists with correct schema
2. **Initialization**: Both L2PSMempool and L2PSHashes initialize on startup
3. **Hash Storage**: Validators store hash updates every 5 seconds
4. **Endpoints**: All 3 NodeCall endpoints return proper data
5. **Sync**: Participants discover peers and sync mempools
6. **Integration**: L2PS operations don't block blockchain sync
7. **Privacy**: Validators never access transaction content
8. **Errors**: L2PS failures isolated and don't crash node

**Full testing guide**: See L2PS_TESTING.md (17 test scenarios)

---

## Quick File Reference

**Need to understand L2PS transactions?** → `handleL2PS.ts`
**Need to see hash generation?** → `L2PSHashService.ts`
**Need to see sync logic?** → `L2PSConcurrentSync.ts`
**Need to see endpoints?** → `manageNodeCall.ts` (lines 318-421)
**Need to see blockchain integration?** → `Sync.ts` (search for "L2PS")
**Need to understand storage?** → `l2ps_mempool.ts` + `l2ps_hashes.ts`

---

## Implementation Status

✅ **ALL PHASES COMPLETE (100%)**
- Code implementation finished
- Documentation complete
- Testing guide created
- Awaiting runtime validation

**Commits**: 51b93f1a, 42d42eea, a54044dc, 80bc0d62, 36b03f22
**Lines Added**: ~650 production code, ~1200 documentation
**Files Created**: 3 new files, 4 modified

---

## Key Takeaways for New Sessions

1. **L2PS = Privacy-Preserving Transactions**: Encrypted for participants, hashes for validators
2. **Two Storage Systems**: L2PSMempool (participants) + L2PSHashes (validators)
3. **Auto-Sync**: Background mempool synchronization between participants
4. **Non-Blocking**: L2PS operations never block blockchain operations
5. **Content-Blind Validators**: Privacy guarantee maintained throughout
6. **5-Second Hash Generation**: Automatic hash updates for consensus
7. **Incremental Sync**: Efficient transaction synchronization using timestamps
8. **Error Isolation**: L2PS failures don't crash node or break blockchain

**Start here when working on L2PS**: Read this guide → Check L2PS_PHASES.md → Review file locations → Test with L2PS_TESTING.md
