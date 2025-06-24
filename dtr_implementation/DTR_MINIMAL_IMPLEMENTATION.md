# DTR - Minimal Implementation Plan

## Core Philosophy: Leverage Everything, Add Almost Nothing

Instead of creating new services, we'll add DTR logic directly into existing flow with minimal code additions.

## Single Point of Modification

**File**: `src/libs/network/manageExecution.ts`
**Location**: After transaction validation, before mempool storage
**Addition**: ~20 lines of DTR logic

## Implementation Strategy

### Step 1: Add DTR Check Function (Minimal) ✅ **COMPLETED**

**File**: `src/libs/consensus/v2/routines/isValidator.ts` (NEW - 15 lines)

```typescript
import getShard from "./getShard"
import getCommonValidatorSeed from "./getCommonValidatorSeed"
import { getSharedState } from "../../../utilities/sharedState"

// Single function - reuses existing logic
export default async function isValidatorForNextBlock(): Promise<boolean> {
    try {
        const { commonValidatorSeed } = await getCommonValidatorSeed()
        const validators = await getShard(commonValidatorSeed)
        const ourIdentity = getSharedState.identity.ed25519.publicKey.toString("hex")
        return validators.some(peer => peer.identity === ourIdentity)
    } catch {
        return false // Conservative fallback
    }
}
```

### Step 2: Modify Transaction Processing (Single Integration Point) ✅ **COMPLETED**

**File**: `src/libs/network/endpointHandlers.ts`
**Modification**: Add DTR logic in `handleExecuteTransaction` before mempool storage

```typescript
// Add import
import isValidatorForNextBlock from "../consensus/v2/routines/isValidator"
import { PeerManager } from "../peer/PeerManager"

// In the broadcastTx section, BEFORE mempool.addTransaction():
if (process.env.DTR_ENABLED === "true") {
    const isValidator = await isValidatorForNextBlock()
    
    if (!isValidator) {
        // Relay instead of storing locally
        const validators = await getShard(await getCommonValidatorSeed().then(r => r.commonValidatorSeed))
        const relayTarget = validators.find(v => v.status.online && v.sync.status)
        
        if (relayTarget) {
            // Use existing P2P infrastructure
            await relayTarget.call({
                method: "nodeCall",
                params: [{
                    type: "RELAY_TX",
                    data: { transaction, validityData }
                }]
            }, true)
            return { result: 200, response: "Transaction relayed", extra: null }
        }
    }
}

// Continue with existing mempool.addTransaction() for validators
```

### Step 3: Handle Relayed Transactions (Extend Existing) ✅ **COMPLETED**

**File**: `src/libs/network/manageNodeCall.ts`
**Modification**: Add relay message handling with comprehensive validation

```typescript
case "RELAY_TX":
    // Verify we are actually a validator for next block
    const isValidator = await isValidatorForNextBlock()
    if (!isValidator) {
        response.result = 403
        response.response = "Node is not a validator for next block"
        break
    }

    const relayData = data as { transaction: Transaction; validityData: ValidityData }
    const { transaction, validityData } = relayData

    // Validate transaction coherence (hash matches content)
    const isCoherent = TxUtils.isCoherent(transaction)
    if (!isCoherent) {
        response.result = 400
        response.response = "Transaction coherence validation failed"
        break
    }

    // Validate transaction signature
    const signatureValid = TxUtils.validateSignature(transaction)
    if (!signatureValid) {
        response.result = 400
        response.response = "Transaction signature validation failed"
        break
    }

    // Add validated transaction to mempool
    await Mempool.addTransaction({
        ...transaction,
        reference_block: validityData.data.reference_block,
    })
    break
```

## Complete Implementation

### Total New Files: 1
- `src/libs/consensus/v2/routines/isValidator.ts` (15 lines)

### Total Modified Files: 2
- `src/libs/network/manageExecution.ts` (+10 lines)
- `src/libs/network/manageNodeCall.ts` (+5 lines)

### Total Code Addition: ~30 lines

## Configuration

**Environment Variable**: `DTR_ENABLED=true|false`
**Default**: `false` (backward compatible)

## How It Works

1. **Transaction arrives** → `manageExecution.ts`
2. **Validation happens** (existing code)
3. **DTR check**: If `DTR_ENABLED` and not validator → relay
4. **Relay**: Use existing `peer.call()` to validator
5. **Validator receives**: Handle via existing `manageNodeCall.ts` message system
6. **Validator stores**: Use existing `mempool.addTransaction()`

## Leverages Existing Infrastructure

- ✅ **Validator Selection**: Uses `getShard()` + `getCommonValidatorSeed()`
- ✅ **P2P Communication**: Uses `peer.call()`
- ✅ **Transaction Storage**: Uses `Mempool.addTransaction()`
- ✅ **Message Handling**: Extends existing peer message system
- ✅ **Error Handling**: Existing try/catch and logging
- ✅ **Configuration**: Existing environment variable system

## Zero New Dependencies

All functionality uses existing imports and patterns.

## Fallback Strategy

If relay fails or DTR is disabled → continues with existing behavior (local storage).

## Testing

Since we're reusing existing functions:
- **Unit Test**: Only test the 15-line `isValidator.ts`
- **Integration Test**: Test the relay message handling
- **Everything else**: Already tested in existing consensus system

This approach gives us DTR functionality with minimal risk and maximum reuse of battle-tested code.

## DTR Flow Diagram

### Current Implementation Flow

```
                                   Client Transaction
                                          │
                                          ▼
                                  ┌─────────────────┐
                                  │ RPC Endpoint    │
                                  │ server_rpc.ts   │
                                  └─────────┬───────┘
                                          │
                                          ▼
                                  ┌─────────────────┐
                                  │ Transaction     │
                                  │ Validation      │
                                  │ confirmTx       │
                                  └─────────┬───────┘
                                          │
                                          ▼
                                  ┌─────────────────┐
                                  │ Execute Handler │
                                  │ broadcastTx     │
                                  │ endpointHandlers│
                                  └─────────┬───────┘
                                          │
                                          ▼
                                  ┌─────────────────┐
                                  │ DTR_ENABLED?    │
                                  └─────┬─────┬─────┘
                                      NO│     │YES
                                        │     ▼
                                        │ ┌─────────────────┐
                                        │ │ isValidator()?  │
                                        │ └─────┬─────┬─────┘
                                        │    YES│     │NO
                                        │       │     ▼
                                        │       │ ┌─────────────────┐
                                        │       │ │ Find Validator  │
                                        │       │ │ getShard()      │
                                        │       │ └─────────┬───────┘
                                        │       │           │
                                        │       │           ▼
                                        │       │ ┌─────────────────┐
                                        │       │ │ Relay via P2P   │
                                        │       │ │ peer.call()     │
                                        │       │ └─────────┬───────┘
                                        │       │           │
                                        │       │           ▼
                                        │       │ ┌─────────────────┐
                                        │       │ │ RELAY_TX        │
                                        │       │ │ Message Sent    │
                                        │       │ └─────────┬───────┘
                                        │       │           │
                                        │       │           ▼
                                        │       │ ┌─────────────────┐
                                        │       │ │ Validator Node  │
                                        │       │ │ manageNodeCall  │
                                        │       │ └─────────┬───────┘
                                        │       │           │
                                        │       │           ▼
                                        │       │ ┌─────────────────┐
                                        │       │ │ Validate Relay  │
                                        │       │ │ • isValidator() │
                                        │       │ │ • isCoherent()  │
                                        │       │ │ • validateSig() │
                                        │       │ └─────────┬───────┘
                                        │       │           │
                                        ▼       ▼           ▼
                                  ┌─────────────────────────────┐
                                  │     Add to Mempool          │
                                  │   mempool.addTransaction()  │
                                  └─────────────┬───────────────┘
                                                │
                                                ▼
                                  ┌─────────────────────────────┐
                                  │     Consensus Process       │
                                  │    (unchanged - existing)   │
                                  └─────────────────────────────┘

Legend:
┌─────┐  Process/Function
│     │  
└─────┘  

▼        Flow Direction
│        
─        

┬─┐      Decision Branch
 │       
─┘       

DTR enabled nodes:
• Non-validators: Relay transactions (stateless)
• Validators: Store transactions locally (existing behavior)

DTR disabled nodes:
• All nodes: Store transactions locally (existing behavior)
```