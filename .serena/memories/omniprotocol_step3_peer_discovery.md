# OmniProtocol Step 3: Peer Discovery & Handshake - Design Decisions

## Session Metadata
**Date**: 2025-10-10
**Phase**: Design Step 3 Complete
**Status**: Documented and approved

## Design Questions & Answers

### Q1. Connection String Encoding
**Decision**: Length-prefixed UTF-8 (2 bytes length + variable string)
**Rationale**: Flexible, supports URLs, hostnames, IPv4, IPv6

### Q2. Signature Type Encoding
**Decision**: Reuse Step 1 algorithm codes (0x01=ed25519, 0x02=falcon, 0x03=ml-dsa)
**Rationale**: Consistency with auth block format

### Q3. Sync Data Binary Encoding
**Decision**: 
- Block number: 8 bytes (uint64)
- Block hash: 32 bytes fixed (SHA-256)
**Rationale**: Future-proof, effectively unlimited blocks

### Q4. hello_peer Response Payload
**Decision**: Minimal (just syncData)
**Current Behavior**: HTTP returns `{ msg: "Peer connected", syncData: peerManager.ourSyncData }`
**Rationale**: Matches current HTTP behavior - responds with own syncData

### Q5. Peerlist Array Encoding
**Decision**: Count-based (2 bytes count + N entries)
**Rationale**: Simpler than length-based, efficient for parsing

### Q6. TCP Connection Strategy
**Decision**: Hybrid - persistent for active, timeout after 10min idle
**Rationale**: Balance between connection reuse and resource efficiency

### Q7. Retry Mechanism
**Decision**: 3 retries, 250ms sleep, track via Message ID, implement in Peer class
**Rationale**: Maintains existing API, proven pattern

### Q8. Ping Mechanism (0x00)
**Decision**: Empty payload, on-demand only (no periodic)
**Rationale**: TCP keepalive + RPC success/failure provides natural health signals

### Q9. Dead Peer Detection
**Decision**: 3 failures → offline, retry every 5min, TCP close → immediate offline
**Rationale**: Tolerates transient issues, reasonable recovery speed

## Binary Message Formats

### hello_peer Request (0x01)
**Payload Structure**:
- URL Length: 2 bytes
- URL String: variable (UTF-8)
- Algorithm: 1 byte (reuse Step 1 codes)
- Signature Length: 2 bytes
- Signature: variable (signs URL)
- Sync Status: 1 byte (0x00/0x01)
- Block Number: 8 bytes (uint64)
- Hash Length: 2 bytes
- Block Hash: variable (typically 32 bytes)
- Timestamp: 8 bytes (unix ms)
- Reserved: 4 bytes

**Size**: ~265 bytes typical (60-70% reduction vs HTTP)

**Header Flags**:
- Bit 0: 1 (auth required - uses Step 1 auth block)
- Bit 1: 1 (response expected)

### hello_peer Response (0x01)
**Payload Structure**:
- Status Code: 2 bytes (200/400/401/409)
- Sync Status: 1 byte
- Block Number: 8 bytes
- Hash Length: 2 bytes
- Block Hash: variable (typically 32 bytes)
- Timestamp: 8 bytes

**Size**: ~65 bytes typical (85-90% reduction vs HTTP)

**Header Flags**:
- Bit 0: 0 (no auth)
- Bit 1: 0 (no further response)

### getPeerlist Request (0x04)
**Payload Structure**:
- Max Peers: 2 bytes (0 = no limit)
- Reserved: 2 bytes

**Size**: 16 bytes total (header + payload)

### getPeerlist Response (0x04)
**Payload Structure**:
- Status Code: 2 bytes
- Peer Count: 2 bytes
- Peer Entries: variable (each entry: identity + URL + syncData)

**Per Entry** (~104 bytes):
- Identity Length: 2 bytes
- Identity: variable (typically 32 bytes for ed25519)
- URL Length: 2 bytes
- URL: variable (typically ~25 bytes)
- Sync Status: 1 byte
- Block Number: 8 bytes
- Hash Length: 2 bytes
- Block Hash: variable (typically 32 bytes)

**Size Examples**:
- 10 peers: ~1 KB (70-80% reduction vs HTTP)
- 100 peers: ~10 KB

### ping Request (0x00)
**Payload**: Empty (0 bytes)
**Size**: 12 bytes (header only)

### ping Response (0x00)
**Payload**:
- Status Code: 2 bytes
- Timestamp: 8 bytes (for latency measurement)

**Size**: 22 bytes total

## TCP Connection Lifecycle

### Strategy: Hybrid
- Persistent connections for recently active peers (< 10 minutes)
- Automatic idle timeout and cleanup (10 minutes)
- Reconnection automatic on next RPC call
- Connection pooling: One TCP connection per peer identity

### Connection States
```
CLOSED → CONNECTING → ACTIVE → IDLE → CLOSING → CLOSED
```

### Parameters
- **Idle Timeout**: 10 minutes
- **TCP Options**: TCP_NODELAY enabled, SO_KEEPALIVE enabled
- **Buffer Sizes**: 256 KB send/receive buffers
- **Connection Limit**: Max 5 per IP

### Scalability
- Active connections: ~50-100 (consensus shard size)
- Memory per active: ~4-8 KB
- Total for 1000 peers: 200-800 KB (manageable)

## Health Check Mechanisms

### Ping Strategy
- On-demand only (no periodic ping)
- Empty payload (minimal overhead)
- Rationale: TCP keepalive + RPC success/failure provides health signals

### Dead Peer Detection
- **Failure Threshold**: 3 consecutive RPC failures
- **Action**: Move to offlinePeers registry, close TCP connection
- **Offline Retry**: Every 5 minutes with hello_peer
- **TCP Close**: Immediate offline status (don't wait for failures)

### Retry Mechanism
- 3 retry attempts per RPC call
- 250ms sleep between retries
- Message ID tracked across retries
- Implemented in Peer class (maintains existing API)

## Security

### Handshake Authentication
- Signature verification required (Flags bit 0 = 1)
- Signs URL to prove control of connection endpoint
- Auth block validates sender identity
- Timestamp prevents replay (±5 min window)
- Rate limit: Max 10 hello_peer per IP per minute

### Connection Security
- TLS/SSL support (optional, configurable)
- IP whitelisting for trusted peers
- Connection limit: Max 5 per IP
- Identity continuity: Public key must match across reconnections

### Attack Prevention
- Reject hello_peer if signature invalid (401)
- Reject if sender identity mismatch (401)
- Reject if peer already connected from different IP (409)
- Reject if peer is self (200 with skip message)

## Performance Characteristics

### Bandwidth Savings
- hello_peer: 60-70% reduction vs HTTP (~600-800 bytes → ~265 bytes)
- getPeerlist (10 peers): 70-80% reduction (~3-5 KB → ~1 KB)
- ping: 96% reduction (~300 bytes → 12 bytes)

### Connection Overhead
- Initial connection: ~4-5 round trips (TCP + hello_peer)
- Reconnection: Same as initial
- Persistent: Zero overhead (immediate RPC)

### Scalability
- Handles thousands of peers efficiently
- Memory: 200-800 KB for 1000 peers
- Automatic resource cleanup via idle timeout

## Implementation Notes

### Peer Class Changes
**New Methods**:
- `ensureConnection()`: Manage connection lifecycle
- `sendOmniMessage()`: Low-level message sending
- `resetIdleTimer()`: Update last activity timestamp
- `closeConnection()`: Graceful/forced close
- `ping()`: Explicit health check
- `measureLatency()`: Latency measurement

### PeerManager Changes
**New Methods**:
- `markPeerOffline()`: Move to offline registry
- `scheduleOfflineRetry()`: Queue retry attempt
- `retryOfflinePeers()`: Batch retry offline peers
- `getConnectionStats()`: Monitoring
- `closeIdleConnections()`: Cleanup task

### Background Tasks
- Idle connection cleanup (10 min timer per connection)
- Offline peer retry (global 5 min timer)
- Connection monitoring (1 min health check)

## Migration Strategy

### Dual-Protocol Support
- Peer class supports both HTTP and TCP
- Connection string determines protocol (http:// vs tcp://)
- Transparent fallback if peer doesn't support OmniProtocol
- Periodic retry to detect upgrades (every 1 hour)

### Protocol Negotiation
- Version negotiation (0xF0) after TCP connect
- Capability exchange (0xF1) for feature detection
- Graceful degradation for unsupported features

## Files Created
1. `OmniProtocol/03_PEER_DISCOVERY.md` - Complete Step 3 specification

## Files Updated
1. `OmniProtocol/SPECIFICATION.md` - Added Peer Discovery section, progress 43%

## Next Steps
**Step 4**: Connection Management & Lifecycle (deeper TCP details)
**Step 5**: Payload Structures (binary format for all 9 opcode categories)
**Step 6**: Module Structure & Interfaces (TypeScript implementation)
**Step 7**: Phased Implementation Plan (testing, migration, rollout)

## Design Completeness
- **Step 1**: Message Format ✅
- **Step 2**: Opcode Mapping ✅
- **Step 3**: Peer Discovery ✅ (current)
- **Step 4**: Connection Management (pending)
- **Step 5**: Payload Structures (pending)
- **Step 6**: Module Structure (pending)
- **Step 7**: Implementation Plan (pending)

**Progress**: 3 of 7 steps (43%)
