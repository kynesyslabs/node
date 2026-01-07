# IPFS Custom Charges Implementation Plan

## Overview

This document is the source of truth for implementing cost estimation in the IPFS confirm/execute two-step transaction flow.

## Problem Statement

Users currently cannot see how much an IPFS operation will cost before it executes. The transaction is submitted and costs are calculated/charged during execution with no preview.

## Solution Architecture

### Key Principle
**Transaction is NEVER modified by the node** - client signs the max cost they agree to pay.

### Flow Diagram
```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    IPFS TRANSACTION FLOW WITH CUSTOM_CHARGES                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  SDK (Client Side)                           Node (Server Side)                 │
│  ────────────────                            ──────────────────                 │
│                                                                                 │
│  1. [Optional] Get quote:                    ipfsQuote nodeCall:                │
│     demos.ipfsQuote(fileSize)    ────────►   - Calculate cost for sender        │
│                                  ◄────────   - Return { cost_dem, breakdown }   │
│                                                                                 │
│  2. Build TX with custom_charges:                                               │
│     tx.content.custom_charges = {                                               │
│       ipfs: {                                                                   │
│         max_cost_dem: quote.cost_dem * 1.1,  // 10% buffer                      │
│         file_size_bytes: fileSize,                                              │
│         operation: 'add' | 'pin'                                                │
│       }                                                                         │
│     }                                                                           │
│                                                                                 │
│  3. Hash & Sign TX:                                                             │
│     tx.hash = SHA256(JSON.stringify(tx.content))  // includes custom_charges    │
│     tx.signature = sign(tx.hash, privateKey)                                    │
│                                                                                 │
│  4. Confirm TX:                              confirmTx handler:                 │
│     demos.confirm(tx)            ────────►   - Validate signature & hash        │
│                                              - Check custom_charges.ipfs exists │
│                                              - Calculate actual cost            │
│                                              - If actual > max_cost_dem: REJECT │
│                                              - Attach actual cost to response   │
│                                  ◄────────   Return ValidityData with:          │
│                                                custom_charges: {                │
│                                                  ipfs: {                        │
│                                                    actual_cost_dem,             │
│                                                    breakdown                    │
│                                                  }                              │
│                                                }                                │
│                                                                                 │
│  5. User reviews ValidityData:                                                  │
│     - See actual_cost_dem                                                       │
│     - Compare with max_cost_dem                                                 │
│     - Decide to proceed or cancel                                               │
│                                                                                 │
│  6. Broadcast TX:                            broadcastTx handler:               │
│     demos.broadcast(validityData) ────────►  - Re-validate cost                 │
│                                              - actual ≤ max_cost_dem? YES       │
│                                              - Execute IPFS operation           │
│                                              - Charge actual_cost (fair price)  │
│                                  ◄────────   Return execution result            │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Type Definitions

### Transaction.content.custom_charges (SDK)
```typescript
// In TransactionContent interface
custom_charges?: {
    ipfs?: {
        max_cost_dem: number        // Maximum user agrees to pay (signed)
        file_size_bytes: number     // Size for cost calculation
        operation: 'add' | 'pin'    // IPFS operation type
    }
    // Extensible for future charge types (storage, compute, etc.)
}
```

### ValidityData.data.custom_charges (SDK)
```typescript
// In ValidityData.data
custom_charges?: {
    ipfs?: {
        actual_cost_dem: number     // What will actually be charged
        file_size_bytes: number
        is_genesis_rate: boolean
        breakdown: {
            base_cost: number
            free_tier_discount: number
            final_cost: number
        }
    }
}
total_estimated_cost?: number  // Gas + all custom charges
```

### IpfsQuote Response (Node)
```typescript
interface IpfsQuoteResponse {
    cost_dem: number
    file_size_bytes: number
    is_genesis_rate: boolean
    breakdown: {
        base_cost: number
        free_tier_discount: number
        final_cost: number
    }
}
```

## Implementation Order

### Phase 1: SDK Types (../sdks)
1. **node-1qg**: Add custom_charges to Transaction types
2. **node-xq9**: Add custom_charges to ValidityData types
   - Depends on: node-1qg

### Phase 2: Node Quote Endpoint
3. **node-29n**: Add ipfsQuote nodeCall
   - Depends on: node-xq9 (needs types in SDK first)

### Phase 3: SDK Helpers (../sdks)  
4. **node-gqd**: Add ipfsQuote helper method
   - Depends on: node-29n (needs endpoint to exist)
5. **node-wuw**: Update IPFSOperations payloads
   - Depends on: node-1qg

### Phase 4: Node Validation & Execution
6. **node-31n**: Validate custom_charges in confirmTransaction
   - Depends on: node-xq9
7. **node-dhc**: Update IPFS execution to use custom_charges
   - Depends on: node-31n

### Phase 5: Documentation
8. **node-bud**: Create IPFS flow diagram

## SDK Workflow

For each SDK task:
1. Make changes in ../sdks
2. Run `bun run build` to verify
3. Commit and push to SDK repo
4. **STOP and ask user to publish new SDK version**
5. Wait for confirmation before continuing with node tasks

## Key Files

### SDK (../sdks)
- `src/types/blockchain/Transaction.ts` - TransactionContent interface
- `src/types/blockchain/ValidityData.ts` - ValidityData interface
- `src/websdk/demosclass.ts` - ipfsQuote helper
- `src/abstraction/ipfs/IPFSOperations.ts` - Payload builders

### Node (this repo)
- `src/libs/network/routines/nodecalls/ipfs/ipfsQuote.ts` - New quote endpoint
- `src/libs/network/routines/nodecalls/ipfs/index.ts` - Export registration
- `src/libs/network/manageNodeCall.ts` - Route registration
- `src/libs/network/endpointHandlers.ts` - handleValidateTransaction
- `src/libs/blockchain/routines/ipfsOperations.ts` - Execution handlers
- `src/libs/blockchain/routines/ipfsTokenomics.ts` - Cost calculation (existing)

## Verification Commands

### SDK
```bash
cd ../sdks
bun run build
```

### Node
```bash
bun run lint:fix
bun run type-check
```

## Beads Epic

Epic ID: **node-zbp**
Title: IPFS Cost Estimation in Confirm/Execute Flow

All tasks are children of this epic with proper blocking dependencies set up.

## Notes

- Transaction hash integrity is preserved because custom_charges is added BEFORE signing
- User's signature covers the max_cost_dem - provides audit trail
- Node validates but never modifies the transaction
- Fair pricing: actual cost charged (not max), as long as actual ≤ max
- Pattern is extensible for future custom charge types
