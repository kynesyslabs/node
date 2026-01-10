# IPFS Technical Reference

## Key Files

### Infrastructure Layer
- `docker-compose.yml` - Kubo container (ipfs/kubo:v0.26.0)
- `src/features/ipfs/IPFSManager.ts` - Core IPFS operations

### State Management
- `src/model/entities/types/IPFSTypes.ts` - Type definitions
- `src/libs/blockchain/gcr/gcr_routines/GCRIPFSRoutines.ts` - Account state

### demosCall Handlers (Gas-Free)
- `src/libs/network/routines/nodecalls/ipfs/` - Handler implementations
- `src/libs/network/manageNodeCall.ts` - Switch dispatch

### Transaction Handlers (On-Chain)
- `src/libs/blockchain/routines/ipfsOperations.ts` - Operation handlers
- `src/libs/blockchain/routines/executeOperations.ts` - Dispatch

## Type Definitions

```typescript
interface PinnedContent {
    cid: string
    size: number
    timestamp: number
    metadata?: Record<string, unknown>
}

interface AccountIPFSState {
    pins: PinnedContent[]
    totalPinnedBytes: number
    earnedRewards: bigint
    paidCosts: bigint
}
```

## Singleton Access
```typescript
import { ensureIpfsManager } from "@/libs/network/routines/nodecalls/ipfs/ipfsManager"
const ipfs = await ensureIpfsManager()
```

## GCR State Operations
```typescript
import GCRIPFSRoutines from "@/libs/blockchain/gcr/gcr_routines/GCRIPFSRoutines"
await GCRIPFSRoutines.addPin(pubkey, { cid, size, timestamp })
await GCRIPFSRoutines.removePin(pubkey, cid)
```