# Telegram Identity Implementation - Current State

## Architecture: Transaction-Based System
**Key**: Bot submits Demos transactions directly (NO API endpoints) - similar to Twitter identity flow but with dual signature validation.

## Implementation Status

### ✅ **Bot Repository** (COMPLETED)
**Location**: `/Users/tcsenpai/kynesys/tg_verification_bot/`
- Complete challenge verification with DemosSDK v2.4.0
- Dual signature creation (user + bot signatures) 
- SQLite storage with 15-minute challenge expiration
- Rate limiting and comprehensive error handling
- **Ready**: To submit Demos transactions once transaction subtype exists

### ❌ **../sdks Repository** (NOT STARTED)
**Need**: Extensible identity transaction subtype
```typescript
{
  type: "identity",
  subtype: "web2_platform", 
  data: {
    platform: "telegram" | "twitter" | "github" | "discord",
    payload: { /* platform-specific data */ }
  }
}
```

### ❌ **Node Repository** (NOT STARTED) 
**Files to modify**:
- `src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts`: Add telegram context validation
- `src/libs/blockchain/gcr/gcr_routines/IncentiveManager.ts`: Add telegram incentive methods
- `src/libs/blockchain/gcr/gcr_routines/identityManager.ts`: Allow telegram as twitter alternative

## Transaction Flow
1. **dApp**: Generates challenge → User signs → Sends to bot
2. **Bot**: Verifies user signature → Creates attestation → Signs with bot key
3. **Bot**: Submits Demos transaction with telegram identity data  
4. **Node**: Processes via `HandleGCR.applyToTx()` → `GCRIdentityRoutines` → validates & stores

## Validation Logic
- **Twitter**: `SHA256(proof) === proofHash` (simple)
- **Telegram**: Dual signature verification (user + bot) + bot authorization via genesis addresses

## Time Estimate
- **../sdks**: 1 hour (transaction subtype)
- **Node**: 2-3 hours (GCR integration)
- **Total**: 3-4 hours remaining