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

## Implementation Status

✅ SDK Types added
✅ ipfsQuote nodeCall implemented
✅ Confirm validation implemented
✅ Execute validation implemented