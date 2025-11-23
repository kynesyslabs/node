# Escrow System Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    TRUSTLESS ESCROW ARCHITECTURE                        │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Sender    │         │  Consensus  │         │   GCR DB    │
│   (Alice)   │────────▶│   Shard     │────────▶│ (Persistent │
│             │         │ Validators  │         │   State)    │
└─────────────┘         └─────────────┘         └─────────────┘
      │                        │                        │
      │                        │                        │
      │                        ▼                        │
      │                 ┌─────────────┐                 │
      │                 │   Escrow    │                 │
      │                 │   Logic     │                 │
      │                 │ (Consensus  │                 │
      │                 │  Validated) │                 │
      │                 └─────────────┘                 │
      │                        │                        │
      │                        │                        │
      ▼                        ▼                        ▼
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│  Claimant   │────────▶│  Web2 ID    │────────▶│   GCR DB    │
│    (Bob)    │         │ Verification│         │  (Identity  │
│             │         │             │         │   Proofs)   │
└─────────────┘         └─────────────┘         └─────────────┘
```

## Detailed Flow Diagrams

### Phase 1: Deposit to Escrow

```
┌─────────────────────────────────────────────────────────────────────────┐
│               SENDING DEM TO UNCLAIMED IDENTITY                         │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────┐                    ┌──────────────┐                ┌──────────┐
│  Alice   │                    │  Demos Node  │                │  GCR DB  │
│ (Sender) │                    │  (Consensus) │                │ (State)  │
└────┬─────┘                    └──────┬───────┘                └────┬─────┘
     │                                 │                             │
     │ 1. Create Transaction           │                             │
     │    "Send 100 DEM to @bob"       │                             │
     │                                 │                             │
     │ 2. Sign & Submit Tx             │                             │
     ├────────────────────────────────▶│                             │
     │                                 │                             │
     │                                 │ 3. Validate Signature       │
     │                                 │                             │
     │                                 │ 4. Compute Escrow Address   │
     │                                 │    addr = sha3("twitter:@bob")
     │                                 │    addr = "0xabc...def"     │
     │                                 │                             │
     │                                 │ 5. Parse GCREdits:          │
     │                                 │    a) balance.remove        │
     │                                 │       account: alice        │
     │                                 │       amount: 100           │
     │                                 │                             │
     │                                 │    b) escrow.deposit        │
     │                                 │       account: 0xabc..def   │
     │                                 │       data: {               │
     │                                 │         platform: "twitter" │
     │                                 │         username: "@bob"    │
     │                                 │         amount: 100         │
     │                                 │       }                     │
     │                                 │                             │
     │                                 │ 6. Shard Consensus Loop     │
     │                                 │                             │
     │        ┌────────────────────────┼────────────────────────┐    │
     │        │   All Validators in    │                        │    │
     │        │   Shard Independently: │                        │    │
     │        │                        │                        │    │
     │        │   V1: ✓ Valid          │                        │    │
     │        │   V2: ✓ Valid          │                        │    │
     │        │   V3: ✓ Valid          │                        │    │
     │        │   V4: ✓ Valid          │                        │    │
     │        │   V5: ✓ Valid          │                        │    │
     │        │                        │                        │    │
     │        │   BFT: 5/5 agree       │                        │    │
     │        └────────────────────────┼────────────────────────┘    │
     │                                 │                             │
     │                                 │ 7. Apply GCREdits           │
     │                                 │    (Atomic Transaction)     │
     │                                 ├────────────────────────────▶│
     │                                 │                             │
     │                                 │         UPDATE GCR_Main:    │
     │                                 │                             │
     │                                 │         -- Alice's balance  │
     │                                 │         alice.balance -= 100│
     │                                 │                             │
     │                                 │         -- Create/Update    │
     │                                 │         -- escrow account   │
     │                                 │         INSERT/UPDATE       │
     │                                 │         escrows["0xabc"] = {│
     │                                 │           claimableBy: {    │
     │                                 │             platform: "twitter"│
     │                                 │             username: "@bob"│
     │                                 │           },                │
     │                                 │           balance: 100n,    │
     │                                 │           deposits: [{      │
     │                                 │             from: "alice",  │
     │                                 │             amount: 100n,   │
     │                                 │             timestamp: ...  │
     │                                 │           }],               │
     │                                 │           expiryTimestamp: ..│
     │                                 │           createdAt: ...    │
     │                                 │         }                   │
     │                                 │                             │
     │                                 │◀────────────────────────────│
     │                                 │                             │
     │                                 │ 8. Forge Block              │
     │                                 │    (Include tx hash)        │
     │                                 │                             │
     │◀────────────────────────────────│                             │
     │   Response: "✓ Sent to @bob"    │                             │
     │   Tx Hash: 0x123...             │                             │
     │                                 │                             │
```

### Phase 2: Claim Escrowed Funds

```
┌─────────────────────────────────────────────────────────────────────────┐
│                  CLAIMING ESCROWED FUNDS                                │
└─────────────────────────────────────────────────────────────────────────┘

┌──────────┐                    ┌──────────────┐                ┌──────────┐
│   Bob    │                    │  Demos Node  │                │  GCR DB  │
│(Claimant)│                    │  (Consensus) │                │ (State)  │
└────┬─────┘                    └──────┬───────┘                └────┬─────┘
     │                                 │                             │
     │ PREREQUISITE: Bob must first prove Twitter ownership          │
     │                                 │                             │
     │ 1a. Link Twitter Account        │                             │
     │     (existing Web2 flow)        │                             │
     ├────────────────────────────────▶│                             │
     │                                 │                             │
     │                                 │ 1b. Validate Twitter Proof  │
     │                                 │     (posts signed message)  │
     │                                 │                             │
     │                                 │ 1c. Store Identity          │
     │                                 ├────────────────────────────▶│
     │                                 │                             │
     │                                 │    bob_pubkey.identities    │
     │                                 │    .web2.twitter = [{       │
     │                                 │      username: "@bob",      │
     │                                 │      userId: "12345",       │
     │                                 │      proof: "...",          │
     │                                 │      timestamp: ...         │
     │                                 │    }]                       │
     │                                 │                             │
     │◀────────────────────────────────│                             │
     │   "✓ Twitter linked"            │                             │
     │                                 │                             │
     │━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│
     │                                 │                             │
     │ 2. Check for Claimable Escrows  │                             │
     │    (RPC: getClaimableEscrows)   │                             │
     ├────────────────────────────────▶│                             │
     │                                 │                             │
     │                                 │ Query: Find escrows where   │
     │                                 │ Bob has proven identity     │
     │                                 ├────────────────────────────▶│
     │                                 │                             │
     │                                 │    SELECT * FROM escrows    │
     │                                 │    WHERE claimableBy =      │
     │                                 │      "twitter:@bob"         │
     │                                 │                             │
     │                                 │◀────────────────────────────│
     │                                 │    Found: {balance: 100n}   │
     │                                 │                             │
     │◀────────────────────────────────│                             │
     │   Response: [{                  │                             │
     │     platform: "twitter",        │                             │
     │     username: "@bob",           │                             │
     │     balance: "100"              │                             │
     │   }]                            │                             │
     │                                 │                             │
     │ 3. Submit Claim Transaction     │                             │
     ├────────────────────────────────▶│                             │
     │                                 │                             │
     │                                 │ 4. Parse GCREdits:          │
     │                                 │    a) escrow.claim          │
     │                                 │       account: 0xabc..def   │
     │                                 │       data: {               │
     │                                 │         claimant: bob_pubkey│
     │                                 │         platform: "twitter" │
     │                                 │         username: "@bob"    │
     │                                 │       }                     │
     │                                 │                             │
     │                                 │    b) balance.add           │
     │                                 │       account: bob_pubkey   │
     │                                 │       amount: 100           │
     │                                 │                             │
     │                                 │ 5. Shard Consensus          │
     │        ┌────────────────────────┼────────────────────────┐    │
     │        │   All Validators       │                        │    │
     │        │   Independently Check: │                        │    │
     │        │                        │                        │    │
     │        │   a) Escrow exists?    │                        │    │
     │        │      ✓ Yes             │                        │    │
     │        │                        │                        │    │
     │        │   b) Bob proven @bob?  │                        │    │
     │        │      ✓ Check GCR       │◀───────────────────────┼────│
     │        │        bob.identities  │                        │    │
     │        │        .web2.twitter   │                        │    │
     │        │        .username = "@bob"                       │    │
     │        │      ✓ Yes             │                        │    │
     │        │                        │                        │    │
     │        │   c) Expired?          │                        │    │
     │        │      ✗ No (still valid)│                        │    │
     │        │                        │                        │    │
     │        │   V1: ✓ Valid          │                        │    │
     │        │   V2: ✓ Valid          │                        │    │
     │        │   V3: ✓ Valid          │                        │    │
     │        │   V4: ✓ Valid          │                        │    │
     │        │   V5: ✓ Valid          │                        │    │
     │        │                        │                        │    │
     │        │   BFT: 5/5 agree       │                        │    │
     │        └────────────────────────┼────────────────────────┘    │
     │                                 │                             │
     │                                 │ 6. Apply GCREdits           │
     │                                 │    (Atomic Transaction)     │
     │                                 ├────────────────────────────▶│
     │                                 │                             │
     │                                 │      BEGIN TRANSACTION;     │
     │                                 │                             │
     │                                 │      -- Delete escrow       │
     │                                 │      DELETE FROM            │
     │                                 │      escrows["0xabc..."]    │
     │                                 │                             │
     │                                 │      -- Add to Bob          │
     │                                 │      UPDATE GCR_Main        │
     │                                 │      SET balance = balance + 100│
     │                                 │      WHERE pubkey = bob     │
     │                                 │                             │
     │                                 │      COMMIT;                │
     │                                 │                             │
     │                                 │◀────────────────────────────│
     │                                 │                             │
     │◀────────────────────────────────│                             │
     │   "✓ Claimed 100 DEM"           │                             │
     │                                 │                             │
```

### Shard Rotation & State Persistence

```
┌─────────────────────────────────────────────────────────────────────────┐
│           SHARD ROTATION DOES NOT AFFECT ESCROW STATE                   │
└─────────────────────────────────────────────────────────────────────────┘

Block N                    Block N+1                   Block N+2
Shard A                    Shard B                     Shard C
[V1,V2,V3,V4,V5]          [V6,V7,V8,V9,V10]           [V11,V12,V13,V14,V15]

┌─────────────┐            ┌─────────────┐             ┌─────────────┐
│  Ephemeral  │            │  Ephemeral  │             │  Ephemeral  │
│   Shard A   │───────────▶│   Shard B   │────────────▶│   Shard C   │
│ (rotates)   │            │ (rotates)   │             │ (rotates)   │
└─────┬───────┘            └─────┬───────┘             └─────┬───────┘
      │                          │                           │
      │ reads                    │ reads                     │ reads
      ▼                          ▼                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     PERSISTENT GCR_Main DATABASE                    │
│                     (PostgreSQL / SQLite)                           │
│                                                                     │
│  escrows["0xabc...def"] = {                                        │
│    claimableBy: {platform: "twitter", username: "@bob"},           │
│    balance: 100n,                                                  │
│    deposits: [{from: "alice", amount: 100n, timestamp: ...}],      │
│    expiryTimestamp: 1234567890,                                    │
│    createdAt: 1234567800                                           │
│  }                                                                 │
│                                                                     │
│  ← State persists across all blocks, regardless of shard rotation  │
└─────────────────────────────────────────────────────────────────────┘

Timeline:

Block N   : Alice deposits to escrow (validated by Shard A)
            └─▶ GCR_Main.escrows["0xabc"] created

Block N+1 : (Shard rotates to Shard B)
            └─▶ GCR_Main.escrows["0xabc"] still exists

Block N+2 : Bob claims escrow (validated by Shard C)
            └─▶ Shard C reads same GCR_Main
            └─▶ Validates claim independently
            └─▶ Transfers funds to Bob
```

### Consensus Validation Detail

```
┌─────────────────────────────────────────────────────────────────────────┐
│            DISTRIBUTED VALIDATION (BFT CONSENSUS)                       │
└─────────────────────────────────────────────────────────────────────────┘

Claim Transaction Submitted
         │
         ▼
┌────────────────────────────────────────────────────────────────┐
│                   Broadcast to All Shard Validators            │
└────────────────────────────────────────────────────────────────┘
         │
         ├───────────┬───────────┬───────────┬───────────┐
         ▼           ▼           ▼           ▼           ▼
    ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
    │  V1    │  │  V2    │  │  V3    │  │  V4    │  │  V5    │
    └───┬────┘  └───┬────┘  └───┬────┘  └───┬────┘  └───┬────┘
        │           │           │           │           │
        │ Each validator independently validates:        │
        │                                                 │
        │ 1. Read escrow from GCR_Main                   │
        │    ├─▶ Query: SELECT * FROM GCR_Main           │
        │    │         WHERE pubkey = escrowAddress       │
        │    └─▶ Exists? ✓                                │
        │                                                 │
        │ 2. Check claimant has proven identity          │
        │    ├─▶ Query: SELECT identities FROM GCR_Main  │
        │    │         WHERE pubkey = claimantAddress     │
        │    ├─▶ Has web2.twitter.username = "@bob"? ✓   │
        │    └─▶ Valid proof? ✓                           │
        │                                                 │
        │ 3. Check not expired                           │
        │    ├─▶ now() < escrow.expiryTimestamp? ✓       │
        │    └─▶ Valid? ✓                                 │
        │                                                 │
        │ 4. Sign block if all checks pass               │
        │                                                 │
        ▼           ▼           ▼           ▼           ▼
    ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐
    │ Valid✓ │  │ Valid✓ │  │ Valid✓ │  │ Valid✓ │  │ Valid✓ │
    │ Sign   │  │ Sign   │  │ Sign   │  │ Sign   │  │ Sign   │
    └───┬────┘  └───┬────┘  └───┬────┘  └───┬────┘  └───┬────┘
        │           │           │           │           │
        └───────────┴───────────┴───────────┴───────────┘
                            │
                            ▼
                ┌────────────────────────┐
                │  BFT Threshold Reached │
                │      (5/5 = 100%)      │
                │   > 2/3 required (67%) │
                └───────────┬────────────┘
                            │
                            ▼
                    ┌───────────────┐
                    │  Block Forged │
                    │  Tx Included  │
                    │ State Updated │
                    └───────────────┘

Attack Scenario: Malicious V3 approves without proof
─────────────────────────────────────────────────────
    V1: ✗ No proof → Reject
    V2: ✗ No proof → Reject
    V3: ✓ Malicious → Approve anyway
    V4: ✗ No proof → Reject
    V5: ✗ No proof → Reject

    BFT: 1/5 = 20% < 67% threshold
    Result: ✗ Consensus NOT reached
            ✗ Block NOT forged
            ✗ Funds NOT released

Security: Malicious minority cannot affect outcome!
```

## Data Flow

### GCR_Main Table Structure

```sql
-- Existing structure (simplified)
CREATE TABLE gcr_main (
  pubkey TEXT PRIMARY KEY,
  balance BIGINT,
  nonce INTEGER,
  identities JSONB,  -- {xm: {...}, web2: {...}, pqc: {...}}
  points JSONB,
  referralInfo JSONB,
  assignedTxs JSONB,

  -- NEW: Escrow field
  escrows JSONB,     -- {[escrowAddr]: {...escrow data...}}

  flagged BOOLEAN,
  flaggedReason TEXT,
  reviewed BOOLEAN,
  createdAt TIMESTAMP,
  updatedAt TIMESTAMP
);
```

### Escrow Data Structure

```typescript
// TypeScript interface
interface EscrowData {
  claimableBy: {
    platform: "twitter" | "github" | "telegram"
    username: string  // e.g., "@bob"
  }
  balance: bigint
  deposits: Array<{
    from: string      // Sender's pubkey
    amount: bigint
    timestamp: number
    message?: string  // Optional memo
  }>
  expiryTimestamp: number  // Unix timestamp (ms)
  createdAt: number
}

// Storage in GCR_Main
{
  pubkey: "0xabc...def",  // Escrow address
  balance: 0n,             // Always 0 (funds stored in escrows field)
  escrows: {
    "0xabc...def": {       // Self-referential (escrow account stores its own data)
      claimableBy: {
        platform: "twitter",
        username: "@bob"
      },
      balance: 100n,
      deposits: [{
        from: "0x123...alice",
        amount: 100n,
        timestamp: 1234567890,
        message: "Welcome to Demos!"
      }],
      expiryTimestamp: 1237159890,  // +30 days
      createdAt: 1234567890
    }
  }
}
```

## Component Interaction

```
┌─────────────────────────────────────────────────────────────────────┐
│                      COMPONENT ARCHITECTURE                         │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────┐
│   Frontend UI   │
│   (dApp)        │
└────────┬────────┘
         │
         │ EscrowTransaction.sendToIdentity(platform, username, amount)
         ▼
┌─────────────────────────────────────┐
│  Transaction Builder                │
│  EscrowTransaction.ts               │
│  - Computes escrow address          │
│  - Creates GCREdits                 │
│  - Signs transaction                │
└────────┬────────────────────────────┘
         │
         │ Transaction object
         ▼
┌─────────────────────────────────────┐
│  Consensus Layer                    │
│  PoRBFT.ts                          │
│  - Validates transaction            │
│  - Broadcasts to shard              │
│  - Collects validator signatures    │
└────────┬────────────────────────────┘
         │
         │ Approved transaction
         ▼
┌─────────────────────────────────────┐
│  GCR Handler                        │
│  handleGCR.ts                       │
│  - Routes to GCREscrowRoutines      │
│  - Manages rollback on failure      │
└────────┬────────────────────────────┘
         │
         │ GCREdit objects
         ▼
┌─────────────────────────────────────┐
│  Escrow Routines                    │
│  GCREscrowRoutines.ts               │
│  - applyEscrowDeposit()             │
│  - applyEscrowClaim()               │
│  - Validates identity proofs        │
└────────┬────────────────────────────┘
         │
         │ Database operations
         ▼
┌─────────────────────────────────────┐
│  Database Layer                     │
│  GCR_Main Table (PostgreSQL/SQLite) │
│  - JSONB escrows column             │
│  - ACID transactions                │
│  - Persistent state                 │
└─────────────────────────────────────┘
```

## Security Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SECURITY LAYERS                                  │
└─────────────────────────────────────────────────────────────────────┘

Layer 1: Cryptographic Signatures
──────────────────────────────────
├─ Transaction signed by sender (Ed25519)
├─ Block signed by validators
└─ Identity proofs signed by social account owner

Layer 2: Consensus Validation
──────────────────────────────
├─ All validators independently validate
├─ BFT threshold (2/3+) required
├─ Malicious minority cannot affect outcome
└─ Deterministic validation (same input → same output)

Layer 3: State Integrity
─────────────────────────
├─ GCR state hashed into every block
├─ Tampering detected via hash mismatch
├─ Database ACID transactions
└─ Rollback on any GCREdit failure

Layer 4: Business Logic
────────────────────────
├─ Identity verification via existing Web2 flow
├─ Escrow expiry prevents permanent locks
├─ Only proven owner can claim
└─ Balance checks prevent double-spending

Layer 5: Operational Security
──────────────────────────────
├─ Rate limiting on RPC endpoints
├─ Input validation on all user data
├─ SQL injection prevention (parameterized queries)
└─ Audit logging for all escrow operations
```

## Failure Scenarios & Recovery

```
Scenario 1: Transaction Fails During Consensus
───────────────────────────────────────────────
Alice sends to escrow → V1,V2 approve, V3,V4,V5 reject
Result: No consensus → Transaction dropped → Alice keeps funds

Scenario 2: GCREdit Partial Failure
────────────────────────────────────
Deposit succeeds, but balance deduction fails
Result: Automatic rollback → All changes reverted → Retry

Scenario 3: Database Crash During Write
────────────────────────────────────────
Escrow being written when DB crashes
Result: ACID transaction rollback → Consistent state restored

Scenario 4: Network Partition
──────────────────────────────
Shard split into two groups during consensus
Result: Neither group reaches 2/3 → Block not forged → Retry

Scenario 5: Validator Byzantine Behavior
─────────────────────────────────────────
Malicious validator approves invalid claim
Result: Honest majority rejects → Claim fails → Funds safe

Scenario 6: User Claims Expired Escrow
───────────────────────────────────────
Bob tries to claim after 30 days
Result: Validators check timestamp → Reject → Sender can refund
```

---

**Next**: See `IMPLEMENTATION_PHASES.md` for detailed implementation steps.
