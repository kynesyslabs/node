# Storage Programs API Reference

Complete API reference for Storage Programs on Demos Network.

## Table of Contents

1. [SDK Methods](#sdk-methods)
2. [RPC Endpoints](#rpc-endpoints)
3. [Transaction Payloads](#transaction-payloads)
4. [Response Formats](#response-formats)
5. [Constants and Limits](#constants-and-limits)
6. [Types and Interfaces](#types-and-interfaces)
7. [Error Codes](#error-codes)

## SDK Methods

### DemosClient.storageProgram

The `storageProgram` namespace provides all Storage Program operations.

---

### create()

Create a new Storage Program.

#### Signature

```typescript
async create(
  programName: string,
  accessControl: "private" | "public" | "restricted" | "deployer-only",
  options?: {
    initialData?: Record<string, any>
    allowedAddresses?: string[]
    salt?: string
  }
): Promise<StorageProgramCreateResult>
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `programName` | `string` | ✅ | Unique name for the storage program |
| `accessControl` | `AccessControlMode` | ✅ | Access control mode |
| `options.initialData` | `Record<string, any>` | ❌ | Initial data to store |
| `options.allowedAddresses` | `string[]` | ❌ | Whitelist for restricted mode |
| `options.salt` | `string` | ❌ | Salt for address derivation (default: "") |

#### Returns

```typescript
{
  success: boolean
  txHash: string
  storageAddress: string
  message?: string
}
```

#### Example

```typescript
const result = await demos.storageProgram.create(
  "userProfile",
  "private",
  {
    initialData: {
      username: "alice",
      email: "alice@example.com"
    }
  }
)

console.log('Storage address:', result.storageAddress)
console.log('Transaction:', result.txHash)
```

#### Errors

- **400**: Invalid access control mode
- **400**: Data size exceeds 128KB limit
- **400**: Nesting depth exceeds 64 levels
- **400**: Key length exceeds 256 characters
- **400**: Restricted mode without allowedAddresses

---

### write()

Write or update data in a Storage Program.

#### Signature

```typescript
async write(
  storageAddress: string,
  data: Record<string, any>
): Promise<StorageProgramWriteResult>
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `storageAddress` | `string` | ✅ | Storage Program address (stor-...) |
| `data` | `Record<string, any>` | ✅ | Data to write/merge |

#### Returns

```typescript
{
  success: boolean
  txHash: string
  message?: string
}
```

#### Behavior

- **Merges** with existing data (does not replace)
- Updates `lastModified` timestamp
- Recalculates `size` metadata

#### Example

```typescript
await demos.storageProgram.write(
  "stor-abc123...",
  {
    bio: "Web3 developer",
    lastUpdated: Date.now()
  }
)
```

#### Errors

- **403**: Access denied (not deployer or allowed)
- **400**: Combined size exceeds 128KB limit
- **404**: Storage program not found

---

### read()

Read data from a Storage Program (RPC query, no transaction).

#### Signature

```typescript
async read(
  storageAddress: string,
  key?: string
): Promise<StorageProgramReadResult>
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `storageAddress` | `string` | ✅ | Storage Program address |
| `key` | `string` | ❌ | Specific key to read (optional) |

#### Returns

```typescript
{
  success: boolean
  data: {
    variables: Record<string, any>
    metadata: {
      programName: string
      deployer: string
      accessControl: string
      allowedAddresses: string[]
      created: number
      lastModified: number
      size: number
    }
  } | any // If key specified, returns just the value
}
```

#### Example

```typescript
// Read all data
const result = await demos.storageProgram.read("stor-abc123...")
console.log('Data:', result.data.variables)
console.log('Metadata:', result.data.metadata)

// Read specific key
const username = await demos.storageProgram.read("stor-abc123...", "username")
console.log('Username:', username)
```

#### Errors

- **403**: Access denied
- **404**: Storage program not found

---

### updateAccessControl()

Update access control settings (deployer only).

#### Signature

```typescript
async updateAccessControl(
  storageAddress: string,
  updates: {
    accessControl?: "private" | "public" | "restricted" | "deployer-only"
    allowedAddresses?: string[]
  }
): Promise<StorageProgramUpdateResult>
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `storageAddress` | `string` | ✅ | Storage Program address |
| `updates.accessControl` | `AccessControlMode` | ❌ | New access mode |
| `updates.allowedAddresses` | `string[]` | ❌ | New whitelist |

#### Returns

```typescript
{
  success: boolean
  txHash: string
  message?: string
}
```

#### Example

```typescript
// Change access mode
await demos.storageProgram.updateAccessControl(
  "stor-abc123...",
  { accessControl: "public" }
)

// Update allowed addresses
await demos.storageProgram.updateAccessControl(
  "stor-abc123...",
  {
    allowedAddresses: ["0x1111...", "0x2222...", "0x3333..."]
  }
)
```

#### Errors

- **403**: Only deployer can update access control
- **400**: Restricted mode requires allowedAddresses

---

### delete()

Delete a Storage Program (deployer only).

#### Signature

```typescript
async delete(
  storageAddress: string
): Promise<StorageProgramDeleteResult>
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `storageAddress` | `string` | ✅ | Storage Program address |

#### Returns

```typescript
{
  success: boolean
  txHash: string
  message?: string
}
```

#### Example

```typescript
await demos.storageProgram.delete("stor-abc123...")
console.log('Storage program deleted')
```

#### Errors

- **403**: Only deployer can delete

---

## Utility Functions

### deriveStorageAddress()

Calculate storage address client-side.

#### Signature

```typescript
function deriveStorageAddress(
  deployerAddress: string,
  programName: string,
  salt?: string
): string
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `deployerAddress` | `string` | ✅ | Deployer's wallet address |
| `programName` | `string` | ✅ | Program name |
| `salt` | `string` | ❌ | Optional salt (default: "") |

#### Returns

`string` - Storage address in format `stor-{40 hex chars}`

#### Example

```typescript
import { deriveStorageAddress } from '@kynesyslabs/demosdk/storage'

const address = deriveStorageAddress(
  "0xdeployer123...",
  "myApp",
  "v1"
)

console.log(address) // "stor-a1b2c3d4e5f6..."
```

---

### getDataSize()

Calculate data size in bytes.

#### Signature

```typescript
function getDataSize(data: Record<string, any>): number
```

#### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `data` | `Record<string, any>` | ✅ | Data object to measure |

#### Returns

`number` - Size in bytes (UTF-8 encoded JSON)

#### Example

```typescript
import { getDataSize } from '@kynesyslabs/demosdk/storage'

const data = { username: "alice", posts: [] }
const size = getDataSize(data)

console.log(`Data size: ${size} bytes`)

if (size > 128 * 1024) {
  console.error('Data too large!')
}
```

---

## RPC Endpoints

### getStorageProgram

Query Storage Program data via RPC.

#### Endpoint

`POST /rpc`

#### Request Payload

```json
{
  "message": "getStorageProgram",
  "data": {
    "storageAddress": "stor-abc123...",
    "key": "username" // Optional
  }
}
```

#### Response

```json
{
  "result": 200,
  "response": {
    "success": true,
    "data": {
      "variables": {
        "username": "alice",
        "email": "alice@example.com"
      },
      "metadata": {
        "programName": "userProfile",
        "deployer": "0xabc123...",
        "accessControl": "private",
        "allowedAddresses": [],
        "created": 1706745600000,
        "lastModified": 1706745700000,
        "size": 2048
      }
    },
    "metadata": { /* same as data.metadata */ }
  }
}
```

#### Error Responses

**400 - Missing Parameter**:
```json
{
  "result": 400,
  "response": {
    "error": "Missing storageAddress parameter"
  }
}
```

**404 - Not Found**:
```json
{
  "result": 404,
  "response": {
    "error": "Storage program not found"
  }
}
```

**500 - Server Error**:
```json
{
  "result": 500,
  "response": {
    "error": "Internal server error",
    "details": "Database connection failed"
  }
}
```

---

## Transaction Payloads

### CREATE_STORAGE_PROGRAM

```typescript
{
  operation: "CREATE_STORAGE_PROGRAM"
  storageAddress: string
  programName: string
  accessControl: "private" | "public" | "restricted" | "deployer-only"
  allowedAddresses?: string[]
  data: Record<string, any>
}
```

### WRITE_STORAGE

```typescript
{
  operation: "WRITE_STORAGE"
  storageAddress: string
  data: Record<string, any>
}
```

### UPDATE_ACCESS_CONTROL

```typescript
{
  operation: "UPDATE_ACCESS_CONTROL"
  storageAddress: string
  accessControl?: "private" | "public" | "restricted" | "deployer-only"
  allowedAddresses?: string[]
}
```

### DELETE_STORAGE_PROGRAM

```typescript
{
  operation: "DELETE_STORAGE_PROGRAM"
  storageAddress: string
}
```

---

## Response Formats

### Success Response

```typescript
{
  success: true
  txHash: string        // For write operations
  storageAddress: string // For create operation
  message?: string
  gcrEdits?: GCREdit[]  // Internal: GCR modifications
}
```

### Error Response

```typescript
{
  success: false
  message: string
  error?: string
  code?: number
}
```

---

## Constants and Limits

### Storage Limits

```typescript
const STORAGE_LIMITS = {
  MAX_SIZE_BYTES: 131072,      // 128KB (128 * 1024)
  MAX_NESTING_DEPTH: 64,       // 64 levels of nested objects
  MAX_KEY_LENGTH: 256          // 256 characters per key name
}
```

### Access Control Modes

```typescript
type AccessControlMode =
  | "private"         // Deployer only (read & write)
  | "public"          // Anyone reads, deployer writes
  | "restricted"      // Deployer + whitelist
  | "deployer-only"   // Explicit deployer-only
```

### Address Format

- **Prefix**: `stor-`
- **Hash**: 40 hex characters (SHA256)
- **Total Length**: 45 characters
- **Pattern**: `/^stor-[a-f0-9]{40}$/`

---

## Types and Interfaces

### StorageProgramPayload

```typescript
interface StorageProgramPayload {
  operation:
    | "CREATE_STORAGE_PROGRAM"
    | "WRITE_STORAGE"
    | "READ_STORAGE"
    | "UPDATE_ACCESS_CONTROL"
    | "DELETE_STORAGE_PROGRAM"

  storageAddress: string
  programName?: string
  accessControl?: AccessControlMode
  allowedAddresses?: string[]
  data?: Record<string, any>
}
```

### StorageProgramMetadata

```typescript
interface StorageProgramMetadata {
  programName: string
  deployer: string
  accessControl: AccessControlMode
  allowedAddresses: string[]
  created: number          // Unix timestamp (ms)
  lastModified: number     // Unix timestamp (ms)
  size: number            // Bytes
}
```

### StorageProgramData

```typescript
interface StorageProgramData {
  variables: Record<string, any>
  metadata: StorageProgramMetadata
}
```

### GCREdit

```typescript
interface GCREdit {
  type: "storageProgram"
  target: string          // Storage address
  context: {
    operation: string
    data?: {
      variables?: Record<string, any>
      metadata?: Partial<StorageProgramMetadata>
    }
    sender?: string
  }
  txhash?: string
}
```

---

## Error Codes

### HTTP Status Codes

| Code | Meaning | Description |
|------|---------|-------------|
| 200 | Success | Operation completed successfully |
| 400 | Bad Request | Invalid parameters or validation failed |
| 403 | Forbidden | Access denied |
| 404 | Not Found | Storage program doesn't exist |
| 500 | Server Error | Internal error or database failure |

### Common Error Messages

#### Validation Errors

```
"Data size {size} bytes exceeds limit of 131072 bytes (128KB)"
"Nesting depth {depth} exceeds limit of 64"
"Key length {length} exceeds limit of 256"
"Restricted mode requires allowedAddresses list"
"Unknown access control mode: {mode}"
```

#### Access Control Errors

```
"Access denied: private mode allows deployer only"
"Access denied: public mode allows deployer to write only"
"Access denied: address not in allowlist"
"Only deployer can perform admin operations"
```

#### Operation Errors

```
"Storage program not found"
"Storage program does not exist"
"READ_STORAGE is a query operation, use RPC endpoints"
"Unknown storage program operation: {operation}"
```

---

## Usage Examples

### Complete Transaction Flow

```typescript
import { DemosClient } from '@kynesyslabs/demosdk'
import { deriveStorageAddress, getDataSize } from '@kynesyslabs/demosdk/storage'

// Initialize client
const demos = new DemosClient({
  rpcUrl: 'https://rpc.demos.network',
  privateKey: process.env.PRIVATE_KEY
})

// 1. Derive address before creation
const myAddress = await demos.getAddress()
const storageAddress = deriveStorageAddress(myAddress, "myApp", "v1")
console.log('Storage will be created at:', storageAddress)

// 2. Check data size before creating
const initialData = {
  username: "alice",
  settings: { theme: "dark" }
}
const size = getDataSize(initialData)
console.log(`Data size: ${size} bytes`)

if (size > 128 * 1024) {
  throw new Error('Data too large')
}

// 3. Create storage program
const createResult = await demos.storageProgram.create(
  "myApp",
  "private",
  {
    initialData: initialData,
    salt: "v1"
  }
)

console.log('Created:', createResult.storageAddress)
console.log('TX:', createResult.txHash)

// 4. Wait for confirmation
await demos.waitForTransaction(createResult.txHash)

// 5. Read data (free RPC query)
const data = await demos.storageProgram.read(storageAddress)
console.log('Variables:', data.data.variables)
console.log('Metadata:', data.data.metadata)

// 6. Update data
await demos.storageProgram.write(storageAddress, {
  bio: "Web3 developer",
  lastActive: Date.now()
})

// 7. Read updated data
const updated = await demos.storageProgram.read(storageAddress)
console.log('Updated:', updated.data.variables)
```

### Error Handling Pattern

```typescript
async function safeStorageOperation() {
  try {
    const result = await demos.storageProgram.create(
      "myProgram",
      "restricted",
      {
        allowedAddresses: ["0x1111..."],
        initialData: { data: "value" }
      }
    )

    return { success: true, data: result }

  } catch (error: any) {
    // Handle specific errors
    if (error.message?.includes('exceeds limit')) {
      return { success: false, error: 'Data too large' }
    }

    if (error.message?.includes('Access denied')) {
      return { success: false, error: 'Permission denied' }
    }

    if (error.code === 404) {
      return { success: false, error: 'Not found' }
    }

    // Generic error
    return { success: false, error: error.message }
  }
}
```

---

## Best Practices

### 1. Address Derivation

Always derive addresses client-side before creating:

```typescript
// ✅ GOOD
const address = deriveStorageAddress(deployer, name, salt)
// ... prepare data ...
await demos.storageProgram.create(name, mode, { salt })

// ❌ BAD
const result = await demos.storageProgram.create(name, mode)
// Where is it? Have to check result.storageAddress
```

### 2. Size Validation

Check size before operations:

```typescript
// ✅ GOOD
const size = getDataSize(data)
if (size > 128 * 1024) {
  throw new Error('Data too large')
}
await demos.storageProgram.write(address, data)

// ❌ BAD
await demos.storageProgram.write(address, data)
// Transaction fails, gas wasted
```

### 3. Access Control

Start restrictive, expand as needed:

```typescript
// ✅ GOOD
await demos.storageProgram.create(name, "deployer-only")
// ... later, when ready ...
await demos.storageProgram.updateAccessControl(addr, {
  accessControl: "public"
})

// ❌ BAD
await demos.storageProgram.create(name, "public")
// Can't take it back!
```

### 4. Read Operations

Use specific key reads when possible:

```typescript
// ✅ GOOD
const username = await demos.storageProgram.read(addr, "username")

// ❌ BAD (if you only need username)
const all = await demos.storageProgram.read(addr)
const username = all.data.variables.username
```

### 5. Error Handling

Always handle errors gracefully:

```typescript
// ✅ GOOD
try {
  const result = await demos.storageProgram.read(addr)
  return result.data
} catch (error) {
  console.error('Read failed:', error)
  return null
}

// ❌ BAD
const result = await demos.storageProgram.read(addr)
// Unhandled promise rejection
```

---

## Version History

### SDK Version 2.4.20

- Initial Storage Programs implementation
- CREATE, WRITE, READ, UPDATE_ACCESS_CONTROL, DELETE operations
- Four access control modes
- 128KB size limit
- 64 level nesting depth
- 256 character key names

---

## See Also

- [Getting Started Guide](./getting-started.md)
- [Operations Guide](./operations.md)
- [Access Control Guide](./access-control.md)
- [RPC Queries Guide](./rpc-queries.md)
- [Examples](./examples.md)
- [Overview](./overview.md)
