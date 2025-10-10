# Getting Started with Storage Programs

This guide will walk you through creating your first Storage Program on Demos Network.

## Prerequisites

- Node.js 18+ or Bun installed
- Demos Network SDK installed: `@kynesyslabs/demosdk`
- A Demos wallet with some balance for transaction fees
- Connection to a Demos Network RPC node

## Installation

```bash
# Using npm
npm install @kynesyslabs/demosdk

# Using bun
bun add @kynesyslabs/demosdk
```

## Your First Storage Program

### Step 1: Initialize the SDK

```typescript
import { DemosClient } from '@kynesyslabs/demosdk'
import { deriveStorageAddress } from '@kynesyslabs/demosdk/storage'

// Connect to Demos Network
const demos = new DemosClient({
  rpcUrl: 'https://rpc.demos.network',
  privateKey: 'your-private-key-here' // Use environment variables in production
})

// Get your wallet address
const myAddress = await demos.getAddress()
console.log('My address:', myAddress)
```

### Step 2: Generate Storage Address

Before creating a Storage Program, you can calculate its address client-side:

```typescript
// Generate deterministic address
const programName = "myFirstProgram"
const salt = "" // Optional: use different salt for multiple programs with same name

const storageAddress = deriveStorageAddress(
  myAddress,
  programName,
  salt
)

console.log('Storage address:', storageAddress)
// Output: stor-a1b2c3d4e5f6789012345678901234567890abcd...
```

**Address Format**: `stor-` + 40 hex characters (SHA256 hash)

### Step 3: Create Your Storage Program

Let's create a simple user profile storage:

```typescript
import { StorageProgram } from '@kynesyslabs/demosdk/storage'

// Create storage program with initial data
const result = await demos.storageProgram.create(
  programName,
  "private", // Access control: private, public, restricted, deployer-only
  {
    initialData: {
      username: "alice",
      email: "alice@example.com",
      preferences: {
        theme: "dark",
        notifications: true
      },
      createdAt: Date.now()
    }
  }
)

console.log('Transaction hash:', result.txHash)
console.log('Storage address:', result.storageAddress)
```

**Access Control Modes**:
- `private`: Only you can read and write
- `public`: Anyone can read, only you can write
- `restricted`: Only you and whitelisted addresses can access
- `deployer-only`: Explicit deployer-only mode (same as private)

### Step 4: Write Data to Storage

Add or update data in your Storage Program:

```typescript
// Write/update data (merges with existing data)
const writeResult = await demos.storageProgram.write(
  storageAddress,
  {
    bio: "Web3 developer and blockchain enthusiast",
    socialLinks: {
      twitter: "@alice_demos",
      github: "alice"
    },
    lastUpdated: Date.now()
  }
)

console.log('Data written:', writeResult.txHash)
```

**Important**: Write operations **merge** with existing data. They don't replace the entire storage.

### Step 5: Read Data via RPC

Reading data is **free** and doesn't require a transaction:

```typescript
// Read all data
const allData = await demos.storageProgram.read(storageAddress)
console.log('All data:', allData.data)
console.log('Metadata:', allData.metadata)

// Read specific key
const username = await demos.storageProgram.read(storageAddress, 'username')
console.log('Username:', username)
```

**Read Response Structure**:
```typescript
{
  success: true,
  data: {
    variables: {
      username: "alice",
      email: "alice@example.com",
      preferences: { theme: "dark", notifications: true },
      bio: "Web3 developer...",
      socialLinks: { twitter: "@alice_demos", github: "alice" }
    },
    metadata: {
      programName: "myFirstProgram",
      deployer: "0xabc123...",
      accessControl: "private",
      allowedAddresses: [],
      created: 1706745600000,
      lastModified: 1706745700000,
      size: 2048
    }
  }
}
```

## Complete Example

Here's a complete working example:

```typescript
import { DemosClient } from '@kynesyslabs/demosdk'
import { deriveStorageAddress } from '@kynesyslabs/demosdk/storage'

async function main() {
  // 1. Initialize SDK
  const demos = new DemosClient({
    rpcUrl: 'https://rpc.demos.network',
    privateKey: process.env.PRIVATE_KEY
  })

  const myAddress = await demos.getAddress()
  console.log('Connected as:', myAddress)

  // 2. Generate storage address
  const programName = "userProfile"
  const storageAddress = deriveStorageAddress(myAddress, programName)
  console.log('Storage address:', storageAddress)

  // 3. Create storage program
  console.log('Creating storage program...')
  const createResult = await demos.storageProgram.create(
    programName,
    "private",
    {
      initialData: {
        displayName: "Alice",
        joinedAt: Date.now(),
        stats: {
          posts: 0,
          followers: 0
        }
      }
    }
  )
  console.log('Created! TX:', createResult.txHash)

  // 4. Wait for transaction confirmation (optional but recommended)
  await demos.waitForTransaction(createResult.txHash)
  console.log('Transaction confirmed')

  // 5. Read the data back
  const data = await demos.storageProgram.read(storageAddress)
  console.log('Data retrieved:', data.data.variables)
  console.log('Metadata:', data.data.metadata)

  // 6. Update some data
  console.log('Updating stats...')
  const updateResult = await demos.storageProgram.write(
    storageAddress,
    {
      stats: {
        posts: 5,
        followers: 42
      },
      lastActive: Date.now()
    }
  )
  console.log('Updated! TX:', updateResult.txHash)

  // 7. Read specific field
  const stats = await demos.storageProgram.read(storageAddress, 'stats')
  console.log('Stats:', stats)
}

main().catch(console.error)
```

## Common Patterns

### Creating Public Storage (Announcements)

```typescript
const announcementAddress = await demos.storageProgram.create(
  "projectAnnouncements",
  "public", // Anyone can read, only you can write
  {
    initialData: {
      latest: "Version 2.0 released!",
      updates: [
        { date: Date.now(), message: "Initial release" }
      ]
    }
  }
)
```

### Creating Restricted Storage (Team Collaboration)

```typescript
const teamStorage = await demos.storageProgram.create(
  "teamWorkspace",
  "restricted",
  {
    allowedAddresses: [
      "0xteamMember1...",
      "0xteamMember2...",
      "0xteamMember3..."
    ],
    initialData: {
      projectName: "DeFi Dashboard",
      tasks: []
    }
  }
)
```

### Updating Access Control

```typescript
// Add new team member to restricted storage
await demos.storageProgram.updateAccessControl(
  storageAddress,
  {
    allowedAddresses: [
      "0xteamMember1...",
      "0xteamMember2...",
      "0xteamMember3...",
      "0xnewMember..." // New member added
    ]
  }
)

// Change access mode
await demos.storageProgram.updateAccessControl(
  storageAddress,
  {
    accessControl: "public" // Change from restricted to public
  }
)
```

## Troubleshooting

### Error: "Data size exceeds limit"

**Problem**: Your data exceeds the 128KB limit.

**Solution**:
```typescript
// Check data size before storing
import { getDataSize } from '@kynesyslabs/demosdk/storage'

const data = { /* your data */ }
const size = getDataSize(data)
console.log(`Data size: ${size} bytes (limit: ${128 * 1024})`)

if (size > 128 * 1024) {
  console.error('Data too large! Consider splitting or compressing.')
}
```

### Error: "Access denied"

**Problem**: Trying to write to storage you don't have access to.

**Solution**: Check the access control mode and your permissions:
```typescript
const data = await demos.storageProgram.read(storageAddress)
const metadata = data.data.metadata

console.log('Access control:', metadata.accessControl)
console.log('Deployer:', metadata.deployer)
console.log('Allowed addresses:', metadata.allowedAddresses)
```

### Error: "Storage program not found"

**Problem**: Trying to read a Storage Program that doesn't exist yet.

**Solution**: Verify the address and ensure the creation transaction was confirmed:
```typescript
// Check if storage program exists
try {
  const data = await demos.storageProgram.read(storageAddress)
  console.log('Storage program exists')
} catch (error) {
  console.log('Storage program not found or not yet confirmed')
}
```

### Error: "Nesting depth exceeds limit"

**Problem**: Your object structure is too deeply nested (>64 levels).

**Solution**: Flatten your data structure:
```typescript
// ❌ BAD: Too deeply nested
const badData = { level1: { level2: { level3: { /* ... 64+ levels */ } } } }

// ✅ GOOD: Flattened structure
const goodData = {
  "user.profile.name": "Alice",
  "user.profile.email": "alice@example.com",
  "user.settings.theme": "dark"
}
```

## Best Practices

### 1. Use Environment Variables

```typescript
// ✅ GOOD
const demos = new DemosClient({
  rpcUrl: process.env.DEMOS_RPC_URL,
  privateKey: process.env.PRIVATE_KEY
})

// ❌ BAD
const demos = new DemosClient({
  privateKey: 'hardcoded-private-key' // NEVER DO THIS
})
```

### 2. Wait for Transaction Confirmation

```typescript
// ✅ GOOD
const result = await demos.storageProgram.create(...)
await demos.waitForTransaction(result.txHash)
const data = await demos.storageProgram.read(storageAddress)

// ❌ BAD
const result = await demos.storageProgram.create(...)
const data = await demos.storageProgram.read(storageAddress) // Might fail, tx not confirmed yet
```

### 3. Check Data Size Before Writing

```typescript
// ✅ GOOD
import { getDataSize } from '@kynesyslabs/demosdk/storage'

const size = getDataSize(myData)
if (size > 128 * 1024) {
  throw new Error('Data too large')
}
await demos.storageProgram.write(storageAddress, myData)
```

### 4. Use Descriptive Program Names

```typescript
// ✅ GOOD
const storageAddress = deriveStorageAddress(myAddress, "userProfile", "v1")

// ❌ BAD
const storageAddress = deriveStorageAddress(myAddress, "data", "")
```

### 5. Structure Data Logically

```typescript
// ✅ GOOD: Organized structure
const userData = {
  profile: { name: "Alice", bio: "..." },
  settings: { theme: "dark", notifications: true },
  stats: { posts: 5, followers: 42 }
}

// ❌ BAD: Flat and unorganized
const userData = {
  name: "Alice",
  bio: "...",
  theme: "dark",
  notifications: true,
  posts: 5,
  followers: 42
}
```

## Next Steps

Now that you've created your first Storage Program, explore:

- [Operations Guide](./operations.md) - Learn all CRUD operations in detail
- [Access Control](./access-control.md) - Master permission systems
- [RPC Queries](./rpc-queries.md) - Efficient data reading patterns
- [Examples](./examples.md) - Practical real-world examples
- [API Reference](./api-reference.md) - Complete API documentation

## Quick Reference

### SDK Methods

```typescript
// Create storage program
await demos.storageProgram.create(programName, accessControl, options)

// Write data
await demos.storageProgram.write(storageAddress, data)

// Read data
await demos.storageProgram.read(storageAddress, key?)

// Update access control
await demos.storageProgram.updateAccessControl(storageAddress, updates)

// Delete storage program
await demos.storageProgram.delete(storageAddress)

// Generate address
deriveStorageAddress(deployerAddress, programName, salt?)
```

### Storage Limits

- **Max size**: 128KB per program
- **Max nesting**: 64 levels
- **Max key length**: 256 characters

### Access Control Modes

- `private` - Deployer only (read & write)
- `public` - Anyone reads, deployer writes
- `restricted` - Deployer + whitelist
- `deployer-only` - Same as private
