# OmniProtocol Session Final State

## Session Metadata
**Date**: 2025-10-10  
**Phase**: Collaborative Design (Step 3 questions pending)  
**Progress**: 2.5 of 7 design steps complete  
**Status**: Active - awaiting user feedback on Step 3 questions

## Completed Work

### Step 1: Message Format ✅
**File**: `OmniProtocol/01_MESSAGE_FORMAT.md`  
**Status**: Complete and documented

**Key Decisions**:
- Header: 12 bytes fixed (Version 2B, Type 1B, Flags 1B, Length 4B, Message ID 4B)
- Auth block: Algorithm 1B, Signature Mode 1B, Timestamp 8B, Identity (length-prefixed), Signature (length-prefixed)
- Big-endian encoding throughout
- Signature Mode for versatility (6 modes defined)
- Mandatory timestamp for replay protection (±5 min window)
- 60-90% bandwidth savings vs HTTP

### Step 2: Opcode Mapping ✅
**File**: `OmniProtocol/02_OPCODE_MAPPING.md`  
**Status**: Complete and documented

**Key Decisions**:
- 256 opcodes across 9 categories (high nibble = category)
- 0x0X: Control (16), 0x1X: Transactions (16), 0x2X: Sync (16)
- 0x3X: Consensus (16), 0x4X: GCR (16), 0x5X: Browser (16)
- 0x6X: Admin (16), 0x7X-0xEX: Reserved (128), 0xFX: Protocol Meta (16)
- Wrapper opcodes: 0x03 (nodeCall), 0x30 (consensus_generic), 0x40 (gcr_generic)
- Security model: Auth required for transactions, consensus, sync, write ops
- HTTP compatibility via wrapper opcodes for gradual migration

### Step 3: Peer Discovery & Handshake (In Progress)
**Status**: Questions formulated, awaiting user feedback

**Approach Correction**: User feedback received - "we should replicate what happens in the node, not redesign it completely"

**Files Analyzed**:
- `src/libs/peer/PeerManager.ts` - Peer registry management
- `src/libs/peer/Peer.ts` - RPC call wrappers
- `src/libs/network/manageHelloPeer.ts` - Handshake handler

**Current System Understanding**:
- Bootstrap from `demos_peer.json` (identity → connection_string map)
- `sayHelloToPeer()`: Send hello_peer with URL, signature, syncData
- Signature: Sign URL with private key (ed25519/falcon/ml-dsa)
- Response: Peer's syncData
- Registries: online (peerList) and offline (offlinePeers)
- No explicit ping, no periodic health checks
- Retry: longCall() with 3 attempts, 250ms sleep

**9 Design Questions Formulated** (in omniprotocol_step3_questions memory):
1. Connection string encoding (length-prefixed vs fixed structure)
2. Signature type encoding (reuse Step 1 algorithm codes)
3. SyncData binary encoding (block size, hash format)
4. hello_peer response structure (symmetric vs minimal)
5. Peerlist array encoding (count-based vs length-based)
6. TCP connection strategy (persistent vs pooled vs hybrid)
7. Retry mechanism integration (Message ID tracking)
8. Ping mechanism design (payload, frequency)
9. Dead peer detection (thresholds, retry intervals)

**Next Action**: Wait for user answers, then create `03_PEER_DISCOVERY.md`

## Pending Design Steps

### Step 4: Connection Management & Lifecycle
**Status**: Not started  
**Scope**: TCP connection pooling, timeout/retry/circuit breaker, thousands of nodes support

### Step 5: Payload Structures
**Status**: Not started  
**Scope**: Binary payload format for each message category (9 categories from Step 2)

### Step 6: Module Structure & Interfaces
**Status**: Not started  
**Scope**: TypeScript interfaces, OmniProtocol module architecture, integration points

### Step 7: Phased Implementation Plan
**Status**: Not started  
**Scope**: Unit testing, load testing, dual HTTP/TCP migration, rollback capability

## Files Created
1. `OmniProtocol/SPECIFICATION.md` - Master specification (updated 2x)
2. `OmniProtocol/01_MESSAGE_FORMAT.md` - Complete message format spec
3. `OmniProtocol/02_OPCODE_MAPPING.md` - Complete 256-opcode mapping

## Memories Created
1. `omniprotocol_discovery_session` - Requirements from initial brainstorming
2. `omniprotocol_http_endpoint_analysis` - HTTP endpoint inventory
3. `omniprotocol_comprehensive_communication_analysis` - 40+ message types catalogued
4. `omniprotocol_sdk_client_analysis` - SDK patterns, client-node vs inter-node
5. `omniprotocol_step1_message_format` - Step 1 design decisions
6. `omniprotocol_step2_opcode_mapping` - Step 2 design decisions
7. `omniprotocol_step3_questions` - Step 3 design questions awaiting feedback
8. `omniprotocol_session_checkpoint` - Previous checkpoint
9. `omniprotocol_session_final_state` - This final state

## Key Technical Insights

### Consensus Communication (PoRBFTv2)
- **Secretary Manager Pattern**: One node coordinates validator phases
- **Opcodes**: 0x31-0x3A (10 consensus messages)
- **Flow**: setValidatorPhase → secretary coordination → greenlight signal
- **CVSA Validation**: Common Validator Seed Algorithm for shard selection
- **Parallel Broadcasting**: broadcastBlockHash to shard members, async aggregation

### Authentication Pattern
- **Current HTTP**: Headers with "identity:algorithm:pubkey" and "signature"
- **Signature**: Sign public key with private key
- **Algorithms**: ed25519 (primary), falcon, ml-dsa (post-quantum)
- **OmniProtocol**: Auth block in message (conditional on Flags bit 0)

### Communication Patterns
1. **Request-Response**: call() with 3s timeout
2. **Retry**: longCall() with 3 retries, 250ms sleep, allowed error codes
3. **Parallel**: multiCall() with Promise.all, 2s timeout
4. **Broadcast**: Async aggregation pattern for consensus voting

### Migration Strategy
- **Dual Protocol**: Support both HTTP and TCP during transition
- **Wrapper Opcodes**: 0x03, 0x30, 0x40 for HTTP compatibility
- **Gradual Rollout**: Node-by-node migration with rollback capability
- **SDK Unchanged**: Client-to-node remains HTTP for backward compatibility

## User Instructions & Constraints

**Collaborative Design**: "ask me for every design choice, we design it together, and dont code until i tell you"

**Scope Clarification**: "replace inter node communications: external libraries remains as they are"

**Design Approach**: Map existing proven patterns to binary format, don't redesign the system

**No Implementation Yet**: Pure design phase, no code until user requests

## Progress Metrics
- **Design Completion**: 28% (2 of 7 steps complete, step 3 questions pending)
- **Documentation**: 3 specification files created
- **Memory Persistence**: 9 memories for cross-session continuity
- **Design Quality**: All decisions documented with rationale

## Session Continuity Plan

**To Resume Session**:
1. Run `/sc:load` to activate project and load memories
2. Read `omniprotocol_step3_questions` for pending questions
3. Continue with user's answers to formulate Step 3 specification
4. Follow remaining steps 4-7 in collaborative design pattern

**Session Recovery**:
- All design decisions preserved in memories
- Files contain complete specifications for Steps 1-2
- Question document ready for Step 3 continuation
- TodoList tracks overall progress

**Next Session Goals**:
1. Get user feedback on 9 Step 3 questions
2. Create `03_PEER_DISCOVERY.md` specification
3. Move to Step 4 or Step 5 (user choice)
4. Continue collaborative design until all 7 steps complete
