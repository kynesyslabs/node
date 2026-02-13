# L2PS Architecture

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    L2PS ARCHITECTURE                        │
└─────────────────────────────────────────────────────────────┘

Client Application
       │
       ▼
L2PS Participant Node (Non-Validator)
       ├─► Decrypt Transaction (handleL2PS.ts)
       ├─► Store in L2PS Mempool (l2ps_mempool.ts)
       │   └─► L2PSMempoolTx Entity (PostgreSQL)
       │
       └─► Every 5s: L2PSHashService
               ├─► Generate Consolidated Hash
               ├─► Create L2PS Hash Update TX
               └─► Relay to Validators (DTR)
                       │
                       ▼
Validator Node (Consensus)
       ├─► Receive Hash Update TX (RELAY_TX)
       ├─► Validate Transaction
       └─► Store UID → Hash Mapping
           └─► [TODO: L2PSHashes Entity]

L2PS Participant Sync (Horizontal)
       ├─► [TODO: Discover Participants]
       ├─► [TODO: Exchange Mempool Info]
       └─► [TODO: Sync Missing Transactions]
```

## Data Flow

### Transaction Submission Flow

1. **Client Encryption**: Client encrypts transaction using L2PS network keys
2. **L2PS Node Reception**: L2PS node receives encrypted transaction
3. **Local Decryption**: Node decrypts transaction locally (validates signature)
4. **Mempool Storage**: Node stores encrypted transaction in separate L2PS mempool
5. **Hash Generation**: Every 5 seconds, hash service generates consolidated hash
6. **Hash Relay**: Hash update transaction relayed to validators via DTR
7. **Validator Storage**: Validators store only the hash mapping for consensus

### Privacy Separation

```
L2PS Participant Storage:
├─► Encrypted Transactions (Full Content)
├─► Decryption Keys (Local Only)
└─► Can View Transaction Details

Validator Storage:
├─► L2PS UID → Hash Mappings
├─► Transaction Count
├─► Block Numbers
└─► ZERO Transaction Visibility
```

## Component Interactions

### L2PS Hash Service Workflow

```
┌─────────────────────────────────────────────────┐
│         L2PSHashService (5s interval)           │
└─────────────────────────────────────────────────┘
                    │
                    ├─► For each L2PS UID in getSharedState.l2psJoinedUids
                    │
                    ├─► L2PSMempool.getHashForL2PS(uid)
                    │   └─► Generate deterministic consolidated hash
                    │
                    ├─► Create L2PSHashTransaction
                    │   ├─► self-directed (from === to)
                    │   ├─► contains: l2ps_uid, hash, tx_count
                    │   └─► triggers DTR routing
                    │
                    └─► relayToValidators()
                        ├─► Get validators via getCommonValidatorSeed()
                        ├─► Random validator ordering
                        └─► Try until one accepts (RELAY_TX)
```

### Transaction Handler Workflow

```
┌─────────────────────────────────────────────────┐
│    handleL2PS (Transaction Reception)           │
└─────────────────────────────────────────────────┘
                    │
                    ├─► Load L2PS Instance
                    │   └─► ParallelNetworks.getInstance()
                    │
                    ├─► Decrypt Transaction
                    │   └─► l2psInstance.decryptTx()
                    │
                    ├─► Re-verify Signature
                    │   └─► Validate decrypted transaction
                    │
                    ├─► Check Duplicates
                    │   └─► L2PSMempool.existsByOriginalHash()
                    │
                    ├─► Store in L2PS Mempool
                    │   └─► L2PSMempool.addTransaction()
                    │
                    └─► Return Confirmation
```

### Validator Hash Update Workflow

```
┌─────────────────────────────────────────────────┐
│    handleL2PSHashUpdate (Validator Reception)   │
└─────────────────────────────────────────────────┘
                    │
                    ├─► Extract L2PS Hash Payload
                    │   ├─► l2ps_uid
                    │   ├─► consolidated_hash
                    │   └─► transaction_count
                    │
                    ├─► Validate L2PS Network Participation
                    │   └─► ParallelNetworks.getL2PS(uid)
                    │
                    ├─► [TODO] Store Hash Mapping
                    │   └─► L2PSHashes.updateHash()
                    │
                    └─► Return Success/Error
```

## Network Topology

### L2PS Participant Network

```
┌──────────────┐       ┌──────────────┐       ┌──────────────┐
│ L2PS Node A  │◄─────►│ L2PS Node B  │◄─────►│ L2PS Node C  │
│ (Participant)│       │ (Participant)│       │ (Participant)│
└──────────────┘       └──────────────┘       └──────────────┘
       │                      │                       │
       │ Hash Updates         │ Hash Updates          │ Hash Updates
       │ (Every 5s)          │ (Every 5s)           │ (Every 5s)
       │                      │                       │
       ▼                      ▼                       ▼
┌───────────────────────────────────────────────────────────┐
│                  Validator Network                         │
│  (Receives hash mappings only, NO transaction content)    │
└───────────────────────────────────────────────────────────┘
```

### Future Sync Network (NOT YET IMPLEMENTED)

```
L2PS Node A ◄──► L2PS Node B ◄──► L2PS Node C
    │                 │                 │
    └─────────────────┼─────────────────┘
                      │
           [TODO: Mempool Sync]
           - Discover Participants
           - Exchange Mempool Info
           - Sync Missing Transactions
```

## Security Model

### Threat Protection

1. **Validator Privacy Leak**: IMPOSSIBLE - Validators never receive transaction content
2. **L2PS Node Compromise**: Only affects compromised node's local data
3. **Network Eavesdropping**: Transactions encrypted, only hashes transmitted
4. **Duplicate Transactions**: Prevented by original_hash duplicate detection
5. **Unauthorized Hash Updates**: Validated via L2PS network participation check

### Trust Boundaries

```
┌────────────────────────────────────────────┐
│ TRUSTED ZONE: L2PS Participants            │
│ - Full transaction visibility              │
│ - Decryption keys available                │
│ - Mempool synchronization                  │
└────────────────────────────────────────────┘
                    │
                    │ Hash Updates Only
                    ▼
┌────────────────────────────────────────────┐
│ UNTRUSTED ZONE: Validators                 │
│ - Hash mappings only                       │
│ - Zero transaction visibility              │
│ - Content-blind consensus                  │
└────────────────────────────────────────────┘
```

## Performance Characteristics

### L2PS Hash Service
- **Interval**: 5 seconds
- **Reentrancy Protection**: Yes (isGenerating flag)
- **Parallel Processing**: Processes all L2PS UIDs concurrently
- **Graceful Shutdown**: Timeout-based with statistics

### Transaction Processing
- **Decryption**: Per-transaction, on-demand
- **Duplicate Detection**: Hash-based O(1) lookup
- **Storage**: PostgreSQL with composite indexes
- **Query Performance**: Optimized with [l2ps_uid, timestamp] indexes

### Validator Relay
- **Strategy**: Random validator ordering for load balancing
- **Retry Logic**: Try all validators until one accepts
- **Production Mode**: Only operates when getSharedState.PROD === true
- **Error Handling**: Comprehensive logging, graceful degradation
