# IPFS Pin Expiration System (DEM-481)

## Overview
Pins can have expiration dates for time-limited storage. Expired pins are automatically cleaned up by the ExpirationWorker.

## Duration Types
```typescript
type PinDuration = 'week' | 'month' | 'quarter' | 'year' | 'permanent'
```

## Key Functions

### Setting Expiration
When pinning content with duration:
```typescript
function calculateExpiresAt(duration?: PinDuration): number | undefined {
  if (!duration || duration === 'permanent') return undefined
  const durationMs = DURATION_VALUES[duration]
  if (!durationMs) return undefined
  return Date.now() + durationMs
}
```

### Checking Expiration
```typescript
// From IPFSTypes.ts
function isPinExpired(pin: PinnedContent, now?: number): boolean {
  if (!pin.expiresAt) return false  // Permanent pins never expire
  return pin.expiresAt < (now ?? Date.now())
}

function getExpiredPins(pins: PinnedContent[], now?: number): PinnedContent[] {
  const timestamp = now ?? Date.now()
  return pins.filter(pin => isPinExpired(pin, timestamp))
}
```

## ExpirationWorker

### Configuration
```typescript
interface ExpirationWorkerConfig {
  checkIntervalMs: number   // Default: 1 hour (3,600,000)
  gracePeriodMs: number     // Default: 24 hours (86,400,000)
  batchSize: number         // Default: 100 pins per cycle
  enableUnpin: boolean      // Default: true
  verbose: boolean          // Default: false
}
```

### Lifecycle
```typescript
// Start worker (typically at node startup)
startExpirationWorker(config?)

// Stop worker (at shutdown)
stopExpirationWorker()

// Get singleton instance
getExpirationWorker(config?)
```

### Check Cycle Flow
1. Query GCRMain for accounts with non-empty pins
2. For each account, get IPFS state
3. Find pins where `expiresAt < now`
4. If pin expired > gracePeriod ago: actually unpin
5. Update statistics

### Grace Period
Pins are not immediately unpinned when they expire:
- `expiredAt < now`: Pin is expired (marked in summaries)
- `expiredAt < (now - gracePeriod)`: Pin is past grace period (actually unpinned)

This allows users time to extend before content is deleted.

### Forced Cleanup
For admin operations:
```typescript
await worker.forceCleanupAccount(pubkey)
// Uses immediate expiration (no grace period)
```

## Extending Pins

### Via Transaction
```typescript
// ipfs_extend_pin transaction
{
  operation: "extend_pin",
  cid: "Qm...",
  duration: "month"  // Add 30 more days
}
```

### Processing
1. Find existing pin by CID
2. Calculate new expiration:
   - If currently permanent: stays permanent
   - If currently expiring: add duration to current expiration
3. Update pin via `GCRIPFSRoutines.updatePin()`
4. Charge extension fee based on size and duration

## Expiration Summary (ipfsPins response)
```typescript
interface ExpirationSummary {
  permanentCount: number        // Pins without expiration
  expiringCount: number         // Pins with expiration date
  expiredCount: number          // Already expired
  expiringWithin7Days: number   // Expiring soon
  expiringWithin30Days: number  // Expiring this month
}
```

## Database Query
ExpirationWorker finds accounts with pins:
```typescript
const results = await repo
  .createQueryBuilder("gcr")
  .select("gcr.pubkey")
  .where("jsonb_array_length(gcr.ipfs -> 'pins') > 0")
  .getRawMany()
```
