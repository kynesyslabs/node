# OmniProtocol - Step 2: Complete Opcode Mapping

## Design Decisions

### Opcode Structure

Opcodes are organized into functional categories using the high nibble (first hex digit) as the category identifier:

```
0x0X - Control & Infrastructure (16 opcodes)
0x1X - Transactions & Execution (16 opcodes)
0x2X - Data Synchronization (16 opcodes)
0x3X - Consensus PoRBFTv2 (16 opcodes)
0x4X - GCR Operations (16 opcodes)
0x5X - Browser/Client Communication (16 opcodes)
0x6X - Admin Operations (16 opcodes)
0x7X-0xEX - Reserved for future categories (128 opcodes)
0xFX - Protocol Meta (16 opcodes)
```

## Complete Opcode Mapping

### 0x0X - Control & Infrastructure

Core node-to-node communication primitives.

| Opcode | Name | Description | Auth | Response |
|--------|------|-------------|------|----------|
| 0x00 | `ping` | Heartbeat/connectivity check | No | Yes |
| 0x01 | `hello_peer` | Peer handshake with sync data exchange | Yes | Yes |
| 0x02 | `auth` | Authentication message handling | Yes | Yes |
| 0x03 | `nodeCall` | Generic node call wrapper (HTTP compatibility) | No | Yes |
| 0x04 | `getPeerlist` | Request full peer list | No | Yes |
| 0x05 | `getPeerInfo` | Query specific peer information | No | Yes |
| 0x06 | `getNodeVersion` | Query node software version | No | Yes |
| 0x07 | `getNodeStatus` | Query node health/status | No | Yes |
| 0x08-0x0F | - | **Reserved** | - | - |

**Notes:**
- `nodeCall` (0x03) wraps all SDK-compatible query methods for backward compatibility
- Submethods include: getPeerlistHash, getLastBlockNumber, getBlockByNumber, getTxByHash, getAddressInfo, getTransactionHistory, etc.
- Deprecated methods (getAllTxs) remain accessible via nodeCall for compatibility

### 0x1X - Transactions & Execution

Transaction submission and cross-chain operations.

| Opcode | Name | Description | Auth | Response |
|--------|------|-------------|------|----------|
| 0x10 | `execute` | Execute transaction bundle | Yes | Yes |
| 0x11 | `nativeBridge` | Native bridge operation compilation | Yes | Yes |
| 0x12 | `bridge` | External bridge operation (Rubic) | Yes | Yes |
| 0x13 | `bridge_getTrade` | Get bridge trade quote | Yes | Yes |
| 0x14 | `bridge_executeTrade` | Execute bridge trade | Yes | Yes |
| 0x15 | `confirm` | Transaction validation/gas estimation | Yes | Yes |
| 0x16 | `broadcast` | Broadcast signed transaction | Yes | Yes |
| 0x17-0x1F | - | **Reserved** | - | - |

**Notes:**
- `execute` has rate limiting: 1 identity tx per IP per block
- Bridge operations (0x12-0x14) integrate with external Rubic API
- `confirm` and `broadcast` are used by SDK transaction flow

### 0x2X - Data Synchronization

Blockchain state and peer data synchronization.

| Opcode | Name | Description | Auth | Response |
|--------|------|-------------|------|----------|
| 0x20 | `mempool_sync` | Mempool synchronization | Yes | Yes |
| 0x21 | `mempool_merge` | Mempool merge request | Yes | Yes |
| 0x22 | `peerlist_sync` | Peerlist synchronization | Yes | Yes |
| 0x23 | `block_sync` | Block synchronization request | Yes | Yes |
| 0x24 | `getBlocks` | Fetch block range | No | Yes |
| 0x25 | `getBlockByNumber` | Fetch specific block by number | No | Yes |
| 0x26 | `getBlockByHash` | Fetch specific block by hash | No | Yes |
| 0x27 | `getTxByHash` | Fetch transaction by hash | No | Yes |
| 0x28 | `getMempool` | Get current mempool contents | No | Yes |
| 0x29-0x2F | - | **Reserved** | - | - |

**Notes:**
- Mempool operations (0x20-0x21) require authentication for security
- Block queries (0x24-0x27) are read-only, no auth required
- Used heavily during consensus round preparation

### 0x3X - Consensus (PoRBFTv2)

Proof of Reputation Byzantine Fault Tolerant consensus v2 messages.

| Opcode | Name | Description | Auth | Response |
|--------|------|-------------|------|----------|
| 0x30 | `consensus_generic` | Generic consensus routine wrapper | Yes | Yes |
| 0x31 | `proposeBlockHash` | Block hash proposal for voting | Yes | Yes |
| 0x32 | `voteBlockHash` | Vote on proposed block hash | Yes | Yes |
| 0x33 | `broadcastBlock` | Distribute finalized block | Yes | Yes |
| 0x34 | `getCommonValidatorSeed` | Seed synchronization (CVSA) | Yes | Yes |
| 0x35 | `getValidatorTimestamp` | Timestamp collection for averaging | Yes | Yes |
| 0x36 | `setValidatorPhase` | Validator reports phase to secretary | Yes | Yes |
| 0x37 | `getValidatorPhase` | Query validator phase status | Yes | Yes |
| 0x38 | `greenlight` | Secretary authorization signal | Yes | Yes |
| 0x39 | `getBlockTimestamp` | Query block timestamp from secretary | Yes | Yes |
| 0x3A | `validatorStatusSync` | Validator status synchronization | Yes | Yes |
| 0x3B-0x3F | - | **Reserved** | - | - |

**Notes:**
- All consensus messages require authentication (signature verification)
- Secretary Manager pattern: One node coordinates validator phases
- Messages only processed during consensus time window
- Shard membership validated before processing
- Deprecated v1 methods (vote, voteRequest) removed from protocol

**Secretary System Flow:**
1. `getCommonValidatorSeed` (0x34) - Deterministic shard formation
2. `setValidatorPhase` (0x36) - Validators report phase to secretary
3. `greenlight` (0x38) - Secretary authorizes phase transition
4. `proposeBlockHash` (0x31) - Secretary proposes, validators vote
5. `getValidatorTimestamp` (0x35) - Timestamp averaging for block

### 0x4X - GCR (Global Consensus Registry) Operations

Blockchain state queries and identity management.

| Opcode | Name | Description | Auth | Response |
|--------|------|-------------|------|----------|
| 0x40 | `gcr_generic` | Generic GCR routine wrapper | Yes | Yes |
| 0x41 | `gcr_identityAssign` | Infer identity from write operations | Yes | Yes |
| 0x42 | `gcr_getIdentities` | Get all identities for account | No | Yes |
| 0x43 | `gcr_getWeb2Identities` | Get Web2 identities only | No | Yes |
| 0x44 | `gcr_getXmIdentities` | Get crosschain identities only | No | Yes |
| 0x45 | `gcr_getPoints` | Get incentive points for account | No | Yes |
| 0x46 | `gcr_getTopAccounts` | Leaderboard query by points | No | Yes |
| 0x47 | `gcr_getReferralInfo` | Referral information lookup | No | Yes |
| 0x48 | `gcr_validateReferral` | Referral code validation | Yes | Yes |
| 0x49 | `gcr_getAccountByIdentity` | Account lookup by identity | No | Yes |
| 0x4A | `gcr_getAddressInfo` | Full address state query | No | Yes |
| 0x4B | `gcr_getAddressNonce` | ~~Get address nonce only~~ **REDUNDANT** | No | ~~Yes~~ N/A |
| 0x4C-0x4F | - | **Reserved** | - | - |

**Notes:**
- Read operations (0x42-0x47, 0x49-0x4A) typically don't require auth
- Write operations (0x41, 0x48) require authentication
- Used by SDK clients and inter-node GCR synchronization
- **0x41 Implementation**: Internal operation triggered by write transactions. Payload contains `GCREditIdentity` with context (xm/web2/pqc/ud), operation (add/remove), and context-specific identity data. Implemented via `GCRIdentityRoutines.apply()`.
- **0x4B Redundancy**: Nonce is already included in `gcr_getAddressInfo` (0x4A) response as `response.nonce` field. No separate opcode needed.

### 0x5X - Browser/Client Communication

Client-facing operations (future TCP client support).

| Opcode | Name | Description | Auth | Response |
|--------|------|-------------|------|----------|
| 0x50 | `login_request` | Browser login initiation | Yes | Yes |
| 0x51 | `login_response` | Browser login completion | Yes | Yes |
| 0x52 | `web2ProxyRequest` | Web2 proxy request handling | Yes | Yes |
| 0x53 | `getTweet` | Fetch tweet data through node | No | Yes |
| 0x54 | `getDiscordMessage` | Fetch Discord message through node | No | Yes |
| 0x55-0x5F | - | **Reserved** | - | - |

**Notes:**
- Currently used for browser-to-node communication (HTTP)
- Reserved for future native TCP client support
- Web2 proxy operations remain HTTP to external services
- Social media fetching (0x53-0x54) proxied through node

### 0x6X - Admin Operations

Protected administrative operations (SUDO_PUBKEY required).

| Opcode | Name | Description | Auth | Response |
|--------|------|-------------|------|----------|
| 0x60 | `admin_rateLimitUnblock` | Unblock IP from rate limiter | Yes* | Yes |
| 0x61 | `admin_getCampaignData` | Campaign data retrieval | Yes* | Yes |
| 0x62 | `admin_awardPoints` | Manual points award to users | Yes* | Yes |
| 0x63-0x6F | - | **Reserved** | - | - |

**Notes:**
- (*) Requires authentication + SUDO_PUBKEY verification
- Returns 401 if public key doesn't match SUDO_PUBKEY
- Used for operational management and manual interventions

### 0x7X-0xEX - Reserved Categories

Reserved for future protocol expansion.

| Range | Purpose | Notes |
|-------|---------|-------|
| 0x7X | Reserved | Future category |
| 0x8X | Reserved | Future category |
| 0x9X | Reserved | Future category |
| 0xAX | Reserved | Future category |
| 0xBX | Reserved | Future category |
| 0xCX | Reserved | Future category |
| 0xDX | Reserved | Future category |
| 0xEX | Reserved | Future category |

**Total Reserved:** 128 opcodes for future expansion

### 0xFX - Protocol Meta

Protocol-level operations and error handling.

| Opcode | Name | Description | Auth | Response |
|--------|------|-------------|------|----------|
| 0xF0 | `proto_versionNegotiate` | Protocol version negotiation | No | Yes |
| 0xF1 | `proto_capabilityExchange` | Capability/feature exchange | No | Yes |
| 0xF2 | `proto_error` | Protocol-level error message | No | No |
| 0xF3 | `proto_ping` | Protocol-level keepalive | No | Yes |
| 0xF4 | `proto_disconnect` | Graceful disconnect notification | No | No |
| 0xF5-0xFE | - | **Reserved** | - | - |
| 0xFF | `proto_reserved` | Reserved for future meta operations | - | - |

**Notes:**
- Protocol meta messages operate at connection/session level
- `proto_error` (0xF2) for protocol violations, not application errors
- `proto_ping` (0xF3) different from application `ping` (0x00)
- `proto_disconnect` (0xF4) allows graceful connection shutdown

## Opcode Assignment Rationale

### Category Organization

**Why category-based structure?**
1. **Quick identification**: High nibble instantly identifies message category
2. **Logical grouping**: Related operations grouped together for easier implementation
3. **Future expansion**: Each category has 16 slots, plenty of room for growth
4. **Reserved space**: 128 opcodes (0x7X-0xEX) reserved for entirely new categories

### Specific Opcode Choices

**0x00 (ping):**
- First opcode for most fundamental operation
- Simple connectivity check without complexity

**0x01 (hello_peer):**
- Second opcode for peer handshake (follows ping)
- Critical for peer discovery and connection establishment

**0x03 (nodeCall):**
- Kept as wrapper for HTTP backward compatibility
- All SDK-compatible methods route through this
- Allows gradual migration without breaking SDK clients

**0x30 (consensus_generic):**
- Generic wrapper for HTTP compatibility
- Specific consensus opcodes (0x31-0x3A) preferred for efficiency

**0x40 (gcr_generic):**
- Generic wrapper for HTTP compatibility
- Specific GCR opcodes (0x41-0x4B) preferred for efficiency

**0xF0-0xFF (Protocol Meta):**
- Highest category for protocol-level operations
- Distinguishes protocol messages from application messages

### Migration Strategy Opcodes

Some opcodes exist solely for HTTP-to-TCP migration:

- **0x03 (nodeCall)**: HTTP compatibility wrapper
- **0x30 (consensus_generic)**: HTTP compatibility wrapper
- **0x40 (gcr_generic)**: HTTP compatibility wrapper

These may be **deprecated** once full TCP migration is complete, with all messages using specific opcodes instead.

## Opcode Usage Patterns

### Request-Response Pattern (Most Messages)

```
Client → Server: [Header with Type=0x31] [Payload: block hash proposal]
Server → Client: [Header with Type=0x31, same Message ID] [Payload: status + vote]
```

### Fire-and-Forget Pattern

```
Node A → Node B: [Header with Type=0xF4, Flags bit 1=0] [Payload: disconnect reason]
(No response expected)
```

### Broadcast Pattern (Consensus)

```
Secretary → All Shard Members (parallel):
    [Header Type=0x31] [Payload: proposed block hash]
    
Shard Members → Secretary (individual responses):
    [Header Type=0x31, echo Message ID] [Payload: status + signature]
```

## HTTP to TCP Opcode Mapping

| HTTP Method | HTTP Endpoint | TCP Opcode | Notes |
|-------------|---------------|------------|-------|
| POST | `/` method: "execute" | 0x10 | Direct mapping |
| POST | `/` method: "hello_peer" | 0x01 | Direct mapping |
| POST | `/` method: "consensus_routine" | 0x30 | Wrapper (use specific 0x31-0x3A) |
| POST | `/` method: "gcr_routine" | 0x40 | Wrapper (use specific 0x41-0x4B) |
| POST | `/` method: "nodeCall" | 0x03 | Wrapper (keep for SDK compat) |
| POST | `/` method: "mempool" | 0x20 | Direct mapping |
| POST | `/` method: "peerlist" | 0x22 | Direct mapping |
| POST | `/` method: "bridge" | 0x12 | Direct mapping |
| GET | `/version` | 0x06 | Via nodeCall or direct |
| GET | `/peerlist` | 0x04 | Via nodeCall or direct |

## Security Considerations

### Authentication Requirements

**Always Require Auth (Flags bit 0 = 1):**
- All transaction operations (0x10-0x16)
- All consensus messages (0x30-0x3A)
- Mempool/peerlist sync (0x20-0x22)
- Admin operations (0x60-0x62)
- Write GCR operations (0x41, 0x48)

**No Auth Required (Flags bit 0 = 0):**
- Basic queries (ping, version, peerlist)
- Block/transaction queries (0x24-0x27)
- Read-only GCR operations (0x42-0x47, 0x49-0x4B)
- Protocol meta messages (0xF0-0xF4)

**Additional Verification:**
- Admin operations (0x60-0x62) require SUDO_PUBKEY match
- Consensus messages validate shard membership
- Rate limiting applied to 0x10 (execute)

### Opcode-Specific Security

**0x01 (hello_peer):**
- Establishes peer trust relationship
- Signature verification critical
- Sync data must be validated

**0x36 (setValidatorPhase):**
- CVSA seed validation prevents fork attacks
- Block reference tracking prevents replay
- Secretary identity verification required

**0x38 (greenlight):**
- Only valid from secretary node
- Timestamp validation for replay prevention

**0x10 (execute):**
- Rate limited: 1 identity tx per IP per block
- IP whitelist bypass for trusted nodes

## Performance Characteristics

### Expected Message Frequency

**High Frequency (per consensus round ~10s):**
- 0x34 (getCommonValidatorSeed): Once per round
- 0x36 (setValidatorPhase): 5-10 times per round (per validator)
- 0x38 (greenlight): Once per phase transition
- 0x20 (mempool_sync): Once per round
- 0x22 (peerlist_sync): Once per round

**Medium Frequency (periodic):**
- 0x01 (hello_peer): Health check interval
- 0x00 (ping): Periodic connectivity checks

**Low Frequency (on-demand):**
- 0x10 (execute): User transaction submissions
- 0x24-0x27 (block/tx queries): SDK client queries
- 0x4X (GCR queries): Application queries

### Message Size Estimates

| Opcode | Typical Size | Max Size |
|--------|--------------|----------|
| 0x00 (ping) | 50-100 bytes | 1 KB |
| 0x01 (hello_peer) | 500-1000 bytes | 5 KB |
| 0x10 (execute) | 500-2000 bytes | 100 KB |
| 0x20 (mempool_sync) | 10-100 KB | 10 MB |
| 0x22 (peerlist_sync) | 1-10 KB | 100 KB |
| 0x31 (proposeBlockHash) | 200-500 bytes | 5 KB |
| 0x33 (broadcastBlock) | 10-100 KB | 10 MB |

## Next Steps

1. **Payload Structure Design**: Define exact payload format for each opcode
2. **Submethod Encoding**: Design submethod field for wrapper opcodes (0x03, 0x30, 0x40)
3. **Error Code Mapping**: Define opcode-specific error responses
4. **Versioning Strategy**: How opcode mapping changes between protocol versions
