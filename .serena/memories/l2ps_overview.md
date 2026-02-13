# L2PS (Layer 2 Privacy Subnets) Overview

## What is L2PS?

L2PS is a privacy-preserving transaction system integrated with DTR (Distributed Transaction Routing) that enables private transactions while maintaining validator consensus participation.

## Core Architecture

### Node Types
- **L2PS Participant Nodes**: Non-validator RPC nodes that decrypt and store L2PS transactions locally
- **Validators**: Receive only consolidated L2PS UID → hash mappings (never see transaction content)

### Privacy Model
- **Complete separation** between encrypted transaction storage and validator consensus
- **L2PS participants** store full encrypted transactions and can decrypt content
- **Validators** store ONLY `l2ps_uid → hash` mappings with zero transaction visibility
- **Critical principle**: L2PS mempool and validator mempool NEVER mix

## Transaction Flow

```
Client → L2PS Node → Decrypt → L2PS Mempool (encrypted storage)
                                      ↓
                     Every 5s: Generate Consolidated Hash
                                      ↓
                     Create L2PS Hash Update TX (self-directed)
                                      ↓
                     DTR Routes to ALL Validators
                                      ↓
                     Validators Store UID → Hash Mapping (content blind)
```

## Key Concepts

1. **Encrypted Storage**: L2PS nodes store transactions in encrypted form in separate mempool
2. **Hash Consolidation**: Every 5 seconds, hash service generates deterministic consolidated hash
3. **Blind Consensus**: Validators participate in consensus without seeing transaction content
4. **Self-Directed TX**: L2PS hash update uses self-directed transaction (from === to) for DTR routing
5. **Privacy First**: Complete separation ensures validators never access transaction content

## Branch Information
- **Development Branch**: l2ps_simplified
- **Status**: Partially implemented (Phases 1, 2, 3a complete; 3b, 3c incomplete)
- **Target**: Merge to main after completion
