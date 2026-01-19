# OmniProtocol Wave 8: TCP Physical Layer Implementation

## Overview

**Status**: 📋 PLANNED  
**Dependencies**: Wave 7.1-7.5 (Logical Layer complete)  
**Goal**: Implement true TCP binary protocol transport replacing HTTP

## Current State Analysis

### What We Have (Wave 7.1-7.4 Complete)
✅ **40 Binary Handlers Implemented**:
- Control & Infrastructure: 5 opcodes (0x03-0x07)
- Data Sync: 8 opcodes (0x20-0x28)
- Protocol Meta: 5 opcodes (0xF0-0xF4)
- Consensus: 7 opcodes (0x31, 0x34-0x39)
- GCR: 10 opcodes (0x41-0x4A, excluding redundant 0x4B)
- Transactions: 5 opcodes (0x10-0x12, 0x15-0x16)

✅ **Architecture Components**:
- Complete opcode registry with typed handlers
- JSON envelope serialization (intermediate format)
- Binary message header structures defined
- Handler wrapper pattern established
- Feature flags and migration modes configured

❌ **What We're Missing**:
- TCP socket transport layer
- Connection pooling and lifecycle management
- Full binary payload encoding (still using JSON envelopes)
- Message framing and parsing from TCP stream
- Connection state machine implementation

### What We're Currently Using
```
Handler → JSON Envelope → HTTP Transport
         (Wave 7.x)       (peerAdapter.ts:78-81)
```

### What Wave 8 Will Build
```
Handler → Binary Encoding → TCP Transport
         (new encoders)    (new ConnectionPool)
```

## Wave 8 Implementation Plan

### Wave 8.1: TCP Connection Infrastructure (Foundation)
**Duration**: 3-5 days  
**Priority**: CRITICAL - Core transport layer

#### Deliverables
1. **ConnectionPool Class** (`src/libs/omniprotocol/transport/ConnectionPool.ts`)
   - Per-peer connection management
   - Connection state machine (UNINITIALIZED → CONNECTING → AUTHENTICATING → READY → IDLE → CLOSED)
   - Idle timeout handling (10 minutes)
   - Connection limits (1000 total, 1 per peer initially)
   - LRU eviction when at capacity

2. **PeerConnection Class** (`src/libs/omniprotocol/transport/PeerConnection.ts`)
   - TCP socket wrapper with Node.js `net` module
   - Connection lifecycle (connect, authenticate, ready, close)
   - Message ID generation and tracking
   - Request-response correlation (Map<messageId, Promise>)
   - Idle timer management
   - Graceful shutdown with proto_disconnect (0xF4)

3. **Message Framing** (`src/libs/omniprotocol/transport/MessageFramer.ts`)
   - TCP stream → complete messages parsing
   - Buffer accumulation and boundary detection
   - Header parsing (12-byte: version, opcode, sequence, payloadLength)
   - Checksum validation
   - Partial message buffering

#### Key Technical Decisions
- **One Connection Per Peer**: Sufficient for current traffic patterns, can scale later
- **TCP_NODELAY**: Disabled (Nagle's algorithm) for low latency
- **SO_KEEPALIVE**: Enabled with 60s interval
- **Connect Timeout**: 5 seconds
- **Auth Timeout**: 5 seconds
- **Idle Timeout**: 10 minutes

#### Integration Points
```typescript
// peerAdapter.ts will use ConnectionPool instead of HTTP
async adaptCall(peer: Peer, request: RPCRequest): Promise<RPCResponse> {
    if (!this.shouldUseOmni(peer.identity)) {
        return peer.call(request, isAuthenticated)  // HTTP fallback
    }

    // NEW: Use TCP connection pool
    const conn = await ConnectionPool.getConnection(peer.identity, { timeout: 3000 })
    const { opcode, payload } = convertToOmniMessage(request)
    const response = await conn.sendMessage(opcode, payload, 3000)
    return convertFromOmniMessage(response)
}
```

#### Tests
- Connection establishment and authentication flow
- Message send/receive round-trip
- Timeout handling (connect, auth, request)
- Idle timeout and graceful close
- Reconnection after disconnect
- Concurrent request handling
- Connection pool limits and LRU eviction

### Wave 8.2: Binary Payload Encoding (Performance)
**Duration**: 4-6 days  
**Priority**: HIGH - Bandwidth savings

#### Current JSON Envelope Format
```typescript
// From jsonEnvelope.ts
export function encodeJsonRequest(payload: unknown): Buffer {
    const json = Buffer.from(JSON.stringify(payload), "utf8")
    const length = PrimitiveEncoder.encodeUInt32(json.length)
    return Buffer.concat([length, json])
}
```

#### Target Binary Format (from 05_PAYLOAD_STRUCTURES.md)
```typescript
// Example: Transaction structure
interface BinaryTransaction {
    hash: Buffer        // 32 bytes fixed
    type: number        // 1 byte
    from: Buffer        // 32 bytes (address)
    to: Buffer          // 32 bytes (address)
    amount: bigint      // 8 bytes (uint64)
    nonce: bigint       // 8 bytes
    timestamp: bigint   // 8 bytes
    fees: bigint        // 8 bytes
    signature: Buffer   // length-prefixed
    data: Buffer[]      // count-prefixed array
    gcrEdits: Buffer[]  // count-prefixed array
    raw: Buffer         // length-prefixed
}
```

#### Deliverables
1. **Binary Encoders** (`src/libs/omniprotocol/serialization/`)
   - Update existing `transaction.ts` to use full binary encoding
   - Update `gcr.ts` beyond just addressInfo
   - Update `consensus.ts` for remaining consensus types
   - Update `sync.ts` for block/mempool/peerlist structures
   - Keep `primitives.ts` as foundation (already exists)

2. **Encoder Registry Pattern**
   ```typescript
   // Map opcode → binary encoder/decoder
   interface PayloadCodec<T> {
       encode(data: T): Buffer
       decode(buffer: Buffer): T
   }
   
   const PAYLOAD_CODECS = new Map<OmniOpcode, PayloadCodec<any>>()
   ```

3. **Gradual Migration Strategy**
   - Phase 1: Keep JSON envelope for complex structures (GCR edits, bridge trades)
   - Phase 2: Binary encode simple structures (addresses, hashes, numbers)
   - Phase 3: Full binary encoding for all payloads
   - Always maintain decoder parity with encoder

#### Bandwidth Savings Analysis
```
Current (JSON envelope):
  Simple request (getPeerInfo): ~120 bytes
  Transaction: ~800 bytes
  Block sync: ~15KB

Target (Binary):
  Simple request: ~50 bytes (60% savings)
  Transaction: ~250 bytes (69% savings)
  Block sync: ~5KB (67% savings)
```

#### Tests
- Round-trip encoding/decoding for all opcodes
- Edge cases (empty arrays, max values, unicode strings)
- Backward compatibility (can still decode JSON envelopes)
- Size comparison tests vs JSON
- Malformed data handling

### Wave 8.3: Timeout & Retry Enhancement (Reliability)
**Duration**: 2-3 days  
**Priority**: MEDIUM - Better than HTTP's fixed delays

#### Current HTTP Behavior (from Peer.ts)
```typescript
// Fixed retry logic
async longCall(request, isAuthenticated, sleepTime = 250, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await this.call(request, isAuthenticated)
        } catch (err) {
            if (i < retries - 1) await sleep(sleepTime)
        }
    }
}
```

#### Enhanced Retry Strategy (from 04_CONNECTION_MANAGEMENT.md)
```typescript
interface RetryOptions {
    maxRetries: number        // Default: 3
    initialDelay: number      // Default: 250ms
    backoffMultiplier: number // Default: 1.0 (linear), 2.0 (exponential)
    maxDelay: number          // Default: 1000ms
    allowedErrors: number[]   // Don't retry for these status codes
    retryOnTimeout: boolean   // Default: true
}
```

#### Deliverables
1. **RetryManager** (`src/libs/omniprotocol/transport/RetryManager.ts`)
   - Exponential backoff support
   - Per-operation timeout configuration
   - Error classification (transient, degraded, fatal)

2. **CircuitBreaker** (`src/libs/omniprotocol/transport/CircuitBreaker.ts`)
   - 5 failures → OPEN state
   - 30 second timeout → HALF_OPEN
   - 2 successes → CLOSED
   - Prevents cascading failures when peer is consistently offline

3. **TimeoutManager** (`src/libs/omniprotocol/transport/TimeoutManager.ts`)
   - Adaptive timeouts based on peer latency history
   - Per-operation type timeouts (consensus 1s, sync 30s, etc.)

#### Integration
```typescript
// Enhanced PeerConnection.sendMessage with circuit breaker
async sendMessage(opcode, payload, timeout) {
    return await this.circuitBreaker.execute(async () => {
        return await RetryManager.withRetry(
            () => this.sendMessageInternal(opcode, payload, timeout),
            { maxRetries: 3, backoffMultiplier: 1.5 }
        )
    })
}
```

#### Tests
- Exponential backoff timing verification
- Circuit breaker state transitions
- Adaptive timeout calculation from latency history
- Allowed error code handling
- Timeout vs retry interaction

### Wave 8.4: Concurrency & Resource Management (Scalability)
**Duration**: 3-4 days  
**Priority**: MEDIUM - Handles 1000+ peers

#### Deliverables
1. **Request Slot Management** (PeerConnection enhancement)
   - Max 100 concurrent requests per connection
   - Backpressure queue when at limit
   - Slot acquisition/release pattern

2. **AsyncMutex** (`src/libs/omniprotocol/transport/AsyncMutex.ts`)
   - Thread-safe send operations (one message at a time per connection)
   - Lock queue for waiting operations

3. **BufferPool** (`src/libs/omniprotocol/transport/BufferPool.ts`)
   - Reusable buffers for common message sizes (256, 1K, 4K, 16K, 64K)
   - Max 100 buffers per size to prevent memory bloat
   - Security: Zero-fill buffers on release

4. **Connection Metrics** (`src/libs/omniprotocol/transport/MetricsCollector.ts`)
   - Per-peer latency tracking (p50, p95, p99)
   - Error counts (connection, timeout, auth)
   - Resource usage (memory, in-flight requests)
   - Connection pool statistics

#### Memory Targets
```
1,000 peers:
  - Active connections: 50-100 (5-10% typical)
  - Memory per connection: 4-8 KB
  - Total overhead: ~400-800 KB

10,000 peers:
  - Active connections: 500-1000
  - Connection limit: 2000 (configurable)
  - LRU eviction for excess
  - Total overhead: ~4-8 MB
```

#### Tests
- Concurrent request limiting (100 per connection)
- Buffer pool acquire/release cycles
- Metrics collection and calculation
- Memory leak detection (long-running test)
- Connection pool scaling (simulate 1000 peers)

### Wave 8.5: Integration & Migration (Production Readiness)
**Duration**: 3-5 days  
**Priority**: CRITICAL - Safe rollout

#### Deliverables
1. **PeerAdapter Enhancement** (`src/libs/omniprotocol/integration/peerAdapter.ts`)
   - Remove HTTP fallback placeholder (lines 78-81)
   - Implement full TCP transport path
   - Maintain dual-protocol support (HTTP + TCP based on connection string)

2. **Peer.ts Integration**
   ```typescript
   async call(request: RPCRequest, isAuthenticated = true): Promise<RPCResponse> {
       // Detect protocol from connection string
       if (this.connection.string.startsWith('tcp://')) {
           return await this.callOmniProtocol(request, isAuthenticated)
       } else if (this.connection.string.startsWith('http://')) {
           return await this.callHTTP(request, isAuthenticated)
       }
   }
   ```

3. **Connection String Format**
   - HTTP: `http://ip:port` or `https://ip:port`
   - TCP: `tcp://ip:port` or `tcps://ip:port` (TLS)
   - Auto-detection based on peer capabilities

4. **Migration Modes** (already defined in config)
   - `HTTP_ONLY`: All peers use HTTP (Wave 7.x default)
   - `OMNI_PREFERRED`: Use TCP for peers in `omniPeers` set, HTTP fallback
   - `OMNI_ONLY`: TCP only, fail if TCP unavailable (production target)

5. **Error Handling & Fallback**
   ```typescript
   // Dual protocol with automatic fallback
   async call(request) {
       if (this.supportsOmni() && config.mode !== 'HTTP_ONLY') {
           try {
               return await this.callOmniProtocol(request)
           } catch (error) {
               if (config.mode === 'OMNI_PREFERRED') {
                   log.warning('TCP failed, falling back to HTTP', error)
                   return await this.callHTTP(request)
               }
               throw error  // OMNI_ONLY mode
           }
       }
       return await this.callHTTP(request)
   }
   ```

#### Tests
- End-to-end flow: handler → binary encoding → TCP → response
- HTTP fallback when TCP unavailable
- Migration mode switching (HTTP_ONLY → OMNI_PREFERRED → OMNI_ONLY)
- Connection string detection and routing
- Parity testing: HTTP response === TCP response for all opcodes
- Performance benchmarking: TCP vs HTTP latency comparison

### Wave 8.6: Monitoring & Debugging (Observability)
**Duration**: 2-3 days  
**Priority**: LOW - Can be deferred

#### Deliverables
1. **Logging Infrastructure**
   - Connection lifecycle events (connect, auth, ready, close)
   - Message send/receive with opcodes and sizes
   - Error details with classification
   - Circuit breaker state changes

2. **Debug Mode**
   - Packet-level inspection (hex dumps)
   - Message flow tracing (message ID tracking)
   - Connection state visualization

3. **Metrics Dashboard** (future enhancement)
   - Real-time connection count
   - Latency histograms
   - Error rate trends
   - Bandwidth savings vs HTTP

4. **Health Check Endpoint**
   - OmniProtocol status (enabled/disabled)
   - Active connections count
   - Circuit breaker states
   - Recent errors summary

## Pending Handlers (Can Implement in Parallel)

While Wave 8 is being built, we can continue implementing remaining handlers using JSON envelope pattern:

### Medium Priority
- `0x13 bridge_getTrade` (likely redundant with 0x12)
- `0x14 bridge_executeTrade` (likely redundant with 0x12)
- `0x50-0x5F` Browser/client operations (16 opcodes)
- `0x60-0x62` Admin operations (3 opcodes)

### Low Priority
- `0x30 consensus_generic` (wrapper opcode)
- `0x40 gcr_generic` (wrapper opcode)
- `0x32 voteBlockHash` (deprecated in PoRBFTv2)

## Wave 8 Success Criteria

### Technical Validation
✅ All existing HTTP tests pass with TCP transport  
✅ Binary encoding round-trip tests for all 40 opcodes  
✅ Connection pool handles 1000 simulated peers  
✅ Circuit breaker prevents cascading failures  
✅ Graceful fallback from TCP to HTTP works  
✅ Memory usage within targets (<1MB for 1000 peers)  

### Performance Targets
✅ Cold connection: <120ms (TCP handshake + auth)  
✅ Warm connection: <30ms (message send + response)  
✅ Bandwidth savings: >60% vs HTTP for typical payloads  
✅ Throughput: >10,000 req/s with connection reuse  
✅ Latency p95: <50ms for warm connections  

### Production Readiness
✅ Feature flag controls (HTTP_ONLY, OMNI_PREFERRED, OMNI_ONLY)  
✅ Dual protocol support (HTTP + TCP)  
✅ Error handling and logging comprehensive  
✅ No breaking changes to existing Peer class API  
✅ Safe rollout strategy documented  

## Timeline Estimate

**Optimistic**: 14-18 days  
**Realistic**: 21-28 days  
**Conservative**: 35-42 days (with buffer for issues)

### Parallel Work Opportunities
- Wave 8.1 (TCP infra) can be built while finishing Wave 7.5 (testing)
- Wave 8.2 (binary encoding) can start before 8.1 completes
- Remaining handlers (browser/admin ops) can be implemented anytime
- Wave 8.6 (monitoring) can be deferred or done in parallel

## Risk Analysis

### High Risk
🔴 **TCP Connection Management Complexity**
- Mitigation: Start with single connection per peer, scale later
- Fallback: Keep HTTP as safety net during migration

🔴 **Binary Encoding Bugs**
- Mitigation: Extensive round-trip testing, fixture validation
- Fallback: JSON envelope mode for complex structures

### Medium Risk
🟡 **Performance Doesn't Meet Targets**
- Mitigation: Profiling and optimization sprints
- Fallback: Hybrid mode (TCP for hot paths, HTTP for bulk)

🟡 **Memory Leaks in Connection Pool**
- Mitigation: Long-running stress tests, memory profiling
- Fallback: Aggressive idle timeout, connection limits

### Low Risk
🟢 **Protocol Versioning**
- Already designed in message header
- Backward compatibility maintained

## Next Immediate Steps

1. **Review this plan** with the team/stakeholders
2. **Start Wave 8.1** (TCP Connection Infrastructure)
   - Create `src/libs/omniprotocol/transport/` directory
   - Implement ConnectionPool and PeerConnection classes
   - Write connection lifecycle tests
3. **Continue Wave 7.5** (Testing & Hardening) in parallel
   - Complete remaining handler tests
   - Integration test suite for existing opcodes
4. **Document Wave 8.1 progress** in memory updates

## References

- **Design Specs**: `OmniProtocol/04_CONNECTION_MANAGEMENT.md` (1238 lines, complete)
- **Binary Encoding**: `OmniProtocol/05_PAYLOAD_STRUCTURES.md` (defines all formats)
- **Current Status**: `OmniProtocol/STATUS.md` (40 handlers complete)
- **Implementation Plan**: `OmniProtocol/07_PHASED_IMPLEMENTATION.md` (Wave 7.1-7.5)
- **Memory Progress**: `.serena/memories/omniprotocol_wave7_progress.md`

---

**Created**: 2025-11-02  
**Author**: Claude (Session Context)  
**Status**: Ready for Wave 8.1 kickoff
