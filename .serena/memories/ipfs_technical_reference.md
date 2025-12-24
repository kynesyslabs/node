# IPFS Technical Reference

## Key Files

### Infrastructure Layer
- `docker-compose.yml` - Kubo container definition (ipfs/kubo:v0.26.0)
- `src/features/ipfs/IPFSManager.ts` - Core IPFS operations wrapper

### State Management
- `src/model/entities/types/IPFSTypes.ts` - Type definitions (PinnedContent, AccountIPFSState)
- `src/libs/blockchain/gcr/gcr_routines/GCRIPFSRoutines.ts` - Account state operations

### demosCall Handlers (Gas-Free Reads)
- `src/libs/network/routines/nodecalls/ipfs/index.ts` - Handler exports
- `src/libs/network/routines/nodecalls/ipfs/ipfsManager.ts` - Singleton access
- `src/libs/network/manageNodeCall.ts` - Switch dispatch for demosCall

### Transaction Handlers (On-Chain Writes)
- `src/libs/blockchain/routines/ipfsOperations.ts` - Operation handlers
- `src/libs/blockchain/routines/executeOperations.ts` - Operation dispatch

### SDK Types (v2.6.0+)
- `../sdks/src/types/blockchain/TransactionSubtypes/IPFSTransaction.ts`
- Exports: `IPFSOperationType`, `IPFSPayload`, `IPFSAddPayload`, `IPFSPinPayload`, `IPFSUnpinPayload`
- Type guards: `isIPFSAddPayload`, `isIPFSPinPayload`, `isIPFSUnpinPayload`, `isIPFSPayload`

## Type Definitions

### PinnedContent (Node)
```typescript
interface PinnedContent {
    cid: string
    size: number
    timestamp: number
    metadata?: Record<string, unknown>
    expiresAt?: number
}
```

### AccountIPFSState (Node)
```typescript
interface AccountIPFSState {
    pins: PinnedContent[]
    totalPinnedBytes: number
    earnedRewards: bigint
    paidCosts: bigint
}
```

### IPFSPayload Types (SDK)
```typescript
type IPFSOperationType = "IPFS_ADD" | "IPFS_PIN" | "IPFS_UNPIN"

interface IPFSAddPayload {
    operation: "IPFS_ADD"
    content: string  // base64 encoded
    filename?: string
    metadata?: Record<string, unknown>
}

interface IPFSPinPayload {
    operation: "IPFS_PIN"
    cid: string
    duration?: number
    metadata?: Record<string, unknown>
}

interface IPFSUnpinPayload {
    operation: "IPFS_UNPIN"
    cid: string
}
```

## Operation Flow

### demosCall (Gas-Free Read)
```
Client → RPC → manageNodeCall.ts → ipfs/* handlers → IPFSManager → Kubo API
```

### Transaction (On-Chain Write)
```
Client → RPC → Validation → Consensus → executeOperations.ts → IPFSOperations → IPFSManager + GCRIPFSRoutines
```

## Singleton Access Pattern
```typescript
import { getIpfsManager, ensureIpfsManager } from "@/libs/network/routines/nodecalls/ipfs/ipfsManager"

// Ensure initialized
await ensureIpfsManager()

// Get instance
const ipfs = getIpfsManager()
if (ipfs && ipfs.isInitialized()) {
    const cid = await ipfs.add(content)
}
```

## GCR State Operations
```typescript
import GCRIPFSRoutines from "@/libs/blockchain/gcr/gcr_routines/GCRIPFSRoutines"

// Add pin to account
await GCRIPFSRoutines.addPin(pubkey, { cid, size, timestamp })

// Remove pin
await GCRIPFSRoutines.removePin(pubkey, cid)

// Check if pinned
const isPinned = await GCRIPFSRoutines.isPinned(pubkey, cid)

// Get full state
const state = await GCRIPFSRoutines.getIPFSState(pubkey)
```
