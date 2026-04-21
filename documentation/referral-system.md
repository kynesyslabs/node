# Referral System Implementation Guide

## Overview

The referral system allows users to earn bonus points when they refer new users to the platform. It integrates with the existing points system and GCR (Global Change Registry) identity management to provide a seamless referral experience.

## Architecture

The referral system consists of three main components:

1. **GCR Identity Integration** (`src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts`) - Identity linking hooks
1. **PointSystem Integration** (`src/features/incentive/PointSystem.ts`) - Point awarding integration
1. **Referrals Class** (`src/features/incentive/referrals.ts`) - Core referral logic

## Core Components

### 1. Referrals Class (`referrals.ts`)

The main class that handles all referral-related operations.

#### Constants

```typescript
static readonly REFERRER_BONUS = 3        // Points awarded to referrer
static readonly REFERRED_USER_BONUS = 3   // Points awarded to new user
```

#### Key Methods

##### `generateReferralCode(publicKey: string, options?: object): string`

- **Purpose**: Creates deterministic referral codes from ed25519 public keys
- **Algorithm**: SHA-256 hash → Base58 encoding → 12-character code
- **Features**:
    - Collision-resistant (~70 bits entropy)
    - Human-friendly (no confusing characters)
    - Optional checksum and prefix support
- **Example**: `generateReferralCode("0x123...abc")` → `"8jKm9Xp2QvR7"`

##### `findAccountByReferralCode(referralCode: string): Promise<GCRMain | null>`

- **Purpose**: Locates the account that owns a specific referral code
- **Implementation**: PostgreSQL JSONB query on `referralInfo.referralCode`
- **Query**: `WHERE gcr.referralInfo ->> 'referralCode' = :referralCode`

##### `isAlreadyReferred(referrerAccount: GCRMain, newUserPubkey: string): boolean`

- **Purpose**: Prevents duplicate referrals between same user pairs
- **Logic**: Checks if `newUserPubkey` exists in referrer's `referralInfo.referrals[]` array

##### `isEligibleForReferral(account: GCRMain): boolean`

- **Purpose**: Determines if an existing account can still be referred
- **Criteria**:
    - User has NOT been referred before (`referralInfo.referredBy` is null)
    - User has zero existing points (`points.totalPoints === 0`)

##### `processReferral(newAccount: GCRMain, referralCode: string, gcrMainRepository): Promise<void>`

- **Purpose**: Main entry point for processing referrals
- **Validation Steps**:
    1. Verify referral code exists and is valid
    2. Prevent self-referrals (referrer !== new user)
    3. Check for duplicate referrals
- **Action**: Calls `awardReferralPoints()` if all validations pass

##### `awardReferralPoints(referrerAccount: GCRMain, newUserAccount: GCRMain, gcrMainRepository): Promise<void>` (private)

- **Purpose**: Awards points and updates database records for both parties
- **Referrer Updates**:
    - Add 3 points to `totalPoints` and `breakdown.referrals`
    - Increment `referralInfo.totalReferrals` counter
    - Append referral record to `referralInfo.referrals[]` array
- **New User Updates**:
    - Add 3 points to `totalPoints` and `breakdown.referrals`
    - Set `referralInfo.referredBy` to referrer's pubkey
    - Generate referral code if missing
- **Database**: Saves referrer account (new user saved by PointSystem)

### 2. PointSystem Integration

The PointSystem class orchestrates referral processing during point-earning activities.

#### Modified Methods

##### `addPointsToGCR(userId, points, type, platform, referralCode?)`

- **New Parameter**: `referralCode?: string` - Optional referral code from user
- **Integration Points**:
    - **New Accounts**: Always process referral if code provided
    - **Existing Accounts**: Process only if `Referrals.isEligibleForReferral()` returns true
- **Flow**:
    1. Award original points for action (wallet link, X, etc.)
    2. Call `Referrals.processReferral()` if referral code present
    3. Save account with all updates

##### `getUserPointsInternal(userId)`

- **Enhancement**: Automatic referral code generation for legacy accounts
- **Fallback Logic**: If account lacks referral code, generates and saves one
- **Return Value**: Now includes `referralCode` field in response

##### Point Award Methods

- `awardWeb3WalletPoints()` - Now accepts `referralCode` parameter
- `awardXPoints()` - Now accepts `referralCode` parameter

- Note: Deduct methods haven't been modified to handle referrals.

### 3. GCR Identity Routines Integration

Identity linking operations trigger referral processing through the incentive system.

#### Integration Flow

On the SDK, the `inferXmIdentity` and `addXIdentity` methods now accepts a `referralCode` parameter. The code is embedded in the payload and also in the `GCR_Edit` for the transaction.

During the consensus, when the x or xm wallet point system hooks are triggered, the referral code is passed to the point system methods.

The flow looks something like this:

```
editOperation.referralCode (from client)
    ↓
GCRIdentityRoutines.applyXmIdentityAdd() (consensus)
    ↓
IncentiveManager.walletLinked(userId, address, chain, referralCode)
    ↓
PointSystem.awardWeb3WalletPoints(userId, address, chain, referralCode)
    ↓
PointSystem.addPointsToGCR(userId, points, type, platform, referralCode)
    ↓
Referrals.processReferral(account, referralCode, repository)
```

#### Modified Methods

##### `applyXmIdentityAdd()` (Wallet Linking)

- **Change**: Passes `editOperation.referralCode` to `IncentiveManager.walletLinked()`
- **Trigger**: Only on first wallet connection (`isFirstConnection()`)

##### `applyWeb2IdentityAdd()` (X Linking)

- **Change**: Passes `editOperation.referralCode` to `IncentiveManager.xLinked()`
- **Trigger**: Only on first X connection for new accounts

## Testing Scenarios

### Valid Referral Flow

1. User A gets referral code: `getUserPoints()` returns `referralCode`
2. User B signs up with User A's code
3. User B links first wallet/X with `referralCode` in editOperation
4. System awards 3 points to both users
5. Both accounts updated with referral relationship

### Edge Cases

1. **Invalid code**: No points awarded, no errors
2. **Self-referral**: User A tries to use their own code - ignored
3. **Duplicate referral**: User B already referred by User A - ignored
4. **Existing user**: User B already has points - referral ignored
5. **Already referred**: User B was referred by User C - new referral ignored

## File Changes Summary

### New Files

- `src/features/incentive/referrals.ts` - Core referral logic

### Modified Files

- `src/features/incentive/PointSystem.ts` - Referral integration
- `src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts` - Identity hooks
- `src/libs/blockchain/gcr/gcr_routines/IncentiveManager.ts` - Method signatures
- `src/libs/blockchain/gcr/handleGCR.ts` - Account creation updates
- `src/libs/network/routines/transactions/handleIdentityRequest.ts` - Referral code validation during tx broadcast
