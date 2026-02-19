# L2PS Code Patterns and Conventions

## File Locations

### Implemented Files
- L2PS Entity: `src/model/entities/L2PSMempool.ts`
- L2PS Mempool Manager: `src/libs/blockchain/l2ps_mempool.ts`
- L2PS Hash Service: `src/libs/l2ps/L2PSHashService.ts`
- L2PS Transaction Handler: `src/libs/network/routines/transactions/handleL2PS.ts`
- ParallelNetworks Manager: `src/libs/l2ps/parallelNetworks.ts`
- NodeCall Router: `src/libs/network/manageNodeCall.ts`
- Endpoint Handlers: `src/libs/network/endpointHandlers.ts`
- Startup Integration: `src/index.ts`

### Files to Create
- Validator Hash Storage: `src/model/entities/L2PSHashes.ts`
- Concurrent Sync Utilities: `src/libs/l2ps/L2PSConcurrentSync.ts`

### Files to Modify
- Sync Integration: `src/libs/blockchain/routines/Sync.ts` (add L2PS sync hooks)
- NodeCall Router: `src/libs/network/manageNodeCall.ts` (complete placeholders)
- Hash Update Handler: `src/libs/network/endpointHandlers.ts` (add storage logic)

## Service Pattern

Standard singleton service structure used throughout:

```typescript
export class ExampleService {
    private static instance: ExampleService | null = null
    private isRunning = false

    static getInstance(): ExampleService {
        if (!this.instance) {
            this.instance = new ExampleService()
        }
        return this.instance
    }

    async start(): Promise<void> {
        if (this.isRunning) {
            throw new Error("Service already running")
        }
        this.isRunning = true
        // Start work
    }

    async stop(): Promise<void> {
        if (!this.isRunning) return
        this.isRunning = false
        // Cleanup
    }
}
```

## NodeCall Pattern

**Structure** (from `manageNodeCall.ts`):

```typescript
export async function manageNodeCall(content: NodeCall): Promise<RPCResponse> {
    let response = _.cloneDeep(emptyResponse)
    response.result = 200

    switch (content.message) {
        case "exampleCall": {
            // Validate data
            if (!data.requiredField) {
                response.result = 400
                response.response = "Missing required field"
                break
            }

            // Process request
            const result = await someService.doWork(data)

            // Return response
            response.response = result
            break
        }
    }

    return response
}
```

**Making NodeCalls**:

```typescript
const result = await peer.call({
    method: "nodeCall",
    params: [{
        message: "getL2PSParticipationById",
        data: { l2psUid: "network_123" }
    }]
}, true) // true = authenticated call

if (result.result === 200) {
    // Success
    const data = result.response
}
```

**Parallel Peer Calls**:

```typescript
const promises = new Map<string, Promise<RPCResponse>>()
for (const peer of peers) {
    promises.set(peer.identity, peer.call(request, false))
}

const responses = new Map<string, RPCResponse>()
for (const [peerId, promise] of promises) {
    const response = await promise
    responses.set(peerId, response)
}
```

## Database Patterns

**Using TypeORM Repository**:

```typescript
public static repo: Repository<EntityName> = null

public static async init(): Promise<void> {
    const db = await Datasource.getInstance()
    this.repo = db.getDataSource().getRepository(EntityName)
}

// Find with options
const results = await this.repo.find({
    where: { field: value },
    order: { timestamp: "ASC" }
})

// Check existence
const exists = await this.repo.exists({ where: { field: value } })

// Save
await this.repo.save(entityInstance)
```

## Key Integration Points

### Shared State
**File**: `src/utilities/sharedState.ts`

```typescript
getSharedState.l2psJoinedUids // string[] - L2PS networks this node participates in
getSharedState.PROD // boolean - production mode flag
getSharedState.publicKeyHex // string - node identity
getSharedState.keypair // KeyPair - node keys
```

### ParallelNetworks (L2PS Network Manager)

```typescript
import ParallelNetworks from "@/libs/l2ps/parallelNetworks"

const parallelNetworks = ParallelNetworks.getInstance()
const l2psInstance = await parallelNetworks.getL2PS(l2psUid)

// Decrypt transaction
const decryptedTx = await l2psInstance.decryptTx(l2psTx)
```

### PeerManager

```typescript
import PeerManager from "@/libs/peer/PeerManager"

const peerManager = PeerManager.getInstance()
const allPeers = peerManager.getPeers() // Returns Peer[]
const specificPeer = peerManager.getPeer(identity)
```

### Sync Integration Points
**File**: `src/libs/blockchain/routines/Sync.ts`

Key functions to integrate L2PS sync:
- `mergePeerlist(block)`: Merge peers from block content (add L2PS participant exchange)
- `getHigestBlockPeerData(peers)`: Discover highest block peer (add L2PS participant discovery)
- `requestBlocks()`: Main block sync loop (add L2PS data sync alongside blocks)

## Logging

```typescript
import log from "@/utilities/logger"

log.info("[ServiceName] Informational message")
log.debug("[ServiceName] Debug details")
log.warning("[ServiceName] Warning message")
log.error("[ServiceName] Error occurred:", error)
log.custom("category", "message", logToFile)
```

## Important Constraints

1. **Do NOT overengineer**: Follow existing patterns, keep it simple
2. **Do NOT break existing sync**: L2PS sync should be additive, not disruptive
3. **Privacy first**: Never expose decrypted L2PS transaction content to validators
4. **Reuse infrastructure**: No new dependencies, use existing peer/network code
5. **Follow conventions**: Match logging style, naming patterns, file structure
6. **Concurrent sync**: L2PS sync must run concurrently with blockchain sync, not sequentially
