# SDK Repository Tasks for Escrow System

This document describes what needs to be implemented in the `sdks` repository (kynesyslabs/demosdk) to complete the escrow system. The node repo has already implemented the server-side consensus validation.

---

## What's Already Done in Node Repo

### Phase 1: Database Schema ✅
**Location**: `/home/user/node/src/model/entities/`

- `GCRv2/GCR_Main.ts` - Added `escrows` JSONB column
- `types/EscrowTypes.ts` - Type definitions for escrow data structures

### Phase 2: Consensus Validation Logic ✅
**Location**: `/home/user/node/src/libs/blockchain/gcr/gcr_routines/`

- `GCREscrowRoutines.ts` - Server-side escrow operations:
  - `getEscrowAddress(platform, username)` - Deterministic address computation
  - `applyEscrowDeposit()` - Validates and applies deposits
  - `applyEscrowClaim()` - Validates Web2 identity proof and releases funds
  - `applyEscrowRefund()` - Validates expiry and processes refunds
  - `apply()` - Main router with rollback support

- `handleGCR.ts` - Integration with GCR system (added `case "escrow"`)

**Key Algorithm** (needed for SDK):
```typescript
// This must match between node and SDK
function getEscrowAddress(platform: string, username: string): string {
    const identity = `${platform}:${username}`.toLowerCase()
    return sha3_256(identity)  // Must use same hash function!
}
```

---

## What Needs to Be Done in SDK Repo

### Task 1: Extend GCREdit Type Definition

**File to modify**: `packages/demosdk/src/types/gcr.ts` (or similar)

**Add new type**:
```typescript
/**
 * Escrow GCR edit operation
 */
export interface GCREditEscrow {
    type: "escrow"
    operation: "deposit" | "claim" | "refund"
    account: string  // Escrow address (for deposit/claim) or refunder address
    data: {
        // Deposit fields
        sender?: string           // Ed25519 pubkey of sender
        platform?: "twitter" | "github" | "telegram"
        username?: string         // Social username (e.g., "@bob")
        amount?: bigint
        expiryDays?: number       // Optional, default 30
        message?: string          // Optional memo

        // Claim fields
        claimant?: string         // Ed25519 pubkey of claimant

        // Refund fields
        refunder?: string         // Ed25519 pubkey of refunder
    }
    txhash?: string
    isRollback?: boolean
}

// Update the main GCREdit union type
export type GCREdit =
    | GCREditBalance
    | GCREditNonce
    | GCREditIdentity
    | GCREditEscrow  // ← NEW
```

---

### Task 2: Create Escrow Transaction Builder

**File to create**: `packages/demosdk/src/escrow/EscrowTransaction.ts`

This provides the high-level API for dApps to create escrow transactions.

```typescript
import { Demos } from "../Demos"
import { Transaction, GCREdit } from "../types"
import { sha3_256 } from "../crypto/hashing"  // Or wherever hash function is

export class EscrowTransaction {

    /**
     * Computes deterministic escrow address from platform:username
     * MUST MATCH node implementation!
     */
    static getEscrowAddress(platform: string, username: string): string {
        const identity = `${platform}:${username}`.toLowerCase()
        return sha3_256(identity)
    }

    /**
     * Creates transaction to send DEM to social identity escrow
     *
     * @example
     * const tx = await EscrowTransaction.sendToIdentity(
     *   demos,
     *   alicePrivateKey,
     *   "twitter",
     *   "@bob",
     *   100n,
     *   { expiryDays: 30, message: "Welcome!" }
     * )
     * await demos.submitTransaction(tx)
     */
    static async sendToIdentity(
        demos: Demos,
        senderPrivateKey: Uint8Array,
        platform: "twitter" | "github" | "telegram",
        username: string,
        amount: bigint,
        options?: {
            expiryDays?: number  // Default: 30
            message?: string     // Optional memo
        }
    ): Promise<Transaction> {

        // Get sender address
        const sender = await demos.getAddressFromPrivateKey(senderPrivateKey)

        // Compute escrow address
        const escrowAddress = this.getEscrowAddress(platform, username)

        // Build GCREdits
        const gcrEdits: GCREdit[] = [
            // 1. Deduct from sender's balance
            {
                type: "balance",
                operation: "remove",
                account: sender,
                amount: amount,
            },

            // 2. Deposit to escrow
            {
                type: "escrow",
                operation: "deposit",
                account: escrowAddress,
                data: {
                    sender,
                    platform,
                    username,
                    amount,
                    expiryDays: options?.expiryDays || 30,
                    message: options?.message,
                },
            },
        ]

        // Create and sign transaction
        const tx = await demos.createTransaction(
            {
                from: sender,
                gcr_edits: gcrEdits,
                data: [
                    `escrow_deposit:${platform}:${username}`,
                    {
                        platform,
                        username,
                        amount: amount.toString(),
                    },
                ],
            },
            senderPrivateKey
        )

        return tx
    }

    /**
     * Creates transaction to claim escrowed funds
     *
     * Prerequisites:
     * - Claimant must have already proven ownership of social identity
     *   (via Web2 identity linking transaction)
     *
     * @example
     * // Bob links Twitter first
     * await bob.linkTwitter("@bob")
     *
     * // Then claims escrow
     * const tx = await EscrowTransaction.claimEscrow(
     *   demos,
     *   bobPrivateKey,
     *   "twitter",
     *   "@bob"
     * )
     * await demos.submitTransaction(tx)
     */
    static async claimEscrow(
        demos: Demos,
        claimantPrivateKey: Uint8Array,
        platform: "twitter" | "github" | "telegram",
        username: string
    ): Promise<Transaction> {

        // Get claimant address
        const claimant = await demos.getAddressFromPrivateKey(claimantPrivateKey)

        // Compute escrow address
        const escrowAddress = this.getEscrowAddress(platform, username)

        // Note: Should query escrow balance first via RPC
        // For now, consensus will determine amount during validation

        // Build GCREdits
        const gcrEdits: GCREdit[] = [
            // 1. Claim escrow (includes identity verification)
            {
                type: "escrow",
                operation: "claim",
                account: escrowAddress,
                data: {
                    claimant,
                    platform,
                    username,
                },
            },

            // 2. Add to claimant's balance
            // Note: Amount determined by consensus during claim validation
            {
                type: "balance",
                operation: "add",
                account: claimant,
                amount: 0n,  // Will be filled by GCREscrowRoutines.applyEscrowClaim()
            },
        ]

        // Create and sign transaction
        const tx = await demos.createTransaction(
            {
                from: claimant,
                gcr_edits: gcrEdits,
                data: [
                    `escrow_claim:${platform}:${username}`,
                    { platform, username },
                ],
            },
            claimantPrivateKey
        )

        return tx
    }

    /**
     * Creates transaction to refund an expired escrow
     *
     * @example
     * const tx = await EscrowTransaction.refundExpiredEscrow(
     *   demos,
     *   alicePrivateKey,
     *   "twitter",
     *   "@unclaimed_user"
     * )
     * await demos.submitTransaction(tx)
     */
    static async refundExpiredEscrow(
        demos: Demos,
        refunderPrivateKey: Uint8Array,
        platform: "twitter" | "github" | "telegram",
        username: string
    ): Promise<Transaction> {

        const refunder = await demos.getAddressFromPrivateKey(refunderPrivateKey)
        const escrowAddress = this.getEscrowAddress(platform, username)

        const gcrEdits: GCREdit[] = [
            // 1. Refund escrow (checks expiry and depositor)
            {
                type: "escrow",
                operation: "refund",
                account: escrowAddress,
                data: {
                    refunder,
                    platform,
                    username,
                },
            },

            // 2. Add refund to original depositor
            {
                type: "balance",
                operation: "add",
                account: refunder,
                amount: 0n,  // Filled during refund validation
            },
        ]

        const tx = await demos.createTransaction(
            {
                from: refunder,
                gcr_edits: gcrEdits,
                data: [
                    `escrow_refund:${platform}:${username}`,
                    { platform, username },
                ],
            },
            refunderPrivateKey
        )

        return tx
    }
}
```

---

### Task 3: Add RPC Query Helpers (Optional)

**File to create**: `packages/demosdk/src/escrow/EscrowQueries.ts`

Convenience wrappers around RPC endpoints (that will be added to node in Phase 4).

```typescript
import { Demos } from "../Demos"
import { EscrowTransaction } from "./EscrowTransaction"

export interface EscrowBalance {
    escrowAddress: string
    exists: boolean
    balance: string  // Stringified bigint
    deposits: Array<{
        from: string
        amount: string
        timestamp: number
        message?: string
    }>
    expiryTimestamp: number
    expired: boolean
}

export interface ClaimableEscrow {
    platform: "twitter" | "github" | "telegram"
    username: string
    balance: string
    escrowAddress: string
    deposits: Array<{
        from: string
        amount: string
        timestamp: number
        message?: string
    }>
    expiryTimestamp: number
    expired: boolean
}

export class EscrowQueries {

    /**
     * Query escrow balance for a specific social identity
     */
    static async getEscrowBalance(
        demos: Demos,
        platform: string,
        username: string
    ): Promise<EscrowBalance> {
        const result = await demos.rpc({
            method: "get_escrow_balance",
            params: { platform, username }
        })
        return result
    }

    /**
     * Get all escrows claimable by a Demos address
     */
    static async getClaimableEscrows(
        demos: Demos,
        address: string
    ): Promise<ClaimableEscrow[]> {
        const result = await demos.rpc({
            method: "get_claimable_escrows",
            params: { address }
        })
        return result
    }

    /**
     * Get all escrows sent by a specific address
     */
    static async getSentEscrows(
        demos: Demos,
        sender: string
    ): Promise<any[]> {
        const result = await demos.rpc({
            method: "get_sent_escrows",
            params: { sender }
        })
        return result
    }
}
```

---

### Task 4: Export Public API

**File to modify**: `packages/demosdk/src/index.ts`

```typescript
// Add to exports
export { EscrowTransaction } from "./escrow/EscrowTransaction"
export { EscrowQueries } from "./escrow/EscrowQueries"
export type { EscrowBalance, ClaimableEscrow } from "./escrow/EscrowQueries"
```

---

## Testing the SDK

Once implemented, test with:

```typescript
import { Demos, EscrowTransaction, EscrowQueries } from "@kynesyslabs/demosdk"

// Initialize
const demos = new Demos()
const aliceKey = /* ... */
const bobKey = /* ... */

// Test 1: Alice sends to @bob
const depositTx = await EscrowTransaction.sendToIdentity(
    demos,
    aliceKey,
    "twitter",
    "@bob",
    100n,
    { message: "Welcome to Demos!" }
)
await demos.submitTransaction(depositTx)

// Test 2: Query escrow
const escrow = await EscrowQueries.getEscrowBalance(demos, "twitter", "@bob")
console.log(`Escrow balance: ${escrow.balance}`)

// Test 3: Bob links Twitter (existing Web2 flow)
await demos.linkTwitter(bobKey, "@bob")

// Test 4: Bob claims
const claimTx = await EscrowTransaction.claimEscrow(
    demos,
    bobKey,
    "twitter",
    "@bob"
)
await demos.submitTransaction(claimTx)

// Test 5: Verify Bob received funds
const bobBalance = await demos.getBalance(bobAddress)
console.log(`Bob's balance: ${bobBalance}`)
```

---

## Critical Implementation Notes

### 1. Hash Function MUST Match
The `getEscrowAddress()` function in SDK **must** produce the same output as the node implementation:

**Node version** (reference):
```typescript
// In GCREscrowRoutines.ts
static getEscrowAddress(platform: string, username: string): string {
    const identity = `${platform}:${username}`.toLowerCase()
    return Hashing.sha3_256(identity)
}
```

**SDK version** (must match):
```typescript
// In EscrowTransaction.ts
static getEscrowAddress(platform: string, username: string): string {
    const identity = `${platform}:${username}`.toLowerCase()
    return sha3_256(identity)  // Use same hash function!
}
```

### 2. GCREdit Structure
The `GCREdit` objects created by SDK must match what the node expects:

**Deposit**:
```typescript
{
    type: "escrow",
    operation: "deposit",
    account: escrowAddress,  // Computed via getEscrowAddress()
    data: {
        sender: "0x...",
        platform: "twitter",
        username: "@bob",
        amount: 100n,
        expiryDays: 30,
        message: "..."
    }
}
```

**Claim**:
```typescript
{
    type: "escrow",
    operation: "claim",
    account: escrowAddress,
    data: {
        claimant: "0x...",
        platform: "twitter",
        username: "@bob"
    }
}
```

**Refund**:
```typescript
{
    type: "escrow",
    operation: "refund",
    account: escrowAddress,
    data: {
        refunder: "0x...",
        platform: "twitter",
        username: "@bob"
    }
}
```

### 3. Balance GCREdits
All escrow transactions include a balance GCREdit:
- **Deposit**: Remove from sender before escrow deposit
- **Claim**: Add to claimant after escrow claim
- **Refund**: Add to refunder after escrow refund

The node will validate these in order.

---

## Dependencies on Node Repo

The SDK implementation depends on:

1. **Phase 4 (Node)**: RPC endpoints for querying escrows
   - `get_escrow_balance`
   - `get_claimable_escrows`
   - `get_sent_escrows`

2. **Consensus validation** (already done in Phase 2):
   - `GCREscrowRoutines` validates all operations
   - Identity proof verification via `IdentityManager`

---

## Timeline

**SDK Tasks**:
- Task 1 (Type definitions): 15 minutes
- Task 2 (Transaction builders): 1 hour
- Task 3 (RPC queries): 30 minutes
- Task 4 (Exports): 5 minutes
- **Total**: ~2 hours

**Node Tasks** (will be done in Phase 4):
- RPC endpoints: 1-2 hours

---

## Reference Files in Node Repo

For implementation reference:

1. **Type definitions**:
   - `/home/user/node/src/model/entities/types/EscrowTypes.ts`

2. **Consensus logic** (for understanding validation):
   - `/home/user/node/src/libs/blockchain/gcr/gcr_routines/GCREscrowRoutines.ts`

3. **GCR integration**:
   - `/home/user/node/src/libs/blockchain/gcr/handleGCR.ts` (line 278-283)

4. **Existing transaction builders** (for patterns):
   - Look for existing `createTransaction()` usage in SDK

---

## Questions?

If you need clarification on:
- Hash function implementation → check `Hashing.sha3_256()` in node repo
- Transaction structure → check existing GCREdit types in SDK
- Validation logic → see `GCREscrowRoutines.ts` in node repo
- Identity verification → see `IdentityManager.getWeb2Identities()` in node repo
