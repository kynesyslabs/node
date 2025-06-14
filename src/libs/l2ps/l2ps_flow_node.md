# L2PS Transaction Flow in DEMOS Node

## Overview

This document explains the complete flow of L2PS (Layer 2 Privacy Subnets) transactions through the DEMOS node, from arrival to processing and mempool addition.

## L2PS Transaction Structure

An L2PS transaction arrives with the following structure:

```typescript
{
  content: {
    type: "subnet",                    // Transaction type identifier
    data: [
      "l2psEncryptedTx",              // Data type identifier
      L2PSEncryptedPayload {          // Encrypted payload
        l2ps_uid: string,             // L2PS network identifier
        encrypted_data: string,       // Base64 AES-GCM encrypted Transaction object
        tag: string,                  // Base64 authentication tag
        original_hash: string         // Hash of original transaction
      }
    ],
    // ... standard transaction fields (from, to, amount, etc.)
  },
  // ... standard transaction properties (hash, blockNumber, etc.)
}
```

## Complete Node Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                    L2PS NODE-SIDE PROCESSING FLOW                   │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────┐
│   L2PS Transaction  │ ──► ✅ WORKING: RPC endpoint receives encrypted TX
│   (type: "subnet")  │     via server_rpc.ts
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   manageExecution   │ ──► ✅ WORKING: Routes based on content.extra
│     (execute)       │     confirmTx → validate, broadcastTx → execute
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│handleExecuteTransaction│ ──► ✅ WORKING: Main transaction processor
│  (endpointHandlers) │     with cryptographic validation
└─────────────────────┘
           │
           ▼ (Validation & Integrity Checks)
┌─────────────────────┐
│  Cryptographic      │ ──► ✅ WORKING: RPC signature verification
│  Validation         │     ✅ WORKING: Reference block validation
│                     │     ✅ WORKING: Transaction validity checks
└─────────────────────┘
           │
           ▼ (Switch on tx.content.type)
┌─────────────────────┐
│  case "subnet":     │ ──► ✅ WORKING: Correctly identifies L2PS TX
│  handleSubnetTx()   │     and routes to L2PS handler
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   handleL2PS()      │ ──► 🔄 INCOMPLETE: L2PS-specific processing
│ (handleL2PS.ts)     │     
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│  L2PS Processing    │ ──► 🔄 TODO: Load keys from ParallelNetworks
│                     │     🔄 TODO: Proper L2PS instance creation
│                     │     ✅ WORKING: Payload extraction structure
│                     │     🔄 INCOMPLETE: Actual decryption
│                     │     🔄 INCOMPLETE: Signature verification
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│   Execution Strategy│ ──► ❌ MISSING: No execution of decrypted TX
│                     │     
│                     │     
└─────────────────────┘
           │
           ▼
┌─────────────────────┐
│  GCR Application    │ ──► ❌ MISSING: GCR edits application (simulate)
│  & Mempool Add     │     ❌ MISSING: Mempool addition for encrypted TX
│                     │     ❌ MISSING: L2PS-specific mempool logic
└─────────────────────┘
```

## Detailed Step-by-Step Flow

### 1. Transaction Arrival

**File**: `src/libs/network/server_rpc.ts`

```typescript
// RPC endpoint receives transaction
POST / {
  method: "execute",
  params: [BundleContent]
}
```

### 2. Execution Management

**File**: `src/libs/network/manageExecution.ts`

```typescript
export async function manageExecution(content: BundleContent) {
    // Route based on content.extra:
    // - "confirmTx" → handleValidateTransaction()
    // - "broadcastTx" → handleExecuteTransaction()
    
    switch (content.extra) {
        case "broadcastTx":
            return await ServerHandlers.handleExecuteTransaction(validityDataPayload)
    }
}
```

### 3. Transaction Validation & Execution

**File**: `src/libs/network/endpointHandlers.ts:158-483`

```typescript
static async handleExecuteTransaction(validatedData: ValidityData) {
    // 1. Cryptographic validation
    //    - Verify RPC public key matches node key
    //    - Validate signature of validity data
    //    - Check reference block is within allowed range
    
    // 2. Extract transaction from validity data
    const tx = validatedData.data.transaction
    
    // 3. Route based on transaction type
    switch (tx.content.type) {
        case "subnet":
            // L2PS transaction processing
            var subnetResult = await ServerHandlers.handleSubnetTx(tx)
            result.response = subnetResult
            break
    }
    
    // 4. Post-processing (if successful)
    if (result.success) {
        // Apply GCR edits (simulate mode)
        await HandleGCR.applyToTx(queriedTx, false, true)
        
        // Add to mempool
        await Mempool.addTransaction(queriedTx)
    }
}
```

### 4. L2PS Subnet Transaction Handler

**File**: `src/libs/network/endpointHandlers.ts:529-533`

```typescript
static async handleSubnetTx(content: Transaction) {
    let response: RPCResponse = _.cloneDeep(emptyResponse)
    response = await handleL2PS(content)  // Delegate to L2PS handler
    return response
}
```

### 5. L2PS Decryption & Processing

**File**: `src/libs/network/routines/transactions/handleL2PS.ts`

```typescript
export default async function handleL2PS(l2psTx: Transaction) {
    // 1. Validate transaction type
    if (l2psTx.content.type !== "subnet") return error
    
    // 2. Extract encrypted payload
    const [dataType, payload] = l2psTx.content.data
    const encryptedPayload = payload as L2PSEncryptedPayload
    
    // 3. Get L2PS configuration
    const l2psUid = encryptedPayload.l2ps_uid
    // TODO: Load L2PS instance with proper key/IV
    
    // 4. Decrypt transaction
    const l2ps = await L2PS.create(key, iv)
    const decryptedTx = await l2ps.decryptTx(l2psTx)
    
    // 5. Verify decrypted transaction signature
    const verified = Cryptography.verify(
        Hashing.sha256(JSON.stringify(decryptedTx.content)),
        decryptedTx.ed25519_signature,
        decryptedTx.content.from
    )
    
    // 6. Return result
    response.result = 200
    response.response = decryptedTx
    return response
}
```
