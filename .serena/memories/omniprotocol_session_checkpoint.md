# OmniProtocol Design Session Checkpoint

## Session Overview
**Project**: OmniProtocol - Custom TCP-based protocol for Demos Network inter-node communication  
**Phase**: Collaborative Design (Step 2 of 7 complete)  
**Status**: Active design phase, no implementation started per user instruction

## Completed Design Steps

### Step 1: Message Format ✅
**File**: `OmniProtocol/01_MESSAGE_FORMAT.md`

**Header Structure (12 bytes fixed)**:
- Version: 2 bytes (semantic: 1 byte major, 1 byte minor)
- Type: 1 byte (opcode)
- Flags: 1 byte (auth required, response expected, compression, encryption)
- Length: 4 bytes (total message length)
- Message ID: 4 bytes (request-response correlation)

**Authentication Block (variable, conditional on Flags bit 0)**:
- Algorithm: 1 byte (0x01=ed25519, 0x02=falcon, 0x03=ml-dsa)
- Signature Mode: 1 byte (0x01-0x06, versatility for different signing strategies)
- Timestamp: 8 bytes (Unix milliseconds, replay protection ±5 min window)
- Identity Length: 2 bytes
- Identity: variable (public key raw binary)
- Signature Length: 2 bytes
- Signature: variable (raw binary)

**Key Decisions**:
- Big-endian encoding throughout
- Signature Mode mandatory when auth block present (versatility)
- Timestamp mandatory for replay protection
- 60-90% bandwidth savings vs HTTP

### Step 2: Opcode Mapping ✅
**File**: `OmniProtocol/02_OPCODE_MAPPING.md`

**Category Structure (256 opcodes)**:
- 0x0X: Control & Infrastructure (16 opcodes)
- 0x1X: Transactions & Execution (16 opcodes)
- 0x2X: Data Synchronization (16 opcodes)
- 0x3X: Consensus PoRBFTv2 (16 opcodes)
- 0x4X: GCR Operations (16 opcodes)
- 0x5X: Browser/Client (16 opcodes)
- 0x6X: Admin Operations (16 opcodes)
- 0x7X-0xEX: Reserved (128 opcodes)
- 0xFX: Protocol Meta (16 opcodes)

**Critical Opcodes**:
- 0x00: ping
- 0x01: hello_peer
- 0x03: nodeCall (HTTP compatibility wrapper)
- 0x10: execute
- 0x20: mempool_sync
- 0x22: peerlist_sync
- 0x31-0x3A: Consensus opcodes (proposeBlockHash, greenlight, setValidatorPhase, etc.)
- 0x4A-0x4B: GCR operations
- 0xF0: proto_versionNegotiate

**Security Model**:
- Auth required: Transactions (0x10-0x16), Consensus (0x30-0x3A), Sync (0x20-0x22), Write GCR, Admin
- No auth: Queries, reads, protocol meta

**HTTP Compatibility**:
- Wrapper opcodes: 0x03 (nodeCall), 0x30 (consensus_generic), 0x40 (gcr_generic)
- Allows gradual HTTP-to-TCP migration

## Pending Design Steps

### Step 3: Peer Discovery & Handshake
**Status**: Not started  
**Scope**:
- Bootstrap peer discovery mechanism
- Dynamic peer addition/removal
- Health check system
- Handshake protocol before communication
- Node authentication via blockchain signatures

### Step 4: Connection Management & Lifecycle
**Status**: Not started  
**Scope**:
- TCP connection pooling
- Timeout, retry, circuit breaker patterns
- Connection lifecycle management
- Thousands of concurrent nodes support

### Step 5: Payload Structures
**Status**: Not started  
**Scope**:
- Define payload format for each message category
- Request payloads (9 categories)
- Response payloads with status codes
- Compression and encoding strategies

### Step 6: Module Structure & Interfaces
**Status**: Not started  
**Scope**:
- OmniProtocol module architecture
- TypeScript interfaces
- Integration points with existing node code

### Step 7: Phased Implementation Plan
**Status**: Not started  
**Scope**:
- Unit testing strategy
- Load testing plan
- Dual HTTP/TCP migration strategy
- Rollback capability
- Local testing before integration

## Key Requirements Captured

**Protocol Characteristics**:
- Pure TCP (no WebSockets) - Bun runtime limitation
- Byte-encoded messages
- Versioning support
- Highest throughput, lowest latency
- Support thousands of nodes
- Exactly-once delivery with TCP
- Three patterns: request-response, fire-and-forget, pub/sub

**Scope**:
- Replace inter-node communication ONLY
- External libraries remain HTTP (Rubic, Web2 proxy)
- SDK client-to-node remains HTTP (backward compatibility)
- Build standalone in OmniProtocol/ folder
- Test locally before integration

**Security**:
- ed25519 (primary), falcon, ml-dsa (post-quantum)
- Signature format: "algorithm:pubkey" in identity header
- Sign public key for authentication
- Replay protection via timestamp
- Handshake required before communication

**Migration Strategy**:
- Dual HTTP/TCP protocol support during transition
- Rollback capability required
- Unit tests and load testing mandatory

## Communication Patterns Identified

**1. Request-Response (Synchronous)**:
- Peer.call() - 3 second timeout
- Peer.longCall() - 3 retries, 250ms sleep, configurable allowed error codes
- Used for: Transactions, queries, consensus coordination

**2. Broadcast with Aggregation (Asynchronous)**:
- broadcastBlockHash() - parallel promises to shard members
- Async aggregation of signatures
- Used for: Consensus voting, block validation

**3. Fire-and-Forget (One-way)**:
- No response expected
- Used for: Status updates, notifications

## Consensus Communication Discovered

**Secretary Manager Pattern** (PoRBFTv2):
- One node coordinates validator phases
- Validators report phases: setValidatorPhase
- Secretary issues greenlight signals
- CVSA (Common Validator Seed Algorithm) validation
- Phase synchronization with timestamps

**Consensus Opcodes**:
- 0x31: proposeBlockHash - validators vote on block hash
- 0x32: getBlockProposal - retrieve proposed block
- 0x33: submitBlockProposal - submit block for validation
- 0x34: getCommonValidatorSeed - CVSA seed synchronization
- 0x35: getStableBlocks - fetch stable block range
- 0x36: setValidatorPhase - report phase to secretary
- 0x37: getValidatorPhase - retrieve phase status
- 0x38: greenlight - secretary authorization signal
- 0x39: getValidatorTimestamp - timestamp synchronization
- 0x3A: setSecretaryManager - secretary election

## Files Created

1. **OmniProtocol/SPECIFICATION.md** - Master specification document
2. **OmniProtocol/01_MESSAGE_FORMAT.md** - Complete message format spec
3. **OmniProtocol/02_OPCODE_MAPPING.md** - Complete opcode mapping (256 opcodes)

## Memories Created

1. **omniprotocol_discovery_session** - Requirements from brainstorming
2. **omniprotocol_http_endpoint_analysis** - HTTP endpoint mapping
3. **omniprotocol_comprehensive_communication_analysis** - 40+ message types
4. **omniprotocol_sdk_client_analysis** - SDK patterns, client-node vs inter-node
5. **omniprotocol_step1_message_format** - Step 1 design decisions
6. **omniprotocol_step2_opcode_mapping** - Step 2 design decisions
7. **omniprotocol_session_checkpoint** - This checkpoint

## Next Actions

**Design Phase** (user approval required for each step):
- User will choose: Step 3 (Peer Discovery), Step 5 (Payload Structures), or other
- Continue collaborative design pattern: propose, discuss, decide, document
- NO IMPLEMENTATION until user explicitly requests it

**User Instruction**: "ask me for every design choice, we design it together, and dont code until i tell you"

## Progress Summary
- Design: 28% complete (2 of 7 steps)
- Foundation: Solid (message format and opcode mapping complete)
- Next: Peer discovery or payload structures (pending user decision)
