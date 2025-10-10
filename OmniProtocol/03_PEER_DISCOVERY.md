# OmniProtocol - Step 3: Peer Discovery & Handshake

## Design Decisions

This step maps the existing `PeerManager.ts`, `Peer.ts`, and `manageHelloPeer.ts` system to OmniProtocol binary format. We replicate proven patterns, not redesign the system.

### Current System Analysis

**Existing Flow:**
1. Load peer bootstrap from `demos_peer.json` (identity → connection_string mapping)
2. `sayHelloToPeer()`: Send hello_peer with URL, publicKey, signature, syncData
3. Peer validates signature (sign URL with private key, verify with public key)
4. Peer responds with success + their syncData
5. Add to PeerManager online/offline registries
6. No explicit ping mechanism (relies on RPC success/failure)
7. Retry: `longCall()` with 3 attempts, 250ms sleep

**Connection Patterns:**
- `call()`: Single RPC, 3 second timeout
- `longCall()`: 3 retries, 250ms sleep between retries
- `multiCall()`: Parallel calls to multiple peers with 2s timeout

## Binary Message Formats

### 1. hello_peer Request (Opcode 0x01)

#### Payload Structure

```
┌────────────────┬──────────────┬────────────────┬──────────────┬───────────────┬──────────────┬──────────────┬──────────┬────────────────┬────────────┬──────────────┐
│  URL Length    │  URL String  │  Algorithm     │  Sig Length  │  Signature    │  Sync Status │  Block Num   │ Hash Len │  Block Hash    │ Timestamp  │   Reserved   │
│   2 bytes      │   variable   │   1 byte       │   2 bytes    │   variable    │   1 byte     │   8 bytes    │ 2 bytes  │   variable     │  8 bytes   │   4 bytes    │
└────────────────┴──────────────┴────────────────┴──────────────┴───────────────┴──────────────┴──────────────┴──────────┴────────────────┴────────────┴──────────────┘
```

#### Field Specifications

**URL Length (2 bytes):**
- Length of connection string in bytes
- Unsigned 16-bit integer (big-endian)
- Range: 0-65,535 bytes
- Rationale: Supports URLs, hostnames, IPv4, IPv6

**URL String (variable):**
- Connection string (UTF-8 encoded)
- Format examples:
  - "http://192.168.1.100:3000"
  - "https://node.demos.network:3000"
  - "http://[2001:db8::1]:3000" (IPv6)
- Length specified by URL Length field
- Rationale: Flexible format, supports any connection type

**Algorithm (1 byte):**
- Reuses auth block algorithm encoding from Step 1
- Values:
  - 0x01: ed25519 (primary)
  - 0x02: falcon (post-quantum)
  - 0x03: ml-dsa (post-quantum)
- Rationale: Consistency with Step 1 auth block

**Signature Length (2 bytes):**
- Length of signature in bytes
- Unsigned 16-bit integer (big-endian)
- Algorithm-specific size:
  - ed25519: 64 bytes
  - falcon: ~666 bytes
  - ml-dsa: ~2420 bytes

**Signature (variable):**
- Raw signature bytes (not hex-encoded)
- Signs the URL string (matches current HTTP behavior)
- Length specified by Signature Length field
- Rationale: Current behavior signs URL for connection verification

**Sync Status (1 byte):**
- Sync status flag
- Values:
  - 0x00: Not synced
  - 0x01: Synced
- Rationale: Simple boolean encoding

**Block Number (8 bytes):**
- Last known block number
- Unsigned 64-bit integer (big-endian)
- Range: 0 to 18,446,744,073,709,551,615
- Rationale: Future-proof, effectively unlimited blocks

**Hash Length (2 bytes):**
- Length of block hash in bytes
- Unsigned 16-bit integer (big-endian)
- Typically 32 bytes (SHA-256)
- Rationale: Future algorithm flexibility

**Block Hash (variable):**
- Last known block hash (raw bytes, not hex)
- Length specified by Hash Length field
- Typically 32 bytes for SHA-256
- Rationale: Flexible for future hash algorithms

**Timestamp (8 bytes):**
- Unix timestamp in milliseconds
- Unsigned 64-bit integer (big-endian)
- Used for connection time tracking
- Rationale: Consistent with auth block timestamp format

**Reserved (4 bytes):**
- Reserved for future extensions
- Set to 0x00 0x00 0x00 0x00
- Allows future field additions without breaking protocol
- Rationale: Future-proof design

#### Message Header Configuration

**Flags:**
- Bit 0: 1 (Authentication required - uses Step 1 auth block)
- Bit 1: 1 (Response expected)
- Other bits: 0

**Auth Block:**
- Present (Flags bit 0 = 1)
- Identity: Sender's public key
- Signature Mode: 0x01 (sign public key, HTTP compatibility)
- Algorithm: Sender's signature algorithm
- Rationale: Replicates current HTTP authentication

#### Size Analysis

**Minimum Size (ed25519, short URL, 32-byte hash):**
- Header: 12 bytes
- Auth block: ~104 bytes (ed25519)
- Payload:
  - URL Length: 2 bytes
  - URL: ~25 bytes ("http://192.168.1.1:3000")
  - Algorithm: 1 byte
  - Signature Length: 2 bytes
  - Signature: 64 bytes (ed25519)
  - Sync Status: 1 byte
  - Block Number: 8 bytes
  - Hash Length: 2 bytes
  - Block Hash: 32 bytes
  - Timestamp: 8 bytes
  - Reserved: 4 bytes
- **Total: ~265 bytes**

**HTTP Comparison:**
- Current HTTP hello_peer: ~600-800 bytes (JSON + headers)
- OmniProtocol: ~265 bytes
- **Bandwidth savings: ~60-70%**

### 2. hello_peer Response (Opcode 0x01)

#### Payload Structure

```
┌──────────────┬──────────────┬──────────────┬──────────┬────────────────┬────────────┐
│ Status Code  │  Sync Status │  Block Num   │ Hash Len │  Block Hash    │ Timestamp  │
│   2 bytes    │   1 byte     │   8 bytes    │ 2 bytes  │   variable     │  8 bytes   │
└──────────────┴──────────────┴──────────────┴──────────┴────────────────┴────────────┘
```

#### Field Specifications

**Status Code (2 bytes):**
- Response status (HTTP-like)
- Values:
  - 200: Peer connected successfully
  - 400: Invalid request (validation failure)
  - 401: Invalid authentication (signature verification failed)
  - 409: Peer already connected or is self
- Unsigned 16-bit integer (big-endian)

**Sync Status (1 byte):**
- Responding peer's sync status
- 0x00: Not synced, 0x01: Synced

**Block Number (8 bytes):**
- Responding peer's last known block
- Unsigned 64-bit integer (big-endian)

**Hash Length (2 bytes):**
- Length of responding peer's block hash
- Unsigned 16-bit integer (big-endian)

**Block Hash (variable):**
- Responding peer's last known block hash
- Raw bytes (not hex)
- Typically 32 bytes

**Timestamp (8 bytes):**
- Responding peer's current timestamp (milliseconds)
- Unsigned 64-bit integer (big-endian)
- Used for time synchronization hints

#### Message Header Configuration

**Flags:**
- Bit 0: 0 (No auth required for response)
- Bit 1: 0 (No further response expected)
- Other bits: 0

**Message ID:**
- Echo Message ID from request (correlation)

#### Size Analysis

**Typical Size (32-byte hash):**
- Header: 12 bytes
- Payload: 2 + 1 + 8 + 2 + 32 + 8 = 53 bytes
- **Total: 65 bytes**

**HTTP Comparison:**
- Current HTTP response: ~400-600 bytes
- OmniProtocol: ~65 bytes
- **Bandwidth savings: ~85-90%**

### 3. getPeerlist Request (Opcode 0x04)

#### Payload Structure

```
┌──────────────┬──────────────┐
│  Max Peers   │   Reserved   │
│   2 bytes    │   2 bytes    │
└──────────────┴──────────────┘
```

#### Field Specifications

**Max Peers (2 bytes):**
- Maximum number of peers to return
- Unsigned 16-bit integer (big-endian)
- 0 = return all peers (no limit)
- Range: 0-65,535
- Rationale: Allows client to control response size

**Reserved (2 bytes):**
- Reserved for future use (filters, sorting, etc.)
- Set to 0x00 0x00

#### Message Header Configuration

**Flags:**
- Bit 0: 0 (No auth required for peerlist query)
- Bit 1: 1 (Response expected)

#### Size Analysis

**Total Size:**
- Header: 12 bytes
- Payload: 4 bytes
- **Total: 16 bytes** (minimal)

### 4. getPeerlist Response (Opcode 0x04)

#### Payload Structure

```
┌──────────────┬──────────────┬────────────────────────────────────────┐
│ Status Code  │  Peer Count  │         Peer Entries (variable)        │
│   2 bytes    │   2 bytes    │         [Peer Entry] x N               │
└──────────────┴──────────────┴────────────────────────────────────────┘

Each Peer Entry:
┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────┬────────────────┬────────────┐
│  ID Length   │  Identity    │  URL Length  │  URL String  │  Sync Status │ Block Num│  Hash Length   │ Block Hash │
│   2 bytes    │   variable   │   2 bytes    │   variable   │   1 byte     │ 8 bytes  │   2 bytes      │  variable  │
└──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────┴────────────────┴────────────┘
```

#### Field Specifications

**Status Code (2 bytes):**
- 200: Success
- 404: No peers available

**Peer Count (2 bytes):**
- Number of peer entries following
- Unsigned 16-bit integer (big-endian)
- Allows receiver to allocate memory efficiently

**Peer Entry (variable, repeated N times):**

- **Identity Length (2 bytes)**: Length of peer's public key
- **Identity (variable)**: Peer's public key (raw bytes)
- **URL Length (2 bytes)**: Length of connection string
- **URL String (variable)**: Peer's connection string (UTF-8)
- **Sync Status (1 byte)**: 0x00 or 0x01
- **Block Number (8 bytes)**: Peer's last known block
- **Hash Length (2 bytes)**: Length of block hash
- **Block Hash (variable)**: Peer's last known block hash

#### Message Header Configuration

**Flags:**
- Bit 0: 0 (No auth required)
- Bit 1: 0 (No further response expected)

**Message ID:**
- Echo Message ID from request

#### Size Analysis

**Per Peer Entry (ed25519, typical URL, 32-byte hash):**
- Identity Length: 2 bytes
- Identity: 32 bytes (ed25519)
- URL Length: 2 bytes
- URL: ~25 bytes
- Sync Status: 1 byte
- Block Number: 8 bytes
- Hash Length: 2 bytes
- Block Hash: 32 bytes
- **Per entry: ~104 bytes**

**Response Size Examples:**
- Header: 12 bytes
- Status: 2 bytes
- Count: 2 bytes
- 10 peers: 10 × 104 = 1,040 bytes
- 100 peers: 100 × 104 = 10,400 bytes (~10 KB)
- **Total for 10 peers: ~1,056 bytes**

**HTTP Comparison:**
- Current HTTP (10 peers): ~3-5 KB (JSON)
- OmniProtocol (10 peers): ~1 KB
- **Bandwidth savings: ~70-80%**

### 5. ping Request (Opcode 0x00)

#### Payload Structure

```
┌──────────────┐
│   Empty      │
│   (0 bytes)  │
└──────────────┘
```

**Rationale:**
- Minimal ping for connectivity check
- No payload needed for simple health check
- Can measure latency via timestamp analysis at protocol level

#### Message Header Configuration

**Flags:**
- Bit 0: 0 (No auth required for basic ping)
- Bit 1: 1 (Response expected)

**Note:** If auth is needed, caller can set Flags bit 0 = 1 and include auth block.

#### Size Analysis

**Total Size:**
- Header: 12 bytes
- Payload: 0 bytes
- **Total: 12 bytes** (absolute minimum)

### 6. ping Response (Opcode 0x00)

#### Payload Structure

```
┌──────────────┬────────────┐
│ Status Code  │ Timestamp  │
│   2 bytes    │  8 bytes   │
└──────────────┴────────────┘
```

#### Field Specifications

**Status Code (2 bytes):**
- 200: Pong (alive)
- Other codes indicate issues

**Timestamp (8 bytes):**
- Responder's current timestamp (milliseconds)
- Allows latency calculation and time sync hints

#### Size Analysis

**Total Size:**
- Header: 12 bytes
- Payload: 10 bytes
- **Total: 22 bytes**

## TCP Connection Lifecycle

### Connection Strategy: Hybrid

**Decision:** Use hybrid connection management with intelligent timeout

**Rationale:**
- Persistent connections for recently active peers (low latency)
- Automatic cleanup for idle peers (resource efficiency)
- Scales to thousands of peers without resource exhaustion

### Connection States

```
┌──────────────┐
│   CLOSED     │  (No connection exists)
└──────┬───────┘
       │ sayHelloToPeer() / inbound hello_peer
       ↓
┌──────────────┐
│  CONNECTING  │  (TCP handshake in progress)
└──────┬───────┘
       │ TCP established + hello_peer success
       ↓
┌──────────────┐
│   ACTIVE     │  (Connection ready, last activity < 10min)
└──────┬───────┘
       │ No activity for 10 minutes
       ↓
┌──────────────┐
│   IDLE       │  (Connection open but unused)
└──────┬───────┘
       │ Idle timeout (10 minutes)
       ↓
┌──────────────┐
│   CLOSING    │  (Graceful shutdown in progress)
└──────┬───────┘
       │ Close complete
       ↓
┌──────────────┐
│   CLOSED     │
└──────────────┘
```

### Connection Parameters

**Idle Timeout:** 10 minutes
- Peer connection kept open if any activity within last 10 minutes
- After 10 minutes of no RPC calls → graceful close
- Rationale: Balance between connection reuse and resource efficiency

**Reconnection Strategy:**
- Automatic reconnection on next RPC call
- hello_peer handshake performed on reconnection
- No penalty for reconnection (transparent to caller)

**Connection Pooling:**
- One TCP connection per peer identity
- Connection reused across all RPC calls to that peer
- Thread-safe connection access with mutex/lock

**TCP Socket Options:**
- `TCP_NODELAY`: Enabled (disable Nagle's algorithm for low latency)
- `SO_KEEPALIVE`: Enabled (detect dead connections)
- `SO_RCVBUF`: 256 KB (receive buffer)
- `SO_SNDBUF`: 256 KB (send buffer)
- Rationale: Optimize for low-latency, high-throughput peer communication

### Connection Establishment Flow

```
1. Peer.call() invoked
   ↓
2. Check connection state
   ├─ ACTIVE → Use existing connection
   ├─ IDLE → Use existing connection + reset idle timer
   └─ CLOSED → Proceed to step 3
   ↓
3. Open TCP connection to peer URL
   ↓
4. Send hello_peer (0x01) with our sync data
   ↓
5. Await hello_peer response
   ├─ Success (200) → Store peer's syncData, mark ACTIVE
   └─ Failure → Mark peer OFFLINE, throw error
   ↓
6. Execute original RPC call
   ↓
7. Update last_activity timestamp
```

### Connection Closure Flow

**Graceful Closure (Idle Timeout):**
```
1. Idle timer expires (10 minutes)
   ↓
2. Send proto_disconnect (0xF4) to peer
   ↓
3. Close TCP socket
   ↓
4. Mark connection CLOSED
   ↓
5. Keep peer in online registry (can reconnect anytime)
```

**Forced Closure (Error):**
```
1. TCP error detected (connection reset, timeout)
   ↓
2. Close TCP socket immediately
   ↓
3. Mark connection CLOSED
   ↓
4. Trigger dead peer detection logic (see below)
```

## Health Check Mechanisms

### Ping Strategy: On-Demand

**Decision:** No periodic ping, on-demand only

**Rationale:**
- TCP keepalive detects dead connections at OS level
- RPC success/failure naturally provides health signals
- Reduces unnecessary network traffic
- Can add periodic ping later if needed

**On-Demand Ping Usage:**
```typescript
// Explicit health check when needed
const isAlive = await peer.ping()

// Latency measurement
const latency = await peer.measureLatency()
```

### Dead Peer Detection

**Failure Threshold:** 3 consecutive failures

**Detection Logic:**
```
1. RPC call fails (timeout, connection error, auth failure)
   ↓
2. Increment peer's consecutive_failure_count
   ↓
3. If consecutive_failure_count >= 3:
   ├─ Move peer to offlinePeers registry
   ├─ Close TCP connection
   ├─ Schedule retry (5 minutes)
   └─ Log warning
   ↓
4. If RPC succeeds:
   └─ Reset consecutive_failure_count to 0
```

**Offline Peer Retry:**
- Retry interval: 5 minutes (fixed, no exponential backoff initially)
- Retry attempt: Send hello_peer (0x01) to check if peer is back
- Success: Move back to online registry, reset failure count
- Failure: Increment offline_retry_count, continue 5-minute interval

**TCP Connection Close Handling:**
```
1. TCP connection unexpectedly closed by remote
   ↓
2. Immediate offline status (don't wait for 3 failures)
   ↓
3. Move to offlinePeers registry
   ↓
4. Schedule retry (5 minutes)
```

**Rationale:**
- 3 failures: Tolerates transient network issues
- 5-minute retry: Reasonable balance between recovery speed and network overhead
- Immediate offline on TCP close: Fast detection of genuine disconnections

### Retry Mechanism

**Integration with Existing `longCall()`:**

**Current Behavior:**
- 3 retry attempts
- 250ms sleep between retries
- Configurable allowed error codes (don't retry for these)

**OmniProtocol Enhancement:**
- Message ID tracked across retries (reuse same ID)
- Retry count included in protocol-level logging
- Failure threshold contributes to dead peer detection

**Retry Flow:**
```
1. Attempt RPC call (attempt 1)
   ├─ Success → Return result, reset failure count
   └─ Failure → Proceed to retry
   ↓
2. Sleep 250ms
   ↓
3. Attempt RPC call (attempt 2)
   ├─ Success → Return result, reset failure count
   └─ Failure → Proceed to retry
   ↓
4. Sleep 250ms
   ↓
5. Attempt RPC call (attempt 3)
   ├─ Success → Return result, reset failure count
   └─ Failure → Increment consecutive_failure_count, check threshold
```

**Location:** Implemented in Peer class (maintains existing API contract)

## Peer State Management

### PeerManager Integration

**Registries (unchanged from current system):**
- `peerList` (online peers): Active, connected peers
- `offlinePeers`: Peers that failed health checks

**Peer Metadata (additions for OmniProtocol):**
```typescript
interface PeerMetadata {
    // Existing fields
    identity: string
    connection: { string: string }
    verification: { status: boolean }
    status: { ready: boolean, online: boolean, timestamp: number }
    sync: SyncData

    // New OmniProtocol fields
    tcp_connection: {
        socket: TCPSocket | null
        state: 'CLOSED' | 'CONNECTING' | 'ACTIVE' | 'IDLE' | 'CLOSING'
        last_activity: number  // Unix timestamp (ms)
        idle_timer: Timer | null
    }
    health: {
        consecutive_failures: number
        last_failure_time: number
        offline_retry_count: number
        next_retry_time: number
    }
}
```

### Peer Synchronization

**SyncData Exchange:**
- Exchanged during hello_peer handshake
- Updated on each successful hello_peer (reconnection)
- Used by consensus to determine block sync status

**Peerlist Sync (0x22):**
- Periodic synchronization of full peer registry
- Uses getPeerlist response format
- Allows nodes to discover new peers dynamically

## Security Considerations

### Handshake Security

**hello_peer Authentication:**
- Signature verification required (Flags bit 0 = 1)
- Signs URL to prove peer controls connection endpoint
- Auth block validates sender identity
- Timestamp in auth block prevents replay attacks (±5 min window)

**Attack Prevention:**
- Reject hello_peer if signature invalid (401 response)
- Reject if sender identity doesn't match auth block identity
- Reject if peer is already connected from different IP (409 response)
- Rate limit hello_peer to prevent DoS (max 10 per IP per minute)

### Connection Security

**TCP-Level Security:**
- TLS/SSL support (optional, configurable)
- IP whitelisting for trusted peers
- Connection limit per IP (max 5 connections)

**Protocol-Level Security:**
- Auth block on sensitive operations (see Step 2 opcode mapping)
- Message ID tracking prevents replay within session
- Timestamp validation prevents replay across sessions

### Peer Verification

**Identity Continuity:**
- Peer identity (public key) must match across reconnections
- URL can change (dynamic IP), but identity must remain consistent
- Reject connection if identity changes for same URL without proper re-registration

**Sybil Attack Mitigation:**
- Peer identities derived from blockchain (eventual GCR integration)
- Bootstrap peer list from trusted source
- Reputation system (future enhancement)

## Performance Characteristics

### Connection Overhead

**Initial Connection:**
- TCP handshake: ~1-3 round trips (SYN, SYN-ACK, ACK)
- hello_peer exchange: 1 round trip (~265 bytes request + ~65 bytes response)
- **Total: ~4-5 round trips, ~330 bytes**

**Reconnection (after idle timeout):**
- TCP handshake: ~1-3 round trips
- hello_peer exchange: 1 round trip
- **Same as initial connection**

**Persistent Connection (no idle timeout):**
- Zero overhead (connection already established)
- Immediate RPC execution

### Scalability Analysis

**Thousand Peer Scenario:**
- Active peers (used in last 10 min): ~50-100 (typical consensus shard size)
- Idle connections: 900-950 (closed after timeout)
- Memory per active connection: ~4-8 KB (TCP buffers + metadata)
- **Total memory: 200-800 KB for active connections** (very manageable)

**Hybrid Strategy Benefits:**
- Low-latency for active consensus participants
- Resource-efficient for large peer registry
- Automatic cleanup prevents connection exhaustion

### Network Traffic

**Periodic Traffic (per peer):**
- No periodic ping (zero overhead)
- hello_peer on reconnection: ~330 bytes every 10+ minutes
- Consensus messages: ~1-10 KB per consensus round (~10s)

**Bandwidth Savings vs HTTP:**
- hello_peer: 60-70% reduction
- getPeerlist (10 peers): 70-80% reduction
- Average RPC message: 60-90% reduction

## Implementation Notes

### Peer Class Changes

**New Methods:**
```typescript
class Peer {
    // Existing
    call(method: string, params: any): Promise<any>
    longCall(method: string, params: any, allowedErrors: number[]): Promise<any>

    // New for OmniProtocol
    private async ensureConnection(): Promise<void>
    private async sendOmniMessage(opcode: number, payload: Buffer): Promise<Buffer>
    private resetIdleTimer(): void
    private closeConnection(graceful: boolean): Promise<void>
    async ping(): Promise<boolean>
    async measureLatency(): Promise<number>
}
```

### PeerManager Changes

**New Methods:**
```typescript
class PeerManager {
    // Existing
    addPeer(peer: Peer): boolean
    removePeer(identity: string): void
    getPeer(identity: string): Peer | undefined

    // New for OmniProtocol
    markPeerOffline(identity: string, reason: string): void
    scheduleOfflineRetry(identity: string): void
    async retryOfflinePeers(): Promise<void>
    getConnectionStats(): ConnectionStats
    closeIdleConnections(): void
}
```

### Background Tasks

**Idle Connection Cleanup:**
- Timer per peer connection (10 minute timeout)
- On expiry: graceful close, send proto_disconnect (0xF4)

**Offline Peer Retry:**
- Global timer (every 5 minutes)
- Attempts hello_peer to all offline peers
- Moves successful peers back to online registry

**Connection Monitoring:**
- Periodic check of connection states (every 1 minute)
- Detects stale connections (TCP keepalive failed)
- Cleans up zombie connections

## Migration from HTTP

### Dual-Protocol Support

**During Migration Period:**
- Peer class supports both HTTP and TCP backends
- Connection string determines protocol:
  - `http://` or `https://` → HTTP
  - `tcp://` or `omni://` → OmniProtocol
- Transparent to caller (same Peer.call() API)

**Fallback Strategy:**
```
1. Attempt OmniProtocol connection
   ↓
2. If peer doesn't support (connection refused):
   ├─ Fallback to HTTP
   └─ Cache protocol preference for peer
   ↓
3. Retry OmniProtocol periodically (every 1 hour) to detect upgrades
```

### Protocol Negotiation

**Version Negotiation (0xF0):**
- First message after TCP connect
- Exchange supported protocol versions
- Downgrade to lowest common version if needed

**Capability Exchange (0xF1):**
- Exchange supported opcodes/features
- Allows gradual feature rollout
- Graceful degradation for unsupported features

## Next Steps

1. **Step 4: Connection Management & Lifecycle** - Deeper TCP connection pooling details
2. **Step 5: Payload Structures** - Binary payload format for all 9 opcode categories
3. **Step 6: Module Structure & Interfaces** - TypeScript implementation architecture
4. **Step 7: Phased Implementation Plan** - Testing, migration, rollout strategy

## Summary

Step 3 defines peer discovery and handshake in OmniProtocol:

**Key Decisions:**
- hello_peer: 265 bytes (60-70% reduction vs HTTP)
- getPeerlist: ~1 KB for 10 peers (70-80% reduction)
- Hybrid TCP connections: 10-minute idle timeout
- On-demand ping (no periodic overhead)
- 3-failure threshold for offline detection
- 5-minute offline retry interval
- Replicates proven patterns from existing system

**Bandwidth Efficiency:**
- Minimum overhead: 12 bytes (header only)
- Typical overhead: 65-330 bytes (vs 400-800 bytes HTTP)
- 60-90% bandwidth savings for peer operations
