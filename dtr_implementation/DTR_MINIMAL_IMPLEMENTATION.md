# DTR - Minimal Implementation Plan

## Core Philosophy: Leverage Everything, Add Almost Nothing

Instead of creating new services, we'll add DTR logic directly into existing flow with minimal code additions.

## Single Point of Modification

**File**: `src/libs/network/endpointHandlers.ts`
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
        const ourIdentity =
            getSharedState.identity.ed25519.publicKey.toString("hex")
        return validators.some(peer => peer.identity === ourIdentity)
    } catch {
        return false // Conservative fallback
    }
}
```

### Step 2: Enhanced Transaction Processing with Multi-Validator Retry ✅ **COMPLETED**

**File**: `src/libs/network/endpointHandlers.ts`
**Modification**: Add comprehensive DTR logic with all-validator retry and fallback

```typescript
// DTR: Check if we should relay instead of storing locally (Production only)
if (getSharedState.PROD) {
    const isValidator = await isValidatorForNextBlock()

    if (!isValidator) {
        console.log(
            "[DTR] Non-validator node: attempting relay to all validators",
        )
        try {
            const { commonValidatorSeed } = await getCommonValidatorSeed()
            const validators = await getShard(commonValidatorSeed)
            const availableValidators = validators
                .filter(v => v.status.online && v.sync.status)
                .sort(() => Math.random() - 0.5) // Random order for load balancing

            // Try ALL validators in random order
            for (const validator of availableValidators) {
                try {
                    const relayResult = await validator.call(
                        {
                            method: "nodeCall",
                            params: [
                                {
                                    type: "RELAY_TX",
                                    data: { transaction, validityData },
                                },
                            ],
                        },
                        true,
                    )

                    if (relayResult.result === 200) {
                        return {
                            success: true,
                            response: "Transaction relayed to validator",
                        }
                    }
                } catch (error) {
                    continue // Try next validator
                }
            }

            console.log(
                "[DTR] All validators failed, storing locally for background retry",
            )
        } catch (relayError) {
            console.log(
                "[DTR] Relay system error, storing locally:",
                relayError,
            )
        }

        // Store ValidityData for retry service
        getSharedState.validityDataCache.set(transaction.hash, validityData)
    }
}

// Continue with mempool.addTransaction() (validators or fallback)
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

### Total New Files: 2

- `src/libs/consensus/v2/routines/isValidator.ts` (15 lines)
- `src/libs/network/dtr/dtrmanager.ts` (240 lines) - Background retry service

### Total Modified Files: 4

- `src/libs/network/endpointHandlers.ts` (+50 lines) - Enhanced DTR logic with multi-validator retry
- `src/libs/network/manageNodeCall.ts` (+55 lines) - RELAY_TX handler with validation
- `src/libs/blockchain/mempool_v2.ts` (+20 lines) - removeTransaction method
- `src/utilities/sharedState.ts` (+3 lines) - ValidityData cache
- `src/index.ts` (+25 lines) - Service startup and graceful shutdown

### Total Code Addition: ~400 lines

## Configuration

**Activation**: Automatically enabled when `PROD=true` in production mode
**Development**: Disabled in development mode for testing flexibility
**Default**: Controlled by existing `PROD` environment variable

## How It Works

### Immediate Relay (Real-time)

1. **Transaction arrives** → `manageExecution.ts` → `endpointHandlers.ts`
2. **Validation happens** (existing code)
3. **DTR check**: If `PROD=true` and not validator → attempt relay to ALL validators
4. **Multi-validator relay**: Try all available validators in random order
5. **Success**: Return immediately if any validator accepts
6. **Fallback**: Store locally with ValidityData cache if all validators fail

### Background Retry (Continuous)

1. **Service runs**: Every 10 seconds on non-validator nodes after sync
2. **Block-aware**: Recalculates validator set only when block number changes
3. **Mempool scan**: Processes all transactions in local mempool
4. **Retry logic**: Attempts relay with fresh validator set, gives up after 10 attempts
5. **Cleanup**: Removes successfully relayed transactions from local mempool

## Leverages Existing Infrastructure

- ✅ **Validator Selection**: Uses `getShard()` + `getCommonValidatorSeed()`
- ✅ **P2P Communication**: Uses `peer.call()`
- ✅ **Transaction Storage**: Uses `Mempool.addTransaction()`
- ✅ **Message Handling**: Extends existing peer message system
- ✅ **Error Handling**: Existing try/catch and logging
- ✅ **Configuration**: Existing environment variable system

## Zero New Dependencies

All functionality uses existing imports and patterns.

## Enhanced Fallback Strategy

### Immediate Fallback

- **All validators fail** → Store in local mempool with ValidityData cache
- **Network issues** → Graceful degradation to local storage
- **Service errors** → Continue with existing transaction processing

### Continuous Retry

- **Background service** → Continuously attempts to relay cached transactions
- **Block-aware optimization** → Only recalculates validators when block changes
- **Bounded retries** → Gives up after 10 attempts to prevent infinite loops
- **Memory management** → Cleans up ValidityData cache on success/failure

## Testing

Since we're reusing existing functions:

- **Unit Test**: Only test the 15-line `isValidator.ts`
- **Integration Test**: Test the relay message handling
- **Everything else**: Already tested in existing consensus system

This approach provides production-ready DTR functionality with comprehensive retry mechanisms and robust fallback strategies.

## Key Improvements Implemented

### Enhanced Reliability

- **Multi-validator retry**: Attempts relay to ALL available validators in random order
- **Background retry service**: Continuously retries failed transactions every 10 seconds
- **Block-aware optimization**: Only recalculates validators when block number changes
- **Graceful fallback**: Maintains local storage as safety net without undermining DTR goals

### Load Balancing & Performance

- **Random validator selection**: Distributes load evenly across validator set
- **ValidityData caching**: Stores validation data in memory for retry attempts
- **Bounded retry logic**: Prevents infinite retry loops with 10-attempt limit
- **Sync-aware processing**: Only processes when node is fully synchronized

### Memory & Resource Management

- **Automatic cleanup**: Removes ValidityData cache on successful relay or max attempts
- **Service lifecycle**: Proper startup after sync and graceful shutdown handling
- **Production-only activation**: DTR only runs in production mode (`PROD=true`)
- **Mempool integration**: Seamlessly removes relayed transactions from local storage

## Enhanced DTR Flow Diagram

### Production Implementation Flow

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
                                    │   PROD=true?    │
                                    └─────┬─────┬─────┘
                                        NO│     │YES
                                          │     ▼
                                          │ ┌─────────────────┐
                                          │ │ isValidator()?  │
                                          │ └─────┬─────┬─────┘
                                          │    YES│     │NO
                                          │       │     ▼
                                          │       │ ┌─────────────────┐
                                          │       │ │ Get ALL         │
                                          │       │ │ Validators      │
                                          │       │ │ getShard()      │
                                          │       │ └─────────┬───────┘
                                          │       │           │
                                          │       │           ▼
                                          │       │ ┌─────────────────┐
                                          │       │ │ Try ALL         │
                                          │       │ │ Validators      │
                                          │       │ │ (Random Order)  │
                                          │       │ └─────────┬───────┘
                                          │       │           │
                                          │       │           ▼
                                          │       │ ┌─────────────────┐
                                          │       │ │ Any Success?    │
                                          │       │ └─────┬─────┬─────┘
                                          │       │    YES│     │NO
                                          │       │       │     ▼
                                          │       │       │ ┌─────────────────┐
                                          │       │       │ │ Store ValidData │
                                          │       │       │ │ in Cache        │
                                          │       │       │ └─────────┬───────┘
                                          │       │       │           │
                                          │       │       ▼           ▼
                                          │       │ ┌─────────────────────────────┐
                                          │       │ │ Return Success or Continue  │
                                          │       │ │ to Local Mempool           │
                                          │       │ └─────────┬───────────────────┘
                                          │       │           │
                                          ▼       ▼           ▼
                                    ┌─────────────────────────────┐
                                    │     Add to Local Mempool    │
                                    │   mempool.addTransaction()  │
                                    └─────────────┬───────────────┘
                                                  │
                            ┌─────────────────────┼─────────────────────┐
                            ▼                     ▼                     ▼
                    ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
                    │ Consensus       │  │ Background      │  │ RELAY_TX        │
                    │ Process         │  │ Retry Service   │  │ Handler         │
                    │ (unchanged)     │  │ (every 10s)     │  │ (validators)    │
                    └─────────────────┘  └─────────┬───────┘  └─────────┬───────┘
                                                   │                     │
                                                   ▼                     ▼
                                         ┌─────────────────┐    ┌─────────────────┐
                                         │ Synced &        │    │ Validate Relay: │
                                         │ Non-validator?  │    │ • isValidator() │
                                         └─────────┬───────┘    │ • isCoherent()  │
                                                   │ YES        │ • validateSig() │
                                                   ▼            └─────────┬───────┘
                                         ┌─────────────────┐              │
                                         │ Process Entire  │              ▼
                                         │ Local Mempool   │    ┌─────────────────┐
                                         └─────────┬───────┘    │ Add to Validator│
                                                   │            │ Mempool         │
                                                   ▼            └─────────────────┘
                                         ┌─────────────────┐
                                         │ Block Changed?  │
                                         │ Recalc Validators│
                                         └─────────┬───────┘
                                                   │
                                                   ▼
                                         ┌─────────────────┐
                                         │ Try Relay Each  │
                                         │ Transaction     │
                                         │ (Max 10 attempts)│
                                         └─────────┬───────┘
                                                   │
                                                   ▼
                                         ┌─────────────────┐
                                         │ Success?        │
                                         │ Remove from     │
                                         │ Local Mempool   │
                                         └─────────────────┘

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

Production Mode (PROD=true):
• Non-validators: Immediate multi-validator relay + background retry
• Validators: Store transactions locally (existing behavior)
• Background service: Continuous retry with block-aware optimization

Development Mode (PROD=false):
• All nodes: Store transactions locally (existing behavior)
```
