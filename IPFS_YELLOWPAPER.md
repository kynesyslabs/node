# Chapter: InterPlanetary File System (IPFS) Integration

## Abstract

This chapter specifies the integration of the InterPlanetary File System (IPFS) into the Demos Network, providing decentralized content-addressed storage with blockchain-backed economic incentives. The implementation enables users to store, retrieve, and share arbitrary data through a private IPFS network while leveraging the Demos token (DEM) for payment and incentive alignment. Key innovations include a tiered pricing model with genesis account benefits, time-limited pins with dynamic pricing, consensus-level quota enforcement, and a private swarm network for performance isolation.

---

## 1. Introduction

### 1.1 Motivation

Traditional centralized storage solutions present single points of failure, censorship vulnerabilities, and trust dependencies. IPFS provides content-addressed storage where data is identified by its cryptographic hash (Content Identifier, CID) rather than location, enabling:

- **Immutability**: Content cannot be modified without changing its CID
- **Deduplication**: Identical content shares the same CID network-wide
- **Resilience**: Content persists as long as at least one node pins it
- **Verifiability**: Clients can cryptographically verify received content

The Demos Network integrates IPFS to provide these benefits while adding:

- **Economic sustainability**: Token-based payments incentivize storage providers
- **Account integration**: Storage linked to Demos identity system
- **Quota enforcement**: Consensus-level limits prevent abuse
- **Time-limited storage**: Flexible pricing for temporary content

### 1.2 Design Goals

1. **Decentralization**: No single entity controls content storage or access
2. **Economic alignment**: Storage providers are compensated fairly
3. **Transparency**: All storage costs and quotas are deterministic
4. **Accessibility**: Genesis accounts receive preferential pricing
5. **Performance**: Private network isolation from public IPFS
6. **Security**: Robust validation prevents DoS and abuse

---

## 2. System Architecture

### 2.1 Component Overview

The IPFS integration consists of five primary components:

```
                                    ┌─────────────────────┐
                                    │   Client/DApp       │
                                    └──────────┬──────────┘
                                               │
                                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         Demos Node                                  │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────┐  │
│  │   RPC Layer      │───▶│  Transaction     │───▶│  GCR State   │  │
│  │   (NodeCalls)    │    │  Processing      │    │  Management  │  │
│  └──────────────────┘    └──────────────────┘    └──────────────┘  │
│           │                       │                                 │
│           ▼                       ▼                                 │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                      IPFSManager                              │  │
│  │   - Content operations (add, get, pin, unpin)                │  │
│  │   - Streaming support for large files                        │  │
│  │   - Swarm peer management                                    │  │
│  │   - Health monitoring                                        │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                  │                                  │
└──────────────────────────────────┼──────────────────────────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │      Kubo IPFS Daemon        │
                    │   (Docker Container)         │
                    │   - Kubo v0.26.0            │
                    │   - Private swarm mode      │
                    │   - HTTP API :54550         │
                    │   - Swarm :4001             │
                    └──────────────────────────────┘
```

### 2.2 Kubo IPFS Daemon

Each Demos node runs an isolated Kubo v0.26.0 instance in a Docker container with the following configuration:

| Parameter | Value | Description |
|-----------|-------|-------------|
| IPFS_PROFILE | `server` | Optimized for always-on operation |
| LIBP2P_FORCE_PNET | `1` | Enforces private network mode |
| API Port | `54550` | HTTP API (internal) |
| Gateway Port | `58080` | Read-only gateway |
| Swarm Port | `4001` | Peer-to-peer communication |

### 2.3 IPFSManager

The `IPFSManager` class serves as the interface between Demos and Kubo, providing:

- **Connection management**: Retry logic with exponential backoff (max 5 retries)
- **Content operations**: add(), get(), pin(), unpin(), getSize()
- **Streaming**: addStream(), getStream() for large files (256KB chunks)
- **Health monitoring**: Periodic health checks and peer count tracking
- **Swarm control**: Peer connection management and bootstrap configuration

### 2.4 State Management

Account IPFS state is stored in the Global Consensus Registry (GCR) as part of the `GCRMain` entity:

```typescript
interface AccountIPFSState {
    pins: PinnedContent[]      // List of pinned content
    totalPinnedBytes: number   // Cached total storage usage
    earnedRewards: string      // Cumulative hosting rewards (bigint as string)
    paidCosts: string          // Cumulative costs paid (bigint as string)
    freeAllocationBytes: number // Free tier allocation
    usedFreeBytes: number      // Free tier consumption
    lastUpdated?: number       // Last modification timestamp
}

interface PinnedContent {
    cid: string                // Content Identifier
    size: number               // Size in bytes
    timestamp: number          // Pin creation time (Unix ms)
    expiresAt?: number         // Optional expiration (Unix ms)
    duration?: number          // Original duration in seconds
    metadata?: object          // User-defined metadata
    wasFree?: boolean          // Used free tier flag
    freeBytes?: number         // Bytes covered by free tier
    costPaid?: string          // Cost paid in DEM
}
```

---

## 3. Transaction Operations

### 3.1 IPFS_ADD

Uploads content to IPFS and automatically pins it to the sender's account.

**Payload Structure:**
```typescript
{
    type: "ipfs_add",
    content: string,           // Base64-encoded content
    filename?: string,         // Optional filename
    duration?: PinDuration,    // Pin duration (default: "permanent")
    metadata?: object          // Optional metadata
}
```

**Execution Flow:**
1. Decode base64 content and calculate size
2. Determine account tier (genesis vs. regular)
3. Validate quota (byte limit and pin count)
4. Calculate cost with duration pricing multiplier
5. Validate payment (balance check, custom_charges if present)
6. Deduct fee and credit hosting RPC
7. Add content to IPFS via Kubo
8. Update account state with pin record

**Returns:** CID, size, cost, expiresAt, duration

### 3.2 IPFS_PIN

Pins an existing CID to the sender's account. Content must already exist on the IPFS network.

**Payload Structure:**
```typescript
{
    type: "ipfs_pin",
    cid: string,               // Content Identifier to pin
    duration?: PinDuration,    // Pin duration (default: "permanent")
    metadata?: object          // Optional metadata
}
```

**Execution Flow:**
1. Validate CID format
2. Verify content exists on IPFS (fetch size)
3. Check not already pinned by account
4. Validate quota
5. Calculate and process payment
6. Pin content locally
7. Update account state

### 3.3 IPFS_UNPIN

Removes a pin from the sender's account. Content may persist if pinned by other accounts.

**Payload Structure:**
```typescript
{
    type: "ipfs_unpin",
    cid: string                // Content Identifier to unpin
}
```

**Note:** No refund is issued upon unpinning. Payments are final per protocol specification.

### 3.4 IPFS_EXTEND_PIN

Extends the expiration time of an existing pin.

**Payload Structure:**
```typescript
{
    type: "ipfs_extend_pin",
    cid: string,                    // Content Identifier
    additionalDuration: PinDuration // Duration to add
}
```

**Execution Flow:**
1. Verify pin exists in account state
2. Validate extension duration
3. Calculate new expiration (from current expiration or now if expired)
4. Calculate extension cost (no free tier for extensions)
5. Process payment
6. Update pin with new expiration

---

## 4. Tokenomics

### 4.1 Pricing Model

The IPFS pricing model differentiates between regular and genesis accounts:

**Regular Accounts:**
| Metric | Value |
|--------|-------|
| Base Rate | 1 DEM per 100 MB |
| Minimum Cost | 1 DEM per operation |
| Free Allocation | None |

**Genesis Accounts:**
| Metric | Value |
|--------|-------|
| Free Allocation | 1 GB |
| Post-Free Rate | 1 DEM per 1 GB |
| Minimum Cost | 0 DEM (within free tier) |

### 4.2 Genesis Account Detection

Genesis accounts are identified by their presence in the genesis block's balance distribution:

```typescript
async function isGenesisAccount(address: string): Promise<boolean> {
    const genesisBlock = await Chain.getGenesisBlock()
    const balances = genesisBlock.content.extra.genesisData.balances
    return balances.some(([addr]) => addr.toLowerCase() === address.toLowerCase())
}
```

The genesis address cache is populated on first query and persists for node lifetime.

### 4.3 Duration-Based Pricing

Pin duration affects pricing through multipliers applied to the base cost:

| Duration | Seconds | Price Multiplier |
|----------|---------|------------------|
| `week` | 604,800 | 0.10 (90% discount) |
| `month` | 2,592,000 | 0.25 (75% discount) |
| `quarter` | 7,776,000 | 0.50 (50% discount) |
| `year` | 31,536,000 | 0.80 (20% discount) |
| `permanent` | ∞ | 1.00 (full price) |

**Custom Durations:**
- Minimum: 86,400 seconds (1 day)
- Maximum: 315,360,000 seconds (10 years)
- Multiplier formula: `0.1 + (duration / maxDuration) * 0.9`

### 4.4 Cost Calculation

The final cost for a pin operation:

```
baseCost = calculateBaseCost(sizeBytes, isGenesis, usedFreeBytes)
finalCost = baseCost × durationMultiplier
```

Where `calculateBaseCost` for genesis accounts:
```
remainingFree = freeAllocation - usedFreeBytes
if (size <= remainingFree):
    return 0
else:
    chargeableBytes = size - remainingFree
    return ceil(chargeableBytes / 1GB)
```

### 4.5 Fee Distribution

Current fee distribution (MVP phase):

| Recipient | Share |
|-----------|-------|
| Hosting RPC | 100% |
| Treasury | 0% |
| Consensus | 0% |

**Future Target:** 70% RPC / 20% Treasury / 10% Consensus

### 4.6 Custom Charges

To enable fair pricing for volatile content sizes, transactions may include `custom_charges`:

```typescript
{
    custom_charges: {
        ipfs: {
            max_cost_dem: "10.5"  // Maximum user agrees to pay
        }
    }
}
```

The node charges actual cost (≤ max_cost_dem), not the signed maximum.

---

## 5. Storage Quotas

### 5.1 Quota Tiers

Quotas are enforced at the consensus level to prevent abuse and ensure deterministic validation:

| Tier | Max Storage | Max Pins |
|------|-------------|----------|
| Regular | 1 GB | 1,000 |
| Genesis | 10 GB | 10,000 |
| Premium | 100 GB | 100,000 |

**Note:** Premium tier is reserved for future implementation.

### 5.2 Consensus-Critical Enforcement

All nodes MUST use identical quota values for consensus validity:

```typescript
const IPFS_QUOTA_LIMITS = {
    regular: { maxPinnedBytes: 1073741824, maxPinCount: 1000 },
    genesis: { maxPinnedBytes: 10737418240, maxPinCount: 10000 },
    premium: { maxPinnedBytes: 107374182400, maxPinCount: 100000 },
}
```

### 5.3 Quota Check Algorithm

```typescript
function checkQuota(state: AccountIPFSState, additionalBytes: number, tier: QuotaTier): QuotaCheckResult {
    const quota = IPFS_QUOTA_LIMITS[tier]
    const newTotal = state.totalPinnedBytes + additionalBytes
    const newPinCount = state.pins.length + 1

    if (newTotal > quota.maxPinnedBytes)
        return { allowed: false, error: "IPFS_QUOTA_EXCEEDED: byte limit" }
    if (newPinCount > quota.maxPinCount)
        return { allowed: false, error: "IPFS_QUOTA_EXCEEDED: pin count" }

    return { allowed: true }
}
```

---

## 6. Pin Expiration System

### 6.1 Overview

The pin expiration system enables time-limited storage with automatic cleanup, reducing long-term storage costs and encouraging efficient resource usage.

### 6.2 Duration Specification

Pins can specify duration as:
- **Preset names:** `permanent`, `week`, `month`, `quarter`, `year`
- **Custom seconds:** Any integer in range [86400, 315360000]

### 6.3 Expiration Worker

A background service monitors and manages expired pins:

**Configuration:**
| Parameter | Default | Description |
|-----------|---------|-------------|
| checkIntervalMs | 3,600,000 | Check interval (1 hour) |
| gracePeriodMs | 86,400,000 | Grace period (24 hours) |
| batchSize | 100 | Pins processed per cycle |
| enableUnpin | true | Actually unpin or just mark |

**Lifecycle:**
1. Periodic scan of all accounts with IPFS pins
2. Identify pins past `expiresAt` timestamp
3. Wait for grace period to elapse
4. Unpin from IPFS and remove from account state
5. Log cleanup statistics

### 6.4 Expiration Calculation

```typescript
function validatePinDuration(duration: PinDuration, currentTimestamp: number): DurationValidationResult {
    if (duration === "permanent")
        return { durationSeconds: 0, expiresAt: undefined, multiplier: 1.0 }

    const seconds = PIN_DURATION_SECONDS[duration] || duration
    return {
        durationSeconds: seconds,
        expiresAt: currentTimestamp + (seconds * 1000),
        pricingMultiplier: calculateMultiplier(seconds)
    }
}
```

---

## 7. Private Network

### 7.1 Swarm Key

The Demos network operates a private IPFS swarm, isolated from the public IPFS network for performance optimization:

**Official Demos Swarm Key:**
```
1d8b2cfa0ee76011ab655cec98be549f3f5cd81199b1670003ec37c0db0592e4
```

**File Format (swarm.key):**
```
/key/swarm/psk/1.0.0/
/base16/
1d8b2cfa0ee76011ab655cec98be549f3f5cd81199b1670003ec37c0db0592e4
```

### 7.2 Security Model

**Important:** The swarm key is intentionally public. It provides:
- ✅ **Performance isolation** from public IPFS network noise
- ✅ **Dedicated peer discovery** among Demos nodes
- ❌ **NOT access control** (blockchain auth handles this)
- ❌ **NOT content encryption** (IPFS content is public by design)

Security guarantees are provided by:
- **Write access:** Requires DEM tokens via signed transactions
- **Identity:** Demos blockchain identity and authentication
- **Consensus:** All operations validated by network consensus

### 7.3 Bootstrap Nodes

Nodes discover peers through bootstrap nodes configured via environment:

```bash
DEMOS_IPFS_BOOTSTRAP_NODES="/ip4/1.2.3.4/tcp/4001/p2p/Qm...,/ip4/5.6.7.8/tcp/4001/p2p/Qm..."
```

### 7.4 Peer Management

| Parameter | Default | Description |
|-----------|---------|-------------|
| DEMOS_IPFS_MAX_PEERS | 100 | Maximum peer connections |
| DEMOS_IPFS_MIN_PEERS | 4 | Minimum peers to maintain |
| PEER_DISCOVERY_INTERVAL | 60s | Discovery check interval |
| PEER_CONNECT_TIMEOUT | 10s | Connection timeout |

---

## 8. Public Bridge (Optional)

### 8.1 Overview

The public bridge provides optional access to the public IPFS network for content retrieval. Disabled by default.

### 8.2 Configuration

```bash
DEMOS_IPFS_PUBLIC_BRIDGE_ENABLED=true
DEMOS_IPFS_PUBLIC_GATEWAY=https://ipfs.io
DEMOS_IPFS_ALLOW_PUBLIC_PUBLISH=false
DEMOS_IPFS_PUBLIC_TIMEOUT=30000
DEMOS_IPFS_PUBLIC_MAX_REQUESTS=30
DEMOS_IPFS_PUBLIC_MAX_BYTES=104857600  # 100 MB
```

### 8.3 Fallback Gateways

When the primary gateway fails, the system attempts fallbacks:
1. `https://ipfs.io`
2. `https://dweb.link`
3. `https://cloudflare-ipfs.com`
4. `https://gateway.pinata.cloud`

### 8.4 Rate Limiting

Public bridge access is rate-limited per minute:
- Maximum requests: 30/minute
- Maximum bytes: 100 MB/minute
- Automatic reset after window expires

---

## 9. RPC Endpoints

### 9.1 Content Operations

| Endpoint | Description |
|----------|-------------|
| `ipfs_add` | Add and pin content |
| `ipfs_get` | Retrieve content by CID |
| `ipfs_pin` | Pin existing CID |
| `ipfs_unpin` | Unpin content |
| `ipfs_list_pins` | List node's pinned CIDs |
| `ipfs_pins` | List account's pinned content |

### 9.2 Streaming (Large Files)

| Endpoint | Description |
|----------|-------------|
| `ipfs_add_stream` | Stream upload with progress |
| `ipfs_get_stream` | Stream download for large files |

**Streaming Configuration:**
- Chunk size: 256 KB
- Extended timeout: 10× normal timeout
- Progress callbacks supported

### 9.3 Status & Quota

| Endpoint | Description |
|----------|-------------|
| `ipfs_status` | Node health and peer count |
| `ipfs_quota` | Account quota usage |
| `ipfs_quote` | Cost estimation for operation |

### 9.4 Swarm Management

| Endpoint | Description |
|----------|-------------|
| `ipfs_swarm_peers` | Connected peers list |
| `ipfs_swarm_connect` | Connect to peer |
| `ipfs_swarm_disconnect` | Disconnect from peer |
| `ipfs_bootstrap_list` | Bootstrap nodes |
| `ipfs_demos_peers` | Demos network peers |
| `ipfs_cluster_pin` | Cluster-wide pinning |

### 9.5 Public Bridge

| Endpoint | Description |
|----------|-------------|
| `ipfs_public_fetch` | Fetch from public gateway |
| `ipfs_public_publish` | Publish to public IPFS |
| `ipfs_public_check` | Check public availability |
| `ipfs_rate_limit_status` | Public bridge rate limits |

---

## 10. Error Handling

### 10.1 Error Hierarchy

```
IPFSError (base)
├── IPFSConnectionError    // Node unreachable
├── IPFSTimeoutError       // Operation timeout
├── IPFSNotFoundError      // Content not found
├── IPFSInvalidCIDError    // Invalid CID format
└── IPFSAPIError           // Kubo API error
```

### 10.2 Error Codes

| Code | Description |
|------|-------------|
| `IPFS_CONNECTION_ERROR` | Cannot reach IPFS daemon |
| `IPFS_TIMEOUT_ERROR` | Operation exceeded timeout |
| `IPFS_NOT_FOUND` | CID not found on network |
| `IPFS_INVALID_CID` | Malformed CID format |
| `IPFS_API_ERROR` | Kubo returned error |
| `IPFS_QUOTA_EXCEEDED` | Account quota exceeded |
| `IPFS_INVALID_DURATION` | Invalid pin duration |

### 10.3 CID Validation

Valid CID formats:
- **CIDv0:** `Qm[base58]{44}` (46 characters total)
- **CIDv1:** `(bafy|bafk|bafz|bafb)[base32]{50+}`

### 10.4 Input Validation

All numeric inputs are validated for:
- NaN values (rejected)
- Negative values (rejected)
- Integer overflow (bounded)

---

## 11. Security Considerations

### 11.1 Denial of Service Prevention

- **Quota enforcement:** Consensus-level storage limits
- **Rate limiting:** Public bridge request throttling
- **Input validation:** NaN, negative, and overflow checks
- **Content size limits:** 16 MB maximum for NodeCall operations

### 11.2 Economic Attack Prevention

- **Balance verification:** Pre-check before operations
- **Custom charges:** Users sign maximum acceptable cost
- **No refunds:** Prevents refund abuse on unpin

### 11.3 Network Security

- **Private swarm:** Isolated from public IPFS noise
- **Blockchain auth:** All writes require valid transactions
- **Consensus validation:** All operations verified by network

---

## 12. Implementation Phases

The IPFS integration was developed across 10 phases:

| Phase | Feature | Status |
|-------|---------|--------|
| 1 | Basic IPFS daemon integration | ✅ Complete |
| 2 | Core RPC operations | ✅ Complete |
| 3 | Account state schema | ✅ Complete |
| 4 | Transaction handlers | ✅ Complete |
| 5 | Tokenomics integration | ✅ Complete |
| 6 | Private swarm network | ✅ Complete |
| 7 | Public bridge (optional) | ✅ Complete |
| 8 | Streaming support | ✅ Complete |
| 9 | Custom charges & TUI | ✅ Complete |
| 10 | Pin expiration system | ✅ Complete |

---

## 13. Configuration Reference

### 13.1 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IPFS_API_PORT` | 54550 | Kubo HTTP API port |
| `IPFS_VERBOSE_LOGGING` | false | Debug logging |
| `DEMOS_IPFS_SWARM_KEY` | (built-in) | Private network key |
| `DEMOS_IPFS_BOOTSTRAP_NODES` | - | Bootstrap multiaddresses |
| `LIBP2P_FORCE_PNET` | 1 | Force private network |
| `DEMOS_IPFS_MAX_PEERS` | 100 | Max peer connections |
| `DEMOS_IPFS_MIN_PEERS` | 4 | Min peer connections |
| `DEMOS_IPFS_PUBLIC_BRIDGE_ENABLED` | false | Enable public bridge |
| `DEMOS_IPFS_PUBLIC_GATEWAY` | https://ipfs.io | Public gateway URL |
| `DEMOS_IPFS_ALLOW_PUBLIC_PUBLISH` | false | Allow public publishing |

### 13.2 Docker Compose Configuration

```yaml
services:
  ipfs:
    image: ipfs/kubo:v0.26.0
    environment:
      IPFS_PROFILE: server
      IPFS_GATEWAY_WRITABLE: "false"
      LIBP2P_FORCE_PNET: "1"
    ports:
      - "4001:4001"      # Swarm
      - "54550:5001"     # API
    volumes:
      - ./data_53550/ipfs:/data/ipfs
```

---

## 14. Future Considerations

### 14.1 Planned Enhancements

- **Fee distribution:** 70/20/10 split (RPC/Treasury/Consensus)
- **Dynamic pricing:** Demand-based rate adjustment
- **Cluster replication:** Multi-node content redundancy
- **Node operator rewards:** Incentives for storage providers
- **Premium tier activation:** Enhanced quotas for subscribers

### 14.2 Protocol Upgrades

Any changes to:
- Quota limits
- Pricing multipliers
- Duration constraints
- Fee distribution

Must be coordinated as consensus-breaking changes requiring network-wide upgrade.

---

## Appendix A: Constants Summary

```typescript
// Pricing
REGULAR_MIN_COST = 1n DEM
REGULAR_BYTES_PER_UNIT = 104,857,600 bytes (100 MB)
GENESIS_FREE_BYTES = 1,073,741,824 bytes (1 GB)
GENESIS_BYTES_PER_UNIT = 1,073,741,824 bytes (1 GB)

// Quotas
REGULAR_MAX_BYTES = 1,073,741,824 bytes (1 GB)
REGULAR_MAX_PINS = 1,000
GENESIS_MAX_BYTES = 10,737,418,240 bytes (10 GB)
GENESIS_MAX_PINS = 10,000

// Durations (seconds)
PIN_WEEK = 604,800
PIN_MONTH = 2,592,000
PIN_QUARTER = 7,776,000
PIN_YEAR = 31,536,000
MIN_CUSTOM = 86,400 (1 day)
MAX_CUSTOM = 315,360,000 (10 years)

// Pricing Multipliers
WEEK_MULTIPLIER = 0.10
MONTH_MULTIPLIER = 0.25
QUARTER_MULTIPLIER = 0.50
YEAR_MULTIPLIER = 0.80
PERMANENT_MULTIPLIER = 1.00

// Timeouts
DEFAULT_TIMEOUT = 30,000 ms
STREAM_CHUNK_SIZE = 262,144 bytes (256 KB)
EXPIRATION_CHECK_INTERVAL = 3,600,000 ms (1 hour)
EXPIRATION_GRACE_PERIOD = 86,400,000 ms (24 hours)
```

---

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| **CID** | Content Identifier - cryptographic hash uniquely identifying content |
| **Pin** | Marking content to prevent garbage collection |
| **Kubo** | Go implementation of IPFS (formerly go-ipfs) |
| **Swarm** | IPFS peer-to-peer network layer |
| **Swarm Key** | Pre-shared key defining a private IPFS network |
| **GCR** | Global Consensus Registry - Demos account state storage |
| **Genesis Account** | Account with balance in the genesis block |
| **NodeCall** | RPC endpoint for node operations |
| **Free Tier** | Genesis account's complimentary storage allocation |
