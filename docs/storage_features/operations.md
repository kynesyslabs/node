# Storage Program Operations

Complete guide to all Storage Program operations: CREATE, WRITE, READ, UPDATE_ACCESS_CONTROL, and DELETE.

## Operation Overview

| Operation | Transaction Required | Who Can Execute | Purpose |
|-----------|---------------------|-----------------|---------|
| CREATE | ✅ Yes | Anyone | Initialize new storage program |
| WRITE | ✅ Yes | Deployer + allowed | Add/update data |
| READ | ❌ No (RPC) | Depends on access mode | Query data |
| UPDATE_ACCESS_CONTROL | ✅ Yes | Deployer only | Modify permissions |
| DELETE | ✅ Yes | Deployer only | Remove storage program |

## CREATE_STORAGE_PROGRAM

Create a new Storage Program with initial data and access control.

### Syntax

```typescript
const result = await demos.storageProgram.create(
  programName: string,
  accessControl: "private" | "public" | "restricted" | "deployer-only",
  options?: {
    initialData?: Record<string, any>,
    allowedAddresses?: string[],
    salt?: string
  }
)
```

### Parameters

- **programName** (required): Unique name for your storage program
- **accessControl** (required): Access control mode
- **options.initialData** (optional): Initial data to store
- **options.allowedAddresses** (optional): Whitelist for restricted mode
- **options.salt** (optional): Salt for address derivation (default: "")

### Returns

```typescript
{
  success: boolean
  txHash: string
  storageAddress: string
  message?: string
}
```

### Examples

#### Basic Private Storage

```typescript
const result = await demos.storageProgram.create(
  "userSettings",
  "private",
  {
    initialData: {
      theme: "dark",
      language: "en",
      notifications: true
    }
  }
)

console.log('Created:', result.storageAddress)
```

#### Public Announcement Board

```typescript
const result = await demos.storageProgram.create(
  "projectUpdates",
  "public",
  {
    initialData: {
      title: "Project Updates",
      posts: [],
      lastUpdated: Date.now()
    }
  }
)
```

#### Restricted Team Workspace

```typescript
const teamMembers = [
  "0x1234567890123456789012345678901234567890",
  "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
]

const result = await demos.storageProgram.create(
  "teamWorkspace",
  "restricted",
  {
    allowedAddresses: teamMembers,
    initialData: {
      projectName: "DeFi Dashboard",
      tasks: [],
      documents: {}
    }
  }
)
```

#### Empty Storage (No Initial Data)

```typescript
const result = await demos.storageProgram.create(
  "dataStore",
  "private"
  // No initialData - storage created with empty {}
)
```

#### Multiple Programs with Same Name

```typescript
// Use different salts to create multiple programs with same name
const v1Address = await demos.storageProgram.create(
  "appConfig",
  "private",
  { salt: "v1", initialData: { version: 1 } }
)

const v2Address = await demos.storageProgram.create(
  "appConfig",
  "private",
  { salt: "v2", initialData: { version: 2 } }
)

// Different addresses despite same programName
```

### Validation

CREATE operation validates:
- ✅ Data size ≤ 128KB
- ✅ Nesting depth ≤ 64 levels
- ✅ Key lengths ≤ 256 characters
- ✅ allowedAddresses provided for restricted mode

### Error Handling

```typescript
try {
  const result = await demos.storageProgram.create(
    "myProgram",
    "restricted",
    {
      allowedAddresses: [], // Error: empty allowlist
      initialData: { /* ... */ }
    }
  )
} catch (error) {
  console.error('Creation failed:', error.message)
  // "Restricted mode requires at least one allowed address"
}
```

## WRITE_STORAGE

Add or update data in an existing Storage Program.

### Syntax

```typescript
const result = await demos.storageProgram.write(
  storageAddress: string,
  data: Record<string, any>
)
```

### Parameters

- **storageAddress** (required): Address of the storage program
- **data** (required): Data to write/merge

### Returns

```typescript
{
  success: boolean
  txHash: string
  message?: string
}
```

### Merge Behavior

WRITE operations **merge** with existing data:

```typescript
// Initial state
{ username: "alice", email: "alice@example.com" }

// Write operation
await demos.storageProgram.write(storageAddress, {
  bio: "Web3 developer",
  social: { twitter: "@alice" }
})

// Final state (merged)
{
  username: "alice",
  email: "alice@example.com",
  bio: "Web3 developer",
  social: { twitter: "@alice" }
}
```

### Examples

#### Simple Update

```typescript
await demos.storageProgram.write(storageAddress, {
  lastLogin: Date.now(),
  loginCount: 42
})
```

#### Nested Object Update

```typescript
await demos.storageProgram.write(storageAddress, {
  settings: {
    theme: "light", // Updates settings.theme
    fontSize: 14    // Adds settings.fontSize
  }
})
```

#### Array Update

```typescript
// Read current data first
const current = await demos.storageProgram.read(storageAddress)
const posts = current.data.variables.posts || []

// Add new post
posts.push({
  id: Date.now(),
  title: "New Post",
  content: "Hello World"
})

// Write updated array
await demos.storageProgram.write(storageAddress, {
  posts: posts
})
```

#### Bulk Update

```typescript
await demos.storageProgram.write(storageAddress, {
  profile: { name: "Alice", age: 30 },
  settings: { theme: "dark" },
  stats: { views: 1000, likes: 250 },
  lastUpdated: Date.now()
})
```

### Access Control

Who can write depends on the access mode:

| Access Mode | Who Can Write |
|-------------|---------------|
| private | Deployer only |
| public | Deployer only |
| restricted | Deployer + allowed addresses |
| deployer-only | Deployer only |

```typescript
// If you're not authorized:
try {
  await demos.storageProgram.write(storageAddress, { data: "value" })
} catch (error) {
  console.error(error.message)
  // "Access denied: private mode allows deployer only"
}
```

### Validation

WRITE operation validates:
- ✅ Access permissions
- ✅ Combined data size (existing + new) ≤ 128KB
- ✅ Nesting depth ≤ 64 levels
- ✅ Key lengths ≤ 256 characters

### Size Management

```typescript
import { getDataSize } from '@kynesyslabs/demosdk/storage'

// Check size before writing
const current = await demos.storageProgram.read(storageAddress)
const currentSize = current.data.metadata.size

const newData = { /* your new data */ }
const newDataSize = getDataSize(newData)

if (currentSize + newDataSize > 128 * 1024) {
  console.error('Combined size would exceed limit')
  // Consider deleting old data or splitting into multiple programs
}
```

## READ_STORAGE

Query data from a Storage Program via RPC (no transaction needed).

### Syntax

```typescript
// Read all data
const result = await demos.storageProgram.read(storageAddress: string)

// Read specific key
const result = await demos.storageProgram.read(
  storageAddress: string,
  key: string
)
```

### Parameters

- **storageAddress** (required): Address of the storage program
- **key** (optional): Specific key to read

### Returns

```typescript
{
  success: boolean
  data: {
    variables: Record<string, any>  // Your stored data
    metadata: {
      programName: string
      deployer: string
      accessControl: string
      allowedAddresses: string[]
      created: number
      lastModified: number
      size: number
    }
  }
}
```

### Examples

#### Read All Data

```typescript
const result = await demos.storageProgram.read(storageAddress)

console.log('All data:', result.data.variables)
console.log('Program name:', result.data.metadata.programName)
console.log('Size:', result.data.metadata.size, 'bytes')
```

#### Read Specific Key

```typescript
const username = await demos.storageProgram.read(storageAddress, 'username')
console.log('Username:', username)

const settings = await demos.storageProgram.read(storageAddress, 'settings')
console.log('Theme:', settings.theme)
```

#### Read Nested Properties

```typescript
// Storage data:
// { user: { profile: { name: "Alice", email: "alice@example.com" } } }

// Read entire user object
const user = await demos.storageProgram.read(storageAddress, 'user')
console.log('User name:', user.profile.name)
```

### Access Control

Who can read depends on the access mode:

| Access Mode | Who Can Read |
|-------------|--------------|
| private | Deployer only |
| public | Anyone |
| restricted | Deployer + allowed addresses |
| deployer-only | Deployer only |

```typescript
// If you're not authorized:
try {
  await demos.storageProgram.read(storageAddress)
} catch (error) {
  console.error(error.message)
  // "Access denied: private mode allows deployer only"
}
```

### Error Handling

```typescript
try {
  const data = await demos.storageProgram.read(storageAddress)
  console.log(data)
} catch (error) {
  if (error.code === 404) {
    console.error('Storage program not found')
  } else if (error.code === 403) {
    console.error('Access denied')
  } else {
    console.error('Read failed:', error.message)
  }
}
```

### Performance

- **Latency**: <100ms (direct database query)
- **Cost**: Free (no transaction required)
- **Caching**: Results can be cached client-side
- **Rate Limits**: Depends on RPC provider

```typescript
// Efficient batch reading
const addresses = [addr1, addr2, addr3]
const results = await Promise.all(
  addresses.map(addr => demos.storageProgram.read(addr))
)
```

## UPDATE_ACCESS_CONTROL

Modify access control settings of a Storage Program.

### Syntax

```typescript
const result = await demos.storageProgram.updateAccessControl(
  storageAddress: string,
  updates: {
    accessControl?: "private" | "public" | "restricted" | "deployer-only"
    allowedAddresses?: string[]
  }
)
```

### Parameters

- **storageAddress** (required): Address of the storage program
- **updates.accessControl** (optional): New access mode
- **updates.allowedAddresses** (optional): New whitelist

### Returns

```typescript
{
  success: boolean
  txHash: string
  message?: string
}
```

### Examples

#### Change Access Mode

```typescript
// Change from private to public
await demos.storageProgram.updateAccessControl(storageAddress, {
  accessControl: "public"
})

// Change from public to restricted
await demos.storageProgram.updateAccessControl(storageAddress, {
  accessControl: "restricted",
  allowedAddresses: ["0x1234...", "0xabcd..."]
})
```

#### Update Allowed Addresses

```typescript
// Add new team members
await demos.storageProgram.updateAccessControl(storageAddress, {
  allowedAddresses: [
    "0x1111...",
    "0x2222...",
    "0x3333...", // New member
    "0x4444..."  // New member
  ]
})
```

#### Remove Access

```typescript
// Change to deployer-only to revoke all access
await demos.storageProgram.updateAccessControl(storageAddress, {
  accessControl: "deployer-only"
})
```

### Authorization

- **Only the deployer can update access control**
- Attempts by others will fail with "Access denied"

```typescript
// Non-deployer attempts to update:
try {
  await demos.storageProgram.updateAccessControl(storageAddress, {
    accessControl: "public"
  })
} catch (error) {
  console.error(error.message)
  // "Only deployer can perform admin operations"
}
```

### Validation

- ✅ Restricted mode requires at least one allowed address
- ✅ AllowedAddresses must be valid Demos addresses
- ✅ Deployer authorization verified

### Use Cases

#### Grant Temporary Access

```typescript
// Add collaborator temporarily
const originalData = await demos.storageProgram.read(storageAddress)
const originalAllowed = originalData.data.metadata.allowedAddresses

await demos.storageProgram.updateAccessControl(storageAddress, {
  allowedAddresses: [...originalAllowed, tempCollaboratorAddress]
})

// ... work together ...

// Revoke access later
await demos.storageProgram.updateAccessControl(storageAddress, {
  allowedAddresses: originalAllowed // Restore original list
})
```

#### Progressive Disclosure

```typescript
// Start private during development
await demos.storageProgram.create("appData", "private", { /* data */ })

// Open to team for testing
await demos.storageProgram.updateAccessControl(storageAddress, {
  accessControl: "restricted",
  allowedAddresses: teamMembers
})

// Make public at launch
await demos.storageProgram.updateAccessControl(storageAddress, {
  accessControl: "public"
})
```

## DELETE_STORAGE_PROGRAM

Permanently delete a Storage Program and all its data.

### Syntax

```typescript
const result = await demos.storageProgram.delete(storageAddress: string)
```

### Parameters

- **storageAddress** (required): Address of the storage program to delete

### Returns

```typescript
{
  success: boolean
  txHash: string
  message?: string
}
```

### Examples

#### Simple Deletion

```typescript
await demos.storageProgram.delete(storageAddress)
console.log('Storage program deleted')
```

#### Safe Deletion with Confirmation

```typescript
// Read data first
const data = await demos.storageProgram.read(storageAddress)
console.log('About to delete:', data.data.variables)

// Confirm deletion
const confirm = await getUserConfirmation("Delete this storage program?")
if (confirm) {
  await demos.storageProgram.delete(storageAddress)
  console.log('Deleted successfully')
}
```

#### Backup Before Deletion

```typescript
// Backup data
const data = await demos.storageProgram.read(storageAddress)
await saveToBackup(data)

// Delete
await demos.storageProgram.delete(storageAddress)
```

### Authorization

- **Only the deployer can delete**
- Deletion is **permanent and irreversible**

```typescript
// Non-deployer attempts to delete:
try {
  await demos.storageProgram.delete(storageAddress)
} catch (error) {
  console.error(error.message)
  // "Only deployer can perform admin operations"
}
```

### What Happens on Deletion

1. All data in `variables` is cleared
2. Metadata is set to `null`
3. The GCR entry remains but is empty
4. The storage address can be reused

```typescript
// After deletion, reading returns empty state:
const result = await demos.storageProgram.read(storageAddress)
// { variables: {}, metadata: null }
```

### Recovery

**There is no recovery after deletion.** The data is permanently lost.

```typescript
// ❌ NO WAY TO RECOVER
await demos.storageProgram.delete(storageAddress)
// Data is gone forever
```

### Best Practices

1. **Backup before deletion**
2. **Verify the address** before deleting
3. **Use confirmation prompts** in UI
4. **Log deletion events** for audit trail

```typescript
// ✅ GOOD: Safe deletion pattern
async function safeDelete(storageAddress: string) {
  // 1. Backup
  const data = await demos.storageProgram.read(storageAddress)
  await saveBackup(storageAddress, data)

  // 2. Verify
  const metadata = data.data.metadata
  console.log(`Deleting: ${metadata.programName}`)

  // 3. Confirm
  const confirm = await prompt('Type DELETE to confirm: ')
  if (confirm !== 'DELETE') {
    console.log('Deletion cancelled')
    return
  }

  // 4. Delete
  await demos.storageProgram.delete(storageAddress)

  // 5. Log
  console.log(`Deleted ${storageAddress} at ${new Date().toISOString()}`)
}
```

## Operation Comparison

### Transaction Costs

| Operation | Gas Cost | Confirmation Time |
|-----------|----------|-------------------|
| CREATE | Medium | ~2-5 seconds |
| WRITE | Low-Medium | ~2-5 seconds |
| READ | **Free** | <100ms |
| UPDATE_ACCESS_CONTROL | Low | ~2-5 seconds |
| DELETE | Low | ~2-5 seconds |

### Permission Matrix

| Operation | Private | Public | Restricted | Deployer-Only |
|-----------|---------|--------|------------|---------------|
| CREATE | Anyone | Anyone | Anyone | Anyone |
| WRITE | Deployer | Deployer | Deployer + Allowed | Deployer |
| READ | Deployer | Anyone | Deployer + Allowed | Deployer |
| UPDATE_ACCESS_CONTROL | Deployer | Deployer | Deployer | Deployer |
| DELETE | Deployer | Deployer | Deployer | Deployer |

## Next Steps

- [Access Control Guide](./access-control.md) - Deep dive into permission systems
- [RPC Queries](./rpc-queries.md) - Optimize read operations
- [Examples](./examples.md) - Real-world implementation patterns
- [API Reference](./api-reference.md) - Complete API documentation
