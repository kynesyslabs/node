# IPFS GCR Integration

## Overview
IPFS state is stored in the GCRMain entity's `ipfs` JSONB column.

## GCRMain Entity
```typescript
// src/model/entities/GCRv2/GCR_Main.ts
@Entity()
export class GCRMain {
  @PrimaryColumn()
  pubkey: string
  
  @Column({ type: 'jsonb', nullable: true })
  ipfs: AccountIPFSState
  
  // ... other columns
}
```

## AccountIPFSState Structure
```typescript
interface AccountIPFSState {
  pins: PinnedContent[]
  totalPinnedBytes: number
  earnedRewards: string      // BigInt as string
  paidCosts: string          // BigInt as string  
  freeAllocationBytes: number
  usedFreeBytes: number
  lastUpdated?: number
}

const DEFAULT_IPFS_STATE: AccountIPFSState = {
  pins: [],
  totalPinnedBytes: 0,
  earnedRewards: "0",
  paidCosts: "0",
  freeAllocationBytes: 0,
  usedFreeBytes: 0
}
```

## GCRIPFSRoutines Methods

### getIPFSState
```typescript
static async getIPFSState(pubkey: string, repository?): Promise<AccountIPFSState>
```
Returns account's IPFS state or default if none exists.

### addPin
```typescript
static async addPin(pubkey: string, pin: PinnedContent, repository?): Promise<OperationResult>
```
Adds pin to account, updates totalPinnedBytes, sets lastUpdated.
Uses per-pubkey locking to prevent race conditions.

### removePin
```typescript
static async removePin(pubkey: string, cid: string, repository?): Promise<OperationResult>
```
Removes pin by CID, adjusts totalPinnedBytes.

### updatePin (DEM-481)
```typescript
static async updatePin(
  pubkey: string, 
  cid: string, 
  updatedPin: Partial<PinnedContent>,
  repository?
): Promise<OperationResult>
```
Updates pin properties (e.g., expiresAt for extension).
CID and size are immutable.

### getPins
```typescript
static async getPins(pubkey: string, repository?): Promise<PinnedContent[]>
```
Returns just the pins array.

### isPinned
```typescript
static async isPinned(pubkey: string, cid: string, repository?): Promise<boolean>
```
Checks if specific CID is pinned by account.

### updateRewards / updateCosts
```typescript
static async updateRewards(pubkey: string, amount: bigint, repository?): Promise<OperationResult>
static async updateCosts(pubkey: string, amount: bigint, repository?): Promise<OperationResult>
```
Manages tokenomics tracking.

### cleanupExpiredPins
```typescript
static async cleanupExpiredPins(pubkey: string, repository?): Promise<OperationResult>
```
Removes expired pins from account state (not from IPFS node).

### getStats
```typescript
static async getStats(pubkey: string, repository?): Promise<{
  pinCount: number
  totalBytes: number
  earnedRewards: string
  paidCosts: string
  netBalance: string
}>
```

## Concurrency Control
Per-pubkey locking prevents race conditions:
```typescript
const pendingOperations = new Map<string, Promise<unknown>>()

async function withPubkeyLock<T>(pubkey: string, operation: () => Promise<T>): Promise<T> {
  const pending = pendingOperations.get(pubkey)
  if (pending) await pending.catch(() => {})
  
  const currentOp = operation()
  pendingOperations.set(pubkey, currentOp)
  
  try {
    return await currentOp
  } finally {
    if (pendingOperations.get(pubkey) === currentOp) {
      pendingOperations.delete(pubkey)
    }
  }
}
```

## Datasource Pattern
```typescript
const db = await Datasource.getInstance()
const repo = db.getDataSource().getRepository(GCRMain)
```
Note: `Datasource.getInstance()` returns a Promise.
