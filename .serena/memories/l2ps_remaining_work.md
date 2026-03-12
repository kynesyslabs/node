# L2PS Remaining Work

## Priority 1: Complete Validator Hash Storage (Phase 3b)

### Create L2PSHashes Entity
**File**: `src/model/entities/L2PSHashes.ts` (DOES NOT EXIST)

**Required Schema**:
```typescript
@Entity("l2ps_hashes")
export class L2PSHash {
    @PrimaryColumn() l2ps_uid: string
    @Column() hash: string
    @Column() transaction_count: number
    @Column() block_number: number
    @Column() timestamp: bigint
}
```

### Create L2PSHashes Manager
Follow pattern from `l2ps_mempool.ts`:
- Static repo: Repository<L2PSHash>
- init() method
- updateHash(l2psUid, hash, txCount, blockNumber)
- getHash(l2psUid)
- getStats()

### Complete handleL2PSHashUpdate
**File**: `src/libs/network/endpointHandlers.ts` (handleL2PSHashUpdate method)

**Current Status**: Has TODO comment at line 751
**Required**: Add actual hash storage logic:

```typescript
// Store hash update for validator consensus
const hashEntry = {
    l2ps_uid: l2psHashPayload.l2ps_uid,
    hash: l2psHashPayload.consolidated_hash,
    transaction_count: l2psHashPayload.transaction_count,
    block_number: tx.block_number || 0,
    timestamp: BigInt(Date.now())
}
await L2PSHashes.updateHash(hashEntry)
```

## Priority 2: Complete NodeCall Endpoints (Phase 3c-1)

### Implement getL2PSMempoolInfo
**File**: `src/libs/network/manageNodeCall.ts:345-354`

**Current Status**: Returns 501 (UNIMPLEMENTED)
**Required Implementation**:

```typescript
case "getL2PSMempoolInfo": {
    if (!data.l2psUid) {
        response.result = 400
        response.response = "No L2PS UID specified"
        break
    }
    
    try {
        const transactions = await L2PSMempool.getByUID(data.l2psUid, "processed")
        response.response = {
            l2psUid: data.l2psUid,
            transactionCount: transactions.length,
            lastTimestamp: transactions[transactions.length - 1]?.timestamp || 0
        }
    } catch (error) {
        response.result = 500
        response.response = "Failed to get L2PS mempool info"
    }
    break
}
```

### Implement getL2PSTransactions
**File**: `src/libs/network/manageNodeCall.ts:356-365`

**Current Status**: Returns 501 (UNIMPLEMENTED)
**Required Implementation**:

```typescript
case "getL2PSTransactions": {
    if (!data.l2psUid) {
        response.result = 400
        response.response = "No L2PS UID specified"
        break
    }
    
    try {
        const transactions = await L2PSMempool.getByUID(
            data.l2psUid,
            "processed",
            data.since_timestamp // Optional filter
        )
        response.response = { transactions }
    } catch (error) {
        response.result = 500
        response.response = "Failed to get L2PS transactions"
    }
    break
}
```

## Priority 3: Create L2PS Concurrent Sync Service (Phase 3c-2)

### Create L2PSConcurrentSync.ts
**File**: `src/libs/l2ps/L2PSConcurrentSync.ts` (DOES NOT EXIST)

**Required Functions**:

1. **discoverL2PSParticipants(peers: Peer[], l2psUids: string[]): Promise<Map<string, Peer[]>>**
   - Query peers using `getL2PSParticipationById` NodeCall
   - Build participant map per L2PS UID
   - Return mapping of L2PS UID → participating peers

2. **syncL2PSWithPeer(peer: Peer, l2psUid: string): Promise<void>**
   - Compare local vs peer mempool counts via `getL2PSMempoolInfo`
   - Request missing transactions via `getL2PSTransactions`
   - Validate signatures and insert into local mempool
   - Handle errors gracefully

3. **exchangeL2PSParticipation(peers: Peer[]): Promise<void>**
   - Inform peers of local L2PS participation
   - Query peers for their L2PS participation
   - Update local participant knowledge

**Pattern**: Follow singleton service pattern, use parallel peer calls, comprehensive logging

## Priority 4: Integrate with Sync.ts (Phase 3c-3)

### Add L2PS Sync Hooks
**File**: `src/libs/blockchain/routines/Sync.ts` (CURRENTLY NO L2PS CODE)

**Required Integrations** (add small hooks, don't break existing sync):

1. **In mergePeerlist()** - after merging blockchain peers:
```typescript
// Exchange L2PS participation info with new peers
await exchangeL2PSParticipation(newPeers)
```

2. **In getHigestBlockPeerData()** - concurrent L2PS participant discovery:
```typescript
// Discover which peers participate in our L2PS networks
await discoverL2PSParticipants(peers, getSharedState.l2psJoinedUids)
```

3. **In requestBlocks()** - sync L2PS data alongside block sync:
```typescript
// Sync L2PS mempools with peers (concurrent, not sequential)
for (const l2psUid of getSharedState.l2psJoinedUids) {
    syncL2PSWithPeer(peer, l2psUid).catch(err => 
        log.error("[Sync] L2PS sync error:", err)
    )
}
```

**Critical**: Make L2PS sync run concurrently, NOT block blockchain sync

## Testing Considerations

- Test with multiple L2PS participants
- Verify sync works for new nodes joining existing L2PS network
- Ensure validators NEVER receive transaction content
- Validate duplicate detection works correctly
- Test graceful shutdown and error recovery
- Verify concurrent sync doesn't block blockchain sync

## Dependencies Between Priorities

- Priority 1 (Hash Storage) is independent, can start immediately
- Priority 2 (NodeCall Endpoints) is independent, can start immediately  
- Priority 3 (Concurrent Sync) depends on Priority 2 (needs NodeCall endpoints)
- Priority 4 (Sync Integration) depends on Priority 3 (needs sync utilities)

**Optimal Implementation Order**: P1 and P2 in parallel → P3 → P4
