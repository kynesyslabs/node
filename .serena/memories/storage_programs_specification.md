# Storage Programs Feature Specification

## Overview
Storage Programs is a new feature for Demos Network that adds structured data storage capabilities to the GCR (Global Chain Registry). This enables deterministic storage addresses with key-value data storage, access control, and SDK integration.

## Key Design Decisions

### Address Derivation
- **Format**: `stor-{hash}` where hash is first 40 chars of SHA-256
- **Algorithm**: SHA-256(`deployerAddress:programName:salt`)
- **Benefits**: Deterministic, collision-resistant, easily identifiable

### Storage Architecture
- **Database**: New `data` JSONB column in `gcr_main` table
- **Structure**: Dictionary-based key-value storage with nested objects
- **Limits**: 
  - 128KB total per address
  - 64 levels nesting depth
  - 256 character key length
- **Index**: GIN index on `data` column for efficient queries

### Transaction Type
- **New Type**: `storageProgram` (separate from existing `storage`)
- **Operations**: 
  1. CREATE_STORAGE_PROGRAM
  2. WRITE_STORAGE
  3. READ_STORAGE (query only)
  4. UPDATE_ACCESS_CONTROL
  5. DELETE_STORAGE_PROGRAM

### Access Control System
Four permission levels:
1. **private**: Only deployer can read/write
2. **public**: Anyone can read, only deployer can write
3. **restricted**: Allowlist-based read/write
4. **deployer-only**: Only deployer has all permissions

### Transaction Payload Structure
```typescript
export interface StorageProgramPayload {
    operation: 'CREATE_STORAGE_PROGRAM' | 'WRITE_STORAGE' | 'READ_STORAGE' 
               | 'UPDATE_ACCESS_CONTROL' | 'DELETE_STORAGE_PROGRAM'
    storageAddress: string
    programName?: string
    data?: Record<string, any>
    accessControl?: 'private' | 'public' | 'restricted' | 'deployer-only'
    allowedAddresses?: string[]
    salt?: string
}
```

## Implementation Components

### Database Changes
- Migration to add `data` JSONB column to `gcr_main`
- GIN index for efficient JSONB queries
- Update GCR_Main entity in TypeORM

### SDK Extensions
- New `StorageProgramTransaction` type
- `StorageProgram` class with methods:
  - `createStorageProgram()`
  - `writeStorage()`
  - `readStorage()`
  - `updateAccessControl()`
  - `deleteStorageProgram()`

### Node Implementation
- New handler: `handleStorageProgramTransaction.ts`
- Access control validator: `validateStorageProgramAccess.ts`
- Size validator: `validateStorageProgramSize.ts`
- HandleGCR integration for `storageProgram` type
- Endpoint integration in `endpointHandlers.ts`

### RPC Endpoints
- `getStorageProgram(address)`: Get full program data
- `getStorageVariable(address, key)`: Get specific variable
- `listStoragePrograms(deployer)`: List programs by deployer

## Security Considerations
- Access control validation on every operation
- Size limits enforced before writes
- Deployer verification for admin operations
- JSONB validation to prevent injection
- Rate limiting on storage operations

## Use Cases
1. Decentralized configuration storage
2. On-chain key-value databases
3. Public data registries
4. Application state storage
5. Cross-chain data bridges

## Testing Strategy
- Unit tests for validators and handlers
- Integration tests for transaction flow
- E2E tests with SDK methods
- Performance tests for large datasets
- Security tests for access control bypass attempts

## Files Modified
### Node Repository
- `src/model/entities/GCRv2/GCR_Main.ts`
- `src/libs/network/endpointHandlers.ts`
- `src/libs/blockchain/gcr/handleGCR.ts`
- New: `src/libs/network/routines/transactions/handleStorageProgramTransaction.ts`
- New: `src/libs/blockchain/validators/validateStorageProgramAccess.ts`
- New: `src/libs/blockchain/validators/validateStorageProgramSize.ts`
- New: Migration file for `data` column

### SDK Repository
- `../sdks/src/types/blockchain/TransactionSubtypes/index.ts`
- New: `../sdks/src/types/blockchain/TransactionSubtypes/StorageProgramTransaction.ts`
- New: `../sdks/src/classes/StorageProgram.ts`
- Update: `../sdks/storageTx.md` documentation

## Reference Documents
- Full specification: `/Users/tcsenpai/kynesys/node/STORAGE_PROGRAMS_SPEC.md`
- Implementation phases: `/Users/tcsenpai/kynesys/node/STORAGE_PROGRAMS_PHASES.md`