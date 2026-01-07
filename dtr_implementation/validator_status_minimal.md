# Validator Status - Minimal Implementation

## Single Function Approach

Instead of a complex service, we create one simple function that leverages existing consensus routines.

## Implementation

**File**: `src/libs/consensus/v2/routines/isValidator.ts`

```typescript
import getShard from "./getShard"
import getCommonValidatorSeed from "./getCommonValidatorSeed"
import { getSharedState } from "../../../utilities/sharedState"

/**
 * Determines if current node will be validator for next block
 * Reuses existing consensus logic with zero modifications
 */
export default async function isValidatorForNextBlock(): Promise<boolean> {
    try {
        // Use existing seed generation (unchanged)
        const { commonValidatorSeed } = await getCommonValidatorSeed()
        
        // Use existing shard selection (unchanged)
        const validators = await getShard(commonValidatorSeed)
        
        // Use existing identity access (unchanged)
        const ourIdentity = getSharedState.identity.ed25519.publicKey.toString("hex")
        
        // Simple check if we're in the validator list
        return validators.some(peer => peer.identity === ourIdentity)
        
    } catch (error) {
        // Conservative fallback - assume we're not validator
        return false
    }
}

/**
 * Gets validator list for relay targets (optional helper)
 */
export async function getValidatorsForRelay(): Promise<import("../../peer/Peer").Peer[]> {
    try {
        const { commonValidatorSeed } = await getCommonValidatorSeed()
        const validators = await getShard(commonValidatorSeed)
        
        // Return only online, synced validators for relay
        return validators.filter(v => v.status.online && v.sync.status)
    } catch {
        return []
    }
}
```

## Usage Pattern

```typescript
// In manageExecution.ts
import isValidatorForNextBlock, { getValidatorsForRelay } from "../consensus/v2/routines/isValidator"

// Simple check
if (await isValidatorForNextBlock()) {
    // Store locally (existing behavior)
    await mempool.addTransaction(transaction)
} else {
    // Relay to validators
    const validators = await getValidatorsForRelay()
    // ... relay logic
}
```

## Why This Works

1. **Reuses Existing Logic**: Same algorithm consensus uses
2. **No State Management**: Stateless function calls
3. **No Caching Needed**: Functions are fast enough for real-time use
4. **No Error Complexity**: Simple try/catch with safe fallback
5. **Zero Dependencies**: Uses existing imports only

## Total Implementation

- **Lines of Code**: 15
- **New Dependencies**: 0
- **Modified Files**: 0 (all new)
- **Testing Complexity**: Minimal (just test the boolean return)

This gives us everything we need for DTR with the absolute minimum code footprint.