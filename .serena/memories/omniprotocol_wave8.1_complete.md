# OmniProtocol Wave 8.1: TCP Physical Layer - COMPLETE

**Date**: 2025-11-02  
**Status**: Infrastructure complete, NOT enabled by default  
**Next Wave**: 8.2 (Full Binary Encoding)

## Implementation Summary

Wave 8.1 successfully implements **persistent TCP transport** to replace HTTP JSON-RPC communication, but it remains **disabled by default** (migration mode: `HTTP_ONLY`).

## Components Implemented

### 1. MessageFramer.ts (215 lines)
**Purpose**: Parse TCP byte stream into complete OmniProtocol messages

**Features**:
- Buffer accumulation from TCP socket
- 12-byte header parsing: `[version:2][opcode:1][flags:1][payloadLength:4][sequence:4]`
- CRC32 checksum validation
- Partial message handling (wait for complete data)
- Static `encodeMessage()` for sending

**Location**: `src/libs/omniprotocol/transport/MessageFramer.ts`

### 2. PeerConnection.ts (338 lines)
**Purpose**: Wrap TCP socket with state machine and request tracking

**Features**:
- Connection state machine: UNINITIALIZED → CONNECTING → AUTHENTICATING → READY → IDLE_PENDING → CLOSING → CLOSED
- Request-response correlation via sequence IDs
- In-flight request tracking with timeout
- Idle timeout (10 minutes default)
- Graceful shutdown with proto_disconnect (0xF4)
- Automatic error transition to ERROR state

**Location**: `src/libs/omniprotocol/transport/PeerConnection.ts`

### 3. ConnectionPool.ts (301 lines)
**Purpose**: Manage pool of persistent TCP connections

**Features**:
- Per-peer connection pooling (max 1 connection per peer by default)
- Global connection limit (max 100 total by default)
- Lazy connection creation (create on first use)
- Connection reuse for efficiency
- Periodic cleanup of idle/dead connections (every 60 seconds)
- Health monitoring and statistics
- Graceful shutdown

**Location**: `src/libs/omniprotocol/transport/ConnectionPool.ts`

### 4. types.ts (162 lines)
**Purpose**: Shared type definitions for transport layer

**Key Types**:
- `ConnectionState`: State machine states
- `ConnectionOptions`: Timeout, retries, priority
- `PendingRequest`: Request tracking structure
- `PoolConfig`: Connection pool configuration
- `PoolStats`: Pool health statistics
- `ConnectionInfo`: Per-connection monitoring data
- `ParsedConnectionString`: tcp://host:port components

**Location**: `src/libs/omniprotocol/transport/types.ts`

### 5. peerAdapter.ts Integration
**Changes**:
- Added `ConnectionPool` initialization in constructor
- Replaced HTTP placeholder in `adaptCall()` with TCP transport
- Added `httpToTcpConnectionString()` converter
- Automatic fallback to HTTP on TCP failure
- Automatic peer marking (HTTP-only) on TCP failure

**Location**: `src/libs/omniprotocol/integration/peerAdapter.ts`

### 6. Configuration Updates
**Added to ConnectionPoolConfig**:
- `maxTotalConnections: 100` - Global TCP connection limit

**Location**: `src/libs/omniprotocol/types/config.ts`

## Architecture Transformation

### Before (Wave 7.x - HTTP Transport)
```
peerAdapter.adaptCall()
    ↓
peer.call() 
    ↓
axios.post(url, json_payload)
    ↓
[HTTP POST with JSON body]
    ↓
One TCP connection per request (closed after response)
```

### After (Wave 8.1 - TCP Transport)
```
peerAdapter.adaptCall()
    ↓
ConnectionPool.send()
    ↓
PeerConnection.send() [persistent TCP socket]
    ↓
MessageFramer.encodeMessage()
    ↓
[12-byte header + JSON payload + CRC32]
    ↓
TCP socket write (connection reused)
    ↓
MessageFramer.extractMessage() [parse response]
    ↓
Correlate response via sequence ID
```

## Performance Benefits

### Connection Efficiency
- **Persistent connections**: Reuse TCP connections across requests (no 3-way handshake overhead)
- **Connection pooling**: Efficient resource management
- **Multiplexing**: Single TCP connection handles multiple concurrent requests via sequence IDs

### Protocol Efficiency
- **Binary framing**: Fixed-size header vs HTTP text headers
- **Direct socket I/O**: No HTTP layer overhead
- **CRC32 validation**: Integrity checking at protocol level

### Resource Management
- **Configurable limits**: Global and per-peer connection limits
- **Idle cleanup**: Automatic cleanup of unused connections after 10 minutes
- **Health monitoring**: Pool statistics for observability

## Current Encoding (Wave 8.1)

**Still using JSON payloads** in hybrid format:
- Header: Binary (12 bytes)
- Payload: JSON envelope (length-prefixed)
- Checksum: Binary (4 bytes CRC32)

**Wave 8.2 will replace** JSON with full binary encoding for:
- Request/response payloads
- Complex data structures
- All handler communication

## Migration Configuration

### Current Default (HTTP Only)
```typescript
DEFAULT_OMNIPROTOCOL_CONFIG = {
    migration: {
        mode: "HTTP_ONLY",  // ← TCP transport NOT used
        omniPeers: new Set(),
        autoDetect: true,
        fallbackTimeout: 1000,
    }
}
```

### To Enable TCP Transport

**Option 1: Global Enable**
```typescript
const adapter = new PeerOmniAdapter({
    config: {
        ...DEFAULT_OMNIPROTOCOL_CONFIG,
        migration: {
            mode: "OMNI_PREFERRED", // Try TCP, fall back to HTTP
            omniPeers: new Set(),
            autoDetect: true,
            fallbackTimeout: 1000,
        }
    }
})
```

**Option 2: Per-Peer Enable**
```typescript
adapter.markOmniPeer(peerIdentity) // Mark specific peer for TCP
// OR
adapter.markHttpPeer(peerIdentity) // Force HTTP for specific peer
```

### Migration Modes
- `HTTP_ONLY`: Never use TCP, always HTTP (current default)
- `OMNI_PREFERRED`: Try TCP first, fall back to HTTP on failure (recommended)
- `OMNI_ONLY`: Force TCP only, error if TCP fails (production after testing)

## Testing Status

**Not yet tested** - infrastructure is complete but:
1. No unit tests written yet
2. No integration tests written yet
3. No end-to-end testing with real nodes
4. Migration mode is HTTP_ONLY (TCP not active)

**To test**:
1. Enable `OMNI_PREFERRED` mode
2. Mark test peer with `markOmniPeer()`
3. Make RPC calls and verify TCP connection establishment
4. Monitor ConnectionPool stats
5. Test fallback to HTTP on failure

## Known Limitations (Wave 8.1)

1. **No authentication** - Wave 8.3 will add hello_peer handshake
2. **No push messages** - Wave 8.4 will add server-initiated messages
3. **No TLS** - Wave 8.5 will add encrypted TCP (tcps://)
4. **JSON payloads** - Wave 8.2 will add full binary encoding
5. **Single connection per peer** - Future: multiple connections for high traffic

## Exit Criteria for Wave 8.1 ✅

- [x] MessageFramer handles TCP stream parsing
- [x] PeerConnection manages single TCP connection
- [x] ConnectionPool manages connection pool
- [x] Integration with peerAdapter complete
- [x] Automatic fallback to HTTP on TCP failure
- [x] Configuration system updated
- [ ] Unit tests (deferred)
- [ ] Integration tests (deferred)
- [ ] Actually enabled and tested with real nodes (NOT DONE - still HTTP_ONLY)

## Next Steps (Wave 8.2)

**Goal**: Replace JSON payloads with full binary encoding

**Approach**:
1. Implement binary encoders for common types (string, number, array, object)
2. Create request/response binary serialization
3. Update handlers to use binary encoding
4. Benchmark performance vs JSON envelope
5. Maintain backward compatibility during transition

**Files to Modify**:
- `src/libs/omniprotocol/serialization/` - Add binary encoders/decoders
- Handler files - Update payload encoding
- peerAdapter - Switch to binary encoding

## Files Created/Modified

### Created
- `src/libs/omniprotocol/transport/types.ts` (162 lines)
- `src/libs/omniprotocol/transport/MessageFramer.ts` (215 lines)
- `src/libs/omniprotocol/transport/PeerConnection.ts` (338 lines)
- `src/libs/omniprotocol/transport/ConnectionPool.ts` (301 lines)

### Modified
- `src/libs/omniprotocol/integration/peerAdapter.ts` - Added ConnectionPool integration
- `src/libs/omniprotocol/types/config.ts` - Added maxTotalConnections to pool config

### Total Lines of Code
**~1,016 lines** across 4 new files + integration

## Decision Log

### Why Persistent Connections?
HTTP's connection-per-request model has significant overhead:
- TCP 3-way handshake for every request
- TLS handshake for HTTPS
- No request multiplexing

Persistent connections eliminate this overhead and enable:
- Request-response correlation via sequence IDs
- Concurrent requests on single connection
- Lower latency for subsequent requests

### Why Connection Pool?
- Prevents connection exhaustion (DoS protection)
- Enables resource monitoring and limits
- Automatic cleanup of idle connections
- Health tracking for observability

### Why Idle Timeout 10 Minutes?
Balance between:
- Connection reuse efficiency (longer is better)
- Resource usage (shorter is better)
- Standard practice for persistent connections

### Why Sequence IDs vs Connection IDs?
Sequence IDs enable:
- Multiple concurrent requests on same connection
- Request-response correlation
- Better resource utilization

### Why CRC32?
- Fast computation (hardware acceleration available)
- Sufficient for corruption detection
- Standard in network protocols
- Better than no validation

## Potential Issues & Mitigations

### Issue: TCP Connection Failures
**Mitigation**: Automatic fallback to HTTP on TCP failure, automatic peer marking

### Issue: Resource Exhaustion
**Mitigation**: Connection pool limits (global and per-peer), idle cleanup

### Issue: Request Timeout
**Mitigation**: Per-request timeout configuration, automatic cleanup of timed-out requests

### Issue: Connection State Management
**Mitigation**: Clear state machine with documented transitions, error state handling

### Issue: Partial Message Handling
**Mitigation**: MessageFramer buffer accumulation, wait for complete messages

## Performance Targets

### Connection Establishment
- Target: <100ms for local connections
- Target: <500ms for remote connections

### Request-Response Latency
- Target: <10ms overhead for connection reuse
- Target: <100ms for first request (includes connection establishment)

### Connection Pool Efficiency
- Target: >90% connection reuse rate
- Target: <1% connection pool capacity usage under normal load

### Resource Usage
- Target: <1MB memory per connection
- Target: <100 open connections under normal load

## Monitoring Recommendations

### Metrics to Track
- Connection establishment time
- Connection reuse rate
- Pool capacity usage
- Idle connection count
- Request timeout rate
- Fallback to HTTP rate
- Average request latency
- TCP vs HTTP request distribution

### Alerts to Configure
- Pool capacity >80%
- Connection timeout rate >5%
- Fallback rate >10%
- Average latency >100ms

## Wave 8.1 Completion Date
**2025-11-02**
