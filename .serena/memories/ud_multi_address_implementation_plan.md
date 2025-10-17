# UD Multi-Address Verification - Implementation Plan (Data-Driven)

## Real Data Findings from Tests

### EVM Discovery (sir.crypto on Polygon)
- **Owner**: `0x45238D633D6a1d18ccde5fFD234958ECeA46eB86`
- **Records found**: `crypto.ETH.address`, `ipfs.html.value`
- **Signable**: Only `crypto.ETH.address` (1 EVM address)
- **Key insight**: EVM domains have sparse records, mostly just ETH address

### Solana Discovery (thecookingsenpai.demos, partner-engineering.demos)
- **Records found**: 4/11 records populated
  - `crypto.ETH.address` ✅
  - `crypto.SOL.address` ✅
  - `token.EVM.ETH.ETH.address` ✅
  - `token.SOL.SOL.SOL.address` ✅
- **Signable**: 4 addresses (2 EVM, 2 Solana)
- **Key insight**: Solana .demos domains have BOTH EVM and Solana addresses, with duplicates

## Address Pattern Analysis

### EVM Addresses
```
Format: 0x[40 hex chars]
Examples:
- 0x45238d633d6a1d18ccde5ffd234958ecea46eb86
- 0xbe2278A4a281427c852D86dD8ba758cA712F1415
```

### Solana Addresses
```
Format: Base58, 32-44 chars
Examples:
- CYiaGjPiyyy9RnnvBHuVsHW8RUQA9hiY5a5XEfcdqZWU
- Av9NFCTMNjCjAqDg8Hq3u6vdLFDBfiwBmMTBc1w7R7u7
```

## Signature Type Detection Strategy

```typescript
function detectAddressType(address: string): "evm" | "solana" | null {
  // EVM: starts with 0x, 42 chars total
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) return "evm"
  
  // Solana: Base58, 32-44 chars, no 0x
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return "solana"
  
  return null // Bitcoin or unknown
}
```

## Revised Implementation Plan

### Phase 1: Signature Detection Utility
**File**: `src/libs/blockchain/gcr/gcr_routines/signatureDetector.ts`

```typescript
export function detectAddressType(address: string): "evm" | "solana" | null
export function isSignableRecord(recordKey: string): boolean
export function extractSignableAddresses(records): SignableAddress[]
```

**Scope**: New file, no modifications to existing code

---

### Phase 2: EVM Records Fetching
**File**: `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`

**Changes**:
1. Extend `registryAbi` with resolver methods
2. Add private method `fetchEvmRecords(domain, tokenId, provider, registry)`
3. Modify `resolveUDDomain()` return type to include `records: string[]`

**Keep existing**: EVM cascade logic (Polygon → Base → Sonic → Ethereum)

---

### Phase 3: Multi-Chain Resolution Integration
**File**: `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`

**Changes**:
1. Import `SolanaDomainResolver`
2. Add private method `resolveSolanaDomain(domain)` 
3. Wrap existing `resolveUDDomain()` EVM code in try-catch
4. On EVM failure, try Solana fallback
5. Return unified structure:

```typescript
{
  domain: string,
  network: "polygon" | "ethereum" | "base" | "sonic" | "solana",
  registryType: "UNS" | "CNS",
  authorizedAddresses: Array<{
    address: string,
    recordKey: string,
    signatureType: "evm" | "solana"
  }>
}
```

---

### Phase 4: Multi-Signature Verification
**File**: `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`

**Method**: `verifyPayload()`

**Changes**:
1. Resolve domain → get authorizedAddresses array
2. Check `payload.signingAddress` is in authorizedAddresses
3. Detect signature type from address
4. Route verification:
   - EVM: `ethers.verifyMessage(signedData, signature)`
   - Solana: `nacl.sign.detached.verify(messageBytes, sigBytes, pubkeyBytes)`

**Dependencies**: Add `tweetnacl` or use existing `@solana/web3.js`

---

### Phase 5: Type Updates
**File**: `src/model/entities/types/IdentityTypes.ts`

**Changes** (BREAKING):
```typescript
export interface SavedUdIdentity {
  domain: string
  signingAddress: string        // NEW: which address signed
  signatureType: "evm" | "solana" // NEW: signature algorithm
  signature: string
  publicKey: string              // For Solana verification
  timestamp: number
  signedData: string
  network: "polygon" | "ethereum" | "base" | "sonic" | "solana" // Add "solana"
  registryType: "UNS" | "CNS"
}
```

**Removed**: `resolvedAddress` (replaced by `signingAddress`)

---

### Phase 6: SDK Updates
**Repo**: `../sdks`
**File**: `src/abstraction/Identities.ts`

**Changes**:
1. Update `UDIdentityPayload` and `UDIdentityAssignPayload`:
   - Add `signingAddress: string`
   - Add `signatureType: "evm" | "solana"`
   - Remove `resolvedAddress`

2. Update `generateUDChallenge()`:
   ```typescript
   generateUDChallenge(demosPublicKey: string, signingAddress: string): string {
     return `Link ${signingAddress} to Demos identity ${demosPublicKey}`
   }
   ```

3. Add method to get available addresses for user selection:
   ```typescript
   async getUDSignableAddresses(domain: string): Promise<SignableAddress[]>
   ```

---

## Implementation Order & Commit Strategy

### Commit 1: Detection Utility (Node)
```bash
# Create signatureDetector.ts
git add src/libs/blockchain/gcr/gcr_routines/signatureDetector.ts
git commit -m "feat(ud): add signature type detection utility for multi-chain addresses"
```

### Commit 2: EVM Records (Node)
```bash
# Modify udIdentityManager.ts - EVM records fetching only
git add src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts
git commit -m "feat(ud): add EVM record fetching for multi-address verification"
```

### Commit 3: Solana Integration (Node)
```bash
# Modify udIdentityManager.ts - add Solana fallback
git add src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts
git commit -m "feat(ud): integrate Solana domain resolution with EVM fallback"
```

### Commit 4: Multi-Sig Verification (Node)
```bash
# Modify udIdentityManager.ts - verification logic
# Add tweetnacl dependency if needed
git add package.json src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts
git commit -m "feat(ud): implement multi-signature verification (EVM + Solana ed25519)"
```

### Commit 5: Type Updates (Node)
```bash
# Modify IdentityTypes.ts - BREAKING CHANGE
git add src/model/entities/types/IdentityTypes.ts
git commit -m "feat(ud)!: BREAKING - update UD identity types for multi-address support"
```

### Commit 6: SDK Updates (SDK Repo)
```bash
cd ../sdks
# Modify Identities.ts
git add src/abstraction/Identities.ts
git commit -m "feat(ud)!: BREAKING - add multi-address UD identity support"
cd ../node
```

---

## Record Keys Priority

**Must Support** (High Priority):
- `crypto.ETH.address` - Primary EVM
- `crypto.SOL.address` - Primary Solana
- `token.EVM.ETH.ETH.address` - EVM tokens
- `token.SOL.SOL.SOL.address` - Solana tokens

**Skip** (Non-signable):
- `crypto.BTC.address` - Can't sign Demos challenges
- `ipfs.html.value` - Not an address
- `dns.*` - Not an address

---

## Simplified Flow

```
User wants to link UD identity
↓
1. Client resolves domain → gets all signable addresses
   - EVM chains first (Polygon → Base → Sonic → Ethereum)
   - Fallback to Solana
↓
2. Client presents address options to user
   - "Sign with 0xbe22... (EVM)"
   - "Sign with CYia... (Solana)"
↓
3. User selects address & signs challenge
↓
4. Node verifies:
   a) Domain resolves to addresses
   b) Selected address is in authorized list
   c) Signature valid for selected address type
↓
5. Identity linked ✅
```

---

## Testing Strategy

After each phase:
1. Run `bun run lint:fix` to check syntax
2. Test with `local_tests/` scripts
3. No need to start full node

Final integration test:
- Use SDK to generate challenge
- Sign with both EVM and Solana addresses
- Verify both work correctly

---

## Dependencies

### Node
```json
{
  "tweetnacl": "^1.0.3"  // For Solana ed25519 verification
}
```

### SDK
No new dependencies (already has ethers, @solana/web3.js)

---

## Breaking Changes Summary

### Node Types
- `SavedUdIdentity` structure changed
- Removed `resolvedAddress` → `signingAddress`
- Added `signatureType` field
- Added `"solana"` to network union

### SDK Types
- `UDIdentityPayload` structure changed
- `UDIdentityAssignPayload` structure changed
- `generateUDChallenge()` signature changed (requires address parameter)

### Database Migration
If UD identities stored in DB, may need migration for existing records

---

## Success Criteria

✅ EVM domains resolve with records (not just owner)
✅ Solana domains resolve with records
✅ Multi-chain fallback works (EVM → Solana)
✅ Signature type auto-detected from address format
✅ EVM signatures verified correctly
✅ Solana signatures verified correctly
✅ SDK provides address selection API
✅ Breaking changes documented

---

## Risk Mitigation

1. **EVM Record Fetching Fails**: Fallback to owner-only mode
2. **Solana RPC Issues**: Cache results, retry logic
3. **Signature Detection False Positives**: Strict regex patterns
4. **Breaking Changes**: Clear migration guide, deprecation warnings

---

## Estimated Timeline

- Phase 1 (Detection): 30min
- Phase 2 (EVM Records): 1-2 hours
- Phase 3 (Solana Integration): 1 hour
- Phase 4 (Verification): 1-2 hours
- Phase 5 (Types): 30min
- Phase 6 (SDK): 1-2 hours

**Total: 5-8 hours focused work**
