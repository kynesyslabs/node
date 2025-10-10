# Storage Programs Overview

## Introduction

Storage Programs are a powerful key-value storage solution built into the Demos Network, providing developers with decentralized, persistent data storage with flexible access control. Think of Storage Programs as smart, programmable databases that live on the blockchain with built-in permission systems.

## What are Storage Programs?

A Storage Program is a deterministic storage container that allows you to:

- **Store arbitrary data**: Store any JSON-serializable data (objects, arrays, primitives)
- **Control access**: Choose who can read and write your data
- **Use deterministic addresses**: Predict storage addresses before creation
- **Query efficiently**: Read data via RPC without transaction costs
- **Update atomically**: All writes are atomic and consensus-validated

## Key Features

### 🔐 Flexible Access Control

Choose from four access control modes:

- **Private**: Only the deployer can read and write
- **Public**: Anyone can read, only deployer can write (perfect for public announcements)
- **Restricted**: Only deployer and whitelisted addresses can access
- **Deployer-Only**: Explicit deployer-only mode

### 📦 Generous Storage Limits

- **128KB per Storage Program**: Store substantial amounts of structured data
- **64 levels of nesting**: Deep object hierarchies supported
- **256 character keys**: Descriptive key names

### 🎯 Deterministic Addressing

Storage Program addresses are derived from:
```
address = stor-{SHA256(deployerAddress + programName + salt)}
```

This means you can:
- Generate addresses client-side before creating programs
- Share addresses with users before deployment
- Create predictable, human-readable program names

### ⚡ Efficient Operations

- **Write operations**: Validated and applied via consensus
- **Read operations**: Instant RPC queries (no transaction needed)
- **Update operations**: Merge updates with existing data
- **Delete operations**: Complete removal (deployer-only)

## How Storage Programs Work

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Client Application                     │
│  (Create, Write, Read, Update Access, Delete)            │
└─────────────────────────┬───────────────────────────────┘
                          │
                ┌─────────┴─────────┐
                │                   │
          Write Operations    Read Operations (RPC)
                │                   │
                ▼                   ▼
┌───────────────────────┐  ┌───────────────────────┐
│  Transaction System   │  │    Query System       │
│  (Consensus)          │  │    (Direct DB)        │
└───────┬───────────────┘  └───────┬───────────────┘
        │                          │
        ▼                          ▼
┌──────────────────────────────────────────────────┐
│         Demos Network Global Chain Registry       │
│                  (GCR Database)                   │
│                                                   │
│  GCR_Main.data = {                               │
│    variables: { ...your data... },               │
│    metadata: { programName, deployer, ... }      │
│  }                                                │
└──────────────────────────────────────────────────┘
```

### Data Storage

Storage Programs are stored in the `GCR_Main` table's `data` column (JSONB):

```json
{
  "variables": {
    "username": "alice",
    "score": 1000,
    "settings": {
      "theme": "dark",
      "notifications": true
    }
  },
  "metadata": {
    "programName": "myApp",
    "deployer": "0xdeployer123...",
    "accessControl": "public",
    "allowedAddresses": [],
    "created": 1706745600000,
    "lastModified": 1706745600000,
    "size": 2048
  }
}
```

## Use Cases

### 1. User Profiles and Settings

Store user preferences, profile data, and application settings:

```typescript
// Create user profile storage
const profileAddress = await demos.storageProgram.create(
  "userProfile",
  "private",
  {
    initialData: {
      displayName: "Alice",
      avatar: "ipfs://...",
      preferences: {
        theme: "dark",
        language: "en"
      }
    }
  }
)
```

### 2. Shared State Management

Coordinate state across multiple users with controlled access:

```typescript
// Game lobby with restricted access
const lobbyAddress = await demos.storageProgram.create(
  "gameLobby1",
  "restricted",
  {
    allowedAddresses: [player1, player2, player3],
    initialData: {
      status: "waiting",
      players: [],
      settings: { maxPlayers: 4, gameMode: "classic" }
    }
  }
)
```

### 3. Public Announcements

Publish read-only data that anyone can access:

```typescript
// Project announcements
const announcementsAddress = await demos.storageProgram.create(
  "projectAnnouncements",
  "public",
  {
    initialData: {
      latest: "Version 2.0 released!",
      updates: []
    }
  }
)
```

### 4. Configuration Management

Store application configuration data:

```typescript
// App configuration
const configAddress = await demos.storageProgram.create(
  "appConfig",
  "deployer-only",
  {
    initialData: {
      apiEndpoints: ["https://api1.example.com", "https://api2.example.com"],
      featureFlags: {
        betaFeatures: false,
        newUI: true
      }
    }
  }
)
```

### 5. Collaborative Documents

Multiple users collaborating on shared data:

```typescript
// Shared document
const docAddress = await demos.storageProgram.create(
  "sharedDoc",
  "restricted",
  {
    allowedAddresses: [user1, user2, user3],
    initialData: {
      title: "Project Proposal",
      content: "",
      lastEdit: Date.now(),
      editors: []
    }
  }
)
```

## Comparison with Other Storage Solutions

### vs. Traditional Databases
- ✅ **Decentralized**: No single point of failure
- ✅ **Immutable history**: All changes recorded on blockchain
- ✅ **Built-in access control**: No separate auth system needed
- ❌ **Size limits**: 128KB per program (vs unlimited in traditional DBs)
- ❌ **Write costs**: Transactions require consensus (vs instant writes)

### vs. IPFS
- ✅ **Mutable**: Update data without changing addresses
- ✅ **Access control**: Built-in permission system
- ✅ **Structured queries**: Read specific keys without downloading everything
- ❌ **Size limits**: 128KB (vs unlimited in IPFS)
- ❌ **Not free**: Writes require transactions (IPFS storage is pay-once)

### vs. Smart Contract Storage
- ✅ **Flexible structure**: No need to predefine schemas
- ✅ **JSON-native**: Store complex nested objects easily
- ✅ **Lower costs**: Optimized for data storage
- ✅ **Simple API**: No Solidity/contract coding needed
- ❌ **No logic**: Cannot execute code (pure storage)

## Core Concepts

### Address Derivation

Storage Program addresses are **deterministic** and **predictable**:

```typescript
import { deriveStorageAddress } from '@kynesyslabs/demosdk/storage'

// Generate address client-side
const address = deriveStorageAddress(
  deployerAddress,  // Your wallet address
  programName,      // Unique name: "myApp"
  salt             // Optional salt for uniqueness: "v1"
)

// Result: "stor-a1b2c3d4e5f6..." (45 characters)
```

**Format**: `stor-` + 40 hex characters

### Operations Lifecycle

1. **CREATE**: Initialize new storage program with optional data
2. **WRITE**: Add or update key-value pairs (merges with existing data)
3. **READ**: Query data via RPC (no transaction needed)
4. **UPDATE_ACCESS_CONTROL**: Change access mode or allowed addresses (deployer only)
5. **DELETE**: Remove entire storage program (deployer only)

### Access Control Modes

| Mode | Read Access | Write Access | Use Case |
|------|-------------|--------------|----------|
| **private** | Deployer only | Deployer only | Personal data, secrets |
| **public** | Anyone | Deployer only | Announcements, public data |
| **restricted** | Deployer + allowed | Deployer + allowed | Shared workspaces, teams |
| **deployer-only** | Deployer only | Deployer only | Explicit private mode |

### Storage Limits

These limits ensure blockchain efficiency:

```typescript
const STORAGE_LIMITS = {
  MAX_SIZE_BYTES: 128 * 1024,    // 128KB total
  MAX_NESTING_DEPTH: 64,         // 64 levels of nested objects
  MAX_KEY_LENGTH: 256            // 256 characters per key name
}
```

**Size Calculation**:
```typescript
const size = new TextEncoder().encode(JSON.stringify(data)).length
```

## Security Considerations

### Data Privacy

- **Private/Deployer-Only modes**: Data is stored on blockchain but access-controlled
- **Encryption recommended**: For sensitive data, encrypt before storing
- **Public mode**: Anyone can read - never store secrets

### Access Control

- **Deployer verification**: All operations verify deployer signature
- **Allowed addresses**: Restricted mode checks whitelist
- **Admin operations**: Only deployer can update access or delete

### Best Practices

✅ **DO**:
- Use descriptive program names for easy identification
- Encrypt sensitive data before storing
- Use public mode for truly public data
- Test with small data first
- Add salt for multiple programs with same name

❌ **DON'T**:
- Store private keys or secrets unencrypted
- Exceed 128KB limit (transaction will fail)
- Use deeply nested objects (>64 levels)
- Store data that changes very frequently (high transaction costs)

## Performance Characteristics

### Write Operations
- **Latency**: Consensus time (~2-5 seconds)
- **Cost**: Transaction fee required
- **Throughput**: Limited by block production
- **Validation**: Full validation before inclusion

### Read Operations
- **Latency**: <100ms (direct database query)
- **Cost**: Free (no transaction needed)
- **Throughput**: Unlimited (RPC queries)
- **Consistency**: Eventually consistent with blockchain state

### Storage Efficiency
- **Overhead**: ~200 bytes metadata per program
- **Compression**: JSONB compression in PostgreSQL
- **Indexing**: Efficient JSONB queries
- **Scalability**: Horizontal scaling with database

## Getting Started

Ready to build with Storage Programs? Head to the [Getting Started](./getting-started.md) guide for your first Storage Program.

## Next Steps

- [Getting Started](./getting-started.md) - Create your first Storage Program
- [Operations](./operations.md) - Learn all CRUD operations
- [Access Control](./access-control.md) - Master permission systems
- [RPC Queries](./rpc-queries.md) - Efficiently read data
- [Examples](./examples.md) - Practical code examples
- [API Reference](./api-reference.md) - Complete API documentation
