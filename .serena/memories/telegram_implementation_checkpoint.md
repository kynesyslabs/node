# Telegram Identity Implementation - Recovery Checkpoint

## Current Implementation State
**Date**: 2025-09-11
**Branch**: `tg_identities_v2`
**Status**: Ready for implementation with corrected architecture understanding

## Critical Architecture Understanding
**CORRECTED**: Transaction-based system (NOT API endpoints)
- Bot submits Demos transactions directly to node
- Node processes via existing GCR system: `HandleGCR.applyToTx()` → `GCRIdentityRoutines`
- Similar to Twitter flow but with dual signature validation instead of simple proof hashing

## Implementation Requirements Identified

### ../sdks Repository (1 hour)
```typescript
// Need extensible identity transaction subtype
{
  type: "identity",
  subtype: "web2_platform",
  data: {
    platform: "telegram" | "twitter" | "github" | "discord",
    payload: { /* platform-specific data */ }
  }
}
```

### Node Repository (2-3 hours)
**Primary File**: `src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts`
- Add `context: "telegram"` case to `applyWeb2IdentityAdd()` method
- Implement dual signature validation (user + bot signatures)
- Bot authorization via genesis block addresses

**Secondary Files**:
- `IncentiveManager.ts`: Add `telegramLinked()` and `telegramUnlinked()` methods
- `identityManager.ts`: Update `filterConnections()` to allow telegram alternative

## Bot Status Confirmed
**Repository**: `/Users/tcsenpai/kynesys/tg_verification_bot/`
**Status**: ✅ FULLY FUNCTIONAL and ready for integration
- Complete challenge verification system
- Dual signature creation (user + bot)
- DemosSDK v2.4.0 integration
- SQLite storage with 15-minute expiration
- Rate limiting and comprehensive error handling

## Key Technical Details
- **Twitter Validation**: `SHA256(data.proof) === data.proofHash`
- **Telegram Validation**: Dual signature verification + bot authorization
- **Storage Pattern**: `accountGCR.identities.web2.telegram[]` (similar to twitter)
- **Transaction Route**: Same GCR processing path as Twitter identities

## Files Ready for Implementation
All analysis complete, ready to begin coding:
1. Start with ../sdks transaction subtype design
2. Then implement node-side GCR integration
3. Bot will integrate automatically once transaction type exists

## Estimated Completion: 3-4 hours total remaining work