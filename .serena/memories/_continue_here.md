# ZK Identity: Verify-and-Delete Implementation Plan

## Context

During review of the ZK identity system, we identified a critical anonymity issue:

**Problem**: If users publicly verify their identity first (via OAuth), then create a ZK commitment, the anonymity is broken because:
- Public record exists: `demosAddress ↔ github:alice`
- ZK commitment can be correlated back to the public identity
- Anonymity set is limited to publicly verified users (easy correlation)

**Solution**: Verify-and-delete flow - verify ownership via OAuth, create ZK commitment, immediately delete public record.

## Current State

### What Works
- ✅ Node backend: Merkle tree, proof verification, RPC endpoints
- ✅ SDK: CommitmentService, ProofGenerator, ZKIdentity classes
- ✅ Traditional OAuth verification: addGithubIdentity(), addTwitterIdentity(), etc.
- ✅ Cryptographic infrastructure complete (circuits, keys, CDN)

### What's Missing
- ❌ No way to verify ownership WITHOUT creating public record
- ❌ Users must choose: verification OR privacy (not both)

## Proposed Solution: `zk_verified_commitment`

### User Flow
```typescript
// ONE transaction: verify + create commitment + no public record
const { zkIdentity, commitment, providerId } = 
    await demos.identities.verifyAndCreateZKIdentity({
        provider: "github",
        proof: gistUrl,  // Traditional OAuth proof
        secret: undefined,  // Optional: client or server generates
        referralCode: "FRIEND123"
    })

// Result:
// ✅ GitHub ownership verified
// ✅ ZK commitment in Merkle tree
// ❌ No public identity record (privacy preserved)
```

### Backend Logic (GCRIdentityRoutines.ts)

```typescript
async function handleZKVerifiedCommitment(payload) {
    // 1. Verify ownership (reuse existing OAuth verification)
    const verification = await verifyOAuthOwnership(
        payload.provider, 
        payload.proof
    )
    const providerId = `${payload.provider}:${verification.userId}`

    // 2. Create or accept commitment
    let commitment: string
    let secret: string | undefined
    
    if (payload.commitment) {
        // Client-provided commitment (user has secret)
        commitment = payload.commitment
    } else {
        // Server generates commitment (must return secret securely)
        secret = generateSecureSecret()
        commitment = generateCommitment(providerId, secret)
    }

    // 3. Store commitment in Merkle tree
    await commitmentRepo.save({
        commitmentHash: commitment,
        leafIndex: -1,
        provider: payload.provider,
        blockNumber: currentBlock,
        timestamp: Date.now(),
        transactionHash: txHash
    })

    // 4. Skip creating public identity record
    // (or create and immediately delete - need to decide)
    if (!payload.deleteAfterVerification) {
        await createPublicIdentity(providerId, demosAddress)
    }

    // 5. Return result (with optional secret if server-generated)
    return {
        success: true,
        commitment,
        providerId,
        secret // If server-generated (encrypt before sending!)
    }
}
```

### SDK Integration (Identities.ts)

```typescript
// New method in Identities class
async verifyAndCreateZKIdentity(
    demos: Demos,
    options: {
        provider: "github" | "twitter" | "discord" | "telegram",
        proof: string,
        secret?: string,  // Optional: user provides secret
        referralCode?: string
    }
): Promise<{
    zkIdentity: ZKIdentity,
    commitment: string,
    providerId: string
}> {
    // Build transaction with new zk_verified_commitment method
    // Return ZKIdentity instance for user
}
```

## Implementation Checklist

### Node Changes (~2-3 hours)
- [ ] Add `zk_verified_commitment` transaction type
- [ ] Implement in GCRIdentityRoutines.ts
- [ ] Reuse existing OAuth verification methods:
  - verifyGithubOwnership()
  - verifyTwitterOwnership()
  - verifyDiscordOwnership()
  - verifyTelegramOwnership()
- [ ] Add commitment to Merkle tree
- [ ] Skip public identity record creation (when deleteAfterVerification: true)
- [ ] Return providerId (and optionally encrypted secret) to user
- [ ] Add tests for verify-and-delete flow

### SDK Changes (~1-2 hours)
- [ ] Add `verifyAndCreateZKIdentity()` method to Identities.ts
- [ ] Support both client-side and server-side secret generation
- [ ] Handle secret encryption/decryption if server-generated
- [ ] Return ZKIdentity instance to user
- [ ] Update types in abstraction/types
- [ ] Add usage examples in documentation

### Testing (~1 hour)
- [ ] Test commitment goes in Merkle tree
- [ ] Verify NO public identity record created
- [ ] Test attestations work with verified commitments
- [ ] Test secret backup/restore flow
- [ ] Test both client-generated and server-generated secrets

**Total Estimate**: 4-6 hours focused work

## Key Decisions to Make

### 1. Secret Generation: Client or Server?

**Option A: Server-Generated (Easier UX)**
- ✅ Simpler for users (no secret management upfront)
- ❌ Node knows the secret (trust required)
- ❌ Must securely transmit secret to user
- **Mitigation**: Encrypt with user's public key, use HTTPS, delete immediately

**Option B: Client-Generated (Better Security)**
- ✅ Node never knows secret (zero trust)
- ✅ User has full control
- ❌ More complex UX (backup before verification)
- **Recommendation**: Support BOTH, let user choose

### 2. Public Record Handling

**Option A: Never Create**
- Simply skip creating public identity record
- Cleaner code path

**Option B: Create and Immediately Delete**
- Create record then delete it
- Maintains audit trail
- **Recommendation**: Option A (simpler, same result)

### 3. Incentive Points for ZK Identities

Should `zk_verified_commitment` award points like traditional verification?
- **YES**: Encourages adoption, same as public verification
- **NO**: Different use case, shouldn't incentivize
- **Recommendation**: YES, but track separately for analytics

## Questions to Resolve

1. **Secret Encryption**: How to securely return server-generated secret?
   - Use user's Demos public key (ed25519/pqc)?
   - Require HTTPS endpoint?
   - Short-lived token approach?

2. **Rate Limiting**: Prevent abuse of verification-without-storage
   - Same rate limits as traditional verification?
   - Cost per commitment transaction?

3. **Referral System**: How do referrals work without public records?
   - Store referrer in commitment metadata?
   - Separate referral tracking table?

4. **Migration**: What about existing public identities?
   - Allow users to "convert" to private?
   - Create ZK commitment for already-verified identity?

## Security Considerations

### Server-Generated Secret
- Must encrypt before sending to user
- Delete from server memory immediately
- Use secure random generation (crypto.randomBytes)
- Log warning if transmitted over non-HTTPS

### Client-Generated Secret
- User must backup BEFORE verification
- If lost, commitment is useless (cannot create attestations)
- Provide clear UX warnings

### Verification Reuse
- Can same OAuth proof be used multiple times?
- Should we track used proofs to prevent?
- **Recommendation**: Allow reuse (user might want multiple commitments)

## Future Enhancements

1. **Batch Verification**: Verify multiple providers in one transaction
2. **Identity Refresh**: Update commitment with new secret (privacy rotation)
3. **Commitment Groups**: Create multiple commitments for same identity (different contexts)
4. **OAuth in ZK Circuit**: Verify ownership inside ZK proof (advanced, future)

## References

- Node implementation: `src/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines.ts`
- SDK implementation: `../sdks/src/abstraction/Identities.ts`
- ZK SDK: `../sdks/src/encryption/zK/identity/`
- Existing OAuth methods: `addGithubIdentity()`, `addTwitterIdentity()`, etc.
- Memory context: `zk_identity_implementation_phases_3_4_5_complete.md`

## Next Steps

1. Discuss and refine this plan
2. Make key decisions (secret generation, points, etc.)
3. Create implementation phases document
4. Begin implementation
5. Test on local node
6. Deploy to testnet
7. Update SDK and documentation
