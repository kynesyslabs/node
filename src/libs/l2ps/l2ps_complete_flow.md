# L2PS Complete System Flow

## Overview

This document provides a unified view of the complete L2PS (Layer 2 Privacy Subnets) transaction flow across the entire DEMOS ecosystem, from client creation to node execution.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    L2PS COMPLETE SYSTEM ARCHITECTURE                │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Client SDK    │    │  DEMOS Network  │    │   L2PS Nodes    │
│                 │    │   (Routing)     │    │  (Processing)   │
│                 │    │                 │    │                 │
│ ✅ IMPLEMENTED  │    │ 🔄 REVIEW       │    │ 🔄 INCOMPLETE   │
│ • L2PS Class    │    │ • RPC Routing   │    │ • Decryption    │
│ • Encryption    │    │ • TX Validation │    │ • Execution     │
│ • Double Sign   │    │ • Error Routing │    │ • Mempool Mgmt  │
│                 │    │                 │    │ • Consensus     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │ Encrypted TX          │ Route & Validate     │ Process
         ├──────────────────────→│──────────────────────→│
         │                       │                       │
         │ Response              │ Forward Response     │
         │◄──────────────────────│◄──────────────────────│
         │                       │                       │
```

## End-to-End Transaction Flow

### Phase 1: Client-Side (SDK) - ✅ IMPLEMENTED

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLIENT-SIDE FLOW                             │
│                     (sdks/src/l2ps/)                               │
└─────────────────────────────────────────────────────────────────────┘

    User Application
           │
           ▼
    ┌─────────────────┐
    │ 1. Create       │ ──► ✅ WORKING: Standard DEMOS transaction
    │ Original TX     │     using SDK transaction builders
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ 2. Sign         │ ──► ✅ WORKING: Ed25519 signature on content
    │ Original TX     │     using user's private key
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ 3. Load L2PS    │ ──► ✅ WORKING: L2PS.create(privateKey, iv)
    │ Instance        │     from network configuration
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ 4. Encrypt TX   │ ──► ✅ WORKING: l2ps.encryptTx(originalTx)
    │ with L2PS       │     AES-GCM encryption + wrapper creation
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ 5. Sign         │ ──► ✅ WORKING: Sign wrapper with private key
    │ Encrypted TX    │     Creates l2psEncryptedTx transaction
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ 6. Send to      │ ──► ✅ WORKING: Standard RPC call to node
    │ Network         │     POST /execute with encrypted payload
    └─────────────────┘
```

### Phase 2: Network Routing - 🔄 REVIEW NEEDED

```
┌─────────────────────────────────────────────────────────────────────┐
│                        NETWORK ROUTING FLOW                         │
│                     (node/src/libs/network/)                       │
└─────────────────────────────────────────────────────────────────────┘

    ┌─────────────────┐
    │ RPC Reception   │ ──► ✅ WORKING: server_rpc.ts receives POST
    │ (server_rpc.ts) │     validates request structure
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ Route to        │ ──► ✅ WORKING: manageExecution.ts routes
    │ Execution       │     based on content.extra field
    │ (manageExecution)│
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ Validate        │ ──► ✅ WORKING: Standard cryptographic
    │ Transaction     │     validation in handleExecuteTransaction
    │ (endpointHandlers)│
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ Type-Based      │ ──► ✅ WORKING: case "subnet" correctly
    │ Routing         │     identified and routed to handleSubnetTx
    │ (switch/case)   │
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ L2PS Handler    │ ──► 🔄 INCOMPLETE: handleL2PS.ts called
    │ Delegation      │     but implementation incomplete
    │ (handleSubnetTx)│
    └─────────────────┘
```

### Phase 3: L2PS Processing - 🔄 INCOMPLETE

```
┌─────────────────────────────────────────────────────────────────────┐
│                        L2PS NODE PROCESSING                         │
│                     (node/src/libs/l2ps/)                          │
└─────────────────────────────────────────────────────────────────────┘

    ┌─────────────────┐
    │ Extract Payload │ ──► ✅ WORKING: L2PSEncryptedPayload extraction
    │ (handleL2PS.ts) │     from transaction.content.data structure
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ Load L2PS Keys  │ ──► ❌ TODO: Integration with ParallelNetworks
    │ (ParallelNetworks)│     loadL2PS(uid) for key/IV retrieval
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ Decrypt         │ ──► 🔄 INCOMPLETE: l2ps.decryptTx() call
    │ Transaction     │     exists but keys are null placeholders
    │ (L2PS.decryptTx)│
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ Verify Original │ ──► 🔄 REVIEW: Signature verification
    │ Signatures      │     structure exists but probably functional: check it
    │ (Cryptography)  │
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ Execute         │ ──► ❌ MISSING: No execution strategy
    │ Decrypted TX    │     Currently returns decrypted TX only
    │ (Strategy TBD)  │
    └─────────────────┘
           │
           ▼
    ┌─────────────────┐
    │ Update Mempool  │ ──► ❌ MISSING: No mempool addition for encrypted TX
    │ & GCR           │     ❌ MISSING: No GCR edits application (but GCR table is there, see GCRSubnetsTxs.ts from GCR_Main.ts)
    │ (Mempool/GCR)   │     ❌ MISSING: L2PS-specific mempool logic during consensus and Sync
    └─────────────────┘
```

## Current Implementation Matrix

| Component | Location | Status | Priority | Notes |
|-----------|----------|--------|----------|-------|
| **Client SDK** | `sdks/src/l2ps/` | ✅ COMPLETE | - | Fully functional |
| **RPC Routing** | `node/src/libs/network/server_rpc.ts` | ✅ WORKING | - | Standard processing |
| **TX Validation** | `node/src/libs/network/endpointHandlers.ts` | ✅ WORKING | - | Crypto validation OK |
| **L2PS Detection** | `node/src/libs/network/endpointHandlers.ts` | ✅ WORKING | - | `subnet` case works |
| **Key Management** | `node/src/libs/l2ps/parallelNetworks.ts` | ✅ AVAILABLE | - | Infrastructure ready |
| **L2PS Decryption** | `node/src/libs/network/routines/transactions/handleL2PS.ts` | 🔄 INCOMPLETE | **HIGH** | Need key integration |
| **Execution Strategy** | Multiple files | ❌ MISSING | **HIGH** | Architecture decision needed |
| **Consensus Integration** | Multiple files | ❌ MISSING (See below) | **MEDIUM** | L2PS-aware consensus |
| **GCR Integration** | `node/src/libs/blockchain/gcr/` | ❌ MISSING | **HIGH** | No GCR edits applied |
| **Mempool Addition** | `node/src/libs/blockchain/mempool_v2.ts` | ❌ MISSING | **HIGH** | No mempool integration |
| **L2PS Mempool** | `node/src/libs/blockchain/mempool_v2.ts` | ❌ MISSING | **MEDIUM** | Need separate pools |
| **L2PS Sync** | `node/src/libs/blockchain/routines/Sync.ts` | ❌ MISSING | **LOW** | Future Sync implementation |


## Security Model Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        L2PS SECURITY LAYERS                         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  Client Layer   │    │ Network Layer   │    │   L2PS Layer    │
│                 │    │                 │    │                 │
│ • Original TX   │    │ • Wrapper TX    │    │ • Decrypted TX  │
│   Signature     │    │   Signature     │    │   Verification  │
│ • L2PS          │    │ • RPC Auth      │    │ • Network Auth  │
│   Encryption    │    │ • Route Valid   │    │ • Exec Security │
│                 │    │                 │    │                 │
│ ✅ IMPLEMENTED  │    │ ✅ WORKING      │    │ 🔄 INCOMPLETE   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         │ AES-GCM Protected    │ Standard DEMOS        │ L2PS Network
         │ Ed25519 Signed       │ Cryptographic         │ Access Control
         │                      │ Validation            │ and execution in L2PS Nodes
```

## Next Steps

### Immediate Actions (This Sprint)

1. **🔥 URGENT**: Complete `handleL2PS.ts` integration with `ParallelNetworks`
2. **🔥 URGENT**: Implement basic execution strategy (REVIEW re-injection of decrypted TX for l2ps nodes only?)
3. **🔥 URGENT**: Add GCR edits application for L2PS transactions (see GCRSubnetsTxs.ts from GCR_Main.ts)
4. **🔥 URGENT**: Add mempool integration for encrypted transactions
5. **🔥 URGENT**: Add proper error handling for L2PS failures
6. **📈 IMPORTANT**: Design and implement L2PS-specific mempool logic
7. **📈 IMPORTANT**: Enhanced GCR integration for L2PS state tracking
8. **📋 PLANNED**: L2PS sync mechanisms

---

## Related Documentation

- **Client Implementation**: See `sdks/src/l2ps/l2ps_client_flow.md`
- **Node Implementation**: See `node/src/libs/l2ps/l2ps_node_flow.md`
- **Implementation Plan**: See `node/src/libs/l2ps/plan_of_action.md`
