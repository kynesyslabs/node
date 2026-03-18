# UD Multi-Chain Phases Tracking

**Branch**: `ud_identities` | **Current**: Phase 5 Complete ✅ | **Next**: Phase 6

## Phase Status Overview

| Phase      | Status      | Commit     | Description                                  |
| ---------- | ----------- | ---------- | -------------------------------------------- |
| Phase 1    | ✅ Complete | `ce3c32a8` | Signature detection utility                  |
| Phase 2    | ✅ Complete | `7b9826d8` | EVM records fetching                         |
| Phase 3    | ✅ Complete | `10460e41` | Solana integration + UnifiedDomainResolution |
| Phase 4    | ✅ Complete | `10460e41` | Multi-signature verification (EVM + Solana)  |
| Phase 5    | ✅ Complete | `eff3af6c` | IdentityTypes updates (breaking changes)     |
| **Points** | ✅ Complete | `c833679d` | **UD domain points system implementation**   |
| Phase 6    | ⏸️ Pending  | -          | SDK client method updates                    |

---

## Phase 1: Signature Detection Utility ✅

**Commit**: `ce3c32a8`  
**File**: `src/libs/blockchain/gcr/gcr_routines/signatureDetector.ts`

**Created**:

- `detectSignatureType(address)` - Auto-detect EVM vs Solana from address format
- `validateAddressType(address, expectedType)` - Validate address matches type
- `isSignableAddress(address)` - Check if address is recognized format

**Patterns**:

- EVM: `/^0x[0-9a-fA-F]{40}$/` (secp256k1)
- Solana: `/^[1-9A-HJ-NP-Za-km-z]{32,44}$/` (ed25519)

---

## Phase 2: EVM Records Fetching ✅

**Commit**: `7b9826d8`  
**File**: `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`

**Changes**:

- `resolveUDDomain()` return type: simple object → `EVMDomainResolution`
- Added resolver ABI with `get()` method
- Defined `UD_RECORD_KEYS` array (8 common crypto address records)
- Created `fetchDomainRecords()` helper for batch retrieval
- Created `extractSignableAddresses()` helper with auto-detection
- Applied to all 5 EVM networks: Polygon, Base, Sonic, Ethereum UNS, Ethereum CNS

**Record Keys**:

```typescript
const UD_RECORD_KEYS = [
    "crypto.ETH.address",
    "crypto.SOL.address",
    "crypto.BTC.address",
    "crypto.MATIC.address",
    "token.EVM.ETH.ETH.address",
    "token.EVM.MATIC.MATIC.address",
    "token.SOL.SOL.SOL.address",
    "token.SOL.SOL.USDC.address",
]
```

---

## Phase 3: Solana Integration + UnifiedDomainResolution ✅

**Commit**: `10460e41`  
**File**: `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`

**Changes**:

- Added imports: `UnifiedDomainResolution`, `SolanaDomainResolver`
- Created `evmToUnified()` - Converts `EVMDomainResolution` → `UnifiedDomainResolution`
- Created `solanaToUnified()` - Converts Solana helper result → `UnifiedDomainResolution`
- Updated `resolveUDDomain()` return type to `UnifiedDomainResolution`
- Added Solana fallback after all EVM networks fail

**Resolution Cascade**:

1. Polygon L2 UNS → unified format
2. Base L2 UNS → unified format
3. Sonic UNS → unified format
4. Ethereum L1 UNS → unified format
5. Ethereum L1 CNS → unified format
6. **Solana fallback** (via `udSolanaResolverHelper.ts`)
7. Throw if domain not found on any network

**Temporary Phase 3 Limitation**:

- `verifyPayload()` only supports EVM domains
- Solana domains fail with "Phase 3 limitation" message
- Phase 4 implements full multi-address verification

---

## Phase 4: Multi-Signature Verification ✅

**Commit**: `10460e41` (same as Phase 3)  
**File**: `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`

**Dependencies Added**:

- `tweetnacl@1.0.3` - Solana signature verification
- `bs58@6.0.0` - Base58 encoding/decoding

**Changes**:

- Completely rewrote `verifyPayload()` for multi-address support
- Added `verifySignature()` helper method for dual signature type support
- Enhanced error messages with authorized address lists

**Verification Flow**:

```typescript
1. Resolve domain → get UnifiedDomainResolution with authorizedAddresses
2. Check domain has authorized addresses (fail if empty)
3. Find matching authorized address from signing address
4. Verify signature based on signature type (EVM or Solana)
5. Verify challenge contains Demos public key
6. Store in GCR with detailed logging
```

**EVM Signature**:

```typescript
const recoveredAddress = ethers.verifyMessage(signedData, signature)
if (recoveredAddress !== authorizedAddress.address) fail
```

**Solana Signature**:

```typescript
const signatureBytes = bs58.decode(signature)
const messageBytes = new TextEncoder().encode(signedData)
const publicKeyBytes = bs58.decode(authorizedAddress.address)

const isValid = nacl.sign.detached.verify(
    messageBytes,
    signatureBytes,
    publicKeyBytes,
)
```

**Key Achievement**: Users can sign with ANY address in domain records (not just owner)

---

## Phase 5: Update IdentityTypes ✅

**Commit**: `eff3af6c`  
**Files**:

- `src/model/entities/types/IdentityTypes.ts`
- `src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts`

**Breaking Changes**:

```typescript
// OLD (Phase 4)
interface SavedUdIdentity {
    resolvedAddress: string // ❌ REMOVED
    // ...
}

// NEW (Phase 5)
interface SavedUdIdentity {
    domain: string
    signingAddress: string // ✅ CHANGED from resolvedAddress
    signatureType: SignatureType // ✅ NEW: "evm" | "solana"
    signature: string
    publicKey: string
    timestamp: number
    signedData: string
    network: "polygon" | "ethereum" | "base" | "sonic" | "solana" // ✅ ADDED solana
    registryType: "UNS" | "CNS"
}
```

**Changes in GCRIdentityRoutines**:

- Updated `applyUdIdentityAdd()` to extract `signingAddress` and `signatureType`
- Added field validation for new required fields
- Updated storage logic to use new field names

**Database Migration**: ✅ None needed (JSONB auto-updates)

**Reference**: See `ud_phase5_complete` memory for complete Phase 5 details

---

## UD Points System Implementation ✅

**Commit**: `c833679d`  
**Date**: 2025-01-31  
**Files**:

- `src/features/incentive/PointSystem.ts`
- `src/model/entities/GCRv2/GCR_Main.ts`

**Purpose**: Incentivize UD domain linking with TLD-based rewards

### Point Values

- `.demos` TLD domains: **3 points**
- Other UD domains: **1 point**

### Methods Implemented

#### awardUdDomainPoints(userId, domain, referralCode?)

**Location**: PointSystem.ts:866-934

**Features**:

- Automatic TLD detection (`domain.toLowerCase().endsWith(".demos")`)
- Duplicate domain linking prevention
- Referral code support
- Integration with existing GCR points infrastructure
- Returns `RPCResponse` with points awarded and updated total

**Logic Flow**:

```typescript
1. Determine point value based on TLD
2. Check for duplicate domain in GCR breakdown.udDomains
3. Award points via addPointsToGCR()
4. Return success response with points awarded
```

#### deductUdDomainPoints(userId, domain)

**Location**: PointSystem.ts:942-1001

**Features**:

- TLD-based point calculation (matching award logic)
- Domain-specific point tracking verification
- Safe deduction (checks if points exist first)
- Returns `RPCResponse` with points deducted and updated total

**Logic Flow**:

```typescript
1. Determine point value based on TLD
2. Verify domain exists in GCR breakdown.udDomains
3. Deduct points via addPointsToGCR() with negative value
4. Return success response with points deducted
```

### Infrastructure Updates

#### GCR Entity Extensions (GCR_Main.ts)

```typescript
// Added to points.breakdown
udDomains: { [domain: string]: number }  // Track points per domain
telegram: number                          // Added to socialAccounts
```

#### PointSystem Type Updates

```typescript
// Extended addPointsToGCR() type parameter
type: "web3Wallets" | "socialAccounts" | "udDomains"

// Added udDomains handling in addPointsToGCR()
if (type === "udDomains") {
    account.points.breakdown.udDomains =
        account.points.breakdown.udDomains || {}
    account.points.breakdown.udDomains[platform] = oldDomainPoints + points
}
```

#### Local UserPoints Interface

Created local interface matching GCR structure to avoid SDK circular dependencies:

```typescript
interface UserPoints {
    // ... existing fields
    breakdown: {
        web3Wallets: { [chain: string]: number }
        socialAccounts: {
            twitter: number
            github: number
            discord: number
            telegram: number // ✅ NEW
        }
        udDomains: { [domain: string]: number } // ✅ NEW
        referrals: number
        demosFollow: number
    }
    // ...
}
```

### Integration with IncentiveManager

**Existing Hooks** (IncentiveManager.ts:117-137):

```typescript
static async udDomainLinked(
    userId: string,
    domain: string,
    referralCode?: string,
): Promise<RPCResponse> {
    return await this.pointSystem.awardUdDomainPoints(
        userId,
        domain,
        referralCode,
    )
}

static async udDomainUnlinked(
    userId: string,
    domain: string,
): Promise<RPCResponse> {
    return await this.pointSystem.deductUdDomainPoints(userId, domain)
}
```

These hooks are called automatically when UD identities are added/removed via `udIdentityManager`.

### Testing & Validation

- ✅ TypeScript compilation: All errors resolved
- ✅ ESLint: All files pass linting
- ✅ Pattern consistency: Matches web3Wallets/socialAccounts implementation
- ✅ Type safety: Local interface matches GCR entity structure

### Design Decisions

**Why TLD-based rewards?**

- `.demos` domains directly promote Demos Network branding
- Higher reward incentivizes ecosystem adoption
- Simple rule: easy for users to understand

**Why local UserPoints interface?**

- Avoid SDK circular dependencies during rapid iteration
- Ensure type consistency with GCR entity structure
- Enable development without rebuilding SDK
- FIXME comment added for future SDK migration

**Why domain-level tracking in breakdown?**

- Prevents duplicate point awards for same domain
- Enables accurate point deduction on unlink
- Matches existing pattern (web3Wallets per chain, socialAccounts per platform)

### Future Considerations

1. **SDK Type Migration**: When SDK stabilizes, replace local UserPoints with SDK import
2. **Multiple Domains**: Current implementation supports unlimited UD domains per user
3. **Point Adjustments**: Easy to modify point values in `pointValues` constant
4. **Analytics**: `breakdown.udDomains` enables detailed UD engagement metrics

---

## Phase 6: SDK Client Method Updates ⏸️

**Status**: Pending  
**Repository**: `../sdks/`

### Required Changes

#### 1. Update Types (`src/types/abstraction/index.ts`)

```typescript
// REMOVE old format
export interface UDIdentityPayload {
    domain: string
    resolvedAddress: string // ❌ DELETE
    signature: string
    publicKey: string
    signedData: string
}

// ADD new format
export interface UDIdentityPayload {
    domain: string
    signingAddress: string // ✅ NEW
    signatureType: SignatureType // ✅ NEW
    signature: string
    publicKey: string
    signedData: string
}
```

#### 2. Update Methods (`src/abstraction/Identities.ts`)

**Update `generateUDChallenge()`**:

```typescript
// OLD
generateUDChallenge(demosPublicKey: string): string

// NEW
generateUDChallenge(
    demosPublicKey: string,
    signingAddress: string  // ✅ NEW parameter
): string {
    return `Link ${signingAddress} to Demos identity ${demosPublicKey}\n...`
}
```

**Update `addUnstoppableDomainIdentity()`**:

```typescript
// OLD
async addUnstoppableDomainIdentity(
    demos: Demos,
    domain: string,
    signature: string,
    signedData: string,
    referralCode?: string,
)

// NEW
async addUnstoppableDomainIdentity(
    demos: Demos,
    domain: string,
    signingAddress: string,    // ✅ NEW: User selects which address to sign with
    signature: string,
    signedData: string,
    referralCode?: string,
) {
    // Detect signature type from address format
    const signatureType = detectAddressType(signingAddress)

    const payload: UDIdentityAssignPayload = {
        method: "ud_identity_assign",
        payload: {
            domain,
            signingAddress,    // ✅ NEW
            signatureType,     // ✅ NEW
            signature,
            publicKey: ...,
            signedData,
        },
        referralCode,
    }
}
```

#### 3. Add Helper Method (NEW)

```typescript
/**
 * Get all signable addresses for a UD domain
 * Helps user select which address to sign with
 */
async getUDSignableAddresses(
    domain: string
): Promise<SignableAddress[]> {
    const resolution = await this.resolveUDDomain(domain)
    return resolution.authorizedAddresses
}
```

### Phase 6 Testing Requirements

**Unit Tests**:

- Challenge generation with signing address
- Signature type auto-detection
- Multi-address payload creation

**Integration Tests**:

- End-to-end UD identity verification flow
- EVM domain + EVM signature
- Solana domain + Solana signature
- Multi-address domain selection

---

## Cross-Phase Dependencies

**Phase 1 → Phase 2**: Signature detection used in record extraction  
**Phase 2 → Phase 3**: EVM records format informs unified format  
**Phase 3 → Phase 4**: UnifiedDomainResolution provides authorizedAddresses  
**Phase 4 → Phase 5**: Verification logic expects new type structure  
**Phase 5 → Points**: Identity storage structure enables points tracking  
**Points → Phase 6**: SDK must match node implementation for client usage

---

## Quick Reference

**Current Status**: Phase 5 Complete, Points Complete, Phase 6 Pending  
**Latest Commit**: `c833679d` (UD points system)  
**Next Action**: Update SDK client methods in `../sdks/` repository  
**Breaking Changes**: Phases 4, 5, 6 all introduce breaking changes  
**Testing**: End-to-end testing blocked until Phase 6 complete

For detailed implementation sessions:

- Phase 5 details: See `ud_phase5_complete` memory
- Points implementation: See `session_ud_points_implementation_2025_01_31` memory
