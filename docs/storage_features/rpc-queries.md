# RPC Queries Guide

Learn how to efficiently read data from Storage Programs using RPC queries.

## Overview

Reading Storage Program data is **free** and **fast** because it uses RPC queries instead of blockchain transactions:

| Feature | RPC Query | Blockchain Transaction |
|---------|-----------|------------------------|
| Cost | **Free** | Requires gas fee |
| Speed | <100ms | ~2-5 seconds (consensus) |
| Rate Limit | RPC provider dependent | Block production rate |
| Use Case | Data reading | Data writing |

## Basic RPC Queries

### Read All Data

```typescript
const result = await demos.storageProgram.read(storageAddress)

console.log('Variables:', result.data.variables)
console.log('Metadata:', result.data.metadata)
```

**Response Structure**:
```typescript
{
  success: true,
  data: {
    variables: {
      // Your stored data
      username: "alice",
      settings: { theme: "dark" },
      posts: [...]
    },
    metadata: {
      programName: "myApp",
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

### Read Specific Key

```typescript
// Read single key
const username = await demos.storageProgram.read(storageAddress, 'username')
console.log(username) // "alice"

// Read nested object
const settings = await demos.storageProgram.read(storageAddress, 'settings')
console.log(settings.theme) // "dark"

// Read array
const posts = await demos.storageProgram.read(storageAddress, 'posts')
console.log(posts.length) // Number of posts
```

## Performance Optimization

### Batch Queries

Read multiple storage programs in parallel:

```typescript
const addresses = [
  "stor-abc123...",
  "stor-def456...",
  "stor-ghi789..."
]

// ✅ GOOD: Parallel queries
const results = await Promise.all(
  addresses.map(addr => demos.storageProgram.read(addr))
)

results.forEach((result, index) => {
  console.log(`Storage ${index}:`, result.data.variables)
})

// ❌ BAD: Sequential queries (slow)
for (const addr of addresses) {
  const result = await demos.storageProgram.read(addr)
  console.log(result)
}
```

**Performance Gain**:
- Sequential: 3 queries × 100ms = 300ms
- Parallel: max(100ms, 100ms, 100ms) = 100ms
- **3× faster**

### Selective Key Reading

Only read the keys you need:

```typescript
// ❌ BAD: Read everything when you only need username
const result = await demos.storageProgram.read(storageAddress)
const username = result.data.variables.username

// ✅ GOOD: Read only what you need
const username = await demos.storageProgram.read(storageAddress, 'username')
```

**Benefits**:
- Reduced bandwidth
- Faster response (less data transferred)
- Lower memory usage client-side

### Caching Strategies

#### Simple In-Memory Cache

```typescript
class StorageCachemanager {
  private cache: Map<string, { data: any; timestamp: number }> = new Map()
  private TTL = 60000 // 1 minute

  async read(storageAddress: string, key?: string) {
    const cacheKey = `${storageAddress}:${key || 'all'}`
    const cached = this.cache.get(cacheKey)

    // Return cached if still valid
    if (cached && Date.now() - cached.timestamp < this.TTL) {
      return cached.data
    }

    // Fetch fresh data
    const data = await demos.storageProgram.read(storageAddress, key)

    // Update cache
    this.cache.set(cacheKey, {
      data: data,
      timestamp: Date.now()
    })

    return data
  }

  invalidate(storageAddress: string, key?: string) {
    if (key) {
      this.cache.delete(`${storageAddress}:${key}`)
    } else {
      // Invalidate all keys for this storage
      for (const cacheKey of this.cache.keys()) {
        if (cacheKey.startsWith(`${storageAddress}:`)) {
          this.cache.delete(cacheKey)
        }
      }
    }
  }
}

// Usage
const cache = new StorageCacheManager()

// Read with caching
const data = await cache.read(storageAddress)

// After writing, invalidate cache
await demos.storageProgram.write(storageAddress, updates)
cache.invalidate(storageAddress)
```

#### Cache with Metadata Tracking

```typescript
class SmartStorageCache {
  private cache: Map<string, any> = new Map()
  private metadataCache: Map<string, any> = new Map()

  async read(storageAddress: string, key?: string) {
    const cacheKey = `${storageAddress}:${key || 'all'}`

    // Check if we have cached metadata
    const cachedMetadata = this.metadataCache.get(storageAddress)

    if (cachedMetadata) {
      // Fetch latest metadata to check lastModified
      const latestData = await demos.storageProgram.read(storageAddress)
      const latestMetadata = latestData.data.metadata

      // If not modified, return cached data
      if (cachedMetadata.lastModified === latestMetadata.lastModified) {
        const cached = this.cache.get(cacheKey)
        if (cached) return cached
      }

      // Data was modified, update metadata cache
      this.metadataCache.set(storageAddress, latestMetadata)
    }

    // Fetch and cache
    const data = key
      ? await demos.storageProgram.read(storageAddress, key)
      : await demos.storageProgram.read(storageAddress)

    this.cache.set(cacheKey, data)

    if (!key) {
      this.metadataCache.set(storageAddress, data.data.metadata)
    }

    return data
  }
}
```

## Query Patterns

### Polling for Updates

```typescript
async function pollForUpdates(
  storageAddress: string,
  interval: number = 5000
) {
  let lastModified = 0

  setInterval(async () => {
    try {
      const data = await demos.storageProgram.read(storageAddress)
      const currentModified = data.data.metadata.lastModified

      if (currentModified > lastModified) {
        console.log('Storage updated:', data.data.variables)
        lastModified = currentModified

        // Trigger update handler
        onStorageUpdate(data.data.variables)
      }
    } catch (error) {
      console.error('Poll error:', error)
    }
  }, interval)
}

// Usage
pollForUpdates(storageAddress, 10000) // Poll every 10 seconds
```

### Conditional Reading

```typescript
async function readIfChanged(
  storageAddress: string,
  lastKnownModified: number
): Promise<any | null> {
  const data = await demos.storageProgram.read(storageAddress)
  const currentModified = data.data.metadata.lastModified

  if (currentModified > lastKnownModified) {
    return data.data.variables
  }

  return null // No changes
}

// Usage
let lastModified = 0
const updates = await readIfChanged(storageAddress, lastModified)

if (updates) {
  console.log('New data:', updates)
  lastModified = Date.now()
}
```

### Pagination Pattern

For large datasets stored in arrays:

```typescript
async function getPaginatedPosts(
  storageAddress: string,
  page: number = 1,
  pageSize: number = 10
) {
  // Read all posts
  const posts = await demos.storageProgram.read(storageAddress, 'posts')

  // Calculate pagination
  const startIndex = (page - 1) * pageSize
  const endIndex = startIndex + pageSize

  // Return paginated slice
  return {
    data: posts.slice(startIndex, endIndex),
    page: page,
    pageSize: pageSize,
    total: posts.length,
    totalPages: Math.ceil(posts.length / pageSize)
  }
}

// Usage
const page1 = await getPaginatedPosts(storageAddress, 1, 20)
console.log('Posts 1-20:', page1.data)
console.log('Total pages:', page1.totalPages)
```

## Access Control and Queries

### Public Queries (No Auth)

```typescript
// Public storage - anyone can query
const result = await demos.storageProgram.read(publicStorageAddress)
console.log('Public data:', result.data.variables)

// No authentication needed
```

### Private Queries (Auth Required)

```typescript
// Private storage - must authenticate
const demos = new DemosClient({
  rpcUrl: 'https://rpc.demos.network',
  privateKey: process.env.PRIVATE_KEY // Your private key
})

// Only works if you're the deployer
try {
  const result = await demos.storageProgram.read(privateStorageAddress)
  console.log('Private data:', result.data.variables)
} catch (error) {
  console.error('Access denied')
}
```

### Restricted Queries

```typescript
// Restricted storage - check if you're allowed
const demos = new DemosClient({
  rpcUrl: 'https://rpc.demos.network',
  privateKey: process.env.PRIVATE_KEY
})

const myAddress = await demos.getAddress()

try {
  const result = await demos.storageProgram.read(restrictedStorageAddress)

  // Verify you're in the allowed list
  const allowedAddresses = result.data.metadata.allowedAddresses
  if (!allowedAddresses.includes(myAddress) &&
      result.data.metadata.deployer !== myAddress) {
    console.warn('You may not have been granted access')
  }

  console.log('Data:', result.data.variables)
} catch (error) {
  console.error('Access denied')
}
```

## Error Handling

### Robust Query Pattern

```typescript
async function safeRead(
  storageAddress: string,
  key?: string,
  retries: number = 3
): Promise<any | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = await demos.storageProgram.read(storageAddress, key)
      return key ? result : result.data
    } catch (error: any) {
      // Handle specific errors
      if (error.code === 404) {
        console.error('Storage program not found')
        return null
      }

      if (error.code === 403) {
        console.error('Access denied')
        return null
      }

      // Network errors - retry
      if (attempt < retries) {
        console.warn(`Attempt ${attempt} failed, retrying...`)
        await sleep(1000 * attempt) // Exponential backoff
        continue
      }

      // All retries failed
      console.error('Query failed after retries:', error.message)
      return null
    }
  }

  return null
}

// Usage
const data = await safeRead(storageAddress, 'username', 3)
if (data) {
  console.log('Username:', data)
}
```

### Handling Non-Existent Keys

```typescript
async function readWithDefault<T>(
  storageAddress: string,
  key: string,
  defaultValue: T
): Promise<T> {
  try {
    const value = await demos.storageProgram.read(storageAddress, key)
    return value !== undefined ? value : defaultValue
  } catch (error) {
    return defaultValue
  }
}

// Usage
const theme = await readWithDefault(storageAddress, 'theme', 'light')
const count = await readWithDefault(storageAddress, 'count', 0)
```

## Advanced Patterns

### Query Aggregation

Aggregate data from multiple storage programs:

```typescript
async function aggregateUserStats(userAddresses: string[]) {
  const userStorageAddresses = userAddresses.map(addr =>
    deriveStorageAddress(addr, "userProfile")
  )

  const results = await Promise.all(
    userStorageAddresses.map(async addr => {
      try {
        return await demos.storageProgram.read(addr)
      } catch (error) {
        return null
      }
    })
  )

  // Aggregate stats
  const stats = {
    totalUsers: results.filter(r => r !== null).length,
    activeUsers: results.filter(r =>
      r && r.data.variables.lastActive > Date.now() - 86400000
    ).length,
    averageScore: results
      .filter(r => r !== null)
      .reduce((sum, r) => sum + (r.data.variables.score || 0), 0) /
      results.filter(r => r !== null).length
  }

  return stats
}
```

### Query Filtering

Client-side filtering for complex queries:

```typescript
async function queryUsers(
  storageAddress: string,
  filter: {
    minScore?: number
    country?: string
    verified?: boolean
  }
) {
  const data = await demos.storageProgram.read(storageAddress, 'users')

  return data.filter((user: any) => {
    if (filter.minScore && user.score < filter.minScore) return false
    if (filter.country && user.country !== filter.country) return false
    if (filter.verified !== undefined && user.verified !== filter.verified) return false
    return true
  })
}

// Usage
const highScoreUsers = await queryUsers(storageAddress, {
  minScore: 1000,
  verified: true
})
```

### Subscription Pattern (WebSocket-like)

Simulate subscriptions using polling:

```typescript
class StorageSubscription {
  private pollInterval: NodeJS.Timeout | null = null
  private lastModified: number = 0

  subscribe(
    storageAddress: string,
    callback: (data: any) => void,
    interval: number = 5000
  ) {
    this.pollInterval = setInterval(async () => {
      try {
        const result = await demos.storageProgram.read(storageAddress)
        const currentModified = result.data.metadata.lastModified

        if (currentModified > this.lastModified) {
          this.lastModified = currentModified
          callback(result.data.variables)
        }
      } catch (error) {
        console.error('Subscription error:', error)
      }
    }, interval)
  }

  unsubscribe() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }
}

// Usage
const subscription = new StorageSubscription()

subscription.subscribe(
  storageAddress,
  (data) => {
    console.log('Storage updated:', data)
    // Update UI, trigger events, etc.
  },
  10000 // Poll every 10 seconds
)

// Later: unsubscribe
subscription.unsubscribe()
```

## Performance Benchmarks

### Query Response Times

Typical response times for RPC queries:

| Operation | Response Time | Bandwidth |
|-----------|---------------|-----------|
| Read metadata only | 20-50ms | ~1KB |
| Read single key | 30-80ms | Varies |
| Read all data (small <1KB) | 40-100ms | ~1-2KB |
| Read all data (medium ~10KB) | 60-150ms | ~10-12KB |
| Read all data (large ~100KB) | 100-300ms | ~100-102KB |

### Optimization Impact

| Technique | Speed Improvement | Use Case |
|-----------|-------------------|----------|
| Selective key reading | 2-3× faster | When you need specific fields |
| Parallel queries | 3-10× faster | Multiple storage programs |
| Client-side caching | 100-1000× faster | Frequently accessed data |
| Metadata-based caching | 10-50× faster | Change detection |

## Best Practices

### 1. Read Only What You Need

```typescript
// ✅ GOOD
const username = await demos.storageProgram.read(addr, 'username')

// ❌ BAD
const all = await demos.storageProgram.read(addr)
const username = all.data.variables.username
```

### 2. Use Parallel Queries

```typescript
// ✅ GOOD
const [user, settings, stats] = await Promise.all([
  demos.storageProgram.read(addr, 'user'),
  demos.storageProgram.read(addr, 'settings'),
  demos.storageProgram.read(addr, 'stats')
])

// ❌ BAD
const user = await demos.storageProgram.read(addr, 'user')
const settings = await demos.storageProgram.read(addr, 'settings')
const stats = await demos.storageProgram.read(addr, 'stats')
```

### 3. Implement Caching

```typescript
// ✅ GOOD: Cache frequently accessed data
const cache = new Map()

async function getCachedData(addr: string) {
  if (cache.has(addr)) return cache.get(addr)

  const data = await demos.storageProgram.read(addr)
  cache.set(addr, data)
  setTimeout(() => cache.delete(addr), 60000) // 1 min TTL

  return data
}
```

### 4. Handle Errors Gracefully

```typescript
// ✅ GOOD
try {
  const data = await demos.storageProgram.read(addr)
  return data
} catch (error) {
  console.error('Read failed:', error.message)
  return null // or default value
}
```

### 5. Monitor Query Performance

```typescript
async function timedRead(addr: string, key?: string) {
  const start = Date.now()

  try {
    const result = await demos.storageProgram.read(addr, key)
    const duration = Date.now() - start

    console.log(`Query took ${duration}ms`)

    if (duration > 1000) {
      console.warn('Slow query detected')
    }

    return result
  } catch (error) {
    const duration = Date.now() - start
    console.error(`Query failed after ${duration}ms:`, error)
    throw error
  }
}
```

## Next Steps

- [Examples](./examples.md) - Real-world query patterns and use cases
- [API Reference](./api-reference.md) - Complete API documentation
- [Operations Guide](./operations.md) - Learn about write operations
