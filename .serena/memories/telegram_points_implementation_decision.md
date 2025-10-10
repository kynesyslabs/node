# Telegram Points Implementation Decision - Final

## Decision: Architecture A - Bot-Attested Membership ✅

**Date**: 2025-10-10
**Decision Made**: Option A (Bot-Attested Membership) selected over Option B (Node-Verified)

## Rationale
- **Reuses existing infrastructure**: Leverages dual-signature system already in place
- **Simpler implementation**: Bot already signs attestations, just extend payload
- **Single source of trust**: Consistent with existing genesis-authorized bot model
- **More practical**: No need for node to store bot tokens or make Telegram API calls
- **Better performance**: No additional API calls from node during verification

## Implementation Approach

### Bot Side (External - Not in this repo)
1. Bot checks group membership via Telegram API before signing attestation
2. Extends `TelegramAttestationPayload` with `group_membership` field:
   ```typescript
   {
     telegram_user_id: number | string
     username: string
     demos_address: string
     timestamp: number
     group_membership: {
       group_id: string
       is_member: boolean
       checked_at: number
     }
   }
   ```
3. Bot signs complete attestation including membership status

### SDK Side (../sdks/ repo)
1. Update `TelegramAttestationPayload` type definition
2. Make `group_membership` optional for backwards compatibility
3. Rebuild SDK and publish/link to node

### Node Side (THIS repo)
1. **src/features/incentive/PointSystem.ts**:
   - Modify `IncentiveManager.telegramLinked()` (if exists) or point award logic
   - Check `attestation.payload.group_membership.is_member === true`
   - Award 1 point ONLY if `is_member === true`
   - Award 0 points if `is_member === false` or field missing

2. **src/libs/abstraction/index.ts** (Optional):
   - Validate `group_membership` field structure if present
   - No changes required if treating as opaque data

## Edge Cases Handling
- **Legacy attestations** (no group_membership field): Treat as 0 points or configurable default
- **is_member = false**: Award 0 points, identity still linked
- **Missing group_membership**: Award 0 points (fail-safe)

## Next Steps
1. Modify bot to include group membership check
2. Update SDK type definitions
3. Update node points logic to read `group_membership.is_member`
4. Test with bot providing membership data

## Discarded Approach
**Option B (Node-Verified)**: Rejected due to:
- Requires TELEGRAM_BOT_TOKEN in each node's .env
- Additional Telegram API calls from node
- More complex infrastructure
- Doesn't maximize code reuse
