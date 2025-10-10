# Telegram Points Implementation Decision - Final (CORRECTED)

## Decision: Architecture A - Bot-Attested Membership ✅

**Date**: 2025-10-10
**Decision Made**: Option A (Bot-Attested Membership) selected over Option B (Node-Verified)
**SDK Version**: v2.4.18 implemented and deployed

## Rationale
- **Reuses existing infrastructure**: Leverages dual-signature system already in place
- **Simpler implementation**: Bot already signs attestations, just extend payload
- **Single source of trust**: Consistent with existing genesis-authorized bot model
- **More practical**: No need for node to store bot tokens or make Telegram API calls
- **Better performance**: No additional API calls from node during verification

## Implementation Approach

### Bot Side (External - Not in this repo)
Bot checks group membership via Telegram API before signing attestation and sets boolean flag.

### SDK Side (../sdks/ repo) - ✅ COMPLETED v2.4.18
Updated `TelegramAttestationPayload` type definition:
```typescript
export interface TelegramAttestationPayload {
    telegram_user_id: string;
    challenge: string;
    signature: string;
    username: string;
    public_key: string;
    timestamp: number;
    bot_address: string;
    group_membership: boolean;  // ← CORRECT: Direct boolean, not object
}
```

### Node Side (THIS repo) - ✅ COMPLETED
1. **src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts**:
   - Pass `data.proof` (TelegramSignedAttestation) to IncentiveManager

2. **src/libs/blockchain/gcr/gcr_routines/IncentiveManager.ts**:
   - Added optional `attestation?: any` parameter to `telegramLinked()`

3. **src/features/incentive/PointSystem.ts**:
   - Check `attestation?.payload?.group_membership === true`
   - Award 1 point ONLY if `group_membership === true`
   - Award 0 points if `false` or field missing

## Actual Implementation Code
```typescript
// CORRECT implementation in PointSystem.ts
const isGroupMember = attestation?.payload?.group_membership === true

if (!isGroupMember) {
    return {
        pointsAwarded: 0,
        message: "Telegram linked successfully, but you must join the required group to earn points"
    }
}
```

## Edge Cases Handling
- **Legacy attestations** (no group_membership field): `undefined === true` → false → 0 points
- **group_membership = false**: 0 points, identity still linked
- **Missing group_membership**: 0 points (fail-safe via optional chaining)

## Security
- `group_membership` is part of SIGNED attestation from authorized bot
- Bot signature verified in `verifyTelegramProof()`
- Users cannot forge membership without valid bot signature

## Breaking Change Risk: LOW
- All parameters optional (backwards compatible)
- Fail-safe defaults (optional chaining)
- Only affects new Telegram linkages
- Existing linked identities unaffected
