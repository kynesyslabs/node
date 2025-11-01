# OmniProtocol Step 4 Complete - Connection Management & Lifecycle

## Status
**Completed**: Step 4 specification fully documented
**File**: `OmniProtocol/04_CONNECTION_MANAGEMENT.md`
**Date**: 2025-10-30

## Summary

Step 4 defines TCP connection pooling, resource management, and concurrency patterns for OmniProtocol while maintaining existing HTTP-based semantics.

### Key Design Decisions

**Connection Pool Architecture:**
1. **Pattern**: One persistent TCP connection per peer identity
2. **State Machine**: UNINITIALIZED → CONNECTING → AUTHENTICATING → READY → IDLE_PENDING → CLOSING → CLOSED
3. **Lifecycle**: 10-minute idle timeout with graceful closure
4. **Pooling**: Single connection per peer (can scale to multiple if needed)

**Timeout Patterns:**
- **Connection (TCP)**: 5000ms default, 10000ms max
- **Authentication**: 5000ms default, 10000ms max
- **call() (single RPC)**: 3000ms default (matches HTTP), 30000ms max
- **longCall() (w/ retries)**: ~10s typical with retries
- **multiCall() (parallel)**: 2000ms default (matches HTTP), 10000ms max
- **Consensus operations**: 1000ms default, 5000ms max (critical)
- **Block sync**: 30000ms default, 300000ms max (bulk operations)

**Retry Strategy:**
- **Enhanced longCall**: Maintains existing behavior (3 retries, 250ms delay)
- **Exponential backoff**: Optional with configurable multiplier
- **Adaptive timeout**: Based on peer latency history (p95 + buffer)
- **Allowed errors**: Don't retry for specified error codes

**Circuit Breaker:**
- **Threshold**: 5 consecutive failures → OPEN
- **Timeout**: 30 seconds before trying HALF_OPEN
- **Success threshold**: 2 successes to CLOSE
- **Purpose**: Prevent cascading failures

**Concurrency Control:**
- **Per-connection limit**: 100 concurrent requests
- **Global limit**: 1000 total connections
- **Backpressure**: Request queue when limit reached
- **LRU eviction**: Automatic cleanup of idle connections

**Thread Safety:**
- **Async mutex**: Sequential message sending per connection
- **Read-write locks**: Peer state modifications
- **Lock-free reads**: Connection state queries

**Error Handling:**
- **Classification**: TRANSIENT (retry immediately), DEGRADED (retry with backoff), FATAL (mark offline)
- **Recovery strategies**: Automatic reconnection, peer degradation, offline marking
- **Error tracking**: Per-peer error counters and metrics

### Performance Characteristics

**Connection Overhead:**
- **Cold start**: 4 RTTs (~40-120ms) - TCP handshake + hello_peer
- **Warm connection**: 1 RTT (~10-30ms) - message only
- **Improvement**: 70-90% latency reduction for warm connections

**Bandwidth Savings:**
- **HTTP overhead**: ~400-800 bytes per request (headers + JSON)
- **OmniProtocol overhead**: 12 bytes (header only)
- **Reduction**: ~97% overhead elimination

**Scalability:**
- **1,000 peers**: ~400-800 KB memory (5-10% active)
- **10,000 peers**: ~4-8 MB memory (5-10% active)
- **Throughput**: 10,000+ requests/second with connection reuse
- **CPU overhead**: <5% (binary parsing minimal)

### Memory Management

**Buffer Pooling:**
- **Pool sizes**: 256, 1024, 4096, 16384, 65536 bytes
- **Max buffers**: 100 per size
- **Reuse**: Zero-fill on release for security

**Connection Limits:**
- **Max total**: 1000 connections (configurable)
- **Max per peer**: 1 connection (can scale)
- **LRU eviction**: Automatic when limit exceeded
- **Memory per connection**: ~4-8 KB (TCP buffers + metadata)

### Monitoring & Metrics

**Connection Metrics:**
- Total/active/idle connection counts
- Latency percentiles (p50, p95, p99)
- Error counts by type (connection, timeout, auth)
- Resource usage (memory, buffers, in-flight requests)

**Per-Peer Tracking:**
- Latency history (last 100 samples)
- Error counters by type
- Circuit breaker state
- Connection state

### Integration with Peer Class

**API Compatibility:**
- `call()`: Maintains exact signature, protocol detection automatic
- `longCall()`: Maintains exact signature, enhanced retry logic
- `multiCall()`: Maintains exact signature, parallel execution preserved
- **Zero breaking changes** - transparent TCP integration

**Protocol Detection:**
- `tcp://` or `omni://` → OmniProtocol
- `http://` or `https://` → HTTP (existing)
- **Dual protocol support** during migration

### Migration Strategy

**Phase 1: Dual Protocol**
- Both HTTP and TCP supported
- Try TCP first, fallback to HTTP on failure
- Track fallback rate metrics

**Phase 2: TCP Primary**
- Same as Phase 1 but with monitoring
- Goal: <1% fallback rate

**Phase 3: TCP Only**
- Remove HTTP fallback
- OmniProtocol only

## Implementation Details

**PeerConnection Class:**
- State machine with 7 states
- Idle timer with 10-minute timeout
- Message ID tracking for request/response correlation
- Send lock for thread-safe sequential sending
- Graceful shutdown with proto_disconnect (0xF4)

**ConnectionPool Class:**
- Map of peer identity → PeerConnection
- Connection acquisition with mutex per peer
- LRU eviction for resource limits
- Global connection counting and limits

**RetryManager:**
- Configurable retry count, delay, backoff
- Adaptive timeout based on peer latency
- Allowed error codes (treat as success)

**TimeoutManager:**
- Promise.race pattern for timeouts
- Adaptive timeouts from peer metrics
- Per-operation configurable timeouts

**CircuitBreaker:**
- State machine (CLOSED/OPEN/HALF_OPEN)
- Automatic recovery after timeout
- Per-peer instance

**MetricsCollector:**
- Latency histograms (100 samples)
- Error counters by type
- Connection state tracking
- Resource usage monitoring

## Design Philosophy Maintained

✅ **No Redesign**: Maps existing HTTP patterns to TCP efficiently
✅ **API Compatibility**: Zero breaking changes to Peer class
✅ **Proven Patterns**: Reuses existing timeout/retry semantics
✅ **Resource Efficiency**: Scales to thousands of peers with minimal memory
✅ **Thread Safety**: Proper synchronization for concurrent operations
✅ **Observability**: Comprehensive metrics for monitoring

## Next Steps

Remaining design steps:
- **Step 5**: Payload Structures (binary format for all 9 opcode categories)
- **Step 6**: Module Structure & Interfaces (TypeScript architecture)
- **Step 7**: Phased Implementation Plan (testing, migration, rollout)

## Progress Metrics

**Design Completion**: 57% (4 of 7 steps complete)
- ✅ Step 1: Message Format
- ✅ Step 2: Opcode Mapping
- ✅ Step 3: Peer Discovery & Handshake
- ✅ Step 4: Connection Management & Lifecycle
- ⏸️ Step 5: Payload Structures
- ⏸️ Step 6: Module Structure
- ⏸️ Step 7: Implementation Plan

## Key Innovations

**Hybrid Connection Strategy:**
- Best of both worlds: persistent for active, cleanup for idle
- Automatic resource management without manual intervention
- Scales from 10 to 10,000 peers seamlessly

**Adaptive Timeouts:**
- Learns from peer latency patterns
- Adjusts dynamically per peer
- Prevents false timeouts for slow peers

**Circuit Breaker Integration:**
- Prevents wasted retries to dead peers
- Automatic recovery when peer returns
- Per-peer isolation (one bad peer doesn't affect others)

**Zero-Copy Message Handling:**
- Buffer pooling reduces allocations
- Direct buffer writes for efficiency
- Minimal garbage collection pressure

**Transparent Migration:**
- Existing code works unchanged
- Gradual rollout with fallback safety
- Metrics guide migration progress
