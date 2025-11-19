import { GCREdit, GCREditEscrow } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../handleGCR"
import HandleGCR from "../handleGCR"
import Hashing from "@/libs/crypto/hashing"
import IdentityManager from "./identityManager"
import ensureGCRForUser from "./ensureGCRForUser"
import log from "@/utilities/logger"
import { EscrowData, EscrowDeposit } from "@/model/entities/types/EscrowTypes"

// Constants for escrow configuration
const DEFAULT_EXPIRY_DAYS = 30
const MS_PER_DAY = 24 * 60 * 60 * 1000

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
        editOperation: GCREditEscrow,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { sender, platform, username, amount, expiryDays, message } =
            editOperation.data

        // Input validation
        if (!sender || !platform || !username || !amount) {
            return {
                success: false,
                message: "Missing required escrow deposit fields",
            }
        }

        if (amount <= 0) {
            return { success: false, message: "Escrow amount must be positive" }
        }

        if (!["twitter", "github", "telegram"].includes(platform)) {
            return {
                success: false,
                message: `Unsupported platform: ${platform}`,
            }
        }

        // Compute deterministic escrow address
        const escrowAddress = this.getEscrowAddress(platform, username)

        log.info(
            `[EscrowDeposit] ${sender} depositing ${amount} DEM for ${platform}:${username}` +
                ` → escrow address: ${escrowAddress}`,
        )

        // Get or create escrow account
        let escrowAccount = await gcrMainRepository.findOneBy({
            pubkey: escrowAddress,
        })

        if (!escrowAccount) {
            escrowAccount = await HandleGCR.createAccount(escrowAddress)
        }

        // Initialize escrows object if needed
        escrowAccount.escrows = escrowAccount.escrows || {}

        // Create new escrow or update existing
        if (!escrowAccount.escrows[escrowAddress]) {
            // New escrow
            const expiryMs = (expiryDays || DEFAULT_EXPIRY_DAYS) * MS_PER_DAY
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
                `Total escrow balance: ${escrowAccount.escrows[escrowAddress].balance}`,
        )

        return {
            success: true,
            message: `Deposited ${amount} to escrow for ${platform}:${username}`,
            response: {
                escrowAddress,
                newBalance:
                    escrowAccount.escrows[escrowAddress].balance.toString(),
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
     * TODO: Race condition - if balance GCREdit fails after escrow deletion,
     * funds could be lost. Consider using database transaction or claimed status field.
     *
     * @param editOperation - GCREdit with type "escrow", operation "claim"
     * @param gcrMainRepository - Database repository
     * @param simulate - If true, don't persist changes
     * @returns Success/failure result with claimed amount
     */
    static async applyEscrowClaim(
        editOperation: GCREditEscrow,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
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
                ` → escrow address: ${escrowAddress}`,
        )

        // Check escrow exists
        const escrowAccount = await gcrMainRepository.findOneBy({
            pubkey: escrowAddress,
        })

        if (
            !escrowAccount ||
            !escrowAccount.escrows ||
            !escrowAccount.escrows[escrowAddress]
        ) {
            return {
                success: false,
                message: `No escrow found for ${platform}:${username}`,
            }
        }

        const escrow = escrowAccount.escrows[escrowAddress]

        // Check if already claimed (prevents race condition)
        if (escrow.claimed) {
            const claimedAt = escrow.claimedAt
                ? new Date(escrow.claimedAt).toISOString()
                : "unknown time"
            log.warning(
                `[EscrowClaim] ✗ Escrow already claimed by ${escrow.claimedBy} at ${claimedAt}`,
            )
            return {
                success: false,
                message: `Escrow already claimed by ${escrow.claimedBy}`,
            }
        }

        // CRITICAL SECURITY CHECK: Verify claimant has proven ownership of social identity
        // This uses the existing Web2 identity verification system (GCRIdentityRoutines)
        // All validators independently check this condition
        log.info(
            `[EscrowClaim] Verifying ${claimant} has proven ${platform}:${username}`,
        )

        const identities = await IdentityManager.getWeb2Identities(
            claimant,
            platform,
        )

        const hasProof = identities.some((id: any) => {
            // Case-insensitive username comparison
            return id.username.toLowerCase() === username.toLowerCase()
        })

        if (!hasProof) {
            log.warning(
                `[EscrowClaim] ✗ ${claimant} has not proven ownership of ${platform}:${username}`,
            )
            return {
                success: false,
                message:
                    `Claimant has not proven ownership of ${platform}:${username}. ` +
                    `Please link your ${platform} account first.`,
            }
        }

        log.info(
            `[EscrowClaim] ✓ Identity verified: ${claimant} owns ${platform}:${username}`,
        )

        // Check expiry
        if (Date.now() > escrow.expiryTimestamp) {
            log.warning(
                `[EscrowClaim] ✗ Escrow expired at ${new Date(
                    escrow.expiryTimestamp,
                )}`,
            )
            return {
                success: false,
                message:
                    `Escrow expired on ${new Date(
                        escrow.expiryTimestamp,
                    ).toISOString()}. ` +
                    "Original depositors can reclaim funds.",
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

        // Mark as claimed (prevents race condition - don't delete yet)
        // Funds will be transferred via separate balance GCREdit
        // If that fails, escrow remains claimed and prevents double-claim
        escrow.claimed = true
        escrow.claimedBy = claimant
        escrow.claimedAt = Date.now()
        escrow.balance = 0n // Zero out balance to prevent double-spend

        // Persist changes
        if (!simulate) {
            await gcrMainRepository.save(escrowAccount)
        }

        log.info(
            `[EscrowClaim] ✓ ${claimant} claimed ${claimedAmount} DEM from ${platform}:${username}`,
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
        editOperation: GCREditEscrow,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { refunder, platform, username } = editOperation.data

        if (!refunder || !platform || !username) {
            return { success: false, message: "Missing required refund fields" }
        }

        const escrowAddress = this.getEscrowAddress(platform, username)

        log.info(
            `[EscrowRefund] ${refunder} attempting to refund ${platform}:${username}`,
        )

        // Check escrow exists
        const escrowAccount = await gcrMainRepository.findOneBy({
            pubkey: escrowAddress,
        })

        if (!escrowAccount || !escrowAccount.escrows?.[escrowAddress]) {
            return { success: false, message: "Escrow not found" }
        }

        const escrow = escrowAccount.escrows[escrowAddress]

        // Check escrow is expired
        if (Date.now() <= escrow.expiryTimestamp) {
            return {
                success: false,
                message: `Escrow not yet expired. Expires: ${new Date(
                    escrow.expiryTimestamp,
                ).toISOString()}`,
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
        const refunderDeposits = escrow.deposits.filter(
            d => d.from === refunder,
        )
        const refundAmount = refunderDeposits.reduce(
            (sum, d) => sum + d.amount,
            0n,
        )

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
        simulate: boolean,
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
                return this.applyEscrowDeposit(
                    editOperation,
                    gcrMainRepository,
                    simulate,
                )

            case "claim":
                return this.applyEscrowClaim(
                    editOperation,
                    gcrMainRepository,
                    simulate,
                )

            case "refund":
                return this.applyEscrowRefund(
                    editOperation,
                    gcrMainRepository,
                    simulate,
                )

            default:
                return {
                    success: false,
                    message: `Unsupported escrow operation: ${operation}`,
                }
        }
    }
}
