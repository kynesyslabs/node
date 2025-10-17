# UD Multi-Address Verification Refactor Plan

## Context
**Date**: 2025-10-17
**Goal**: Refactor UD identity verification to support signing with ANY address in domain records (not just owner)

## User Requirements
1. **Fetch all records** from both EVM and Solana
2. **Infer signature type** automatically (no explicit field)
3. **No backward compatibility** - full breaking change accepted
4. **Full replacement** of existing implementation

## Current Architecture Issues
- EVM: Only checks `ownerOf(tokenId)`, doesn't fetch records
- Solana: Helper fetches records but no integration yet
- Single-address verification: Only domain owner can sign
- EVM-only signatures: No Solana ed25519 support

## Target Architecture

### Resolution Phase
```typescript
resolveDomain(domain) → {
  domain: string,
  network: "polygon" | "ethereum" | "base" | "sonic" | "solana",
  registryType: "UNS" | "CNS",
  authorizedAddresses: [
    { address: string, recordKey: string, signatureType: "evm" | "solana" },
    // Multiple addresses from all records
  ]
}
```

### Record Types to Support
**EVM Records:**
- `crypto.ETH.address` → evm signature
- `token.EVM.*` → evm signature

**Solana Records:**
- `crypto.SOL.address` → solana signature
- `token.SOL.*` → solana signature

**Skip (non-signable):**
- `crypto.BTC.address` - Bitcoin can't sign Demos challenges
- Other non-crypto records (IPFS, DNS, etc.)

### Signature Type Detection Strategy
**By Address Format:**
- Starts with `0x` + 40 hex chars → EVM (secp256k1)
- Base58, 32-44 chars → Solana (ed25519)
- `bc1` or legacy Bitcoin → Skip

**By Signature Format:**
- 130-132 chars hex (with 0x) → EVM ECDSA
- 128 chars base64/base58 → Solana ed25519

### Verification Flow
```typescript
verifyPayload(payload) {
  // 1. Resolve domain on all chains (EVM cascade, then Solana)
  const resolution = await resolveDomain(domain)
  
  // 2. Extract signable addresses from records
  const authorizedAddresses = extractSignableAddresses(resolution)
  
  // 3. Find which address signed the challenge
  const signingAddress = payload.signingAddress
  
  // 4. Verify address is authorized
  if (!authorizedAddresses.includes(signingAddress)) {
    throw "Unauthorized address"
  }
  
  // 5. Detect signature type
  const sigType = detectSignatureType(signingAddress, signature)
  
  // 6. Verify with appropriate algorithm
  if (sigType === "evm") {
    recoveredAddress = ethers.verifyMessage(signedData, signature)
  } else if (sigType === "solana") {
    isValid = nacl.sign.detached.verify(message, signature, publicKey)
  }
}
```

## Implementation Phases

### Phase 0: Discovery (CURRENT)
Create `local_tests/` folder and test scripts:
1. `test_evm_records.ts` - Fetch all records from EVM UD contracts
2. `test_solana_records.ts` - Verify Solana helper record fetching
3. Document exact record structures and available keys

### Phase 1: EVM Records Resolution
**Files to modify:**
- `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`
  - Add `get(key, tokenId)` to registryAbi
  - Implement `fetchEvmRecords()` method
  - Fetch standard record keys: crypto.ETH.address, token.EVM.*, etc.

### Phase 2: Multi-Chain Resolution Unification
**Files to modify:**
- `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`
  - Refactor `resolveUDDomain()` to return records, not just owner
  - Integrate Solana resolution via helper
  - Return unified structure with authorizedAddresses

### Phase 3: Signature Type Detection
**New file:**
- `src/libs/blockchain/gcr/gcr_routines/signatureDetector.ts`
  - `detectAddressType(address: string): "evm" | "solana" | null`
  - `detectSignatureType(signature: string): "evm" | "solana" | null`

### Phase 4: Multi-Signature Verification
**Files to modify:**
- `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`
  - Refactor `verifyPayload()` for multi-address support
  - Add Solana signature verification (nacl library)
  - Implement signature type routing

### Phase 5: Type Updates
**Files to modify:**
- `src/model/entities/types/IdentityTypes.ts`
  - BREAKING: Update `SavedUdIdentity` interface
  - Add `signingAddress`, `signatureType` fields
  - Add "solana" to network union

### Phase 6: SDK Updates
**Files to modify (in ../sdks):**
- `src/abstraction/Identities.ts`
  - Update `generateUDChallenge()` to accept address parameter
  - Update `UDIdentityPayload` and `UDIdentityAssignPayload` types
  - Add address selection logic

## Key Technical Decisions

### EVM Record Fetching
Use UD Resolver contract instead of Registry directly:
```typescript
const resolverAddress = await registry.resolverOf(tokenId)
const resolver = new ethers.Contract(resolverAddress, resolverAbi, provider)
const ethAddress = await resolver.get("crypto.ETH.address", tokenId)
```

### Record Keys to Fetch
**Priority 1 (must support):**
- `crypto.ETH.address`
- `crypto.SOL.address`
- `token.EVM.ETH.ETH.address`
- `token.SOL.SOL.SOL.address`

**Priority 2 (nice to have):**
- All `token.EVM.*` records
- All `token.SOL.*` records

### Signature Algorithm Libraries
**EVM (secp256k1):**
- Use existing `ethers.verifyMessage(message, signature)`

**Solana (ed25519):**
- Add dependency: `tweetnacl` or `@solana/web3.js` (already available)
- Use: `nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes)`

## Testing Strategy

### Unit Tests
- Signature type detection with various address formats
- Record extraction from resolution results
- Signature verification for both EVM and Solana

### Integration Tests
- End-to-end UD identity verification flow
- Multi-chain domain resolution
- Error handling for unauthorized addresses

## Migration Notes

### Breaking Changes
1. `SavedUdIdentity` structure completely changed
2. `verifyPayload()` expects different payload format
3. SDK challenge generation requires address selection

### Database Migration
If UD identities are stored in database:
- May need migration script for existing records
- Or mark old records as deprecated/v1

## Dependencies to Add
```json
{
  "tweetnacl": "^1.0.3", // For Solana ed25519 verification
  "@solana/web3.js": "already installed", // Already available in Solana helper
}
```

## Risk Assessment

### High Risk
- Breaking change affects existing UD users
- Complex multi-chain resolution logic
- Signature type detection must be bulletproof

### Medium Risk  
- EVM record fetching may fail for some domains
- Performance impact of fetching all records

### Low Risk
- Solana signature verification (well-tested libraries)
- Type updates (compile-time safety)

## Success Criteria
1. ✅ Can resolve UD domains on all chains (EVM + Solana)
2. ✅ Can verify signatures from ANY address in domain records
3. ✅ Automatically detects EVM vs Solana signatures
4. ✅ No false positives in signature verification
5. ✅ Comprehensive test coverage (>80%)

## Open Questions
1. How to handle domains with 10+ addresses? Return all or limit?
2. Should we cache record resolution results?
3. What happens if domain owner changes after challenge generated?
4. Should we support Bitcoin addresses with external signing service?

## Timeline Estimate
- Phase 0 (Discovery): 1-2 hours
- Phase 1 (EVM Records): 2-3 hours  
- Phase 2 (Multi-Chain): 2-3 hours
- Phase 3 (Detection): 1-2 hours
- Phase 4 (Verification): 2-3 hours
- Phase 5 (Types): 1 hour
- Phase 6 (SDK): 2-3 hours
- Testing: 2-3 hours

**Total: 13-20 hours of focused work**
