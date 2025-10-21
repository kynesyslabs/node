# UD Multi-Chain Phases Tracking

**Branch**: `ud_identities` | **Current**: Phase 5 Complete ✅ | **Next**: Phase 6

## Phase Status Overview

| Phase | Status | Commit | Description |
|-------|--------|--------|-------------|
| Phase 1 | ✅ Complete | `ce3c32a8` | Signature detection utility |
| Phase 2 | ✅ Complete | `7b9826d8` | EVM records fetching |
| Phase 3 | ✅ Complete | `10460e41` | Solana integration + UnifiedDomainResolution |
| Phase 4 | ✅ Complete | `10460e41` | Multi-signature verification (EVM + Solana) |
| Phase 5 | ✅ Complete | (committed) | IdentityTypes updates (breaking changes) |
| Phase 6 | ⏸️ Pending | - | SDK client method updates |

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
    publicKeyBytes
)
```

**Key Achievement**: Users can sign with ANY address in domain records (not just owner)

---

## Phase 5: Update IdentityTypes ✅

**Status**: Committed  
**Files**: 
- `src/model/entities/types/IdentityTypes.ts`
- `src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts`

**Breaking Changes**:
```typescript
// OLD (Phase 4)
interface SavedUdIdentity {
    resolvedAddress: string  // ❌ REMOVED
    // ...
}

// NEW (Phase 5)
interface SavedUdIdentity {
    domain: string
    signingAddress: string      // ✅ CHANGED from resolvedAddress
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

## Phase 6: SDK Client Method Updates ⏸️

**Status**: Pending  
**Repository**: `../sdks/`

### Required Changes

#### 1. Update Types (`src/types/abstraction/index.ts`)
```typescript
// REMOVE old format
export interface UDIdentityPayload {
    domain: string
    resolvedAddress: string  // ❌ DELETE
    signature: string
    publicKey: string
    signedData: string
}

// ADD new format
export interface UDIdentityPayload {
    domain: string
    signingAddress: string      // ✅ NEW
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
**Phase 5 → Phase 6**: Node types must match SDK payload format  

---

## Quick Reference

**Current Status**: Phase 5 Complete, Phase 6 Pending  
**Next Action**: Update SDK client methods in `../sdks/` repository  
**Breaking Changes**: Phases 4, 5, 6 all introduce breaking changes  
**Testing**: End-to-end testing blocked until Phase 6 complete  

For detailed Phase 5 implementation, see `ud_phase5_complete` memory.
