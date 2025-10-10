# OmniProtocol Step 3: Peer Discovery & Handshake Questions

## Status
**Phase**: Design questions awaiting user feedback  
**Approach**: Map existing PeerManager/Peer system to OmniProtocol binary format  
**Focus**: Replicate current behavior, not redesign the system

## Existing System Analysis Completed

### Files Analyzed
1. **PeerManager.ts**: Singleton managing online/offline peer registries
2. **Peer.ts**: Connection wrapper with call(), longCall(), multiCall()
3. **manageHelloPeer.ts**: Hello peer handshake handler

### Current Flow Identified
1. Load peer list from `demos_peer.json` (identity → connection_string mapping)
2. `sayHelloToPeer()`: Send hello_peer with URL, publicKey, signature, syncData
3. Peer validates signature (sign URL with private key, verify with public key)
4. Peer responds with success + their syncData
5. Add to PeerManager online/offline registries

### Current HelloPeerRequest Structure
```typescript
interface HelloPeerRequest {
    url: string              // Connection string (http://ip:port)
    publicKey: string        // Hex-encoded public key
    signature: {
        type: SigningAlgorithm  // "ed25519" | "falcon" | "ml-dsa"
        data: string         // Hex-encoded signature of URL
    }
    syncData: {
        status: boolean      // Sync status
        block: number        // Last block number
        block_hash: string   // Last block hash (hex string)
    }
}
```

### Current Connection Patterns
- **call()**: Single RPC, 3 second timeout, HTTP POST
- **longCall()**: 3 retries, 250ms sleep between retries, configurable allowed error codes
- **multiCall()**: Parallel calls to multiple peers with 2s timeout
- **No ping mechanism**: Relies on RPC success/failure for health

## Design Questions for User

### Q1. Connection String Encoding (hello_peer payload)
**Context**: Current format is "http://ip:port" or "https://ip:port" as string

**Options**:
- **Option A**: Length-prefixed UTF-8 string (2 bytes length + variable string)
  - Pros: Flexible, supports any URL format, future-proof
  - Cons: Variable size, requires parsing
  
- **Option B**: Fixed structure (1 byte protocol + 4 bytes IP + 2 bytes port)
  - Pros: Compact (7 bytes fixed), efficient parsing
  - Cons: Only supports IPv4, no hostnames, rigid

**Recommendation**: Option A (length-prefixed) for flexibility

### Q2. Signature Type Encoding
**Context**: Step 1 defined Algorithm field (1 byte): 0x01=ed25519, 0x02=falcon, 0x03=ml-dsa

**Question**: Should hello_peer reuse the same algorithm encoding as auth block?
- This would match the auth block format from Step 1
- Consistent across protocol

**Recommendation**: Yes, reuse 1-byte algorithm encoding

### Q3. Sync Data Binary Encoding
**Context**: Current syncData has 3 fields: status (bool), block (number), block_hash (string)

**Sub-questions**:
- **status**: 1 byte boolean (0x00=false, 0x01=true) ✓
- **block**: How many bytes for block number?
  - 4 bytes (uint32): Max 4.2 billion blocks
  - 8 bytes (uint64): Effectively unlimited
- **block_hash**: How to encode hash?
  - 32 bytes fixed (assuming SHA-256 hash)
  - Or length-prefixed (2 bytes + variable)?

**Recommendation**: 
- block: 8 bytes (uint64) for safety
- block_hash: 32 bytes fixed (SHA-256)

### Q4. hello_peer Response Payload
**Context**: Current HTTP response includes peer's syncData in `extra` field

**Options**:
- **Option A**: Symmetric (same structure as request: url + pubkey + signature + syncData)
  - Complete peer info in response
  - Larger payload
  
- **Option B**: Minimal (just syncData, no URL/signature repeat)
  - Smaller payload
  - URL/pubkey already known from request headers

**Recommendation**: Option B (just syncData in response payload)

### Q5. Peerlist Array Encoding (0x02 getPeerlist)
**Context**: Returns array of peer objects with identity + connection_string + sync_data

**Structure Options**:
- **Count-based**: 2 bytes count + N peer entries
  - Each entry: identity (length-prefixed) + connection_string (length-prefixed) + syncData
  
- **Length-based**: 4 bytes total payload length + entries
  - Allows streaming/chunking

**Question**: Which approach? Or both (count + total length)?

**Recommendation**: Count-based (2 bytes) for simplicity

### Q6. TCP Connection Strategy
**Context**: Moving from stateless HTTP to persistent TCP connections

**Options**:
- **Persistent**: One long-lived TCP connection per peer
  - Pros: No reconnection overhead, immediate availability
  - Cons: Resource usage for thousands of peers
  
- **Connection Pool**: Open on-demand, close after idle timeout (e.g., 5 minutes)
  - Pros: Resource efficient, scales to thousands
  - Cons: Reconnection overhead on first call after idle

**Question**: Which strategy? Or hybrid (persistent for active peers, pooled for others)?

**Recommendation**: Hybrid - persistent for recently active peers, timeout after 5min idle

### Q7. Retry Mechanism with OmniProtocol
**Context**: Existing longCall() does 3 retries with 250ms sleep

**Questions**:
- Keep existing retry pattern (3 retries, 250ms sleep)?
- Use Message ID from Step 1 header for tracking retry attempts?
- Should retry logic live in Peer class or OmniProtocol layer?

**Recommendation**: 
- Keep 3 retries, 250ms sleep (proven pattern)
- Track via Message ID
- Implement in Peer class (maintains existing API)

### Q8. Ping Mechanism (0x00 opcode)
**Context**: Current system has no explicit ping, relies on RPC success/failure

**Questions**:
- Add explicit ping using 0x00 opcode?
- Payload: Empty or include timestamp for latency measurement?
- Frequency: How often? (30s, 60s, on-demand only?)
- Required or optional feature?

**Recommendation**: 
- Add explicit ping with empty payload (minimal)
- On-demand only (no periodic pinging initially)
- Keeps system simple, can add periodic later if needed

### Q9. Dead Peer Detection
**Context**: Peers moved to offlinePeers registry on failure

**Questions**:
- Threshold: After how many consecutive failed calls mark as offline? (3? 5?)
- Retry strategy: How often retry offline peers? (every 5 min? exponential backoff?)
- Should TCP connection close trigger immediate offline status?

**Recommendation**:
- 3 consecutive failures → offline
- Retry every 5 minutes
- TCP close → immediate offline + move to offlinePeers

## Summary for Next Steps

Once user answers these 9 questions, we can:
1. Create complete binary payload structures for hello_peer and getPeerlist
2. Define TCP connection lifecycle (open, idle timeout, close, retry)
3. Document health check mechanism (ping, dead peer detection)
4. Write Step 3 specification document

**No redesign needed** - just binary encoding of existing proven patterns!
