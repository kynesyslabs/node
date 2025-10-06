# Unstoppable Domains Integration - Revised Plan (XM Pattern)

## Critical Design Decision

**UD follows XM (web3) pattern, NOT web2 pattern**

User clarification: "the proof would be a signature from the resolved domain (let's say brad.crypto needs to be linked to a demos address, as a proof we need a signature from brad.crypto's resolved address, just as we do for linking web3 identities for solana and metamask)"

## Storage Structure

```typescript
// src/model/entities/types/IdentityTypes.ts
export interface SavedUdIdentity {
    domain: string              // "brad.crypto"
    resolvedAddress: string     // ETH address domain resolves to
    signature: string           // Signature from resolvedAddress
    publicKey: string           // Public key of resolvedAddress
    timestamp: number
    signedData: string          // Challenge message signed
    registryType: "UNS" | "CNS" // Which registry
}

export type StoredIdentities = {
    xm: { [chain]: { [subchain]: SavedXmIdentity[] } }
    web2: { [context]: Web2GCRData["data"][] }
    pqc: { [algorithm]: SavedPqcIdentity[] }
    ud: SavedUdIdentity[]       // NEW: UD identities array
}
```

## Database Migration

✅ **NO MIGRATION NEEDED!** Auto-updates when code runs.

**Why:**
- `identities` column is JSONB (flexible JSON)
- Defensive pattern: `accountGCR.identities.ud = accountGCR.identities.ud || []`
- Existing accounts: Key added on first UD link
- New accounts: Include `ud: []` in default initialization

**Action Required:**
- Update default initialization in `handleGCR.ts` to include `ud: []`
- Use defensive pattern in UD manager before pushing

## Architecture: Reuse XM Pattern

**Why XM Pattern?**
1. Signature-based proof (not URL-based like web2)
2. Blockchain address verification (like Solana/MetaMask)
3. Similar verification flow: resolve address → verify signature
4. Proven pattern already implemented

**Key Difference from XM:**
- XM: chain-based (ethereum/solana → address)
- UD: domain-based (brad.crypto → resolved address)

## Implementation Phases

### Phase 1: Local Testing ✅ COMPLETED
- Created `local_tests/` directory (gitignored)
- Tested basic domain resolution (`ud_basic_resolution.ts`)
- Tested ownership verification (`ud_ownership_verification.ts`)
- Tested ethers.js integration (`ud_sdk_exploration.ts`)
- Validated with real domain (brad.crypto)

**Commit: WHEN PHASE IS APPROVED BY USER**
- Commit WITHOUT Claude Code credits
- Use decent, descriptive commit message

### Phase 2: SDK Types (../sdks/)

**File: `src/types/abstraction/index.ts`**

Add UD payload types following XM pattern:

```typescript
// UD-specific types
export interface UDIdentityPayload {
    domain: string              // "brad.crypto"
    resolvedAddress: string     // ETH address domain resolves to
    signature: string           // Signature from resolvedAddress
    publicKey: string           // Public key
    signedData: string          // Challenge that was signed
}

// Main payload interface
export interface UDIdentityAssignPayload extends BaseIdentityPayload {
    method: "ud_identity_assign"  // NEW transaction method
    payload: UDIdentityPayload
}
```

**File: `src/types/blockchain/GCREdit.ts`**

Add UD GCR data type:

```typescript
export interface UdGCRData {
    domain: string
    resolvedAddress: string
    signature: string
    publicKey: string
    timestamp: number
    registryType: "UNS" | "CNS"
}
```

**Commit: WHEN PHASE IS APPROVED BY USER**

### Phase 3: SDK Methods (../sdks/)

**File: `src/abstraction/Identities.ts`**

Add UD identity method following XM pattern:

```typescript
/**
 * Link an Unstoppable Domain to Demos identity
 * 
 * Flow:
 * 1. Resolve domain to Ethereum address
 * 2. User signs challenge with Ethereum wallet
 * 3. Submit domain + signature for verification
 * 
 * @param demos - Demos instance
 * @param domain - UD domain (e.g., "brad.crypto")
 * @param signature - Signature from domain's resolved address
 * @param signedData - Challenge message that was signed
 * @param referralCode - Optional referral code
 */
async addUnstoppableDomainIdentity(
    demos: Demos,
    domain: string,
    signature: string,
    signedData: string,
    referralCode?: string,
) {
    // Resolve domain to get Ethereum address
    const resolvedAddress = await this.resolveUDDomain(domain)
    
    // Get public key from resolved address (for verification)
    const publicKey = await this.getPublicKeyFromAddress(resolvedAddress)
    
    const payload: UDIdentityAssignPayload = {
        method: "ud_identity_assign",
        payload: {
            domain,
            resolvedAddress,
            signature,
            publicKey,
            signedData,
        },
        referralCode,
    }

    return await createAndSendIdentityTransaction(demos, payload)
}

/**
 * Resolve UD domain to Ethereum address
 */
private async resolveUDDomain(domain: string): Promise<string> {
    const provider = new ethers.JsonRpcProvider("https://eth.llamarpc.com")
    const tokenId = ethers.namehash(domain)
    
    // Try UNS Registry first
    try {
        const unsRegistry = new ethers.Contract(
            "0x049aba7510f45BA5b64ea9E658E342F904DB358D",
            ["function ownerOf(uint256) view returns (address)"],
            provider
        )
        return await unsRegistry.ownerOf(tokenId)
    } catch {
        // Fallback to CNS Registry
        const cnsRegistry = new ethers.Contract(
            "0xD1E5b0FF1287aA9f9A268759062E4Ab08b9Dacbe",
            ["function ownerOf(uint256) view returns (address)"],
            provider
        )
        return await cnsRegistry.ownerOf(tokenId)
    }
}

/**
 * Generate challenge for user to sign
 */
generateUDChallenge(demosPublicKey: string): string {
    const timestamp = Date.now()
    const nonce = Math.random().toString(36).substring(7)
    
    return `Link Unstoppable Domain to Demos Network\n` +
           `Demos Key: ${demosPublicKey}\n` +
           `Timestamp: ${timestamp}\n` +
           `Nonce: ${nonce}`
}
```

**Commit: WHEN PHASE IS APPROVED BY USER**

### Phase 4: Node Transaction Routing

**File: `src/libs/network/routines/transactions/handleIdentityRequest.ts`**

Add UD routing following XM pattern:

```typescript
import { UDIdentityManager } from "@/libs/blockchain/gcr/gcr_routines/udIdentityManager"

switch (payload.method) {
    case "xm_identity_assign": {
        const xmPayload = payload as InferFromSignaturePayload
        result = await IdentityManager.verifyPayload(xmPayload, sender)
        break
    }
    
    case "ud_identity_assign": {  // NEW
        const udPayload = payload as UDIdentityAssignPayload
        result = await UDIdentityManager.verifyPayload(udPayload, sender)
        break
    }
    
    case "pqc_identity_assign": { ... }
    case "web2_identity_assign": { ... }
}
```

**Commit: WHEN PHASE IS APPROVED BY USER**

### Phase 5: Node UD Manager

**File: `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`**

Create UD manager following XM pattern from `identityManager.ts`:

```typescript
import { ethers } from "ethers"
import { UDIdentityAssignPayload, SavedUdIdentity } from "@/types"

export class UDIdentityManager {
    /**
     * Verify UD identity payload
     * 
     * Similar to XM verification but for UD domains:
     * 1. Verify domain resolves to claimed address
     * 2. Verify signature from resolved address
     */
    static async verifyPayload(
        payload: UDIdentityAssignPayload,
        sender: string,
    ): Promise<{ success: boolean; message: string }> {
        
        const { domain, resolvedAddress, signature, signedData } = payload.payload
        
        // 1. Verify domain ownership on blockchain
        const actualOwner = await this.getDomainOwner(domain)
        
        if (!actualOwner) {
            return { success: false, message: "Domain not found" }
        }
        
        if (actualOwner.toLowerCase() !== resolvedAddress.toLowerCase()) {
            return { 
                success: false, 
                message: "Resolved address doesn't match domain owner" 
            }
        }
        
        // 2. Verify signature (same as XM does)
        const messageVerified = await this.verifyEthereumSignature(
            signedData,
            signature,
            resolvedAddress
        )
        
        if (!messageVerified) {
            return { success: false, message: "Invalid signature" }
        }
        
        // 3. Verify challenge contains sender's Demos key
        if (!signedData.includes(sender)) {
            return { 
                success: false, 
                message: "Challenge doesn't match sender" 
            }
        }
        
        // 4. Save to GCR
        await this.saveToGCR(sender, payload.payload)
        
        return { 
            success: true, 
            message: `Successfully linked ${domain}` 
        }
    }
    
    /**
     * Get domain owner from blockchain (reuse from local_tests)
     */
    private static async getDomainOwner(domain: string): Promise<string | null> {
        const provider = new ethers.JsonRpcProvider(
            process.env.ETHEREUM_RPC || "https://eth.llamarpc.com"
        )
        const tokenId = ethers.namehash(domain)
        
        try {
            const unsRegistry = new ethers.Contract(
                "0x049aba7510f45BA5b64ea9E658E342F904DB358D",
                ["function ownerOf(uint256) view returns (address)"],
                provider
            )
            return await unsRegistry.ownerOf(tokenId)
        } catch {
            const cnsRegistry = new ethers.Contract(
                "0xD1E5b0FF1287aA9f9A268759062E4Ab08b9Dacbe",
                ["function ownerOf(uint256) view returns (address)"],
                provider
            )
            return await cnsRegistry.ownerOf(tokenId)
        }
    }
    
    /**
     * Verify Ethereum signature (like XM does for chains)
     */
    private static async verifyEthereumSignature(
        message: string,
        signature: string,
        expectedAddress: string
    ): Promise<boolean> {
        try {
            const recoveredAddress = ethers.verifyMessage(message, signature)
            return recoveredAddress.toLowerCase() === expectedAddress.toLowerCase()
        } catch {
            return false
        }
    }
    
    /**
     * Save to GCR identities.ud array
     */
    private static async saveToGCR(
        sender: string,
        payload: UDIdentityPayload
    ): Promise<void> {
        const gcrEntry = await GCR_Main.findOne({ 
            where: { address: sender } 
        })
        
        if (!gcrEntry) {
            throw new Error("GCR entry not found")
        }
        
        // Initialize identities.ud if needed (defensive pattern)
        if (!gcrEntry.identities.ud) {
            gcrEntry.identities.ud = []
        }
        
        const savedIdentity: SavedUdIdentity = {
            domain: payload.domain,
            resolvedAddress: payload.resolvedAddress,
            signature: payload.signature,
            publicKey: payload.publicKey,
            timestamp: Date.now(),
            signedData: payload.signedData,
            registryType: "UNS", // Detect from which registry was used
        }
        
        gcrEntry.identities.ud.push(savedIdentity)
        await gcrEntry.save()
    }
}
```

**Commit: WHEN PHASE IS APPROVED BY USER**

### Phase 6: Update GCR Types

**File: `src/model/entities/types/IdentityTypes.ts`**

Update StoredIdentities type (add `ud` key):

```typescript
export interface SavedUdIdentity {
    domain: string
    resolvedAddress: string
    signature: string
    publicKey: string
    timestamp: number
    signedData: string
    registryType: "UNS" | "CNS"
}

export type StoredIdentities = {
    xm: { ... }
    web2: { ... }
    pqc: { ... }
    ud: SavedUdIdentity[]  // ADD THIS
}
```

**File: `src/libs/blockchain/gcr/handleGCR.ts`**

Update default initialization (around line 497):

```typescript
account.identities = fillData["identities"] || {
    xm: {},
    web2: {},
    pqc: {},
    ud: [],  // ADD THIS
}
```

**Commit: WHEN PHASE IS APPROVED BY USER**

### Phase 7: Testing

**Test cases:**
1. Domain resolution (brad.crypto → address)
2. Signature verification
3. Full integration flow
4. GCR storage/retrieval
5. Error cases (invalid domain, wrong signature)

**Commit: WHEN PHASE IS APPROVED BY USER**

## Commit Workflow

**IMPORTANT:** 
- After EACH phase completion, WHEN USER SAYS "OK"
- Create commit WITHOUT Claude Code credits in message
- Use decent, descriptive commit message
- Example: "Add UD types and interfaces to SDK"

## Verification Flow Comparison

**XM (existing):**
1. User has Ethereum/Solana wallet
2. User signs challenge with wallet
3. Verify signature matches wallet address
4. Store in `identities.xm[chain][subchain]`

**UD (new):**
1. User owns UD domain (brad.crypto)
2. Domain resolves to Ethereum address (0xABC...)
3. User signs challenge with 0xABC... wallet
4. Verify signature matches resolved address
5. Verify resolved address owns domain
6. Store in `identities.ud[]`

## Key Reuse from Existing Code

✅ **From XM pattern:**
- Signature verification logic
- Transaction routing structure
- GCR storage pattern
- Challenge generation

✅ **From local_tests:**
- `getDomainOwner()` implementation
- `ethers.namehash()` usage
- UNS/CNS registry fallback
- ethers.js integration

✅ **From web2 pattern:**
- Transaction creation flow
- Referral code handling
- Error handling patterns

## Future: .demos TLD

When UD launches `.demos` TLD:
- Zero code changes needed
- Works automatically (domain resolution handles it)
- Just marketing/documentation updates
