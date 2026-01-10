# IPFS Architecture Overview

## System Purpose
The Demos Network IPFS integration provides decentralized file storage with blockchain-backed ownership, tokenomics, and automatic lifecycle management.

## Core Components

### 1. IPFSManager (`src/features/ipfs/IPFSManager.ts`)
- Singleton service managing Helia IPFS node
- Handles pin/unpin operations at the IPFS layer
- Provides content retrieval and CID validation
- Manages node initialization and health

### 2. IPFS Operations (`src/libs/blockchain/routines/ipfsOperations.ts`)
- Transaction processing for IPFS operations
- Integrates with blockchain for ownership tracking
- Handles: ipfsAdd, ipfsPin, ipfsUnpin, ipfsExtendPin
- Coordinates with tokenomics for cost calculation

### 3. GCRIPFSRoutines (`src/libs/blockchain/gcr/gcr_routines/GCRIPFSRoutines.ts`)
- Account-level IPFS state management in GCR database
- Methods: addPin, removePin, updatePin, getPins, getIPFSState
- Tracks: pins, totalPinnedBytes, earnedRewards, paidCosts
- Per-pubkey locking prevents race conditions

### 4. ExpirationWorker (`src/features/ipfs/ExpirationWorker.ts`)
- Background service for expired pin cleanup
- Configurable check intervals and grace periods
- Batch processing with statistics tracking
- Queries GCRMain for accounts with IPFS pins

### 5. NodeCall Handlers (`src/libs/network/routines/nodecalls/ipfs/`)
- RPC endpoints for IPFS operations
- ipfsAdd, ipfsPin, ipfsUnpin, ipfsPins, ipfsListPins, ipfsQuota
- External-facing API for SDK and clients

## Data Flow

```
Client Request → NodeCall Handler → IPFS Operations → IPFSManager (Helia)
                                  ↓
                            GCRIPFSRoutines → GCRMain (PostgreSQL)
                                  ↓
                            IPFS Tokenomics → Balance deduction
```

## Key Entities

### PinnedContent (stored in GCRMain.ipfs.pins)
```typescript
{
  cid: string           // IPFS Content ID
  size: number          // Content size in bytes
  timestamp: number     // When pinned
  expiresAt?: number    // Expiration timestamp (DEM-481)
  metadata?: Record<string, unknown>
}
```

### AccountIPFSState (stored in GCRMain.ipfs)
```typescript
{
  pins: PinnedContent[]
  totalPinnedBytes: number
  earnedRewards: string    // BigInt as string
  paidCosts: string        // BigInt as string
  freeAllocationBytes: number
  usedFreeBytes: number
  lastUpdated?: number
}
```
