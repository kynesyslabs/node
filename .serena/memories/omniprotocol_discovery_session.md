# OmniProtocol Discovery Session - Requirements Capture

## Project Context
Design a custom TCP-based protocol (OmniProtocol) to replace HTTP communication in Demos Network nodes.

## Key Requirements Captured

### 1. Protocol Scope & Architecture
- **Message Types**: Discover from existing HTTP usage in:
  - `Peer.ts` - peer communication patterns
  - `server_rpc.ts` - RPC handling
  - Consensus layer - PoRBFTv2 messages
  - Other HTTP-based node communication throughout repo
- **Byte Encoding**: 
  - Versioning support: YES (required)
  - Header size strategy: TBD (needs discovery from existing patterns)
- **Performance**:
  - Throughput: Highest possible
  - Latency: Lowest possible
  - Expected scale: Thousands of nodes

### 2. Peer Discovery Mechanism
- **Strategy**: Bootstrap nodes approach
- **Peer Management**:
  - Dynamic peer discovery
  - No reputation system (for now)
  - Health check mechanism needed
  - Handle peer churn appropriately

### 3. Existing HTTP Logic Replication
- **Discovery Task**: Map all HTTP endpoints and communication patterns in repository
- **Communication Patterns**: Support all three:
  - Request-response
  - Fire-and-forget (one-way)
  - Pub/sub patterns
  - Pattern choice depends on what's being replicated

### 4. Reliability & Error Handling
- **Delivery Guarantee**: Exactly-once delivery required
- **Reliability Layer**: TCP built-in suffices for now, but leave space for custom verification
- **Error Handling**: All three required:
  - Timeout handling
  - Retry logic with exponential backoff
  - Circuit breaker patterns

### 5. Security & Authentication
- **Node Authentication**: 
  - Signature-based (blockchain native methods)
  - Examples exist in `Peer.ts` or nearby files (HTTP examples)
- **Authorization**:
  - Different node types with different permissions: YES (not implemented yet)
  - Handshake mechanism needed before node communication allowed
  - Design space preserved for better handshake design

### 6. Testing & Validation Strategy
- **Testing Requirements**:
  - Unit tests for protocol components
  - Load testing for performance validation
- **Migration Validation**:
  - TCP/HTTP parallel operation: YES (possible for now)
  - Rollback strategy: YES (needed)
  - Verification approach: TBD (needs todo)

### 7. Integration with Existing Codebase
- **Abstraction Layer**:
  - Should expose interface similar to current HTTP layer
  - Enable drop-in replacement capability
- **Backward Compatibility**:
  - Support nodes running HTTP during migration: YES
  - Dual-protocol support period: YES (both needed for transition)

## Implementation Approach
1. Create standalone `OmniProtocol/` folder
2. Design and test protocol locally
3. Replicate repository HTTP logic in TCP protocol
4. Only after validation, integrate as central communication layer

## Next Steps
- Conduct repository HTTP communication audit
- Design protocol specification
- Create phased implementation plan