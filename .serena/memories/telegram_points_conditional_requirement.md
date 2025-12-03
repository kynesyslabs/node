# Telegram Points Conditional Award Requirement

## Current Status (2025-10-10)
**Requirement**: Telegram identity linking should award 1 point ONLY if the Telegram user is part of a specific group.

## Current Implementation
- **Location**: `src/features/incentive/PointSystem.ts`
- **Current Behavior**: Awards 1 point unconditionally when Telegram is linked for the first time
- **Point Value**: 1 point (defined in `pointValues.LINK_TELEGRAM`)
- **Trigger**: `IncentiveManager.telegramLinked()` called from `GCRIdentityRoutines.ts:305-309`

## Required Change
**Conditional Points Logic**: Check if user is member of specific Telegram group before awarding points

## Technical Context
- **Existing Telegram Integration**: Complete dual-signature verification system in `src/libs/abstraction/index.ts`
- **Bot Authorization**: Genesis-based bot validation already implemented
- **Verification Flow**: User signs → Bot verifies → Bot creates attestation → Node verifies bot signature

## Implementation Considerations
1. **Group Membership Verification**: Bot can check group membership via Telegram Bot API
2. **Attestation Enhancement**: Include group membership status in TelegramSignedAttestation
3. **Points Logic Update**: Modify `IncentiveManager.telegramLinked()` to check group membership
4. **Code Reuse**: Leverage existing verification infrastructure

## Next Steps
- Determine if bot can provide group membership status in attestation
- Design group membership verification flow
- Implement conditional points logic
- Update tests and documentation
