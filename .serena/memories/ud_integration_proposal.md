# Unstoppable Domains Integration - Complete Proposal

## Overview
Based on the existing identity system architecture (Web2, XM, PQC), here's how we integrate UD.

## Architecture Analysis

### Current Identity System Flow

**SDK Side** (`../sdks/`):
1. **Types** (`src/types/abstraction/index.ts`):
   - `Web2CoreTargetIdentityPayload` - Base interface
   - Specific payloads: `InferFromGithubPayload`, `InferFromTwitterPayload`, etc.
   - `Web2IdentityAssignPayload` - Wrapper for assignment

2. **Identities Class** (`src/abstraction/Identities.ts`):
   - `addGithubIdentity()` - Creates payload and calls `inferIdentity()`
   - `addTwitterIdentity()` - Creates payload and calls `inferIdentity()`
   - `addDiscordIdentity()` - Creates payload and calls `inferIdentity()`
   - `inferIdentity()` - Private method that creates transaction

**Node Side** (`./src/`):
1. **Abstraction Layer** (`src/libs/abstraction/`):
   - `web2/github.ts` - `GithubProofParser` class
   - `web2/twitter.ts` - `TwitterProofParser` class
   - `web2/discord.ts` - `DiscordProofParser` class
   - `web2/parsers.ts` - `Web2ProofParser` base class
   - `index.ts` - `verifyWeb2Proof()` function

2. **Transaction Handler** (`src/libs/network/routines/transactions/handleIdentityRequest.ts`):
   - Routes to `verifyWeb2Proof()` for `web2_identity_assign` method
   - Validates proof and returns success/failure

3. **GCR Storage** (handled by IdentityManager):
   - Stores verified identities in Global Consensus Registry

## Proposed UD Integration

### Option 1: Extend Web2 Pattern (RECOMMENDED)
Treat UD as another web2 identity type like GitHub, Twitter, Discord.

**Advantages**:
- Consistent with existing architecture
- Minimal changes required
- Reuses existing verification flow
- Users understand it as "social identity"

**Changes Required**:

#### SDK Side (`../sdks/`)

**1. Add UD Types** (`src/types/abstraction/index.ts`):
```typescript
// ANCHOR Unstoppable Domains Identities
export type UDProof = string // UD domain (e.g., "alice.crypto")

export interface InferFromUDPayload extends Web2CoreTargetIdentityPayload {
    context: "unstoppable_domains"
    proof: UDProof // The UD domain
    username: string // The domain name (same as proof)
    userId: string // Domain owner's Ethereum address
}
```

**2. Update Web2IdentityAssignPayload**:
```typescript
export interface Web2IdentityAssignPayload extends BaseWeb2IdentityPayload {
    method: "web2_identity_assign"
    payload:
        | InferFromGithubPayload
        | InferFromTwitterPayload
        | InferFromTelegramPayload
        | InferFromDiscordPayload
        | InferFromUDPayload // Add this
}
```

**3. Add SDK Method** (`src/abstraction/Identities.ts`):
```typescript
/**
 * Add an Unstoppable Domain identity to the GCR.
 *
 * @param demos A Demos instance to communicate with the RPC.
 * @param domain The UD domain (e.g., "alice.crypto")
 * @param challenge Challenge message to sign
 * @param signature User's signature of the challenge
 * @param referralCode Optional referral code
 * @returns The response from the RPC call.
 */
async addUnstoppableDomainsIdentity(
    demos: Demos,
    domain: string,
    challenge: string,
    signature: string,
    referralCode?: string,
) {
    // Get domain owner from blockchain
    const ownerAddress = await this.getUDOwner(domain)
    
    const udPayload: InferFromUDPayload & {
        referralCode?: string
    } = {
        context: "unstoppable_domains",
        proof: domain,
        username: domain, // Use domain as username
        userId: ownerAddress, // Ethereum address
        challenge: challenge,
        signature: signature,
        referralCode: referralCode,
    }

    return await this.inferIdentity(demos, "web2", udPayload)
}

/**
 * Helper to get UD domain owner
 */
private async getUDOwner(domain: string): Promise<string> {
    // Use ethers.js to query UNS/CNS registry
    // Return owner address
}
```

**4. Update formats validation** (`src/abstraction/Identities.ts`):
```typescript
formats = {
    web2: {
        github: [...],
        twitter: [...],
        discord: [...],
        unstoppable_domains: [], // No URL validation needed
    },
}
```

#### Node Side (`./src/`)

**1. Create UD Parser** (`src/libs/abstraction/ud/unstoppableDomains.ts`):
```typescript
import { ethers } from "ethers"
import { SigningAlgorithm } from "@kynesyslabs/demosdk/types"

// UD Contract addresses
const UNS_REGISTRY = "0x049aba7510f45BA5b64ea9E658E342F904DB358D"
const CNS_REGISTRY = "0xD1E5b0FF1287aA9f9A268759062E4Ab08b9Dacbe"
const PROXY_READER = "0x1BDc0fD4fbABeed3E611fd6195fCd5d41dcEF393"

export class UDProofParser {
    private static instance: UDProofParser
    private provider: ethers.JsonRpcProvider

    constructor() {
        // REVIEW: Get Ethereum RPC from Demos node XM config
        // For now use public RPC
        this.provider = new ethers.JsonRpcProvider(
            process.env.ETHEREUM_RPC || "https://eth.llamarpc.com"
        )
    }

    /**
     * Reads proof data and verifies domain ownership
     * 
     * @param domain - The UD domain
     * @param challenge - Challenge message that was signed
     * @param signature - User's signature
     */
    async readData(
        domain: string,
        challenge: string,
        signature: string,
    ): Promise<{ message: string; type: SigningAlgorithm; signature: string }> {
        // Get domain owner from blockchain
        const owner = await this.getDomainOwner(domain)
        
        if (!owner) {
            throw new Error("Domain owner not found")
        }

        // Return in same format as Web2ProofParser
        return {
            message: challenge,
            type: "ecdsa", // Ethereum signatures are ECDSA
            signature: signature,
        }
    }

    /**
     * Gets the owner of a UD domain from blockchain
     */
    private async getDomainOwner(domain: string): Promise<string | null> {
        try {
            const tokenId = ethers.namehash(domain)
            const registryAbi = [
                "function ownerOf(uint256 tokenId) external view returns (address)",
            ]

            // Try UNS first
            try {
                const unsRegistry = new ethers.Contract(
                    UNS_REGISTRY,
                    registryAbi,
                    this.provider,
                )
                return await unsRegistry.ownerOf(tokenId)
            } catch {
                // Try CNS (legacy)
                const cnsRegistry = new ethers.Contract(
                    CNS_REGISTRY,
                    registryAbi,
                    this.provider,
                )
                return await cnsRegistry.ownerOf(tokenId)
            }
        } catch (error) {
            console.error("Error getting domain owner:", error)
            return null
        }
    }

    static async getInstance() {
        if (!this.instance) {
            this.instance = new this()
        }
        return this.instance
    }
}
```

**2. Update verifyWeb2Proof** (`src/libs/abstraction/index.ts`):
```typescript
import { UDProofParser } from "./ud/unstoppableDomains"

export async function verifyWeb2Proof(
    payload: Web2CoreTargetIdentityPayload,
    sender: string,
) {
    let parser:
        | typeof TwitterProofParser
        | typeof GithubProofParser
        | typeof DiscordProofParser
        | typeof UDProofParser

    switch (payload.context) {
        case "twitter":
            parser = TwitterProofParser
            break
        case "github":
            parser = GithubProofParser
            break
        case "discord":
            parser = DiscordProofParser
            break
        case "unstoppable_domains":
            parser = UDProofParser
            break
        default:
            return {
                success: false,
                message: `Unsupported proof context: ${payload.context}`,
            }
    }

    const instance = await parser.getInstance()

    try {
        // For UD, we pass challenge and signature
        const { message, type, signature } = await instance.readData(
            payload.proof,
            payload.challenge, // New field
            payload.signature, // New field
        )

        // Verify signature using ucrypto (same as Web2)
        const verified = await ucrypto.verify({
            algorithm: type,
            message: new TextEncoder().encode(message),
            publicKey: hexToUint8Array(payload.userId), // Owner's Ethereum address
            signature: hexToUint8Array(signature),
        })

        return {
            success: verified,
            message: verified
                ? `Verified ${payload.context} proof`
                : `Failed to verify ${payload.context} proof`,
        }
    } catch (error: any) {
        return {
            success: false,
            message: error.toString(),
        }
    }
}
```

### Option 2: New UD Context (Alternative)
Create a new top-level context "ud" alongside "web2", "xm", "pqc".

**Advantages**:
- Clear separation (UD is blockchain-based, not web2)
- Dedicated verification flow
- Future-proof for `.demos` TLD

**Disadvantages**:
- More code changes
- New transaction type `ud_identity_assign`
- Changes to multiple layers

## Recommended Approach: Option 1

**Reasoning**:
1. From user perspective, UD is like "linking a social identity"
2. Minimal code changes (extend existing web2 pattern)
3. Consistent with how other platforms are integrated
4. Web2 is already handling various proof types (URL, attestation)
5. Easier to implement and maintain

## Implementation Steps

### Phase 2: SDK Integration
1. Add `InferFromUDPayload` type to SDK
2. Update `Web2IdentityAssignPayload` union type
3. Implement `addUnstoppableDomainsIdentity()` method
4. Add UD helper methods

### Phase 3: Node Integration
1. Create `src/libs/abstraction/ud/` directory
2. Implement `UDProofParser` class
3. Update `verifyWeb2Proof()` to handle UD context
4. Add UD to supported contexts

### Phase 4: Testing
1. Test with real UD domains
2. Validate signature verification
3. Test GCR storage and retrieval
4. Prepare for `.demos` TLD (when available)

### Phase 5: Documentation
1. SDK documentation for `addUnstoppableDomainsIdentity()`
2. User guide for linking UD
3. API reference updates

## Technical Notes

### Ethereum RPC Configuration
- Should use existing XM Ethereum RPC from Demos node config
- Fallback to public RPC for development
- Environment variable: `ETHEREUM_RPC`

### Challenge/Signature Flow
1. User initiates UD linking
2. Backend generates challenge (contains Demos pubkey + timestamp + nonce)
3. User signs challenge with Ethereum wallet (MetaMask, etc.)
4. User submits: domain + challenge + signature
5. Backend verifies:
   - Domain owner via blockchain query
   - Signature validity
   - Signature matches owner address

### Data Structure in GCR
```typescript
{
    context: "unstoppable_domains",
    username: "alice.crypto",
    userId: "0x8aaD44321A86b170879d7A244c1e8d360c99DdA8"
}
```

## Future: .demos TLD Support
When UD launches `.demos` TLD:
- No code changes needed!
- System already validates any UD domain
- `.demos` domains work automatically
- Just update documentation/marketing
