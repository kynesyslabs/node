# OmniProtocol - Comprehensive Communication Analysis

## Complete Message Inventory

### 1. RPC METHODS (Main POST / endpoint)

#### Core Infrastructure (No Auth)
- **nodeCall** - Node-to-node communication wrapper
  - Submethods: ping, getPeerlist, getPeerInfo, etc.

#### Authentication & Session (Auth Required)
- **ping** - Simple heartbeat/connectivity check
- **hello_peer** - Peer handshake with sync data exchange
- **auth** - Authentication message handling

#### Transaction & Execution (Auth Required)
- **execute** - Execute transaction bundles (BundleContent)
  - Rate limited: 1 identity tx per IP per block
- **nativeBridge** - Native bridge operation compilation
- **bridge** - External bridge operations (Rubic)
  - Submethods: get_trade, execute_trade

#### Data Synchronization (Auth Required)
- **mempool** - Mempool merging between peers
- **peerlist** - Peerlist synchronization

#### Browser/Client Communication (Auth Required)
- **login_request** - Browser login initiation
- **login_response** - Browser login completion
- **web2ProxyRequest** - Web2 proxy request handling

#### Consensus Communication (Auth Required)
- **consensus_routine** - PoRBFTv2 consensus messages
  - Submethods (Secretary System):
    - **proposeBlockHash** - Block hash voting
    - **broadcastBlock** - Block distribution
    - **getCommonValidatorSeed** - Seed synchronization
    - **getValidatorTimestamp** - Timestamp collection
    - **setValidatorPhase** - Phase coordination
    - **getValidatorPhase** - Phase query
    - **greenlight** - Secretary authorization signal
    - **getBlockTimestamp** - Block timestamp query

#### GCR (Global Consensus Registry) Communication (Auth Required)
- **gcr_routine** - GCR state management
  - Submethods:
    - **identity_assign_from_write** - Infer identity from write ops
    - **getIdentities** - Get all identities for account
    - **getWeb2Identities** - Get Web2 identities only
    - **getXmIdentities** - Get crosschain identities only
    - **getPoints** - Get incentive points for account
    - **getTopAccountsByPoints** - Leaderboard query
    - **getReferralInfo** - Referral information
    - **validateReferralCode** - Referral code validation
    - **getAccountByIdentity** - Account lookup by identity

#### Protected Admin Operations (Auth + SUDO_PUBKEY Required)
- **rate-limit/unblock** - Unblock IP addresses from rate limiter
- **getCampaignData** - Campaign data retrieval
- **awardPoints** - Manual points award to users

### 2. PEER-TO-PEER COMMUNICATION PATTERNS

#### Direct Peer Methods (Peer.ts)
- **call()** - Standard authenticated RPC call
- **longCall()** - Retry-enabled RPC call (3 retries, 250ms sleep)
- **authenticatedCall()** - Explicit auth wrapper
- **multiCall()** - Parallel calls to multiple peers
- **fetch()** - HTTP GET for info endpoints

#### Consensus-Specific Peer Communication
From `broadcastBlockHash.ts`, `mergeMempools.ts`, `shardManager.ts`:

**Broadcast Patterns:**
- Block hash proposal to shard (parallel longCall)
- Mempool merge requests (parallel longCall)
- Validator phase transmission (parallel longCall)
- Peerlist synchronization (parallel call)

**Query Patterns:**
- Validator status checks (longCall with force recheck)
- Timestamp collection for averaging
- Peer sync data retrieval

**Secretary Communication:**
- Phase updates from validators to secretary
- Greenlight signals from secretary to validators
- Block timestamp distribution

### 3. COMMUNICATION CHARACTERISTICS

#### Message Flow Patterns

**1. Request-Response (Synchronous)**
- Most RPC methods
- Timeout: 3000ms default
- Expected result codes: 200, 400, 500, 501

**2. Broadcast (Async with Aggregation)**
- Block hash broadcasting to shard
- Mempool merging
- Validator phase updates
- Pattern: Promise.all() with individual promise handling

**3. Fire-and-Forget (One-way)**
- Some consensus status updates
- require_reply: false in response

**4. Retry-with-Backoff**
- longCall mechanism: 3 retries, configurable sleep
- Used for critical consensus messages
- Allowed errors list for partial success

#### Shard Communication Specifics

**Shard Formation:**
1. Get common validator seed
2. Deterministic shard selection from synced peers
3. Shard size validation
4. Member identity verification

**Intra-Shard Coordination:**
1. **Phase Synchronization**
   - Each validator reports phase to secretary
   - Secretary validates and sends greenlight
   - Validators wait for greenlight before proceeding

2. **Block Hash Consensus**
   - Secretary proposes block hash
   - Validators vote (sign hash)
   - Signatures aggregated in validation_data
   - Threshold-based consensus

3. **Mempool Synchronization**
   - Parallel mempool merge requests
   - Bidirectional transaction exchange
   - Mempool consolidation before block creation

4. **Timestamp Averaging**
   - Collect timestamps from all shard members
   - Calculate average for block timestamp
   - Prevents timestamp manipulation

**Secretary Manager Pattern:**
- One node acts as secretary per consensus round
- Secretary coordinates validator phases
- Greenlight mechanism for phase transitions
- Block timestamp authority
- Seed validation between validators

### 4. AUTHENTICATION & SECURITY PATTERNS

#### Signature-Based Authentication
**Algorithms Supported:**
- ed25519 (primary)
- falcon (post-quantum)
- ml-dsa (post-quantum)

**Header Format:**
```
identity: <algorithm>:<hex_publickey>
signature: <hex_signature_of_publickey>
```

**Verification Flow:**
1. Extract identity and signature from headers
2. Parse algorithm prefix
3. Verify signature against public key
4. Validate before processing payload

#### Rate Limiting
**IP-Based Limits:**
- General request rate limiting
- Special limit: 1 identity tx per IP per block
- Whitelisted IPs bypass limits
- Block-based tracking (resets each block)

**Protected Endpoints:**
- Require specific SUDO_PUBKEY
- Checked before method execution
- Unauthorized returns 401

### 5. DATA STRUCTURES IN TRANSIT

#### Core Types
- **RPCRequest**: { method, params[] }
- **RPCResponse**: { result, response, require_reply, extra }
- **BundleContent**: Transaction bundle wrapper
- **HelloPeerRequest**: { url, publicKey, signature, syncData }
- **ValidationData**: { signatures: {identity: signature} }
- **NodeCall**: { message, data, muid }

#### Consensus Types
- **ConsensusMethod**: Method-specific consensus payloads
- **ValidatorStatus**: Phase tracking structure
- **ValidatorPhase**: Secretary coordination state
- **SyncData**: { status, block, block_hash }

#### GCR Types
- **GCRRoutinePayload**: { method, params }
- Identity assignment payloads
- Account query payloads

#### Bridge Types
- **BridgePayload**: { method, chain, params }
- Trade quotes and execution data

### 6. ERROR HANDLING & RESILIENCE

#### Error Response Codes
- **200**: Success
- **400**: Bad request / validation failure
- **401**: Unauthorized / invalid signature
- **429**: Rate limit exceeded
- **500**: Internal server error
- **501**: Method not implemented

#### Retry Mechanisms
- **longCall()**: 3 retries with 250ms sleep
- Allowed error codes for partial success
- Circuit breaker concept mentioned in requirements

#### Failure Recovery
- Offline peer tracking
- Periodic hello_peer health checks
- Automatic peer list updating
- Shard recalculation on peer failures

### 7. SPECIAL COMMUNICATION FEATURES

#### Waiter System
- Asynchronous coordination primitive
- Used in secretary consensus waiting
- Timeout-based with promise resolution
- Keys: WAIT_FOR_SECRETARY_ROUTINE, SET_WAIT_STATUS

#### Parallel Execution Optimization
- Promise.all() for shard broadcasts
- Individual promise then() handlers for aggregation
- Async result processing (pro/con counting)

#### Connection String Management
- Format: http://ip:port or exposedUrl
- Self-node detection (isLocalNode)
- Dynamic connection string updates
- Bootstrap from demos_peer.json

### 8. TCP PROTOCOL REQUIREMENTS DERIVED

#### Critical Features to Preserve

**1. Bidirectional Communication**
- Peers are both clients and servers
- Any node can initiate to any peer
- Response correlation required

**2. Message Ordering**
- Some consensus phases must be sequential
- Greenlight before next phase
- Block hash proposal before voting

**3. Parallel Message Handling**
- Multiple concurrent requests to different peers
- Async response aggregation
- Non-blocking server processing

**4. Session State**
- Peer online/offline tracking
- Sync status monitoring
- Validator phase coordination

**5. Message Size Handling**
- Variable-size payloads (transactions, peerlists)
- Large block data transmission
- Signature aggregation

#### Communication Frequency Estimates
Based on code analysis:
- **Hello_peer**: Every health check interval (periodic)
- **Consensus messages**: Every block time (~10s with 2s consensus window)
- **Mempool sync**: Once per consensus round
- **Peerlist sync**: Once per consensus round
- **Block hash broadcast**: 1 proposal + N responses per round
- **Validator phase updates**: ~5-10 per consensus round (per phase)
- **Greenlight signals**: 1 per phase transition

#### Peak Load Scenarios
- **Consensus round start**: Simultaneous mempool, peerlist, shard formation
- **Block hash voting**: Parallel signature collection from all shard members
- **Phase transitions**: Secretary greenlight + all validators acknowledging

### 9. COMPLETE MESSAGE TYPE MAPPING

#### Message Categories for TCP Encoding

**Category 0x0X - Control & Infrastructure**
- 0x00: ping
- 0x01: hello_peer
- 0x02: auth
- 0x03: nodeCall

**Category 0x1X - Transactions & Execution**
- 0x10: execute
- 0x11: nativeBridge
- 0x12: bridge

**Category 0x2X - Data Synchronization**
- 0x20: mempool
- 0x21: peerlist

**Category 0x3X - Consensus (PoRBFTv2)**
- 0x30: consensus_routine (generic)
- 0x31: proposeBlockHash
- 0x32: broadcastBlock
- 0x33: getCommonValidatorSeed
- 0x34: getValidatorTimestamp
- 0x35: setValidatorPhase
- 0x36: getValidatorPhase
- 0x37: greenlight
- 0x38: getBlockTimestamp

**Category 0x4X - GCR Operations**
- 0x40: gcr_routine (generic)
- 0x41: identity_assign_from_write
- 0x42: getIdentities
- 0x43: getWeb2Identities
- 0x44: getXmIdentities
- 0x45: getPoints
- 0x46: getTopAccountsByPoints
- 0x47: getReferralInfo
- 0x48: validateReferralCode
- 0x49: getAccountByIdentity

**Category 0x5X - Browser/Client**
- 0x50: login_request
- 0x51: login_response
- 0x52: web2ProxyRequest

**Category 0x6X - Admin Operations**
- 0x60: rate-limit/unblock
- 0x61: getCampaignData
- 0x62: awardPoints

**Category 0xFX - Protocol Meta**
- 0xF0: version negotiation
- 0xF1: capability exchange
- 0xF2: error response
- 0xFF: reserved

### 10. PERFORMANCE BENCHMARKS FROM HTTP

#### Timeout Configuration
- Default RPC timeout: 3000ms
- longCall sleep between retries: 250ms
- Secretary routine wait: 3000ms
- Consensus phase transition wait: 500ms check interval

#### Parallel Operations
- Shard size: Variable (based on validator set)
- Broadcast fanout: All shard members simultaneously
- Response aggregation: Promise.all() based

#### Rate Limiting
- Identity tx: 1 per IP per block
- General requests: Configurable per IP
- Whitelisted IPs: Unlimited

### 11. MISSING/DEPRECATED PATTERNS NOTED

**Deprecated (code comments indicate):**
- consensus_v1 vote mechanisms
- proofOfConsensus handler
- Some ShardManager methods moved to SecretaryManager

**Planned but not implemented:**
- Different node permission levels (mentioned in handshake)
- Some bridge chain-specific methods

**Edge Cases Found:**
- Consensus mode activation from external requests
- Shard membership validation on every consensus_routine
- Seed mismatch handling in setValidatorPhase
- Block reference tracking for phase coordination