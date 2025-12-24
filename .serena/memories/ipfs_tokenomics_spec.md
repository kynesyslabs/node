# IPFS Tokenomics Specification

> **Version**: 1.0 (MVP)
> **Status**: Ready for Review
> **Last Updated**: 2025-12-24

## Overview

This document specifies the economic model for IPFS integration in the Demos Network. The tokenomics system creates an additional revenue stream that incentivizes RPC operators to host pinned files.

## Design Principles

1. **Simplicity First**: Arweave-like one-time payment model
2. **Demos Native**: All fees paid in DEM token
3. **RPC Incentives**: Direct revenue to hosting nodes
4. **Future-Ready**: Architecture supports planned enhancements

---

## Pricing Model

### Regular Accounts

| Size Range | Cost (DEM) | Formula |
|------------|------------|---------|
| 0 - 100MB | 1 DEM | Minimum |
| 100MB - 200MB | 2 DEM | ceil(size / 100MB) |
| 200MB - 300MB | 3 DEM | ceil(size / 100MB) |
| ... | N DEM | ceil(size / 100MB) |

**Pricing Formula**:
```
cost = max(1, ceil(fileSizeBytes / (100 * 1024 * 1024)))
```

**Examples**:
- 50MB file → 1 DEM
- 100MB file → 1 DEM
- 101MB file → 2 DEM
- 250MB file → 3 DEM
- 1GB file → 11 DEM

### Genesis Accounts

Genesis accounts (addresses in genesis block) receive preferential pricing:

| Usage | Cost (DEM) | Notes |
|-------|------------|-------|
| First 1GB | **FREE** | No charge |
| After 1GB | 1 DEM per 1GB | Bulk discount |

**Genesis Pricing Formula**:
```
if (totalUsed + fileSize <= 1GB):
    cost = 0
else:
    chargeableBytes = fileSize - max(0, 1GB - totalUsed)
    cost = ceil(chargeableBytes / 1GB)
```

---

## Fee Distribution

### MVP (Current Implementation)

| Recipient | Share | Purpose |
|-----------|-------|---------|
| Hosting RPC | 100% | Direct revenue to storage provider |

### Future Target

| Recipient | Share | Purpose |
|-----------|-------|---------|
| Hosting RPC | 70% | Storage provider incentive |
| Treasury | 20% | Network development fund |
| Consensus Shard | 10% | Validator rewards |

---

## Storage Rules

### Duration
- **Model**: Permanent storage (pay once, stored indefinitely)
- **Persistence**: Content remains pinned until user explicitly unpins
- **Future**: Optional time-based renewal model

### Unpinning
- **Allowed**: Users can unpin their content at any time
- **Refund**: No refund on unpin (payment is final)
- **Effect**: Content removed from account state, RPC may garbage collect

### Replication
- **MVP**: Single node hosting (content on one RPC)
- **Future**: User-choice multi-node replication (pay per additional node)

---

## Transaction Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    IPFS Transaction Flow                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. USER SUBMITS TRANSACTION                                    │
│     └─ IPFS_ADD / IPFS_PIN with content + metadata              │
│                                                                 │
│  2. PRE-CONSENSUS VALIDATION                                    │
│     ├─ Calculate fee based on file size                         │
│     ├─ Check: user.balance >= calculated fee                    │
│     └─ REJECT if insufficient funds (before consensus)          │
│                                                                 │
│  3. CONSENSUS                                                   │
│     └─ Transaction included in block if valid                   │
│                                                                 │
│  4. EXECUTION (post-consensus)                                  │
│     ├─ Deduct fee from user account                             │
│     ├─ Credit fee to hosting RPC (100%)                         │
│     ├─ Execute IPFS operation (add/pin content)                 │
│     └─ Update user's IPFS state in GCR                          │
│                                                                 │
│  5. ON FAILURE                                                  │
│     └─ Revert fee deduction (atomic operation)                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Account State

### IPFS State Fields

```typescript
interface AccountIPFSState {
  // Content tracking
  pins: PinnedContent[];           // List of pinned content
  totalPinnedBytes: number;        // Total bytes currently pinned

  // Free tier tracking (Genesis accounts)
  freeAllocationBytes: number;     // Genesis: 1GB, Regular: 0
  usedFreeBytes: number;           // How much of free tier used

  // Economic tracking
  totalPaidDEM: bigint;            // Lifetime DEM spent on IPFS
  earnedRewardsDEM: bigint;        // Earned from hosting (future)
}

interface PinnedContent {
  cid: string;                     // IPFS content identifier
  size: number;                    // Size in bytes
  timestamp: number;               // When pinned
  metadata?: Record<string, any>;  // Optional user metadata
  wasFree: boolean;                // Pinned using free tier?
}
```

---

## Configuration

### Pricing Constants

```typescript
const IPFS_PRICING_CONFIG = {
  // Regular accounts
  REGULAR_MIN_COST: 1n,                          // 1 DEM minimum
  REGULAR_BYTES_PER_UNIT: 100 * 1024 * 1024,     // 100 MB
  REGULAR_COST_PER_UNIT: 1n,                     // 1 DEM per 100MB

  // Genesis accounts
  GENESIS_FREE_BYTES: 1024 * 1024 * 1024,        // 1 GB free
  GENESIS_BYTES_PER_UNIT: 1024 * 1024 * 1024,    // 1 GB
  GENESIS_COST_PER_UNIT: 1n,                     // 1 DEM per GB

  // Fee distribution (MVP)
  HOST_SHARE_PERCENT: 100,                       // 100% to host
  TREASURY_SHARE_PERCENT: 0,                     // 0% to treasury
  CONSENSUS_SHARE_PERCENT: 0,                    // 0% to consensus
};
```

---

## Free Allocation System

### Current Tiers

| Account Type | Free Allocation | Detection |
|--------------|-----------------|-----------|
| Regular | 0 bytes | Default |
| Genesis | 1 GB | In genesis block |

### Future Tiers (Architecture Ready)

| Account Type | Free Allocation | Detection |
|--------------|-----------------|-----------|
| Node Operators | TBD | Future: on-chain proof |
| Early Adopters | Configurable | Admin assignment |
| Promotional | Configurable | Campaign system |

---

## Future Enhancements (Not in MVP)

### Phase 2: Fee Distribution
- Implement 70/20/10 split (Host/Treasury/Consensus)
- Add treasury address configuration
- Integrate with consensus reward system

### Phase 3: Time-Based Renewal
- Optional expiration dates on pins
- Renewal transactions and pricing
- Grace periods before garbage collection

### Phase 4: Multi-Node Replication
- User-selected replication factor
- Pricing: base cost × replication factor
- Node selection and incentive distribution

### Phase 5: DEM Price Calculator
- Fiat-equivalent pricing display
- Dynamic pricing based on network demand
- Price oracle integration

### Phase 6: Node Operator Rewards
- Proof of storage verification
- Automatic reward distribution
- Uptime and availability bonuses

---

## API Reference

### Transaction Types

| Type | Description | Payload |
|------|-------------|---------|
| `IPFS_ADD` | Upload + auto-pin | `{ content: base64, filename?, metadata? }` |
| `IPFS_PIN` | Pin existing CID | `{ cid: string, metadata? }` |
| `IPFS_UNPIN` | Remove pin | `{ cid: string }` |

### demosCall Queries (Gas-Free)

| Method | Description | Returns |
|--------|-------------|---------|
| `ipfs_get(cid)` | Retrieve content | `Buffer` |
| `ipfs_pins(address?)` | List pins | `PinnedContent[]` |
| `ipfs_status()` | Node IPFS health | `IPFSStatus` |
| `ipfs_cost(size, address?)` | Calculate pin cost | `{ cost: bigint, breakdown }` |

---

## Security Considerations

1. **Balance Validation**: Always check before consensus to prevent spam
2. **Size Limits**: Enforce maximum file size per transaction
3. **Rate Limiting**: Consider per-account rate limits for abuse prevention
4. **Content Validation**: Validate content structure before pinning

---

## Beads Issue Reference

- **Phase 5 Issue**: `node-5l8`
- **Parent Epic**: `node-qz1` (IPFS Integration)
- **Depends On**: Phase 4 `node-xhh` (completed)
- **Blocks**: Phase 6 `node-9pb` (SDK Integration)
