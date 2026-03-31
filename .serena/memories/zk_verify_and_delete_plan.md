# ZK Identity: Verify-and-Delete Flow (Future Feature)

## Problem
Public OAuth verification followed by ZK commitment creation breaks anonymity:
- Public record: `demosAddress ↔ github:alice`
- ZK commitment can be correlated back

## Solution: `zk_verified_commitment`
Single atomic transaction: OAuth verify → create ZK commitment → NO public record

```typescript
const { zkIdentity, commitment, providerId } = 
    await demos.identities.verifyAndCreateZKIdentity({
        provider: "github",
        proof: gistUrl,
        secret: undefined,  // Optional: client or server generates
        referralCode: "FRIEND123"
    })
```

## Key Decisions Pending
1. **Secret Generation**: Client-side vs Server-side (or support both)
2. **Public Record**: Never create vs create-and-delete
3. **Points**: Award incentive points for ZK identities or not

## Implementation Scope
- Node: New transaction type in GCRIdentityRoutines.ts
- SDK: `verifyAndCreateZKIdentity()` method
- Reuse existing OAuth verification methods

## Security Considerations
- Server-generated secret: Must encrypt, delete from memory immediately
- Client-generated secret: User must backup BEFORE verification
- OAuth proof reuse: Allow (user may want multiple commitments)

## Phase Tracking
See beads-mcp issue: node-a95
