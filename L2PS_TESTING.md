# L2PS Testing & Validation Guide

**Purpose**: Checklist for validating L2PS implementation when node can be safely started
**Status**: Implementation complete, awaiting runtime validation
**Date Created**: 2025-01-31

---

## Pre-Start Validation

### 1. Database Schema Check
**Goal**: Verify l2ps_hashes table exists

```bash
# Check if TypeORM created the table
sqlite3 data/chain.db ".schema l2ps_hashes"
# OR
psql -d demos_node -c "\d l2ps_hashes"
```

**Expected Output**:
```sql
CREATE TABLE l2ps_hashes (
    l2ps_uid TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    transaction_count INTEGER NOT NULL,
    block_number BIGINT DEFAULT 0,
    timestamp BIGINT NOT NULL
);
```

**If Missing**:
- TypeORM auto-create may need explicit migration
- Check datasource.ts synchronize settings
- Consider manual migration generation

---

## Node Startup Validation

### 2. L2PSHashes Initialization Check
**Goal**: Verify L2PSHashes auto-initializes on startup

**What to Look For in Logs**:
```
[L2PS Hashes] Initialized successfully
```

**If Missing**:
- Check if endpointHandlers.ts is loaded (imports L2PSHashes)
- Verify import statement exists: `import L2PSHashes from "@/libs/blockchain/l2ps_hashes"`
- Check for initialization errors in startup logs

**Validation Command** (when node running):
```bash
# Check logs for L2PS Hashes initialization
grep "L2PS Hashes" logs/node.log
```

---

## Phase 3b Testing: Validator Hash Storage

### 3. Hash Storage Test
**Goal**: Verify validators can store L2PS hash mappings

**Prerequisites**:
- Node must be a validator
- At least one L2PS network with hash updates

**Test Steps**:
1. Trigger hash update (L2PSHashService runs every 5 seconds)
2. Verify validator receives hash update transaction
3. Check handleL2PSHashUpdate processes it
4. Verify hash stored in database

**Validation Queries**:
```bash
# Check stored hashes
sqlite3 data/chain.db "SELECT * FROM l2ps_hashes;"

# Expected: Rows with l2ps_uid, hash, transaction_count, block_number, timestamp
```

**What to Look For in Logs**:
```
[L2PS Hash Update] Stored hash for L2PS <uid>: <hash_prefix>... (<count> txs)
```

**Expected Behavior**:
- Hash mappings update every 5 seconds (if L2PS has transactions)
- Validators never see transaction content (only hashes)
- Updates don't break if validator isn't in network

---

## Phase 3c-1 Testing: NodeCall Endpoints

### 4. getL2PSMempoolInfo Test
**Goal**: Verify mempool info endpoint works

**Test Method** (from another node or script):
```typescript
const response = await peer.call({
    message: "getL2PSMempoolInfo",
    data: { l2psUid: "test_network_1" },
    muid: "test_mempool_info"
})
```

**Expected Response**:
```json
{
    "result": 200,
    "response": {
        "l2psUid": "test_network_1",
        "transactionCount": 42,
        "lastTimestamp": 1706745600000,
        "oldestTimestamp": 1706700000000
    }
}
```

**Error Cases to Test**:
- Missing l2psUid → 400 response
- Non-existent L2PS UID → 200 with transactionCount: 0
- Database errors → 500 response

---

### 5. getL2PSTransactions Test
**Goal**: Verify transaction sync endpoint works

**Test Method**:
```typescript
// Full sync
const response1 = await peer.call({
    message: "getL2PSTransactions",
    data: { l2psUid: "test_network_1" },
    muid: "test_full_sync"
})

// Incremental sync
const response2 = await peer.call({
    message: "getL2PSTransactions",
    data: {
        l2psUid: "test_network_1",
        since_timestamp: 1706700000000
    },
    muid: "test_incremental_sync"
})
```

**Expected Response**:
```json
{
    "result": 200,
    "response": {
        "l2psUid": "test_network_1",
        "transactions": [
            {
                "hash": "0xabc...",
                "l2ps_uid": "test_network_1",
                "original_hash": "0xdef...",
                "encrypted_tx": { "ciphertext": "..." },
                "timestamp": 1706700000000,
                "block_number": 12345
            }
        ],
        "count": 1
    }
}
```

**What to Verify**:
- Only encrypted data returned (validators can't decrypt)
- Incremental sync filters by timestamp correctly
- Duplicate transactions handled gracefully

---

## Phase 3c-2 Testing: Concurrent Sync Service

### 6. Peer Discovery Test
**Goal**: Verify L2PS participant discovery works

**Test Scenario**: Start multiple nodes participating in same L2PS network

**What to Look For in Logs**:
```
[L2PS Sync] Discovered <N> participants for L2PS <uid>
[L2PS Sync] Discovery complete: <total> total participants across <M> networks
```

**Manual Test**:
```typescript
import { discoverL2PSParticipants } from "@/libs/l2ps/L2PSConcurrentSync"

const peers = PeerManager.getInstance().getPeers()
const l2psUids = ["test_network_1", "test_network_2"]
const participantMap = await discoverL2PSParticipants(peers, l2psUids)

console.log(`Network 1: ${participantMap.get("test_network_1")?.length} participants`)
```

**Expected Behavior**:
- Parallel queries to all peers
- Graceful failure handling (some peers may be unreachable)
- Returns map of L2PS UID → participating peers

---

### 7. Mempool Sync Test
**Goal**: Verify incremental mempool sync works

**Test Scenario**:
1. Node A has 50 L2PS transactions
2. Node B has 30 L2PS transactions (older subset)
3. Sync B with A

**What to Look For in Logs**:
```
[L2PS Sync] Starting sync with peer <muid> for L2PS <uid>
[L2PS Sync] Local: 30 txs, Peer: 50 txs for <uid>
[L2PS Sync] Received 20 transactions from peer <muid>
[L2PS Sync] Sync complete for <uid>: 20 new, 0 duplicates
```

**Manual Test**:
```typescript
import { syncL2PSWithPeer } from "@/libs/l2ps/L2PSConcurrentSync"

const peer = PeerManager.getInstance().getPeerByMuid("<peer_muid>")
await syncL2PSWithPeer(peer, "test_network_1")
```

**Expected Behavior**:
- Only fetches missing transactions (since_timestamp filter)
- Handles duplicates gracefully (no errors)
- Doesn't break on peer failures

---

### 8. Participation Exchange Test
**Goal**: Verify participation broadcast works

**Test Scenario**: Node joins new L2PS network, informs peers

**What to Look For in Logs**:
```
[L2PS Sync] Broadcasting participation in <N> L2PS networks to <M> peers
[L2PS Sync] Exchanged participation info with peer <muid>
[L2PS Sync] Participation exchange complete for <N> networks
```

**Manual Test**:
```typescript
import { exchangeL2PSParticipation } from "@/libs/l2ps/L2PSConcurrentSync"

const peers = PeerManager.getInstance().getPeers()
const myNetworks = ["test_network_1", "test_network_2"]
await exchangeL2PSParticipation(peers, myNetworks)
```

**Expected Behavior**:
- Fire-and-forget (doesn't block)
- Parallel execution to all peers
- Graceful failure handling

---

## Phase 3c-3 Testing: Blockchain Sync Integration

### 9. mergePeerlist Integration Test
**Goal**: Verify L2PS participation exchange on peer discovery

**Test Scenario**: New peer joins network

**What to Look For in Logs**:
```
[Sync] Exchanging L2PS participation with <N> new peers
```

**Expected Behavior**:
- Only triggers if node participates in L2PS networks
- Runs in background (doesn't block blockchain sync)
- Errors don't break peer merging

---

### 10. Participant Discovery Integration Test
**Goal**: Verify L2PS discovery runs during block sync

**Test Scenario**: Node starts syncing blockchain

**What to Look For in Logs**:
```
[Sync] Discovered L2PS participants: <N> networks, <M> total peers
```

**Expected Behavior**:
- Runs concurrently with block discovery (non-blocking)
- Only triggers if node participates in L2PS networks
- Errors don't break blockchain sync

---

### 11. Mempool Sync Integration Test
**Goal**: Verify L2PS mempool sync during blockchain sync

**Test Scenario**: Node syncing blocks from peer

**What to Look For in Logs**:
```
[Sync] L2PS mempool synced: <uid>
```

**Expected Behavior**:
- Syncs each L2PS network the node participates in
- Runs in background (doesn't block blockchain sync)
- Errors logged but don't break blockchain sync

**Critical Test**: Introduce L2PS sync failure, verify blockchain sync continues

---

## Privacy Validation

### 12. Validator Content-Blindness Test
**Goal**: Verify validators never see transaction content

**What to Verify**:
- Validators ONLY receive hash mappings (via handleL2PSHashUpdate)
- Validators CANNOT call getL2PSTransactions (only participants can)
- L2PSHashes table contains ONLY hashes, no encrypted_tx field
- Logs never show decrypted transaction content

**Test**: As validator, attempt to access L2PS transactions
```typescript
// This should fail or return empty (validators don't store encrypted_tx)
const txs = await L2PSMempool.getByUID("test_network_1", "processed")
console.log(txs.length) // Should be 0 for validators
```

---

## Performance Testing

### 13. Concurrent Sync Performance
**Goal**: Measure sync performance with multiple peers/networks

**Test Scenarios**:
1. **Single Network, Multiple Peers**: 5 peers, 1 L2PS network
2. **Multiple Networks, Single Peer**: 1 peer, 5 L2PS networks
3. **Multiple Networks, Multiple Peers**: 5 peers, 5 L2PS networks

**Metrics to Measure**:
- Time to discover all participants
- Time to sync 100 transactions
- Memory usage during sync
- CPU usage during sync
- Network bandwidth usage

**Validation**:
- All operations should complete without blocking blockchain sync
- No memory leaks (check after 1000+ transactions)
- Error rate should be <5% (graceful peer failures expected)

---

## Error Recovery Testing

### 14. Peer Failure Scenarios
**Goal**: Verify graceful error handling

**Test Cases**:
1. Peer disconnects during sync → Should continue with other peers
2. Peer returns invalid data → Should log error and continue
3. Peer returns 500 error → Should try next peer
4. All peers unreachable → Should log and retry later

**What to Look For**: Errors logged but blockchain sync never breaks

---

### 15. Database Failure Scenarios
**Goal**: Verify database error handling

**Test Cases**:
1. l2ps_hashes table doesn't exist → Should log clear error
2. Database full → Should log error and gracefully degrade
3. Concurrent writes → Should handle with transactions

---

## Edge Cases

### 16. Empty Network Test
**Goal**: Verify behavior with no L2PS transactions

**Test**: Node participates in L2PS network but no transactions yet

**Expected Behavior**:
- No errors logged
- Hash generation skips empty networks
- Sync operations return empty results
- Endpoints return transactionCount: 0

---

### 17. Large Mempool Test
**Goal**: Verify performance with large transaction counts

**Test**: L2PS network with 10,000+ transactions

**What to Monitor**:
- Memory usage during sync
- Query performance for getL2PSTransactions
- Hash generation time
- Database query performance

**Validation**: Operations should remain responsive (<2s per operation)

---

## Completion Checklist

Use this checklist when validating L2PS implementation:

### Database
- [ ] l2ps_hashes table exists with correct schema
- [ ] L2PSHashes auto-initializes on startup
- [ ] Hash storage works correctly
- [ ] Statistics queries work

### Phase 3b
- [ ] Validators receive and store hash updates
- [ ] Validators never see transaction content
- [ ] Hash mappings update every 5 seconds
- [ ] getStats() returns correct statistics

### Phase 3c-1
- [ ] getL2PSMempoolInfo returns correct data
- [ ] getL2PSTransactions returns encrypted transactions
- [ ] Incremental sync with since_timestamp works
- [ ] Error cases handled correctly (400, 500)

### Phase 3c-2
- [ ] discoverL2PSParticipants finds all peers
- [ ] syncL2PSWithPeer fetches missing transactions
- [ ] exchangeL2PSParticipation broadcasts to peers
- [ ] All functions handle errors gracefully

### Phase 3c-3
- [ ] mergePeerlist exchanges participation
- [ ] getHigestBlockPeerData discovers participants
- [ ] requestBlocks syncs mempools
- [ ] L2PS operations never block blockchain sync
- [ ] L2PS errors don't break blockchain operations

### Privacy
- [ ] Validators content-blind verified
- [ ] Only encrypted data transmitted
- [ ] No transaction content in validator logs
- [ ] L2PSHashes stores ONLY hashes

### Performance
- [ ] Concurrent operations don't block
- [ ] No memory leaks detected
- [ ] Query performance acceptable
- [ ] Error rate <5%

---

## Known Issues to Watch For

1. **Database Schema**: If l2ps_hashes table doesn't auto-create, need manual migration
2. **Initialization Order**: L2PSHashes must initialize before handleL2PSHashUpdate is called
3. **Shared State**: Ensure l2psJoinedUids is populated before L2PS operations
4. **Peer Discovery**: First discovery may be slow (cold start, no cached participants)
5. **Error Cascades**: Watch for repeated errors causing log spam

---

## Success Criteria

L2PS implementation is validated when:
✅ All database tables exist and initialized
✅ All 17 test scenarios pass
✅ Zero errors during normal operation
✅ Blockchain sync unaffected by L2PS operations
✅ Privacy guarantees maintained
✅ Performance within acceptable bounds
✅ All edge cases handled gracefully

**When Complete**: Update l2ps_implementation_status memory with testing results
