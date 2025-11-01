# OmniProtocol Step 6: Module Structure & Interfaces - COMPLETE

**Status**: ✅ COMPLETE
**File**: `/home/tcsenpai/kynesys/node/OmniProtocol/06_MODULE_STRUCTURE.md`
**Completion Date**: 2025-10-30

## Overview
Comprehensive TypeScript architecture defining module structure, interfaces, serialization utilities, connection management implementation, and zero-breaking-change integration patterns.

## Key Deliverables

### 1. Module Organization
Complete directory structure under `src/libs/omniprotocol/`:
- `types/` - All TypeScript interfaces and error types
- `serialization/` - Encoding/decoding utilities for all payload types
- `connection/` - Connection pool, circuit breaker, async mutex
- `protocol/` - Client, handler, and registry implementations
- `integration/` - Peer adapter and migration utilities
- `utilities/` - Buffer manipulation, crypto, validation

### 2. Type System
**Core Message Types**:
- `OmniMessage` - Complete message structure
- `OmniMessageHeader` - 14-byte header structure
- `ParsedOmniMessage<T>` - Generic parsed message
- `SendOptions` - Message send configuration
- `ReceiveContext` - Message receive metadata

**Error Types**:
- `OmniProtocolError` - Base error class
- `ConnectionError` - Connection-related failures
- `SerializationError` - Encoding/decoding errors
- `VersionMismatchError` - Protocol version conflicts
- `InvalidMessageError` - Malformed messages
- `TimeoutError` - Operation timeouts
- `CircuitBreakerOpenError` - Circuit breaker state

**Payload Namespaces** (8 categories):
- `ControlPayloads` (0x0X) - Ping, HelloPeer, NodeCall, GetPeerlist
- `TransactionPayloads` (0x1X) - Execute, Bridge, Confirm, Broadcast
- `SyncPayloads` (0x2X) - Mempool, Peerlist, Block sync
- `ConsensusPayloads` (0x3X) - Propose, Vote, CVSA, Secretary system
- `GCRPayloads` (0x4X) - Identity, Points, Leaderboard queries
- `BrowserPayloads` (0x5X) - Login, Web2 proxy
- `AdminPayloads` (0x6X) - Rate limit, Campaign, Points award
- `MetaPayloads` (0xFX) - Version, Capabilities, Errors

### 3. Serialization Layer
**PrimitiveEncoder** methods:
- `encodeUInt8/16/32/64()` - Big-endian integer encoding
- `encodeString()` - Length-prefixed UTF-8 (2 bytes + data)
- `encodeHash()` - Fixed 32-byte SHA-256 hashes
- `encodeArray()` - Count-based arrays (2 bytes count + elements)
- `calculateChecksum()` - CRC32 checksum computation

**PrimitiveDecoder** methods:
- `decodeUInt8/16/32/64()` - Big-endian integer decoding
- `decodeString()` - Length-prefixed UTF-8 decoding
- `decodeHash()` - 32-byte hash decoding
- `decodeArray()` - Count-based array decoding
- `verifyChecksum()` - CRC32 verification

**MessageEncoder/Decoder**:
- Message encoding with header + payload + checksum
- Header parsing and validation
- Complete message decoding with checksum verification
- Generic payload parsing with type safety

### 4. Connection Management
**AsyncMutex**:
- Thread-safe lock coordination
- Wait queue for concurrent operations
- `runExclusive()` wrapper for automatic acquire/release

**CircuitBreaker**:
- States: CLOSED → OPEN → HALF_OPEN
- 5 failures → OPEN (default)
- 30-second reset timeout (default)
- 2 successes to close from HALF_OPEN

**PeerConnection**:
- State machine: UNINITIALIZED → CONNECTING → AUTHENTICATING → READY → IDLE_PENDING → CLOSING → CLOSED
- 10-minute idle timeout (configurable)
- Max 100 concurrent requests per connection (configurable)
- Circuit breaker integration
- Async mutex for send operations
- Automatic message sequencing
- Receive buffer management

**ConnectionPool**:
- One connection per peer identity
- Max 1000 total concurrent requests (configurable)
- Automatic connection cleanup on idle
- Connection statistics tracking

### 5. Integration Layer
**PeerOmniAdapter**:
- **Zero breaking changes** to Peer class API
- `adaptCall()` - Maintains exact Peer.call() signature
- `adaptLongCall()` - Maintains exact Peer.longCall() signature
- RPC ↔ OmniProtocol conversion (stubs for Step 7)

**MigrationManager**:
- Three modes: HTTP_ONLY, OMNI_PREFERRED, OMNI_ONLY
- Auto-detect OmniProtocol support
- Peer capability tracking
- Fallback timeout handling

## Design Patterns

### Encoding Standards
- **Big-endian** for all multi-byte integers
- **Length-prefixed strings**: 2 bytes length + UTF-8 data
- **Fixed 32-byte hashes**: SHA-256 format
- **Count-based arrays**: 2 bytes count + elements
- **CRC32 checksums**: Data integrity verification

### Connection Patterns
- **One connection per peer** - No connection multiplexing within peer
- **Hybrid strategy** - Persistent with 10-minute idle timeout
- **Circuit breaker** - 5 failures → 30s cooldown → 2 successes to recover
- **Concurrency control** - 100 requests/connection, 1000 total
- **Thread safety** - AsyncMutex for send operations

### Integration Strategy
- **Zero breaking changes** - Peer class API unchanged
- **Gradual migration** - HTTP_ONLY → OMNI_PREFERRED → OMNI_ONLY
- **Fallback support** - Automatic HTTP fallback on OmniProtocol failure
- **Parallel operation** - HTTP and OmniProtocol coexist during migration

## Testing Strategy

### Unit Test Priorities
1. **Serialization correctness** - Round-trip encoding, checksum validation
2. **Connection lifecycle** - State transitions, timeouts, circuit breaker
3. **Integration compatibility** - Exact Peer API behavior match

### Integration Test Scenarios
1. HTTP → OmniProtocol migration flow
2. Connection pool behavior and reuse
3. Circuit breaker activation and recovery
4. Message sequencing and concurrent requests

## Configuration
**Default values**:
- Pool: 1 connection/peer, 10min idle, 5s connect/auth, 100 req/conn, 1000 total
- Circuit breaker: 5 failures, 30s timeout, 2 successes to recover
- Migration: HTTP_ONLY mode, auto-detect enabled, 1s fallback timeout
- Protocol: v0x01, 3s default timeout, 10s longCall, 10MB max payload

## Documentation Standards
All public APIs require:
- JSDoc with function purpose
- @param, @returns, @throws tags
- @example with usage code
- Type annotations throughout

## Next Steps → Step 7
**Step 7: Phased Implementation Plan** will cover:
1. RPC method → opcode mapping
2. Complete payload encoder/decoder implementations
3. Binary authentication flow
4. Handler registry and routing
5. Comprehensive test suite
6. Rollout strategy and timeline
7. Performance benchmarks
8. Monitoring and metrics

## Progress
**85% Complete** (6 of 7 steps)

## Files Created
- `06_MODULE_STRUCTURE.md` - Complete specification (22,500 tokens)

## Integration Readiness
✅ All interfaces defined
✅ Serialization patterns established
✅ Connection management designed
✅ Zero-breaking-change adapter ready
✅ Migration strategy documented
✅ Ready for Step 7 implementation planning
