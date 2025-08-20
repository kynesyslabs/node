# Demos Smart Contracts Implementation Plan

## Overview
This document outlines the complete plan for implementing smart contracts in the Demos blockchain. Smart contracts will be TypeScript-based, executed directly by Bun runtime, and stored as enhanced accounts in the GCR system.

## Core Design Principles
1. **Simplicity First**: Leverage existing Demos infrastructure
2. **TypeScript Native**: Direct execution using Bun runtime
3. **Account-Based**: Contracts are accounts with code
4. **Gradual Enhancement**: Start simple, add features incrementally

## Architecture

### Contract Storage (GCR_Main Enhancement)
```typescript
@Column({ type: "jsonb", name: "contract", nullable: true })
contract?: {
    metadata: {
        version: string;              // e.g., "1.0.0"
        createdAt: Date;
        updatedAt: Date;
        creator: string;              // Original deployer pubkey
        name?: string;
        description?: string;
    };
    
    code: {
        source: string;               // TypeScript source code
        abi: ContractABI;            // Interface for SDK interaction
        checksum: string;             // sha256(source)
    };
    
    state: {
        storage: Record<string, any>; // Contract persistent storage
        frozen: boolean;              // Placeholder for future upgrades
        paused: boolean;              // Emergency pause
    };
    
    events: Array<{                   // Event log
        name: string;
        args: Record<string, any>;
        blockHeight: number;
        timestamp: Date;
        transactionHash: string;
    }>;
    
    stats: {
        callCount: number;
        lastExecuted?: Date;
        gasUsed: bigint;             // Reserved for future
    };
}
```

### Contract Addressing
- **Address Generation**: `hash(creatorPubkey + nonce + sourceCodeHash)`
- **Deterministic**: Same creator can deploy same code multiple times
- **No Vanity Addresses**: No specific address targeting

### Execution Model
1. **Runtime**: Bun with sandboxed Worker threads (MVP)
2. **Language**: TypeScript subset
3. **State**: Isolated per contract, stored in JSONB
4. **Limits**:
   - Max source code: 256KB
   - Max storage: 64KB per contract
   - Max execution time: 60 seconds per call

### Fee Structure
- **Deployment**: 1 DEM per 32KB (rounded up)
- **Execution**: 1 DEM base + 1 DEM per function call
- **Read-Only Calls**: Free (no state changes)

### Transaction Types
New transaction type needed:
```typescript
{
    type: "CONTRACT_CALL",
    contract: string,        // Contract address
    method: string,          // Method name
    args: any[],            // Method arguments
    value?: bigint          // DEM to send with call
}

{
    type: "CONTRACT_DEPLOY",
    source: string,         // TypeScript source
    args: any[],           // Constructor arguments
    name?: string,         // Optional contract name
}
```

### Contract Access
Contracts have access to:
- Current block height
- Transaction sender
- Contract's own address
- Other contracts (cross-contract calls)
- All SDK read methods (blockchain data)
- Limited SDK write methods (through execution context)

### Error Handling
- **State Reversion**: Revert all reversible state changes on error
- **Mixed Reversion**: Some operations (like cross-chain writes) cannot be reverted
- **Error Propagation**: Return clear error messages to callers

## Development Approach

### Phase 1: Foundation
- Database schema updates
- Basic types and interfaces
- Contract storage/retrieval

### Phase 2: Execution
- Sandbox implementation
- State management
- Fee calculation

### Phase 3: Integration
- Transaction handlers
- RPC endpoints
- SDK integration

### Phase 4: Standards
- Storage contract template
- Token contract template
- Developer documentation

## Security Considerations
- No file system access
- No network access (except through SDK)
- No process spawning
- Memory limits enforced
- Execution timeouts
- Deterministic execution

## Future Enhancements (Placeholders)
- Contract upgrades (currently immutable)
- Advanced gas metering
- Docker-based isolation
- Cross-chain contract calls
- More sophisticated event indexing