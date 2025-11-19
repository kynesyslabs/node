# Pre-Generated Wallet: Trustless Escrow System

## Executive Summary

**Goal**: Enable sending DEM to social handles (e.g., `@alice`) before the user has a Demos wallet. Funds are held in **trustless escrow** (controlled by consensus rules, not a custodian) until the user proves ownership of the social identity and claims them.

**Use Case**:
- Alice wants to send 100 DEM to her friend Bob on Twitter (`@bob`)
- Bob doesn't have a Demos wallet yet
- Alice sends to `twitter:@bob` → funds go into escrow
- Bob creates wallet later, proves he owns `@bob`, claims the 100 DEM

## Why This is NOT Custodial

The escrow is **trustless** because:

✅ **State stored in GCR_Main** (persistent database table)
✅ **Release controlled by deterministic consensus validation**
✅ **All validators independently verify Web2 identity proofs**
✅ **No single party controls the funds** (consensus enforces release)
✅ **Shard rotation doesn't affect escrow** (GCR persists across blocks)

### Comparison

| Aspect | Custodial | Our Escrow |
|--------|-----------|------------|
| Who controls funds? | Single entity | Consensus rules (code) |
| Can entity steal funds? | Yes | No (validators reject) |
| Trust model | Trust the custodian | Trust the math/code |
| Similar to | Exchange wallet | Bitcoin P2SH script |

## Core Principles

### 1. Deterministic Escrow Address

```typescript
escrowAddress = sha3_256("platform:username")

// Examples:
sha3_256("twitter:@bob")   → "0xabc...def"
sha3_256("github:octocat") → "0x123...456"
```

**Properties**:
- Anyone can compute the escrow address for any social identity
- Address is deterministic (always the same for same platform:username)
- No private key exists for this address (funds locked by consensus rules)

### 2. Trustless Release Conditions

Funds can ONLY be released if **all** conditions are met:

1. ✅ Claimant has proven ownership of social identity (via existing Web2 verification flow)
2. ✅ All consensus validators independently verify the proof
3. ✅ Escrow has not expired
4. ✅ Consensus BFT threshold reached (majority of validators agree)

**Security**: Even if one validator is malicious, it cannot release funds without consensus.

### 3. Shard Rotation is Safe

**Your concern**: "The shard rotates every consensus cycle, this means that if the BFT is not reached at block N, it should be clean in the GCR for the next one."

**Answer**: ✅ No problem!

```
Block N (Shard A = [V1, V2, V3, V4, V5])
│
│ GCR_Main (PostgreSQL/SQLite):
│ escrows["0xabc"] = {
│   balance: 100n,
│   claimableBy: {platform: "twitter", username: "@bob"}
│ }
│
│ ← Shard rotates to [V6, V7, V8, V9, V10]
│
Block N+1 (Shard B = [V6, V7, V8, V9, V10])
│
│ Shard B reads same GCR_Main from database
│ Escrow still exists: {balance: 100n, ...}
│
│ If Bob submits claim at block N+1:
│ → Shard B independently validates
│ → Checks: Bob proven @bob in GCR? ✓
│ → All validators in Shard B verify
│ → Consensus reached → Funds released
```

**Why this works**:
- **GCR_Main** is a persistent database table (survives shard rotation)
- **Shards** are ephemeral (exist only for one block)
- **Validation logic** is deterministic (any shard can validate claims)
- **State** persists regardless of which validators are active

### 4. Expiry & Refunds

To prevent funds being locked forever:

- Each escrow has an `expiryTimestamp` (default: 30 days)
- After expiry, original sender can claim refund
- Incentivizes users to claim quickly

## How It Works

### Sending to Unclaimed Identity

```typescript
// Alice sends 100 DEM to @bob
const tx = await EscrowTransaction.sendToIdentity(
  demos,
  alicePrivateKey,
  "twitter",
  "@bob",
  100n,
  { expiryDays: 30, message: "Welcome to Demos!" }
)

// This creates a transaction with GCREdits:
// 1. Deduct 100 DEM from Alice's balance
// 2. Deposit 100 DEM to escrow address for "twitter:@bob"
```

**What happens in consensus**:
1. Validators receive transaction
2. Each validator independently:
   - Validates Alice's signature
   - Checks Alice has 100 DEM balance
   - Computes escrow address: `sha3_256("twitter:@bob")`
   - Creates/updates escrow in GCR_Main
3. BFT consensus reached → Block forged
4. State persisted in database

### Claiming Escrowed Funds

```typescript
// Step 1: Bob creates wallet
const bobWallet = demos.createWallet()

// Step 2: Bob proves he owns @bob (existing Web2 flow)
await bobWallet.linkTwitter("@bob")
// → Bob posts signed message on Twitter
// → Consensus validates proof
// → GCR stores: Bob's pubkey ↔ twitter:@bob

// Step 3: Bob claims escrow
const claimTx = await EscrowTransaction.claimEscrow(
  demos,
  bobPrivateKey,
  "twitter",
  "@bob"
)

// This creates a transaction with GCREdits:
// 1. Verify Bob has proven ownership of twitter:@bob
// 2. Transfer escrow balance to Bob
// 3. Delete escrow
```

**What happens in consensus**:
1. Validators receive claim transaction
2. Each validator independently:
   - Checks: Does escrow exist for "twitter:@bob"? ✓
   - Checks: Has Bob proven ownership of @bob? ✓ (reads GCR)
   - Checks: Is escrow expired? ✗ (still valid)
   - Validates: Transfer funds to Bob
3. BFT consensus reached → Funds released
4. Escrow deleted, Bob's balance increased

## Security Analysis

### Attack Vectors & Mitigations

| Attack Scenario | Mitigation |
|-----------------|------------|
| **Malicious validator releases funds without proof** | ❌ Impossible - other validators reject block (BFT consensus). Malicious block never finalized. |
| **User fakes Twitter identity** | ❌ Prevented by existing Web2 verification (must post signed message from real Twitter account). |
| **Escrow funds stuck forever** | ✅ Expiry mechanism: funds return to sender after 30 days if unclaimed. |
| **Front-running claim** | ✅ Only address that has proven ownership can claim (stored in GCR identities). |
| **Shard collusion to steal funds** | ✅ Would require 2/3+ malicious validators (BFT threshold) - economically irrational. |
| **Database corruption** | ✅ GCR state is hashed into every block (tamper-evident). |
| **Sender sends to wrong username** | ⚠️ User responsibility - UI should confirm before sending. |

### Byzantine Fault Tolerance

Demos uses **PoRBFT** (Proof of Reputation BFT) consensus:

- Requires **2/3+ validators** to agree on state changes
- Escrow claim validation runs on **all validators independently**
- Even if minority of validators are malicious, they cannot:
  - Release funds without proof
  - Prevent legitimate claims
  - Corrupt escrow state

**Example**: Shard of 7 validators

```
V1, V2, V3, V4, V5, V6, V7

Bob claims escrow without proving @bob:
V1: ✗ Rejects (no proof in GCR)
V2: ✗ Rejects
V3: ✓ Malicious - approves anyway
V4: ✗ Rejects
V5: ✗ Rejects
V6: ✗ Rejects
V7: ✗ Rejects

Result: 6/7 reject → No consensus → Claim fails
```

## User Experience

### Sending Flow

1. **Alice** opens Demos dApp
2. Clicks "Send to friend"
3. Selects "Twitter" and enters "@bob"
4. Enters amount: 100 DEM
5. Optional: Adds message "Welcome to Demos!"
6. Confirms transaction
7. **UI shows**: "✓ Sent 100 DEM to @bob. They can claim when they join Demos."

### Claiming Flow

1. **Bob** sees tweet from Alice: "I sent you 100 DEM on Demos!"
2. Bob visits Demos, creates wallet
3. Links Twitter account (posts signed message)
4. **UI shows**: "🎉 You have 100 DEM waiting! Claim now"
5. Bob clicks "Claim"
6. **UI shows**: "✓ Claimed 100 DEM from @alice"

### Discovery

Bob needs to know he has pending funds. Options:

**Option A**: Off-chain notification service
- Bot monitors escrow deposits
- Sends Twitter DM: "@bob, you have DEM waiting at demos.network/claim"

**Option B**: On-claim discovery
- When Bob links Twitter, dApp automatically checks for escrows
- Shows banner: "You have claimable funds!"

**Option C**: Social graph integration
- Alice's transaction includes Twitter mention
- Bob sees notification on Twitter

## Benefits

### For Demos Network

✅ **Viral growth**: Users can onboard friends who aren't on Demos yet
✅ **Lower barrier to entry**: Receive funds before creating wallet
✅ **Network effects**: Incentivizes social sharing
✅ **Unique feature**: No other blockchain has this (truly non-custodial pre-gen wallets)

### For Users

✅ **Simple UX**: "Send to @username" is intuitive
✅ **Non-custodial**: Users generate their own keys
✅ **Trustless**: No third party can steal funds
✅ **Familiar**: Leverages existing social identities

## Extensions (Future)

### Multi-Platform Escrows

Same user could have escrows on multiple platforms:

```typescript
// Same person, different platforms
escrow["twitter:@alice"]  → 100 DEM
escrow["github:alice"]    → 50 DEM
escrow["telegram:@alice"] → 25 DEM

// Alice links all three → claims 175 DEM total
```

### Conditional Escrows

```typescript
// Only claimable if user also links GitHub
escrow.conditions = {
  requireAll: ["twitter:@alice", "github:alice"]
}

// Only claimable by first 100 users
escrow.conditions = {
  maxClaims: 100
}
```

### Escrow Pools

```typescript
// Multiple senders contribute to same escrow
escrow["twitter:@bob"] = {
  balance: 500n,
  deposits: [
    {from: "alice", amount: 100n},
    {from: "charlie", amount: 200n},
    {from: "dave", amount: 200n}
  ]
}
```

### NFT Escrows

```typescript
// Send NFT to unclaimed user
escrow["twitter:@artist"] = {
  nfts: ["artwork_token_id_123"],
  message: "Here's your first NFT!"
}
```

## Timeline

**Minimum Viable Product (MVP)**: 8-11 hours
- Basic escrow deposit/claim
- Twitter integration only
- 30-day expiry
- Simple RPC queries

**Production Ready**: 2-3 weeks
- Multi-platform support (Twitter, GitHub, Telegram)
- Frontend UI components
- Notification system
- Comprehensive testing
- Security audit

**Future Enhancements**: Ongoing
- Conditional escrows
- NFT support
- Analytics dashboard
- Social graph integration

## Conclusion

This escrow system provides a **trustless, non-custodial** way to send DEM to users before they have wallets. It leverages:

- Existing Web2 identity verification infrastructure
- BFT consensus for security
- Persistent GCR state for shard-rotation safety
- Deterministic validation for trustlessness

**Next step**: Begin implementation (see `IMPLEMENTATION_PHASES.md`)
