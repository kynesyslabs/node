# UD Architecture Patterns & Implementation Guide

## Resolution Flow

### Multi-Chain Cascade (5-Network Fallback)

```
1. Try Polygon L2 UNS → Success? Return UnifiedDomainResolution
2. Try Base L2 UNS → Success? Return UnifiedDomainResolution
3. Try Sonic UNS → Success? Return UnifiedDomainResolution
4. Try Ethereum L1 UNS → Success? Return UnifiedDomainResolution
5. Try Ethereum L1 CNS → Success? Return UnifiedDomainResolution
6. Try Solana → Success? Return UnifiedDomainResolution
7. All failed → Throw "Domain not found on any network"
```

### UnifiedDomainResolution Structure

```typescript
{
  domain: string                    // "example.crypto"
  network: NetworkType             // "polygon" | "ethereum" | ...
  registryType: "UNS" | "CNS"
  authorizedAddresses: [           // ALL signable addresses
    {
      address: string               // "0x..." or base58
      recordKey: string             // "crypto.ETH.address"
      signatureType: SignatureType  // "evm" | "solana"
    }
  ]
  metadata: {
    evm?: { owner, resolver, tokenId }
    solana?: { sldPda, domainPropertiesPda, recordsVersion }
  }
}
```

## Verification Flow

### Multi-Address Authorization

```typescript
verifyPayload(payload) {
  // 1. Resolve domain → get all authorized addresses
  const resolution = await resolveUDDomain(domain)

  // 2. Check signing address is authorized
  const matchingAddress = resolution.authorizedAddresses.find(
    auth => auth.address.toLowerCase() === signingAddress.toLowerCase()
  )
  if (!matchingAddress) {
    throw `Address ${signingAddress} not authorized for ${domain}`
  }

  // 3. Verify signature based on type
  if (matchingAddress.signatureType === "evm") {
    const recovered = ethers.verifyMessage(signedData, signature)
    if (recovered !== matchingAddress.address) throw "Invalid EVM signature"
  } else if (matchingAddress.signatureType === "solana") {
    const isValid = nacl.sign.detached.verify(
      new TextEncoder().encode(signedData),
      bs58.decode(signature),
      bs58.decode(matchingAddress.address)
    )
    if (!isValid) throw "Invalid Solana signature"
  }

  // 4. Verify challenge contains Demos public key
  if (!signedData.includes(demosPublicKey)) throw "Invalid challenge"

  // 5. Store in GCR
  await saveToGCR(demosAddress, { domain, signingAddress, signatureType, ... })
}
```

## Storage Pattern (JSONB)

### GCR Structure

```typescript
gcr_main.identities = {
    xm: {
        /* cross-chain */
    },
    web2: {
        /* social */
    },
    pqc: {
        /* post-quantum */
    },
    ud: [
        // Array of UD identities
        {
            domain: "example.crypto",
            signingAddress: "0x...", // Address that signed
            signatureType: "evm",
            signature: "0x...",
            network: "polygon",
            registryType: "UNS",
            publicKey: "",
            timestamp: 1234567890,
            signedData: "Link ... to Demos ...",
        },
    ],
}
```

### Defensive Initialization

```typescript
// New accounts (handleGCR.ts)
identities: { xm: {}, web2: {}, pqc: {}, ud: [] }

// Existing accounts (before push)
gcr.identities.ud = gcr.identities.ud || []
```

## Helper Methods Pattern

### Conversion Helpers

```typescript
// EVM → Unified
evmToUnified(evmResolution): UnifiedDomainResolution

// Solana → Unified
solanaToUnified(solanaResolution): UnifiedDomainResolution
```

### Signature Detection

```typescript
detectAddressType(address: string): "evm" | "solana" | null
validateAddressType(address, expectedType): boolean
isSignableAddress(address): boolean
```

### Record Extraction

```typescript
fetchDomainRecords(domain, tokenId, provider, registry): Record<string, string | null>
extractSignableAddresses(records): SignableAddress[]
```

## Error Messages

### Authorization Failure

```
Address 0x123... is not authorized for domain example.crypto.
Authorized addresses:
  - 0xabc... (evm) from crypto.ETH.address
  - ABCD...xyz (solana) from crypto.SOL.address
```

### Success Message

```
Verified ownership of example.crypto via evm signature from crypto.ETH.address
```

## Future: .demos TLD Support

**Zero code changes required** - domain resolution handles all TLDs automatically via `ethers.namehash()` and registry contracts.
