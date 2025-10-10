# Access Control Guide

Master the permission system for Storage Programs with flexible access control modes.

## Overview

Storage Programs support four access control modes that determine who can read and write data:

| Mode | Read Access | Write Access | Best For |
|------|-------------|--------------|----------|
| **private** | Deployer only | Deployer only | Personal data, secrets |
| **public** | Anyone | Deployer only | Announcements, public content |
| **restricted** | Deployer + Whitelist | Deployer + Whitelist | Teams, collaboration |
| **deployer-only** | Deployer only | Deployer only | Explicit private mode |

## Access Control Modes

### Private Mode

**Who can access**: Deployer only (both read and write)

**Use cases**:
- Personal user settings
- Private notes and documents
- Sensitive configuration data
- Individual user profiles

**Example**:
```typescript
const result = await demos.storageProgram.create(
  "personalNotes",
  "private",
  {
    initialData: {
      notes: [
        { title: "My Ideas", content: "..." },
        { title: "Todo List", content: "..." }
      ],
      createdAt: Date.now()
    }
  }
)

// Only the deployer can read or write
const data = await demos.storageProgram.read(result.storageAddress)
await demos.storageProgram.write(result.storageAddress, { newNote: "..." })
```

**Access validation**:
```typescript
// Another user trying to read:
try {
  await demos.storageProgram.read(privateStorageAddress)
} catch (error) {
  console.error(error.message)
  // "Access denied: private mode allows deployer only"
}
```

### Public Mode

**Who can access**:
- Read: Anyone
- Write: Deployer only

**Use cases**:
- Project announcements
- Public documentation
- Read-only data feeds
- Company updates

**Example**:
```typescript
const result = await demos.storageProgram.create(
  "companyUpdates",
  "public",
  {
    initialData: {
      name: "Acme Corp Updates",
      announcements: [
        {
          date: Date.now(),
          title: "Q4 Results Released",
          content: "We've achieved record growth..."
        }
      ]
    }
  }
)

// Anyone can read (no authentication needed)
const data = await demos.storageProgram.read(result.storageAddress)
console.log('Latest announcement:', data.data.variables.announcements[0])

// Only deployer can write
await demos.storageProgram.write(result.storageAddress, {
  announcements: [...data.data.variables.announcements, newAnnouncement]
})
```

**Perfect for**:
- Public-facing content
- Transparency initiatives
- Open data publishing
- Status pages

### Restricted Mode

**Who can access**: Deployer + whitelisted addresses

**Use cases**:
- Team workspaces
- Shared documents
- Collaborative projects
- Multi-user applications

**Example**:
```typescript
const teamMembers = [
  "0x1111111111111111111111111111111111111111", // Alice
  "0x2222222222222222222222222222222222222222", // Bob
  "0x3333333333333333333333333333333333333333"  // Carol
]

const result = await demos.storageProgram.create(
  "teamWorkspace",
  "restricted",
  {
    allowedAddresses: teamMembers,
    initialData: {
      projectName: "DeFi Dashboard",
      tasks: [],
      documents: {},
      members: teamMembers
    }
  }
)

// All team members can read and write
// (assuming they're using their respective wallets)
await demos.storageProgram.write(result.storageAddress, {
  tasks: [
    { assignee: teamMembers[0], task: "Design mockups", status: "in-progress" },
    { assignee: teamMembers[1], task: "Backend API", status: "pending" }
  ]
})
```

**Adding/removing members**:
```typescript
// Read current members
const data = await demos.storageProgram.read(storageAddress)
const currentMembers = data.data.metadata.allowedAddresses

// Add new member
const newMember = "0x4444444444444444444444444444444444444444"
await demos.storageProgram.updateAccessControl(storageAddress, {
  allowedAddresses: [...currentMembers, newMember]
})

// Remove member
const updatedMembers = currentMembers.filter(addr => addr !== memberToRemove)
await demos.storageProgram.updateAccessControl(storageAddress, {
  allowedAddresses: updatedMembers
})
```

### Deployer-Only Mode

**Who can access**: Deployer only (explicit private mode)

**Difference from "private"**: Semantically identical, but makes the intent explicit.

**Use cases**:
- Same as private mode
- When you want to be explicit about single-user access

**Example**:
```typescript
const result = await demos.storageProgram.create(
  "adminConfig",
  "deployer-only",  // Explicit single-user mode
  {
    initialData: {
      apiKeys: { /* sensitive keys */ },
      settings: { /* admin settings */ }
    }
  }
)
```

## Changing Access Control

### Syntax

```typescript
await demos.storageProgram.updateAccessControl(
  storageAddress: string,
  updates: {
    accessControl?: "private" | "public" | "restricted" | "deployer-only"
    allowedAddresses?: string[]
  }
)
```

### Examples

#### From Private to Public

```typescript
// Start private during development
const result = await demos.storageProgram.create(
  "projectData",
  "private",
  { initialData: { status: "development" } }
)

// Make public at launch
await demos.storageProgram.updateAccessControl(result.storageAddress, {
  accessControl: "public"
})
```

#### From Public to Restricted

```typescript
// Start public for beta
const result = await demos.storageProgram.create(
  "betaFeatures",
  "public",
  { initialData: { features: [] } }
)

// Restrict to beta testers
await demos.storageProgram.updateAccessControl(result.storageAddress, {
  accessControl: "restricted",
  allowedAddresses: betaTesterAddresses
})
```

#### From Restricted to Private

```typescript
// Team collaboration completed, make it private
await demos.storageProgram.updateAccessControl(storageAddress, {
  accessControl: "private"
  // allowedAddresses becomes irrelevant in private mode
})
```

## Permission Patterns

### Role-Based Access (Restricted Mode)

```typescript
// Define roles
const roles = {
  admins: ["0x1111...", "0x2222..."],
  editors: ["0x3333...", "0x4444...", "0x5555..."],
  viewers: ["0x6666...", "0x7777..."]
}

// Combine all roles for write access
const allUsers = [...roles.admins, ...roles.editors, ...roles.viewers]

const result = await demos.storageProgram.create(
  "sharedDocument",
  "restricted",
  {
    allowedAddresses: allUsers,
    initialData: {
      roles: roles,
      content: "...",
      metadata: { created: Date.now() }
    }
  }
)

// Application logic enforces role permissions
async function updateDocument(user: string, newContent: string) {
  const data = await demos.storageProgram.read(storageAddress)

  // Check role in application logic
  if (data.data.variables.roles.editors.includes(user) ||
      data.data.variables.roles.admins.includes(user)) {
    await demos.storageProgram.write(storageAddress, {
      content: newContent,
      lastModified: Date.now(),
      lastModifiedBy: user
    })
  } else {
    throw new Error("User does not have edit permission")
  }
}
```

### Temporary Access

```typescript
// Grant temporary access for collaboration
const originalData = await demos.storageProgram.read(storageAddress)
const originalAllowed = originalData.data.metadata.allowedAddresses

// Add collaborator
await demos.storageProgram.updateAccessControl(storageAddress, {
  allowedAddresses: [...originalAllowed, collaboratorAddress]
})

// Store original state and expiry
await demos.storageProgram.write(storageAddress, {
  tempAccess: {
    address: collaboratorAddress,
    grantedAt: Date.now(),
    expiresAt: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
  }
})

// Later: Revoke access
await demos.storageProgram.updateAccessControl(storageAddress, {
  allowedAddresses: originalAllowed
})
```

### Progressive Disclosure

```typescript
// Stage 1: Private development
const result = await demos.storageProgram.create(
  "productLaunch",
  "private",
  { initialData: { phase: "development" } }
)

// Stage 2: Internal team testing
await demos.storageProgram.updateAccessControl(result.storageAddress, {
  accessControl: "restricted",
  allowedAddresses: internalTeam
})
await demos.storageProgram.write(result.storageAddress, {
  phase: "internal-testing"
})

// Stage 3: Beta testers
await demos.storageProgram.updateAccessControl(result.storageAddress, {
  allowedAddresses: [...internalTeam, ...betaTesters]
})
await demos.storageProgram.write(result.storageAddress, {
  phase: "beta-testing"
})

// Stage 4: Public launch
await demos.storageProgram.updateAccessControl(result.storageAddress, {
  accessControl: "public"
})
await demos.storageProgram.write(result.storageAddress, {
  phase: "public-launch",
  launchDate: Date.now()
})
```

### Read-Only Viewers (Public Mode)

```typescript
// Create public-readable, deployer-writable storage
const result = await demos.storageProgram.create(
  "publicBlog",
  "public",
  {
    initialData: {
      title: "My Blog",
      posts: []
    }
  }
)

// Anyone can read
const blog = await demos.storageProgram.read(result.storageAddress)
console.log('Blog posts:', blog.data.variables.posts)

// Only deployer can publish new posts
await demos.storageProgram.write(result.storageAddress, {
  posts: [
    ...blog.data.variables.posts,
    {
      id: Date.now(),
      title: "New Post",
      content: "...",
      author: await demos.getAddress(),
      publishedAt: Date.now()
    }
  ]
})
```

## Security Best Practices

### 1. Never Store Secrets Unencrypted

```typescript
// ❌ BAD: Storing API key in plain text
await demos.storageProgram.create(
  "config",
  "private",
  {
    initialData: {
      apiKey: "sk_live_1234567890abcdef" // DANGER: Plain text
    }
  }
)

// ✅ GOOD: Encrypt before storing
import { encrypt } from './encryption'

const encryptedKey = encrypt(apiKey, password)
await demos.storageProgram.create(
  "config",
  "private",
  {
    initialData: {
      apiKey: encryptedKey // Safe: Encrypted
    }
  }
)
```

### 2. Validate Addresses in Restricted Mode

```typescript
// ✅ GOOD: Validate addresses before adding to whitelist
function isValidDemosAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address)
}

const teamMembers = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222"
]

// Validate all addresses
const allValid = teamMembers.every(isValidDemosAddress)
if (!allValid) {
  throw new Error("Invalid address in team members list")
}

await demos.storageProgram.create(
  "teamWorkspace",
  "restricted",
  { allowedAddresses: teamMembers }
)
```

### 3. Audit Access Changes

```typescript
// ✅ GOOD: Log all access control changes
async function updateAccessWithAudit(
  storageAddress: string,
  updates: any,
  reason: string
) {
  // Read current state
  const before = await demos.storageProgram.read(storageAddress)

  // Update access control
  await demos.storageProgram.updateAccessControl(storageAddress, updates)

  // Log the change
  const after = await demos.storageProgram.read(storageAddress)
  await demos.storageProgram.write(storageAddress, {
    auditLog: [
      ...(before.data.variables.auditLog || []),
      {
        timestamp: Date.now(),
        action: "access_control_change",
        before: before.data.metadata.accessControl,
        after: after.data.metadata.accessControl,
        reason: reason,
        changedBy: await demos.getAddress()
      }
    ]
  })
}

// Usage
await updateAccessWithAudit(
  storageAddress,
  { accessControl: "public" },
  "Public launch"
)
```

### 4. Principle of Least Privilege

```typescript
// ✅ GOOD: Start restrictive, expand as needed
const result = await demos.storageProgram.create(
  "userManagement",
  "deployer-only",  // Most restrictive
  { initialData: { users: [] } }
)

// Only expand access when necessary
if (needsTeamAccess) {
  await demos.storageProgram.updateAccessControl(result.storageAddress, {
    accessControl: "restricted",
    allowedAddresses: trustedAdmins
  })
}
```

### 5. Separate Sensitive and Public Data

```typescript
// ✅ GOOD: Use separate storage programs for different sensitivity levels

// Private: Sensitive user data
const privateStorage = await demos.storageProgram.create(
  "userPrivateData",
  "private",
  { initialData: { email: "user@example.com", apiTokens: {} } }
)

// Public: Public profile
const publicStorage = await demos.storageProgram.create(
  "userPublicProfile",
  "public",
  { initialData: { username: "alice", bio: "Developer", avatar: "..." } }
)
```

## Common Patterns

### Multi-Tier Access

```typescript
// Admin-only management storage
const adminStorage = await demos.storageProgram.create(
  "adminPanel",
  "restricted",
  {
    allowedAddresses: admins,
    initialData: { settings: {}, logs: [] }
  }
)

// Team collaboration storage
const teamStorage = await demos.storageProgram.create(
  "teamDocs",
  "restricted",
  {
    allowedAddresses: [...admins, ...teamMembers],
    initialData: { documents: {} }
  }
)

// Public read-only storage
const publicStorage = await demos.storageProgram.create(
  "publicInfo",
  "public",
  {
    initialData: { announcements: [], faq: [] }
  }
)
```

### Dynamic Permissions

```typescript
// Application-level permission checking
async function canUserEdit(
  storageAddress: string,
  userAddress: string
): Promise<boolean> {
  const data = await demos.storageProgram.read(storageAddress)
  const metadata = data.data.metadata

  // Check if user is deployer
  if (userAddress === metadata.deployer) return true

  // Check access mode
  if (metadata.accessControl === "public") return false
  if (metadata.accessControl === "private") return false
  if (metadata.accessControl === "deployer-only") return false

  // Check whitelist for restricted mode
  if (metadata.accessControl === "restricted") {
    return metadata.allowedAddresses.includes(userAddress)
  }

  return false
}

// Usage in application
if (await canUserEdit(storageAddress, currentUser)) {
  await demos.storageProgram.write(storageAddress, updates)
} else {
  console.error("Permission denied")
}
```

### Access Expiration

```typescript
// Store access grants with expiration
await demos.storageProgram.write(storageAddress, {
  accessGrants: [
    {
      address: "0x1111...",
      grantedAt: Date.now(),
      expiresAt: Date.now() + (7 * 24 * 60 * 60 * 1000), // 7 days
      permissions: ["read", "write"]
    }
  ]
})

// Check expiration in application logic
async function hasValidAccess(
  storageAddress: string,
  userAddress: string
): Promise<boolean> {
  const data = await demos.storageProgram.read(storageAddress)
  const grants = data.data.variables.accessGrants || []

  const userGrant = grants.find(g => g.address === userAddress)
  if (!userGrant) return false

  // Check if expired
  if (Date.now() > userGrant.expiresAt) {
    return false
  }

  return true
}
```

## Troubleshooting

### Error: "Access denied"

**Cause**: Your address doesn't have permission to perform the operation.

**Solution**: Check the access control mode and your permissions:
```typescript
const data = await demos.storageProgram.read(storageAddress)
const metadata = data.data.metadata

console.log('Access mode:', metadata.accessControl)
console.log('Deployer:', metadata.deployer)
console.log('Your address:', await demos.getAddress())
console.log('Allowed addresses:', metadata.allowedAddresses)
```

### Error: "Restricted mode requires allowedAddresses list"

**Cause**: Creating restricted storage without providing allowed addresses.

**Solution**: Always provide allowedAddresses for restricted mode:
```typescript
// ❌ BAD
await demos.storageProgram.create("data", "restricted", {})

// ✅ GOOD
await demos.storageProgram.create("data", "restricted", {
  allowedAddresses: ["0x1111..."]
})
```

### Error: "Only deployer can perform admin operations"

**Cause**: Non-deployer trying to update access control or delete.

**Solution**: Only the deployer can perform admin operations. Verify you're using the correct wallet:
```typescript
const myAddress = await demos.getAddress()
const metadata = data.data.metadata

if (myAddress !== metadata.deployer) {
  console.error("You are not the deployer of this storage program")
  console.log("Deployer:", metadata.deployer)
  console.log("Your address:", myAddress)
}
```

## Next Steps

- [RPC Queries](./rpc-queries.md) - Optimize read operations with access control
- [Examples](./examples.md) - Real-world access control patterns
- [API Reference](./api-reference.md) - Complete API documentation
