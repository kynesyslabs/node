# Implementation Phases

## Overview

This document provides detailed, step-by-step implementation instructions for the trustless escrow system.

**Total Estimated Time**: 8-11 hours

---

## Phase 1: Database Schema Extensions

**Time**: 1 hour
**Priority**: Critical (foundational)
**Dependencies**: None

### Goals

- Add `escrows` JSONB column to `GCR_Main` table
- Define TypeScript types for escrow data
- Create database migration

### Files to Modify

#### 1. `src/model/entities/GCRv2/GCR_Main.ts`

**Add the following field**:

```typescript
import {
    Column,
    CreateDateColumn,
    UpdateDateColumn,
    Entity,
    Index,
    PrimaryColumn,
} from "typeorm"
import type { StoredIdentities } from "../types/IdentityTypes"

@Entity("gcr_main")
@Index("idx_gcr_main_pubkey", ["pubkey"])
export class GCRMain {
    @PrimaryColumn({ type: "text", name: "pubkey" })
    pubkey: string

    // ... existing fields ...

    @Column({ type: "jsonb", name: "points", default: () => "'{}'" })
    points: { /* ... existing ... */ }

    @Column({ type: "jsonb", name: "referralInfo", default: () => "'{}'" })
    referralInfo: { /* ... existing ... */ }

    // ===== NEW: Escrow storage =====
    @Column({ type: "jsonb", name: "escrows", default: () => "'{}'" })
    escrows: {
        [escrowAddress: string]: EscrowData
    }
    // ================================

    @Column({ type: "boolean", name: "flagged", default: false })
    flagged: boolean

    // ... rest of existing fields ...
}
```

#### 2. `src/model/entities/types/EscrowTypes.ts` (NEW FILE)

**Create this new file**:

```typescript
/**
 * Data structure for a single escrow
 */
export interface EscrowData {
    claimableBy: {
        platform: "twitter" | "github" | "telegram"
        username: string  // e.g., "@bob" or "octocat"
    }
    balance: bigint
    deposits: EscrowDeposit[]
    expiryTimestamp: number  // Unix timestamp in milliseconds
    createdAt: number
}

/**
 * A single deposit into an escrow
 */
export interface EscrowDeposit {
    from: string      // Sender's Ed25519 public key (hex)
    amount: bigint
    timestamp: number
    message?: string  // Optional memo from sender
}

/**
 * Result of querying an escrow
 */
export interface EscrowQueryResult {
    escrowAddress: string
    exists: boolean
    data?: EscrowData
    claimable: boolean  // Whether caller can claim this
    expired: boolean
}

/**
 * Claimable escrow list item
 */
export interface ClaimableEscrow {
    platform: "twitter" | "github" | "telegram"
    username: string
    balance: string  // Stringified bigint
    escrowAddress: string
    deposits: EscrowDeposit[]
    expiryTimestamp: number
    expired: boolean
}
```

### Database Migration

#### 3. Create migration file

```bash
# Generate migration
npm run migration:generate -- src/model/migrations/AddEscrowsColumn
```

**Or manually create**:
`src/model/migrations/[timestamp]-AddEscrowsColumn.ts`

```typescript
import { MigrationInterface, QueryRunner, TableColumn } from "typeorm"

export class AddEscrowsColumn1234567890000 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.addColumn(
            "gcr_main",
            new TableColumn({
                name: "escrows",
                type: "jsonb",
                default: "'{}'",
                isNullable: false,
            })
        )
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.dropColumn("gcr_main", "escrows")
    }
}
```

**Run migration**:

```bash
npm run migration:run
```

### Acceptance Criteria

- [ ] `escrows` column exists in `gcr_main` table
- [ ] Default value is `{}` (empty JSON object)
- [ ] TypeScript types compile without errors
- [ ] Migration runs successfully on clean database
- [ ] Migration can be reverted (`migration:revert`)

### Testing

```typescript
// Test in Node REPL or test file
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import Datasource from "@/model/datasource"

const db = await Datasource.getInstance()
const repo = db.getDataSource().getRepository(GCRMain)

// Should work without errors
const testAccount = new GCRMain()
testAccount.pubkey = "0xtest"
testAccount.escrows = {}
await repo.save(testAccount)

console.log("✓ Escrow column working")
```

---

## Phase 2: GCREdit Operations for Escrow

**Time**: 2-3 hours
**Priority**: Critical
**Dependencies**: Phase 1 complete

### Goals

- Implement escrow deposit logic
- Implement escrow claim logic with identity verification
- Implement escrow refund (expiry handling)
- Add rollback support

### Files to Create

#### 1. `src/libs/blockchain/gcr/gcr_routines/GCREscrowRoutines.ts` (NEW FILE)

```typescript
import { GCREdit } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../handleGCR"
import Hashing from "@/libs/crypto/hashing"
import IdentityManager from "./identityManager"
import ensureGCRForUser from "./ensureGCRForUser"
import log from "@/utilities/logger"
import { EscrowData, EscrowDeposit } from "@/model/entities/types/EscrowTypes"

export default class GCREscrowRoutines {

    /**
     * Computes deterministic escrow address from platform:username
     * This is a pure function - same input always produces same output
     *
     * @param platform - Social platform ("twitter", "github", "telegram")
     * @param username - Username on that platform (e.g., "@bob")
     * @returns Hex-encoded escrow address
     */
    static getEscrowAddress(platform: string, username: string): string {
        // Normalize to lowercase for case-insensitivity
        const identity = `${platform}:${username}`.toLowerCase()
        // Use SHA3-256 for deterministic address generation
        return Hashing.sha3_256(identity)
    }

    /**
     * Deposits DEM into escrow for an unclaimed social identity
     *
     * @param editOperation - GCREdit with type "escrow", operation "deposit"
     * @param gcrMainRepository - Database repository
     * @param simulate - If true, don't persist changes (used for pre-validation)
     * @returns Success/failure result
     */
    static async applyEscrowDeposit(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean
    ): Promise<GCRResult> {
        const { sender, platform, username, amount, expiryDays, message } = editOperation.data

        // Input validation
        if (!sender || !platform || !username || !amount) {
            return { success: false, message: "Missing required escrow deposit fields" }
        }

        if (amount <= 0) {
            return { success: false, message: "Escrow amount must be positive" }
        }

        if (!["twitter", "github", "telegram"].includes(platform)) {
            return { success: false, message: `Unsupported platform: ${platform}` }
        }

        // Compute deterministic escrow address
        const escrowAddress = this.getEscrowAddress(platform, username)

        log.info(
            `[EscrowDeposit] ${sender} depositing ${amount} DEM for ${platform}:${username}` +
            ` → escrow address: ${escrowAddress}`
        )

        // Get or create escrow account
        let escrowAccount = await gcrMainRepository.findOneBy({ pubkey: escrowAddress })

        if (!escrowAccount) {
            const HandleGCR = (await import("../handleGCR")).default
            escrowAccount = await HandleGCR.createAccount(escrowAddress)
        }

        // Initialize escrows object if needed
        escrowAccount.escrows = escrowAccount.escrows || {}

        // Create new escrow or update existing
        if (!escrowAccount.escrows[escrowAddress]) {
            // New escrow
            const expiryMs = (expiryDays || 30) * 24 * 60 * 60 * 1000
            escrowAccount.escrows[escrowAddress] = {
                claimableBy: {
                    platform: platform as "twitter" | "github" | "telegram",
                    username,
                },
                balance: 0n,
                deposits: [],
                expiryTimestamp: Date.now() + expiryMs,
                createdAt: Date.now(),
            }
        }

        // Add deposit
        const deposit: EscrowDeposit = {
            from: sender,
            amount: BigInt(amount),
            timestamp: Date.now(),
        }

        if (message) {
            deposit.message = message
        }

        escrowAccount.escrows[escrowAddress].balance += BigInt(amount)
        escrowAccount.escrows[escrowAddress].deposits.push(deposit)

        // Persist changes
        if (!simulate) {
            await gcrMainRepository.save(escrowAccount)
        }

        log.info(
            `[EscrowDeposit] ✓ Deposited ${amount} DEM to ${platform}:${username}. ` +
            `Total escrow balance: ${escrowAccount.escrows[escrowAddress].balance}`
        )

        return {
            success: true,
            message: `Deposited ${amount} to escrow for ${platform}:${username}`,
            response: {
                escrowAddress,
                newBalance: escrowAccount.escrows[escrowAddress].balance.toString(),
            },
        }
    }

    /**
     * Claims escrowed funds after Web2 identity verification
     *
     * CRITICAL: This validates that the claimant has proven ownership
     * of the social identity via the existing Web2 verification flow.
     * All validators in consensus independently verify this.
     *
     * @param editOperation - GCREdit with type "escrow", operation "claim"
     * @param gcrMainRepository - Database repository
     * @param simulate - If true, don't persist changes
     * @returns Success/failure result with claimed amount
     */
    static async applyEscrowClaim(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean
    ): Promise<GCRResult> {
        const { claimant, platform, username } = editOperation.data

        // Input validation
        if (!claimant || !platform || !username) {
            return { success: false, message: "Missing required claim fields" }
        }

        // Compute escrow address
        const escrowAddress = this.getEscrowAddress(platform, username)

        log.info(
            `[EscrowClaim] ${claimant} attempting to claim ${platform}:${username}` +
            ` → escrow address: ${escrowAddress}`
        )

        // Check escrow exists
        const escrowAccount = await gcrMainRepository.findOneBy({ pubkey: escrowAddress })

        if (!escrowAccount || !escrowAccount.escrows || !escrowAccount.escrows[escrowAddress]) {
            return {
                success: false,
                message: `No escrow found for ${platform}:${username}`,
            }
        }

        const escrow = escrowAccount.escrows[escrowAddress]

        // CRITICAL SECURITY CHECK: Verify claimant has proven ownership of social identity
        // This uses the existing Web2 identity verification system (GCRIdentityRoutines)
        // All validators independently check this condition
        log.info(`[EscrowClaim] Verifying ${claimant} has proven ${platform}:${username}`)

        const identities = await IdentityManager.getWeb2Identities(claimant, platform)

        const hasProof = identities.some((id: any) => {
            // Case-insensitive username comparison
            return id.username.toLowerCase() === username.toLowerCase()
        })

        if (!hasProof) {
            log.warning(
                `[EscrowClaim] ✗ ${claimant} has not proven ownership of ${platform}:${username}`
            )
            return {
                success: false,
                message: `Claimant has not proven ownership of ${platform}:${username}. ` +
                         `Please link your ${platform} account first.`,
            }
        }

        log.info(`[EscrowClaim] ✓ Identity verified: ${claimant} owns ${platform}:${username}`)

        // Check expiry
        if (Date.now() > escrow.expiryTimestamp) {
            log.warning(`[EscrowClaim] ✗ Escrow expired at ${new Date(escrow.expiryTimestamp)}`)
            return {
                success: false,
                message: `Escrow expired on ${new Date(escrow.expiryTimestamp).toISOString()}. ` +
                         `Original depositors can reclaim funds.`,
            }
        }

        // Get claimed amount
        const claimedAmount = escrow.balance

        if (claimedAmount <= 0n) {
            return {
                success: false,
                message: "Escrow has zero balance",
            }
        }

        // Delete escrow (funds will be transferred via separate balance GCREdit)
        delete escrowAccount.escrows[escrowAddress]

        // Clean up empty escrows object
        if (Object.keys(escrowAccount.escrows).length === 0) {
            escrowAccount.escrows = {}
        }

        // Persist changes
        if (!simulate) {
            await gcrMainRepository.save(escrowAccount)
        }

        log.info(
            `[EscrowClaim] ✓ ${claimant} claimed ${claimedAmount} DEM from ${platform}:${username}`
        )

        return {
            success: true,
            message: `Claimed ${claimedAmount} DEM from ${platform}:${username}`,
            response: {
                amount: claimedAmount.toString(),
                escrowAddress,
            },
        }
    }

    /**
     * Refunds expired escrow to original depositors
     *
     * @param editOperation - GCREdit with type "escrow", operation "refund"
     * @param gcrMainRepository - Database repository
     * @param simulate - If true, don't persist changes
     * @returns Success/failure result
     */
    static async applyEscrowRefund(
        editOperation: any,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean
    ): Promise<GCRResult> {
        const { refunder, platform, username } = editOperation.data

        if (!refunder || !platform || !username) {
            return { success: false, message: "Missing required refund fields" }
        }

        const escrowAddress = this.getEscrowAddress(platform, username)

        log.info(`[EscrowRefund] ${refunder} attempting to refund ${platform}:${username}`)

        // Check escrow exists
        const escrowAccount = await gcrMainRepository.findOneBy({ pubkey: escrowAddress })

        if (!escrowAccount || !escrowAccount.escrows?.[escrowAddress]) {
            return { success: false, message: "Escrow not found" }
        }

        const escrow = escrowAccount.escrows[escrowAddress]

        // Check escrow is expired
        if (Date.now() <= escrow.expiryTimestamp) {
            return {
                success: false,
                message: `Escrow not yet expired. Expires: ${new Date(escrow.expiryTimestamp).toISOString()}`,
            }
        }

        // Verify refunder is one of the original depositors
        const isDepositor = escrow.deposits.some(d => d.from === refunder)

        if (!isDepositor) {
            return {
                success: false,
                message: "Only original depositors can claim refunds",
            }
        }

        // Calculate refunder's portion
        const refunderDeposits = escrow.deposits.filter(d => d.from === refunder)
        const refundAmount = refunderDeposits.reduce((sum, d) => sum + d.amount, 0n)

        if (refundAmount <= 0n) {
            return { success: false, message: "No refundable amount" }
        }

        // Update escrow (remove refunder's deposits)
        escrow.deposits = escrow.deposits.filter(d => d.from !== refunder)
        escrow.balance -= refundAmount

        // If no deposits left, delete escrow
        if (escrow.deposits.length === 0) {
            delete escrowAccount.escrows[escrowAddress]
        }

        // Persist changes
        if (!simulate) {
            await gcrMainRepository.save(escrowAccount)
        }

        log.info(`[EscrowRefund] ✓ ${refunder} refunded ${refundAmount} DEM`)

        return {
            success: true,
            message: `Refunded ${refundAmount} DEM from expired escrow`,
            response: {
                amount: refundAmount.toString(),
            },
        }
    }

    /**
     * Main entry point for escrow GCREdit operations
     * Routes to appropriate handler based on operation type
     *
     * @param editOperation - GCREdit with type "escrow"
     * @param gcrMainRepository - Database repository
     * @param simulate - If true, don't persist changes
     * @returns Success/failure result
     */
    static async apply(
        editOperation: GCREdit,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean
    ): Promise<GCRResult> {
        if (editOperation.type !== "escrow") {
            return {
                success: false,
                message: "Invalid GCREdit type for escrow routine",
            }
        }

        let operation = editOperation.operation

        // Handle rollbacks by reversing operation
        if (editOperation.isRollback) {
            // Rollback logic
            switch (operation) {
                case "deposit":
                    // Rollback deposit = refund
                    operation = "refund"
                    break
                case "claim":
                    // Rollback claim = re-deposit (restore escrow)
                    // This is complex and may need special handling
                    log.warning("[Escrow] Claim rollback not fully implemented")
                    operation = "deposit"
                    break
                case "refund":
                    // Rollback refund = re-deposit
                    operation = "deposit"
                    break
            }
        }

        // Route to appropriate handler
        switch (operation) {
            case "deposit":
                return this.applyEscrowDeposit(editOperation, gcrMainRepository, simulate)

            case "claim":
                return this.applyEscrowClaim(editOperation, gcrMainRepository, simulate)

            case "refund":
                return this.applyEscrowRefund(editOperation, gcrMainRepository, simulate)

            default:
                return {
                    success: false,
                    message: `Unsupported escrow operation: ${operation}`,
                }
        }
    }
}
```

### Files to Modify

#### 2. `src/libs/blockchain/gcr/handleGCR.ts`

**Add escrow case to the `apply()` method**:

```typescript
import GCREscrowRoutines from "./gcr_routines/GCREscrowRoutines"

// ... existing imports ...

export default class HandleGCR {
    // ... existing methods ...

    static async apply(
        editOperation: GCREdit,
        tx: Transaction,
        rollback = false,
        simulate = false,
    ): Promise<GCRResult> {
        const repositories = await this.getRepositories()

        if (rollback) {
            editOperation.isRollback = true
        }

        // Applying the edit operations
        switch (editOperation.type) {
            case "balance":
                return GCRBalanceRoutines.apply(
                    editOperation,
                    repositories.main as Repository<GCRMain>,
                    simulate,
                )
            case "nonce":
                return GCRNonceRoutines.apply(
                    editOperation,
                    repositories.main as Repository<GCRMain>,
                    simulate,
                )
            case "identity":
                return GCRIdentityRoutines.apply(
                    editOperation,
                    repositories.main as Repository<GCRMain>,
                    simulate,
                )

            // ===== NEW: Escrow operations =====
            case "escrow":
                return GCREscrowRoutines.apply(
                    editOperation,
                    repositories.main as Repository<GCRMain>,
                    simulate,
                )
            // ==================================

            case "assign":
            case "subnetsTx":
                console.log(`Assigning GCREdit ${editOperation.type}`)
                return { success: true, message: "Not implemented" }
            default:
                return { success: false, message: "Invalid GCREdit type" }
        }
    }

    // ... rest of existing methods ...
}
```

### Acceptance Criteria

- [ ] `GCREscrowRoutines.getEscrowAddress()` produces deterministic addresses
- [ ] Deposit operation creates/updates escrows correctly
- [ ] Claim operation verifies Web2 identity before releasing funds
- [ ] Refund operation only works for expired escrows
- [ ] Rollback support implemented
- [ ] All methods have proper logging
- [ ] Error handling for all edge cases

### Testing

```typescript
// Test escrow address generation
import GCREscrowRoutines from "@/libs/blockchain/gcr/gcr_routines/GCREscrowRoutines"

const addr1 = GCREscrowRoutines.getEscrowAddress("twitter", "@bob")
const addr2 = GCREscrowRoutines.getEscrowAddress("twitter", "@bob")
const addr3 = GCREscrowRoutines.getEscrowAddress("twitter", "@alice")

console.assert(addr1 === addr2, "Addresses should be deterministic")
console.assert(addr1 !== addr3, "Different usernames should produce different addresses")
console.log("✓ Escrow address generation working")

// Test deposit
// (Integration test - requires database)
```

---

## Phase 3: Transaction Builders & High-Level API

**Time**: 2 hours
**Priority**: High
**Dependencies**: Phase 2 complete

### Goals

- Create helper functions to build escrow transactions
- Simplify the API for frontend/SDK integration
- Handle GCREdit creation and signing

### Files to Create

#### 1. `src/libs/blockchain/escrow/EscrowTransaction.ts` (NEW FILE)

```typescript
import { Transaction, GCREdit } from "@kynesyslabs/demosdk/types"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import GCREscrowRoutines from "../gcr/gcr_routines/GCREscrowRoutines"
import log from "@/utilities/logger"

/**
 * High-level API for creating escrow transactions
 * Used by frontend dApp and SDK integrations
 */
export class EscrowTransaction {

    /**
     * Creates a transaction to send DEM to a social identity escrow
     *
     * Example usage:
     * ```typescript
     * const tx = await EscrowTransaction.sendToIdentity(
     *   demos,
     *   alicePrivateKey,
     *   "twitter",
     *   "@bob",
     *   100n,
     *   { expiryDays: 30, message: "Welcome to Demos!" }
     * )
     * await demos.submitTransaction(tx)
     * ```
     *
     * @param demos - Demos SDK instance
     * @param senderPrivateKey - Sender's Ed25519 private key
     * @param platform - Social platform ("twitter", "github", "telegram")
     * @param username - Username on that platform
     * @param amount - Amount of DEM to send (in smallest unit)
     * @param options - Optional parameters
     * @returns Signed transaction ready to submit
     */
    static async sendToIdentity(
        demos: Demos,
        senderPrivateKey: Uint8Array,
        platform: "twitter" | "github" | "telegram",
        username: string,
        amount: bigint,
        options?: {
            expiryDays?: number  // Default: 30 days
            message?: string     // Optional memo
        }
    ): Promise<Transaction> {

        // Get sender address
        const sender = await demos.getAddressFromPrivateKey(senderPrivateKey)

        // Compute escrow address
        const escrowAddress = GCREscrowRoutines.getEscrowAddress(platform, username)

        log.info(
            `[EscrowTx] Creating sendToIdentity tx: ${sender} → ${platform}:${username} ` +
            `(${amount} DEM, escrow: ${escrowAddress})`
        )

        // Build GCREdits
        const gcrEdits: GCREdit[] = [
            // 1. Deduct from sender's balance
            {
                type: "balance",
                operation: "remove",
                account: sender,
                amount: amount,
                txhash: "", // Will be filled by Demos SDK
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
                    amount: amount,
                    expiryDays: options?.expiryDays || 30,
                    message: options?.message,
                },
                txhash: "",
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
     * Creates a transaction to claim escrowed funds
     *
     * Prerequisites:
     * - Claimant must have already proven ownership of the social identity
     *   (via Web2 identity linking transaction)
     *
     * Example usage:
     * ```typescript
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
     * ```
     *
     * @param demos - Demos SDK instance
     * @param claimantPrivateKey - Claimant's Ed25519 private key
     * @param platform - Social platform
     * @param username - Username to claim for
     * @returns Signed transaction ready to submit
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
        const escrowAddress = GCREscrowRoutines.getEscrowAddress(platform, username)

        log.info(
            `[EscrowTx] Creating claimEscrow tx: ${claimant} claiming ${platform}:${username} ` +
            `(escrow: ${escrowAddress})`
        )

        // Note: We need to query the escrow balance first
        // This would ideally be done via RPC before creating the transaction
        // For now, we'll use a placeholder that gets filled during validation

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
                txhash: "",
            },

            // 2. Add to claimant's balance
            // Note: Amount will be determined during escrow claim validation
            // The GCREscrowRoutines.applyEscrowClaim() returns the amount
            // which should be used to update this edit
            {
                type: "balance",
                operation: "add",
                account: claimant,
                amount: 0n,  // Placeholder - filled by consensus
                txhash: "",
            },
        ]

        // Create and sign transaction
        const tx = await demos.createTransaction(
            {
                from: claimant,
                gcr_edits: gcrEdits,
                data: [
                    `escrow_claim:${platform}:${username}`,
                    {
                        platform,
                        username,
                    },
                ],
            },
            claimantPrivateKey
        )

        return tx
    }

    /**
     * Creates a transaction to refund an expired escrow
     *
     * @param demos - Demos SDK instance
     * @param refunderPrivateKey - Original depositor's private key
     * @param platform - Social platform
     * @param username - Username
     * @returns Signed transaction ready to submit
     */
    static async refundExpiredEscrow(
        demos: Demos,
        refunderPrivateKey: Uint8Array,
        platform: "twitter" | "github" | "telegram",
        username: string
    ): Promise<Transaction> {

        const refunder = await demos.getAddressFromPrivateKey(refunderPrivateKey)
        const escrowAddress = GCREscrowRoutines.getEscrowAddress(platform, username)

        log.info(`[EscrowTx] Creating refund tx: ${refunder} refunding ${platform}:${username}`)

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
                txhash: "",
            },

            // 2. Add refund to original depositor
            {
                type: "balance",
                operation: "add",
                account: refunder,
                amount: 0n,  // Filled by refund validation
                txhash: "",
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

### Acceptance Criteria

- [ ] `sendToIdentity()` creates valid deposit transactions
- [ ] `claimEscrow()` creates valid claim transactions
- [ ] `refundExpiredEscrow()` creates valid refund transactions
- [ ] All transactions properly signed
- [ ] Logging implemented for debugging

### Testing

```typescript
// Manual test (requires Demos SDK setup)
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { EscrowTransaction } from "@/libs/blockchain/escrow/EscrowTransaction"

const demos = new Demos()
const aliceKey = /* ... */
const bobKey = /* ... */

// Test 1: Send to escrow
const depositTx = await EscrowTransaction.sendToIdentity(
    demos,
    aliceKey,
    "twitter",
    "@bob",
    100n,
    { message: "Test escrow" }
)

console.assert(depositTx.content.gcr_edits.length === 2, "Should have 2 GCREdits")
console.assert(depositTx.content.gcr_edits[0].type === "balance", "First edit should be balance")
console.assert(depositTx.content.gcr_edits[1].type === "escrow", "Second edit should be escrow")
console.log("✓ sendToIdentity() working")
```

---

## Phase 4: RPC Endpoints for Querying Escrows

**Time**: 1-2 hours
**Priority**: Medium
**Dependencies**: Phase 2 complete

### Goals

- Add RPC methods to query escrow state
- Enable frontend to discover claimable escrows
- Provide balance information for specific escrows

### Files to Modify

#### 1. `src/libs/network/endpointHandlers.ts`

**Add new RPC methods**:

```typescript
import GCREscrowRoutines from "@/libs/blockchain/gcr/gcr_routines/GCREscrowRoutines"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import Datasource from "@/model/datasource"
import IdentityManager from "@/libs/blockchain/gcr/gcr_routines/identityManager"
import { ClaimableEscrow } from "@/model/entities/types/EscrowTypes"

// ... existing endpoint handlers ...

/**
 * RPC: Get escrow balance for a specific social identity
 *
 * Request:
 * {
 *   "method": "get_escrow_balance",
 *   "params": {
 *     "platform": "twitter",
 *     "username": "@bob"
 *   }
 * }
 *
 * Response:
 * {
 *   "escrowAddress": "0xabc...",
 *   "exists": true,
 *   "balance": "100",
 *   "deposits": [...],
 *   "expiryTimestamp": 1234567890,
 *   "expired": false
 * }
 */
export async function handleGetEscrowBalance(params: {
    platform: string
    username: string
}) {
    const { platform, username } = params

    if (!platform || !username) {
        throw new Error("Missing platform or username")
    }

    const escrowAddress = GCREscrowRoutines.getEscrowAddress(platform, username)
    const db = await Datasource.getInstance()
    const repo = db.getDataSource().getRepository(GCRMain)

    const account = await repo.findOneBy({ pubkey: escrowAddress })

    if (!account || !account.escrows || !account.escrows[escrowAddress]) {
        return {
            escrowAddress,
            exists: false,
            balance: "0",
            deposits: [],
            expiryTimestamp: 0,
            expired: false,
        }
    }

    const escrow = account.escrows[escrowAddress]

    return {
        escrowAddress,
        exists: true,
        balance: escrow.balance.toString(),
        deposits: escrow.deposits.map(d => ({
            from: d.from,
            amount: d.amount.toString(),
            timestamp: d.timestamp,
            message: d.message,
        })),
        expiryTimestamp: escrow.expiryTimestamp,
        expired: Date.now() > escrow.expiryTimestamp,
    }
}

/**
 * RPC: Get all escrows claimable by a Demos address
 * Checks which Web2 identities the address has proven
 *
 * Request:
 * {
 *   "method": "get_claimable_escrows",
 *   "params": {
 *     "address": "0x123..."
 *   }
 * }
 *
 * Response:
 * [
 *   {
 *     "platform": "twitter",
 *     "username": "@bob",
 *     "balance": "100",
 *     "escrowAddress": "0xabc...",
 *     "deposits": [...],
 *     "expired": false
 *   }
 * ]
 */
export async function handleGetClaimableEscrows(params: {
    address: string
}): Promise<ClaimableEscrow[]> {
    const { address } = params

    if (!address) {
        throw new Error("Missing address")
    }

    const db = await Datasource.getInstance()
    const repo = db.getDataSource().getRepository(GCRMain)

    // Get user's account
    const account = await repo.findOneBy({ pubkey: address })

    if (!account || !account.identities || !account.identities.web2) {
        return []
    }

    const claimable: ClaimableEscrow[] = []

    // Check each proven Web2 identity
    for (const [platform, identities] of Object.entries(account.identities.web2)) {
        if (!Array.isArray(identities)) continue

        for (const identity of identities) {
            const username = identity.username

            // Check if escrow exists for this identity
            const escrowAddress = GCREscrowRoutines.getEscrowAddress(platform, username)
            const escrowAccount = await repo.findOneBy({ pubkey: escrowAddress })

            if (escrowAccount?.escrows?.[escrowAddress]) {
                const escrow = escrowAccount.escrows[escrowAddress]

                claimable.push({
                    platform: platform as "twitter" | "github" | "telegram",
                    username,
                    balance: escrow.balance.toString(),
                    escrowAddress,
                    deposits: escrow.deposits.map(d => ({
                        from: d.from,
                        amount: d.amount.toString(),
                        timestamp: d.timestamp,
                        message: d.message,
                    })),
                    expiryTimestamp: escrow.expiryTimestamp,
                    expired: Date.now() > escrow.expiryTimestamp,
                })
            }
        }
    }

    return claimable
}

/**
 * RPC: Get all escrows created by a specific address (sender)
 * Useful for seeing where you've sent funds
 *
 * Request:
 * {
 *   "method": "get_sent_escrows",
 *   "params": {
 *     "sender": "0x123..."
 *   }
 * }
 */
export async function handleGetSentEscrows(params: {
    sender: string
}) {
    const { sender } = params

    if (!sender) {
        throw new Error("Missing sender address")
    }

    const db = await Datasource.getInstance()
    const repo = db.getDataSource().getRepository(GCRMain)

    // This is inefficient for large datasets - consider adding an index
    // For MVP, we'll do a full table scan
    const allAccounts = await repo.find()

    const sentEscrows = []

    for (const account of allAccounts) {
        if (!account.escrows) continue

        for (const [escrowAddr, escrow] of Object.entries(account.escrows)) {
            // Check if sender has deposited to this escrow
            const senderDeposits = escrow.deposits?.filter(d => d.from === sender) || []

            if (senderDeposits.length > 0) {
                const totalSent = senderDeposits.reduce((sum, d) => sum + d.amount, 0n)

                sentEscrows.push({
                    platform: escrow.claimableBy.platform,
                    username: escrow.claimableBy.username,
                    escrowAddress: escrowAddr,
                    totalSent: totalSent.toString(),
                    deposits: senderDeposits.map(d => ({
                        amount: d.amount.toString(),
                        timestamp: d.timestamp,
                        message: d.message,
                    })),
                    totalEscrowBalance: escrow.balance.toString(),
                    expired: Date.now() > escrow.expiryTimestamp,
                    expiryTimestamp: escrow.expiryTimestamp,
                })
            }
        }
    }

    return sentEscrows
}
```

#### 2. `src/libs/network/server_rpc.ts`

**Register new RPC endpoints**:

```typescript
// Add to RPC method routing
case "get_escrow_balance":
    return await handleGetEscrowBalance(request.params)

case "get_claimable_escrows":
    return await handleGetClaimableEscrows(request.params)

case "get_sent_escrows":
    return await handleGetSentEscrows(request.params)
```

### Acceptance Criteria

- [ ] `get_escrow_balance` returns correct escrow data
- [ ] `get_claimable_escrows` finds all escrows user can claim
- [ ] `get_sent_escrows` shows all escrows user has sent to
- [ ] Proper error handling for invalid inputs
- [ ] Performance acceptable (consider indexing for production)

### Testing

```bash
# Test via curl (assuming node is running)

# 1. Check escrow balance
curl -X POST http://localhost:8080/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "get_escrow_balance",
    "params": {
      "platform": "twitter",
      "username": "@bob"
    }
  }'

# 2. Get claimable escrows
curl -X POST http://localhost:8080/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "get_claimable_escrows",
    "params": {
      "address": "0x123..."
    }
  }'
```

---

## Phase 5: Frontend Integration & End-to-End Testing

**Time**: 2-3 hours
**Priority**: High
**Dependencies**: Phases 1-4 complete

### Goals

- Create UI components for escrow operations
- Test complete flow end-to-end
- Verify shard rotation doesn't affect escrows
- Document user flows

### Frontend Components Needed

#### 1. "Send to Social Identity" Component

```typescript
// Example React component (pseudo-code)
function SendToSocialIdentity() {
  const [platform, setPlatform] = useState("twitter")
  const [username, setUsername] = useState("")
  const [amount, setAmount] = useState("")

  async function handleSend() {
    const tx = await EscrowTransaction.sendToIdentity(
      demos,
      userPrivateKey,
      platform,
      username,
      BigInt(amount),
      { message: "Welcome to Demos!" }
    )

    await demos.submitTransaction(tx)

    alert(`✓ Sent ${amount} DEM to ${username} on ${platform}`)
  }

  return (
    <div>
      <select value={platform} onChange={e => setPlatform(e.target.value)}>
        <option value="twitter">Twitter</option>
        <option value="github">GitHub</option>
        <option value="telegram">Telegram</option>
      </select>

      <input
        placeholder="@username"
        value={username}
        onChange={e => setUsername(e.target.value)}
      />

      <input
        type="number"
        placeholder="Amount (DEM)"
        value={amount}
        onChange={e => setAmount(e.target.value)}
      />

      <button onClick={handleSend}>Send</button>
    </div>
  )
}
```

#### 2. "Claimable Escrows" Banner

```typescript
function ClaimableEscrowsBanner() {
  const [escrows, setEscrows] = useState([])

  useEffect(() => {
    async function fetchClaimable() {
      const response = await rpc({
        method: "get_claimable_escrows",
        params: { address: userAddress }
      })
      setEscrows(response)
    }
    fetchClaimable()
  }, [userAddress])

  if (escrows.length === 0) return null

  return (
    <div className="banner">
      🎉 You have {escrows.length} claimable escrow(s)!
      {escrows.map(escrow => (
        <div key={escrow.escrowAddress}>
          <p>{escrow.balance} DEM from {escrow.platform}:{escrow.username}</p>
          <button onClick={() => handleClaim(escrow)}>
            Claim {escrow.balance} DEM
          </button>
        </div>
      ))}
    </div>
  )
}

async function handleClaim(escrow) {
  const tx = await EscrowTransaction.claimEscrow(
    demos,
    userPrivateKey,
    escrow.platform,
    escrow.username
  )

  await demos.submitTransaction(tx)

  alert(`✓ Claimed ${escrow.balance} DEM!`)
}
```

### Test Scenarios

#### Test 1: Basic Flow

```typescript
/**
 * End-to-end test: Alice sends to @bob, Bob claims
 */
async function testBasicFlow() {
  console.log("=== Test 1: Basic Escrow Flow ===")

  // Setup
  const alice = createWallet()
  const bob = createWallet()

  // Give Alice some DEM
  await fundWallet(alice.address, 1000n)

  // Step 1: Alice sends 100 DEM to @bob on Twitter
  console.log("Step 1: Alice sends to @bob")
  const depositTx = await EscrowTransaction.sendToIdentity(
    demos,
    alice.privateKey,
    "twitter",
    "@bob",
    100n
  )
  await demos.submitTransaction(depositTx)

  // Verify escrow created
  const escrowBalance = await rpc({
    method: "get_escrow_balance",
    params: { platform: "twitter", username: "@bob" }
  })
  console.assert(escrowBalance.balance === "100", "Escrow should have 100 DEM")
  console.log("✓ Escrow created with 100 DEM")

  // Step 2: Bob links Twitter account
  console.log("Step 2: Bob proves ownership of @bob")
  await bob.linkTwitter("@bob")

  // Step 3: Bob claims escrow
  console.log("Step 3: Bob claims escrow")
  const claimTx = await EscrowTransaction.claimEscrow(
    demos,
    bob.privateKey,
    "twitter",
    "@bob"
  )
  await demos.submitTransaction(claimTx)

  // Verify Bob received funds
  const bobBalance = await getBalance(bob.address)
  console.assert(bobBalance >= 100n, "Bob should have at least 100 DEM")
  console.log("✓ Bob successfully claimed 100 DEM")

  // Verify escrow deleted
  const escrowAfterClaim = await rpc({
    method: "get_escrow_balance",
    params: { platform: "twitter", username: "@bob" }
  })
  console.assert(escrowAfterClaim.exists === false, "Escrow should be deleted")
  console.log("✓ Escrow deleted after claim")

  console.log("=== Test 1: PASSED ===\n")
}
```

#### Test 2: Shard Rotation

```typescript
/**
 * Test that shard rotation doesn't affect escrow state
 */
async function testShardRotation() {
  console.log("=== Test 2: Shard Rotation ===")

  const alice = createWallet()
  const bob = createWallet()
  await fundWallet(alice.address, 1000n)

  // Create escrow at block N
  console.log("Creating escrow at current block")
  const currentBlock = await getLastBlockNumber()
  const depositTx = await EscrowTransaction.sendToIdentity(
    demos,
    alice.privateKey,
    "twitter",
    "@bob",
    100n
  )
  await demos.submitTransaction(depositTx)

  // Wait for shard rotation (multiple blocks)
  console.log("Waiting for shard rotation...")
  await waitForBlocks(5)

  const newBlock = await getLastBlockNumber()
  console.log(`Advanced from block ${currentBlock} to ${newBlock}`)

  // Verify escrow still exists
  const escrowAfterRotation = await rpc({
    method: "get_escrow_balance",
    params: { platform: "twitter", username: "@bob" }
  })

  console.assert(escrowAfterRotation.exists === true, "Escrow should still exist")
  console.assert(escrowAfterRotation.balance === "100", "Balance should be unchanged")
  console.log("✓ Escrow persisted across shard rotation")

  // Bob can still claim after rotation
  await bob.linkTwitter("@bob")
  const claimTx = await EscrowTransaction.claimEscrow(
    demos,
    bob.privateKey,
    "twitter",
    "@bob"
  )
  await demos.submitTransaction(claimTx)

  const bobBalance = await getBalance(bob.address)
  console.assert(bobBalance >= 100n, "Bob should have claimed funds")
  console.log("✓ Claim successful after shard rotation")

  console.log("=== Test 2: PASSED ===\n")
}
```

#### Test 3: Expiry & Refund

```typescript
/**
 * Test escrow expiry and refund
 */
async function testExpiry() {
  console.log("=== Test 3: Escrow Expiry ===")

  const alice = createWallet()
  await fundWallet(alice.address, 1000n)

  // Create escrow with 1 second expiry (for testing)
  const depositTx = await EscrowTransaction.sendToIdentity(
    demos,
    alice.privateKey,
    "twitter",
    "@unclaimed_user",
    100n,
    { expiryDays: 0.00001 }  // ~1 second
  )
  await demos.submitTransaction(depositTx)

  // Wait for expiry
  console.log("Waiting for escrow to expire...")
  await sleep(2000)

  // Alice refunds
  console.log("Alice refunding expired escrow")
  const refundTx = await EscrowTransaction.refundExpiredEscrow(
    demos,
    alice.privateKey,
    "twitter",
    "@unclaimed_user"
  )
  await demos.submitTransaction(refundTx)

  // Verify Alice got funds back
  const aliceBalance = await getBalance(alice.address)
  console.assert(aliceBalance >= 1000n, "Alice should have funds back")
  console.log("✓ Refund successful")

  console.log("=== Test 3: PASSED ===\n")
}
```

#### Test 4: Security (Invalid Claim)

```typescript
/**
 * Test that users cannot claim escrows they don't own
 */
async function testSecurity() {
  console.log("=== Test 4: Security ===")

  const alice = createWallet()
  const bob = createWallet()
  const eve = createWallet()  // Attacker

  await fundWallet(alice.address, 1000n)

  // Alice sends to @bob
  const depositTx = await EscrowTransaction.sendToIdentity(
    demos,
    alice.privateKey,
    "twitter",
    "@bob",
    100n
  )
  await demos.submitTransaction(depositTx)

  // Eve tries to claim without proving @bob
  console.log("Eve attempting to claim @bob's escrow (should fail)")

  try {
    const evilClaimTx = await EscrowTransaction.claimEscrow(
      demos,
      eve.privateKey,
      "twitter",
      "@bob"
    )
    await demos.submitTransaction(evilClaimTx)

    console.error("✗ SECURITY BREACH: Eve claimed escrow without proof!")
    throw new Error("Security test failed")
  } catch (error) {
    if (error.message.includes("not proven ownership")) {
      console.log("✓ Claim correctly rejected: Eve has not proven @bob")
    } else {
      throw error
    }
  }

  // Verify escrow untouched
  const escrow = await rpc({
    method: "get_escrow_balance",
    params: { platform: "twitter", username: "@bob" }
  })
  console.assert(escrow.balance === "100", "Escrow should be intact")
  console.log("✓ Escrow funds safe from unauthorized claim")

  console.log("=== Test 4: PASSED ===\n")
}
```

### Running All Tests

```typescript
async function runAllTests() {
  await testBasicFlow()
  await testShardRotation()
  await testExpiry()
  await testSecurity()

  console.log("✅ All tests passed!")
}
```

### Acceptance Criteria

- [ ] All 4 test scenarios pass
- [ ] Frontend components render correctly
- [ ] Users can send to social identities via UI
- [ ] Users see claimable escrows when they link accounts
- [ ] Escrows survive shard rotation
- [ ] Security test confirms unauthorized claims are rejected

---

## Phase 6: Documentation & Deployment (Optional)

**Time**: 1-2 hours
**Priority**: Medium

### Goals

- Document API for developers
- Create user guide
- Deploy to testnet

### Deliverables

1. **API Documentation**: Document all RPC methods and transaction builders
2. **User Guide**: Step-by-step instructions for sending/claiming
3. **Developer Guide**: How to integrate escrow into dApps
4. **Testnet Deployment**: Deploy and test on live testnet

---

## Summary Checklist

### Phase 1: Database ✅
- [ ] `escrows` column added to GCR_Main
- [ ] EscrowTypes.ts created
- [ ] Migration runs successfully

### Phase 2: Core Logic ✅
- [ ] GCREscrowRoutines.ts implemented
- [ ] Deposit, claim, refund operations working
- [ ] Integration with handleGCR.ts complete

### Phase 3: Transaction Builders ✅
- [ ] EscrowTransaction.ts created
- [ ] sendToIdentity() working
- [ ] claimEscrow() working
- [ ] refundExpiredEscrow() working

### Phase 4: RPC Endpoints ✅
- [ ] get_escrow_balance implemented
- [ ] get_claimable_escrows implemented
- [ ] get_sent_escrows implemented

### Phase 5: Testing ✅
- [ ] Basic flow test passes
- [ ] Shard rotation test passes
- [ ] Expiry/refund test passes
- [ ] Security test passes

### Phase 6: Deployment (Optional) ✅
- [ ] Documentation written
- [ ] Testnet deployment complete

---

**Next Steps**: Begin with Phase 1 (Database Schema) and proceed sequentially through the phases.
