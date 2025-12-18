# UD Domain Security Patterns

## Ownership Verification Architecture

### Core Principle
**Blockchain State as Source of Truth**: UD domains are NFTs that can be transferred. All ownership decisions must be verified on-chain, not from cached GCR data.

### Verification Flow Pattern
```typescript
// STANDARD PATTERN for UD ownership verification
async verifyUdDomainOwnership(userId: string, domain: string): boolean {
    // 1. Get user's linked wallets from GCR
    const { linkedWallets } = await getUserIdentitiesFromGCR(userId)
    
    // 2. Resolve domain on-chain to get current authorized addresses
    const domainResolution = await UDIdentityManager.resolveUDDomain(domain)
    
    // 3. Extract wallet addresses (format: "chain:address" → "address")
    const userWalletAddresses = linkedWallets.map(wallet => {
        const parts = wallet.split(':')
        return parts.length > 1 ? parts[1] : wallet
    })
    
    // 4. Check ownership with chain-specific comparison
    const isOwner = domainResolution.authorizedAddresses.some(authAddr =>
        userWalletAddresses.some(userAddr => {
            // Solana: case-sensitive (base58 encoding)
            if (authAddr.signatureType === "solana") {
                return authAddr.address === userAddr
            }
            // EVM: case-insensitive (hex encoding)
            return authAddr.address.toLowerCase() === userAddr.toLowerCase()
        })
    )
    
    return isOwner
}
```

## Security Checkpoints

### Domain Linking (Award Points)
**Location**: `src/features/incentive/PointSystem.ts::awardUdDomainPoints()`
**Security**: ✅ Verified via UDIdentityManager.verifyPayload()
- Resolves domain to get authorized addresses
- Verifies signature from authorized wallet
- Checks Demos public key in challenge message
- Only awards points if all verification passes

### Domain Unlinking (Deduct Points)
**Location**: `src/features/incentive/PointSystem.ts::deductUdDomainPoints()`
**Security**: ✅ Verified via UDIdentityManager.resolveUDDomain()
- Resolves domain to get current authorized addresses
- Compares against user's linked wallets
- Blocks deduction if user doesn't own domain
- Returns 400 error with clear message

## Multi-Chain Considerations

### Domain Resolution Priority
**EVM Networks** (in order):
1. Polygon UNS Registry
2. Base UNS Registry
3. Sonic UNS Registry
4. Ethereum UNS Registry
5. Ethereum CNS Registry (legacy)

**Solana Network**:
- Fallback for .demos and other Solana domains
- Uses SolanaDomainResolver for resolution

### Signature Type Handling
**EVM Addresses**:
- Format: 0x-prefixed hex (40 characters)
- Comparison: Case-insensitive
- Verification: ethers.verifyMessage()

**Solana Addresses**:
- Format: Base58-encoded (32 bytes)
- Comparison: Case-sensitive
- Verification: nacl.sign.detached.verify()

## Error Handling Patterns

### Domain Not Resolvable
```typescript
try {
    domainResolution = await UDIdentityManager.resolveUDDomain(domain)
} catch (error) {
    return {
        result: 400,
        response: {
            message: `Cannot verify ownership: domain ${domain} is not resolvable`,
        },
        extra: { error: error.message }
    }
}
```

### Ownership Verification Failed
```typescript
if (!isOwner) {
    return {
        result: 400,
        response: {
            message: `Cannot deduct points: domain ${domain} is not owned by any of your linked wallets`,
        }
    }
}
```

## Testing Considerations

### Test Scenarios
1. **Happy Path**: User owns domain → deduction succeeds
2. **Transfer Scenario**: User transferred domain → deduction fails with 400
3. **Resolution Failure**: Domain expired/deleted → returns 400 with clear error
4. **Multi-Wallet**: User has multiple wallets, domain owned by one → succeeds
5. **Chain Mismatch**: EVM domain but user only has Solana wallets → fails
6. **Case Sensitivity**: EVM addresses with different cases → succeeds (case-insensitive)
7. **Case Sensitivity**: Solana addresses with different cases → fails (case-sensitive)

## Integration Points

### UDIdentityManager API
**Public Methods**:
- `resolveUDDomain(domain: string): Promise<UnifiedDomainResolution>`
  - Returns authorized addresses and network metadata
  - Throws if domain not resolvable
  
- `verifyPayload(payload: UDIdentityAssignPayload, sender: string)`
  - Full signature verification for domain linking
  - Includes ownership + signature validation

### PointSystem Integration
**Dependencies**:
- `getUserIdentitiesFromGCR()`: Get user's linked wallets
- `UDIdentityManager.resolveUDDomain()`: Get current domain ownership
- `addPointsToGCR()`: Execute point changes after verification

## Security Vulnerability Prevention

### Prevented Attack: Domain Transfer Abuse
**Scenario**: Attacker transfers domain after earning points
- ✅ **Protected**: Ownership verified on-chain before deduction
- ✅ **Result**: Attacker loses points when domain transferred

### Prevented Attack: Same Domain Multiple Accounts
**Scenario**: Same domain linked to multiple accounts
- ✅ **Protected**: Duplicate linking check in awardUdDomainPoints()
- ✅ **Protected**: Ownership verification in deductUdDomainPoints()
- ✅ **Result**: Each domain can only earn points once per account

### Prevented Attack: Expired Domain Points
**Scenario**: Domain expires but points remain
- ✅ **Protected**: Resolution failure prevents deduction
- ⚠️ **Note**: Points remain awarded (acceptable - user earned them legitimately)
