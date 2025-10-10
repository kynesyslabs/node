# Storage Programs Feature Specification

## Overview

Storage Programs extend Demos Network's existing `storage` transaction type to enable smart contract-like programmable storage with key-value data structures, access control, and deterministic addressing.

## Current State Analysis

### Existing Storage System
- **Transaction Type**: `storage` (already exists in SDK)
- **Current Functionality**: Binary data storage in sender's account
- **Storage Format**: Base64-encoded binary data in JSONB
- **Limit**: 128KB total per address (as per your requirements)

### GCR Schema (GCRv2/GCR_Main)
```typescript
{
  pubkey: string (primary key)
  assignedTxs: string[] (JSONB)
  nonce: number
  balance: bigint
  identities: StoredIdentities (JSONB)
  points: {...} (JSONB)
  referralInfo: {...} (JSONB)
  // ... other fields
}
```

### Transaction Architecture
- **Types**: `web2Request`, `crosschainOperation`, `demoswork`, `NODE_ONLINE`, `identity`, `storage`, `native`, `l2ps`, `subnet`, `nativeBridge`, `instantMessaging`, `contractDeploy`, `contractCall`
- **Payload Structure**: `data: [type_string, payload_object]`
- **GCR Edits**: Modifications tracked via `gcr_edits` array in transaction content
- **Handlers**: Located in `src/libs/network/routines/transactions/`

---

## Storage Programs Design

### Core Concept

Storage Programs are **deterministic storage addresses** that:
1. Store dictionary-based JSONB data (key-value pairs)
2. Have configurable access control (private/public/restricted/deployer-only)
3. Use `stor-` prefix for addressderivation
4. Operate through extended `storage` transaction subtype
5. Store data in a new `data` JSONB column in GCR

### Address Derivation

**Storage Program Address Format**: `stor-{hash}`

**Derivation Algorithm**:
```typescript
function deriveStorageAddress(
  deployerAddress: string,
  programName: string,
  salt?: string
): string {
  const input = `${deployerAddress}:${programName}:${salt || ''}`
  const hash = sha256(input)
  return `stor-${hash.substring(0, 40)}` // 40 hex chars = 20 bytes
}
```

**Properties**:
- Deterministic: same inputs = same address
- Unique: collision-resistant via SHA-256
- Identifiable: `stor-` prefix distinguishes from regular addresses
- Compatible: fits existing address field structures

---

## Database Schema Changes

### GCR Table Extension

Add new `data` column to `gcr_main` table:

```sql
ALTER TABLE gcr_main
ADD COLUMN data JSONB DEFAULT '{}'::jsonb;

-- Index for efficient querying
CREATE INDEX idx_gcr_main_data_gin ON gcr_main USING GIN (data);
```

**Structure of `data` column**:
```json
{
  "variables": {
    "key1": "value1",
    "key2": {"nested": "object"},
    "key3": [1, 2, 3]
  },
  "metadata": {
    "programName": "MyStorageProgram",
    "deployer": "0xdeployer...",
    "accessControl": "public",
    "created": 1234567890,
    "lastModified": 1234567890,
    "size": 1024
  }
}
```

**Storage Limits**:
- **Total size per address**: 128KB (JSONB serialized)
- **Max nesting depth**: 64 levels
- **Key length**: max 256 characters
- **Value types**: JSON-serializable (strings, numbers, booleans, objects, arrays, null)

---

## Transaction Subtypes

### 1. CREATE_STORAGE_PROGRAM

**Purpose**: Initialize a new Storage Program with metadata and access control

**Payload Structure**:
```typescript
interface CreateStorageProgramPayload {
  operation: 'CREATE_STORAGE_PROGRAM'
  programName: string
  accessControl: 'private' | 'public' | 'restricted' | 'deployer-only'
  allowedAddresses?: string[] // for 'restricted' mode
  initialData?: Record<string, any>
  salt?: string // optional for address derivation
}
```

**Transaction Example**:
```json
{
  "content": {
    "type": "storageProgram",
    "from": "0xdeployer...",
    "to": "stor-a1b2c3...", // derived address
    "amount": 0,
    "data": [
      "storageProgram",
      {
        "operation": "CREATE_STORAGE_PROGRAM",
        "programName": "MyDataStore",
        "accessControl": "public",
        "initialData": {
          "counter": 0,
          "owner": "0xdeployer..."
        }
      }
    ],
    "gcr_edits": [ /* ... */ ],
    // ... other fields
  }
}
```

### 2. WRITE_STORAGE

**Purpose**: Write/update variables in an existing Storage Program

**Payload Structure**:
```typescript
interface WriteStoragePayload {
  operation: 'WRITE_STORAGE'
  storageAddress: string // stor-...
  updates: Record<string, any> // keys to add/update
  deletes?: string[] // keys to remove
}
```

**Access Control Check**:
- `deployer-only`: only deployer can write
- `private`: only deployer can write (same as deployer-only)
- `restricted`: only allowedAddresses + deployer can write
- `public`: anyone can write

**Transaction Example**:
```json
{
  "content": {
    "type": "storageProgram",
    "from": "0xuser...",
    "to": "stor-a1b2c3...",
    "amount": 0,
    "data": [
      "storageProgram",
      {
        "operation": "WRITE_STORAGE",
        "storageAddress": "stor-a1b2c3...",
        "updates": {
          "counter": 5,
          "lastModified": 1234567890
        },
        "deletes": ["tempField"]
      }
    ],
    "gcr_edits": [ /* ... */ ]
  }
}
```

### 3. READ_STORAGE

**Purpose**: Query variables from Storage Program (query-only, no transaction needed)

**Implementation**: RPC endpoint, not a transaction

**Endpoint**: `GET /storage/:storageAddress` or `/storage/:storageAddress/:key`

**Access Control Check**:
- Always allowed for queries (read-only operation)
- Returns `null` for non-existent programs/keys

### 4. UPDATE_ACCESS_CONTROL

**Purpose**: Change access control settings (deployer-only operation)

**Payload Structure**:
```typescript
interface UpdateAccessControlPayload {
  operation: 'UPDATE_ACCESS_CONTROL'
  storageAddress: string
  newAccessControl: 'private' | 'public' | 'restricted' | 'deployer-only'
  allowedAddresses?: string[] // for 'restricted' mode
}
```

**Access Control**: Only deployer can execute this

### 5. DELETE_STORAGE_PROGRAM

**Purpose**: Delete entire Storage Program (deployer-only)

**Payload Structure**:
```typescript
interface DeleteStorageProgramPayload {
  operation: 'DELETE_STORAGE_PROGRAM'
  storageAddress: string
}
```

**Access Control**: Only deployer can execute this

---

## SDK Types Extension

### New Types in `../sdks/src/types/blockchain/TransactionSubtypes/StorageTransaction.ts`

```typescript
/**
 * Access control modes for Storage Programs
 */
export type StorageAccessControl =
  | 'private'        // Only deployer
  | 'public'         // Anyone
  | 'restricted'     // Specific allowed addresses
  | 'deployer-only'  // Explicit deployer-only (same as private)

/**
 * Storage Program operations
 */
export type StorageProgramOperation =
  | 'CREATE_STORAGE_PROGRAM'
  | 'WRITE_STORAGE'
  | 'UPDATE_ACCESS_CONTROL'
  | 'DELETE_STORAGE_PROGRAM'

/**
 * Base interface for all Storage Program payloads
 */
export interface BaseStorageProgramPayload {
  operation: StorageProgramOperation
}

/**
 * Payload for creating a new Storage Program
 */
export interface CreateStorageProgramPayload extends BaseStorageProgramPayload {
  operation: 'CREATE_STORAGE_PROGRAM'
  programName: string
  accessControl: StorageAccessControl
  allowedAddresses?: string[]
  initialData?: Record<string, any>
  salt?: string
}

/**
 * Payload for writing data to Storage Program
 */
export interface WriteStoragePayload extends BaseStorageProgramPayload {
  operation: 'WRITE_STORAGE'
  storageAddress: string
  updates: Record<string, any>
  deletes?: string[]
}

/**
 * Payload for updating access control
 */
export interface UpdateAccessControlPayload extends BaseStorageProgramPayload {
  operation: 'UPDATE_ACCESS_CONTROL'
  storageAddress: string
  newAccessControl: StorageAccessControl
  allowedAddresses?: string[]
}

/**
 * Payload for deleting Storage Program
 */
export interface DeleteStorageProgramPayload extends BaseStorageProgramPayload {
  operation: 'DELETE_STORAGE_PROGRAM'
  storageAddress: string
}

/**
 * Union of all Storage Program payloads
 */
export type StorageProgramPayload =
  | CreateStorageProgramPayload
  | WriteStoragePayload
  | UpdateAccessControlPayload
  | DeleteStorageProgramPayload

/**
 * Extended storage transaction content for Storage Programs
 */
export type StorageProgramTransactionContent = Omit<TransactionContent, 'type' | 'data'> & {
  type: 'storageProgram'
  data: ['storageProgram', StorageProgramPayload]
}

/**
 * Complete Storage Program transaction interface
 */
export interface StorageProgramTransaction extends Omit<Transaction, 'content'> {
  content: StorageProgramTransactionContent
}

// Keep existing StorageTransaction for backwards compatibility
// (simple binary data storage)
export interface StoragePayload {
  bytes: string
  metadata?: Record<string, any>
}

export type StorageTransactionContent = Omit<TransactionContent, 'type' | 'data'> & {
  type: 'storage'
  data: ['storage', StoragePayload]
}

export interface StorageTransaction extends Omit<Transaction, 'content'> {
  content: StorageTransactionContent
}
```

Update `../sdks/src/types/blockchain/TransactionSubtypes/index.ts`:
```typescript
import { StorageProgramTransaction } from './StorageTransaction'

export type SpecificTransaction =
  | L2PSTransaction
  // ... existing types
  | StorageTransaction
  | StorageProgramTransaction  // ADD THIS
  | ContractDeployTransaction
  | ContractCallTransaction
```

---

## Node Implementation

### Handler Location

Create: `src/libs/network/routines/transactions/handleStorageProgramRequest.ts`

### Handler Structure

```typescript
import { GCREdit } from "@kynesyslabs/demosdk/types"
import { StorageProgramPayload } from "@kynesyslabs/demosdk/types"
import HandleGCR from "@/libs/blockchain/gcr/handleGCR"
import { deriveStorageAddress, validateStorageSize } from "./storageProgram/utils"
import { checkAccessControl } from "./storageProgram/accessControl"

export default async function handleStorageProgramRequest(
  payload: StorageProgramPayload,
  from: string,
  txHash: string
): Promise<{
  success: boolean
  message: string
  gcrEdits?: GCREdit[]
}> {
  try {
    switch (payload.operation) {
      case 'CREATE_STORAGE_PROGRAM':
        return await handleCreateStorageProgram(payload, from, txHash)

      case 'WRITE_STORAGE':
        return await handleWriteStorage(payload, from, txHash)

      case 'UPDATE_ACCESS_CONTROL':
        return await handleUpdateAccessControl(payload, from, txHash)

      case 'DELETE_STORAGE_PROGRAM':
        return await handleDeleteStorageProgram(payload, from, txHash)

      default:
        return {
          success: false,
          message: `Unknown storage program operation: ${(payload as any).operation}`
        }
    }
  } catch (error) {
    return {
      success: false,
      message: `Storage program error: ${error.message}`
    }
  }
}
```

### Integration in endpointHandlers.ts

Add case in `handleExecuteTransaction`:
```typescript
case "storageProgram": {
  payload = tx.content.data
  const storageProgramResult = await handleStorageProgramRequest(
    payload[1] as StorageProgramPayload,
    tx.content.from,
    tx.hash
  )
  result.success = storageProgramResult.success
  result.response = {
    message: storageProgramResult.message,
    results: storageProgramResult.gcrEdits
  }
  break
}
```

### GCR Edit Structure

```typescript
interface StorageProgramGCREdit extends GCREdit {
  type: 'storageProgram'
  context: 'data' // indicates modification to `data` column
  operation: 'create' | 'update' | 'delete'
  account: string // storage program address (stor-...)
  data: {
    variables?: Record<string, any>
    metadata?: Record<string, any>
  }
  txhash: string
}
```

---

## Access Control System

### Permission Model

```typescript
interface StorageProgramMetadata {
  programName: string
  deployer: string
  accessControl: StorageAccessControl
  allowedAddresses?: string[]
  created: number
  lastModified: number
  size: number // in bytes
}

async function checkAccessControl(
  storageAddress: string,
  requester: string,
  operation: 'read' | 'write' | 'admin'
): Promise<{ allowed: boolean; reason?: string }> {
  const program = await getStorageProgram(storageAddress)

  if (!program) {
    return { allowed: false, reason: 'Storage program does not exist' }
  }

  // Admin operations (delete, update access control)
  if (operation === 'admin') {
    if (requester === program.metadata.deployer) {
      return { allowed: true }
    }
    return { allowed: false, reason: 'Only deployer can perform admin operations' }
  }

  // Read operations - always allowed
  if (operation === 'read') {
    return { allowed: true }
  }

  // Write operations - check access control
  if (operation === 'write') {
    switch (program.metadata.accessControl) {
      case 'public':
        return { allowed: true }

      case 'private':
      case 'deployer-only':
        if (requester === program.metadata.deployer) {
          return { allowed: true }
        }
        return { allowed: false, reason: 'Only deployer can write to private storage' }

      case 'restricted':
        if (requester === program.metadata.deployer ||
            program.metadata.allowedAddresses?.includes(requester)) {
          return { allowed: true }
        }
        return { allowed: false, reason: 'Address not in allowed list' }
    }
  }
}
```

---

## SDK Methods

### Create Storage Program

```typescript
/**
 * Creates a new Storage Program
 */
async createStorageProgram(
  programName: string,
  accessControl: StorageAccessControl = 'public',
  options?: {
    allowedAddresses?: string[]
    initialData?: Record<string, any>
    salt?: string
  }
): Promise<StorageProgramTransaction>
```

### Write to Storage Program

```typescript
/**
 * Writes data to an existing Storage Program
 */
async writeStorage(
  storageAddress: string,
  updates: Record<string, any>,
  deletes?: string[]
): Promise<StorageProgramTransaction>
```

### Read from Storage Program

```typescript
/**
 * Reads data from a Storage Program (no transaction needed)
 */
async readStorage(
  storageAddress: string,
  key?: string
): Promise<any>
```

### Update Access Control

```typescript
/**
 * Updates access control settings (deployer only)
 */
async updateStorageAccessControl(
  storageAddress: string,
  newAccessControl: StorageAccessControl,
  allowedAddresses?: string[]
): Promise<StorageProgramTransaction>
```

### Delete Storage Program

```typescript
/**
 * Deletes a Storage Program (deployer only)
 */
async deleteStorageProgram(
  storageAddress: string
): Promise<StorageProgramTransaction>
```

### Derive Storage Address

```typescript
/**
 * Derives the address of a Storage Program
 */
deriveStorageAddress(
  deployerAddress: string,
  programName: string,
  salt?: string
): string
```

---

## Migration Considerations

### Backwards Compatibility

1. **Existing `storage` type**: Remains unchanged for binary data storage
2. **New `storageProgram` type**: Separate transaction type for Storage Programs
3. **GCR schema**: New `data` column doesn't affect existing columns

### Migration Steps

1. Add `data` column to `gcr_main` table
2. Deploy updated SDK with new types
3. Deploy updated node with handler
4. Test with testnet deployment
5. Gradual rollout to mainnet

---

## Security Considerations

### Input Validation

1. **Address format**: Validate `stor-` prefix and hash length
2. **Data size**: Enforce 128KB limit before transaction creation
3. **Nesting depth**: Validate max depth of 64 levels
4. **Key names**: Validate against SQL injection and special characters
5. **JSON serialization**: Validate data is JSON-serializable

### Access Control Enforcement

1. **Deployer verification**: Validate deployer signature
2. **Permission checks**: Enforce access control on every write operation
3. **Metadata integrity**: Prevent unauthorized metadata modification

### Resource Limits

1. **Storage quota**: 128KB total per Storage Program address
2. **Operation size**: Limit individual update size
3. **Gas costs**: Standard transaction gas fees apply

---

## Use Cases

### 1. Decentralized Key-Value Store
```typescript
const address = await demos.createStorageProgram('UserPreferences', 'public')
await demos.writeStorage(address, {
  theme: 'dark',
  language: 'en',
  notifications: true
})
```

### 2. Private Data Storage
```typescript
const address = await demos.createStorageProgram('MyPrivateData', 'private')
await demos.writeStorage(address, {
  apiKey: 'secret123',
  config: { /* ... */ }
})
```

### 3. Shared Data Store
```typescript
const address = await demos.createStorageProgram('TeamData', 'restricted', {
  allowedAddresses: ['0xteammate1...', '0xteammate2...']
})
```

### 4. Public Registry
```typescript
const address = await demos.createStorageProgram('DAppRegistry', 'public')
await demos.writeStorage(address, {
  'dapp1': { url: 'https://dapp1.com', version: '1.0.0' },
  'dapp2': { url: 'https://dapp2.com', version: '2.1.0' }
})
```

---

## Testing Strategy

### Unit Tests
- Address derivation algorithm
- Access control logic
- Data serialization/deserialization
- Size validation

### Integration Tests
- Create → Write → Read flow
- Access control enforcement
- Permission updates
- Storage program deletion

### E2E Tests
- Full transaction lifecycle
- Multi-user access scenarios
- Edge cases (limits, errors)

---

## Performance Considerations

### Database Indexing
- GIN index on `data` JSONB column for efficient querying
- Index on storage address prefix for fast lookups

### Caching Strategy
- Cache frequently accessed Storage Programs
- Invalidate cache on writes

### Query Optimization
- Use JSONB operators for efficient key-value lookups
- Limit result set sizes for large programs

---

## Future Enhancements

### Phase 2 (Future)
1. **Storage Program Templates**: Pre-built templates for common patterns
2. **Event Emissions**: Emit events on data changes
3. **Cross-Program References**: Allow Storage Programs to reference each other
4. **Versioning**: Track version history of data changes
5. **Batch Operations**: Update multiple Storage Programs in one transaction
6. **Query Language**: Advanced querying capabilities for JSONB data

---

## Summary

Storage Programs extend Demos Network with:
- ✅ Deterministic addressing (`stor-` prefix)
- ✅ Key-value JSONB storage (128KB limit)
- ✅ Granular access control (private/public/restricted/deployer-only)
- ✅ Full SDK and node integration
- ✅ Backwards compatible with existing `storage` type
- ✅ Transaction-based state changes
- ✅ Query-based reads (no transaction needed)

This design leverages existing infrastructure while adding powerful programmable storage capabilities to the Demos Network.
