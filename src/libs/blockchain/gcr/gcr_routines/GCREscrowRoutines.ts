import { GCREdit } from "@kynesyslabs/demosdk/types"

// REVIEW: Extract escrow-specific type from GCREdit union since GCREditEscrow is not exported
type GCREditEscrow = Extract<GCREdit, { type: "escrow" }>
import { Repository } from "typeorm"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../handleGCR"
import HandleGCR from "../handleGCR"
import Hashing from "@/libs/crypto/hashing"
import IdentityManager from "./identityManager"
import ensureGCRForUser from "./ensureGCRForUser"
import log from "@/utilities/logger"
import { EscrowData, EscrowDeposit } from "@/model/entities/types/EscrowTypes"
import {
    SUPPORTED_PLATFORMS,
    SupportedPlatform,
} from "@/model/entities/types/IdentityTypes"

// Constants for escrow configuration
const DEFAULT_EXPIRY_DAYS = 30
const MIN_EXPIRY_DAYS = 1
const MAX_EXPIRY_DAYS = 365 // 1 year maximum to prevent fund locking
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_BALANCE = BigInt("1000000000000000000000") // 1 sextillion DEM maximum
const MAX_PLATFORM_LENGTH = 20
const MAX_USERNAME_LENGTH = 100
const MAX_DEPOSITS_PER_ESCROW = 1000 // Prevent DoS via unbounded deposits array
const MAX_MESSAGE_LENGTH = 500 // REVIEW: Prevent storage DoS attacks via unbounded message field
const MIN_FIRST_DEPOSIT = BigInt("1000") // REVIEW: Prevent expiry inheritance griefing attacks (1000 DEM minimum)

export default class GCREscrowRoutines {
    private static parseAmount(value?: string | number | bigint): bigint {
        if (value === undefined) {
            return 0n
        }

        if (typeof value === "bigint") {
            return value
        }

        return BigInt(value)
    }

    private static formatAmount(value: bigint): string {
        return value.toString()
    }

    /**
     * Computes deterministic escrow address from platform:username
     * This is a pure function - same input always produces same output
     *
     * @param platform - Social platform ("twitter", "github", "telegram")
     * @param username - Username on that platform (e.g., "@bob")
     * @returns Hex-encoded escrow address
     */
    static getEscrowAddress(platform: string, username: string): string {
        // Input validation to prevent hash collisions from invalid inputs
        if (!platform?.trim() || !username?.trim()) {
            throw new Error("Platform and username must be non-empty strings")
        }

        // Length validation to prevent DoS attacks via large strings
        if (platform.length > MAX_PLATFORM_LENGTH) {
            throw new Error(
                `Platform name too long (max ${MAX_PLATFORM_LENGTH} characters)`,
            )
        }
        if (username.length > MAX_USERNAME_LENGTH) {
            throw new Error(
                `Username too long (max ${MAX_USERNAME_LENGTH} characters)`,
            )
        }

        // Prevent delimiter collision attacks
        if (platform.includes(":") || username.includes(":")) {
            throw new Error(
                "Platform and username cannot contain ':' character",
            )
        }

        // Trim, normalize to lowercase and Unicode NFKC to prevent hash collision attacks
        const identity = `${platform.trim()}:${username.trim()}`.toLowerCase().normalize("NFKC")
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

        // REVIEW: Validate amount is positive and can be converted to BigInt
        try {
            const amountBigInt = BigInt(amount)
            if (amountBigInt <= 0n) {
                return {
                    success: false,
                    message: "Escrow amount must be positive",
                }
            }
        } catch (e) {
            return {
                success: false,
                message: "Invalid amount format - must be a valid integer",
            }
        }

        if (!SUPPORTED_PLATFORMS.includes(platform as SupportedPlatform)) {
            return {
                success: false,
                message: `Unsupported platform: ${platform}. Supported: ${SUPPORTED_PLATFORMS.join(", ")}`,
            }
        }

        // REVIEW: Validate message length to prevent storage DoS attacks
        if (message && message.length > MAX_MESSAGE_LENGTH) {
            return {
                success: false,
                message: `Message too long (max ${MAX_MESSAGE_LENGTH} characters)`,
            }
        }

        // Compute deterministic escrow address
        const escrowAddress = this.getEscrowAddress(platform, username)

        log.info(
            `[EscrowDeposit] ${sender} depositing ${amount} DEM for ${platform}:${username}` +
                ` → escrow address: ${escrowAddress}`,
        )

        // REVIEW: Capture timestamp once for consistency across the operation
        const currentTimestamp = Date.now()

        // REVIEW: Execute entire deposit operation in a transaction with locking
        // to prevent race conditions from concurrent deposits
        const result = await gcrMainRepository.manager.transaction(
            async transactionalEntityManager => {
                // Get sender's account with pessimistic write lock
                const senderAccount = await transactionalEntityManager.findOne(
                    GCRMain,
                    {
                        where: { pubkey: sender },
                        lock: { mode: "pessimistic_write" },
                    },
                )

                if (!senderAccount) {
                    throw new Error("Sender account not found")
                }

                if (senderAccount.balance < BigInt(amount)) {
                    throw new Error(
                        `Insufficient balance: has ${senderAccount.balance}, needs ${amount}`,
                    )
                }

                // Get or create escrow account with pessimistic write lock
                let escrowAccount = await transactionalEntityManager.findOne(
                    GCRMain,
                    {
                        where: { pubkey: escrowAddress },
                        lock: { mode: "pessimistic_write" },
                    },
                )

                if (!escrowAccount) {
                    // Create account inside transaction to prevent orphaned accounts
                    escrowAccount = await HandleGCR.createAccount(escrowAddress)
                    await transactionalEntityManager.save(escrowAccount)
                }

                // Initialize escrows object if needed
                escrowAccount.escrows = escrowAccount.escrows || {}

                // Create new escrow or update existing
                if (!escrowAccount.escrows[escrowAddress]) {
                    // New escrow - validate expiry to prevent fund locking attacks
                    const requestedExpiry = expiryDays || DEFAULT_EXPIRY_DAYS

                    if (
                        requestedExpiry < MIN_EXPIRY_DAYS ||
                        requestedExpiry > MAX_EXPIRY_DAYS
                    ) {
                        throw new Error(
                            `Expiry must be between ${MIN_EXPIRY_DAYS} and ${MAX_EXPIRY_DAYS} days`,
                        )
                    }

                    // REVIEW: Prevent expiry inheritance griefing attacks by requiring minimum first deposit
                    // Without this, attacker could deposit 1 DEM with long expiry, then victim deposits 1M DEM
                    // inheriting the long expiry, locking their funds
                    if (BigInt(amount) < MIN_FIRST_DEPOSIT) {
                        throw new Error(
                            `First deposit must be at least ${MIN_FIRST_DEPOSIT} DEM to prevent griefing attacks`,
                        )
                    }

                    const expiryMs = requestedExpiry * MS_PER_DAY
                    escrowAccount.escrows[escrowAddress] = {
                        claimableBy: {
                            platform: platform as
                                | "twitter"
                                | "github"
                                | "telegram"
                                | "discord",
                            username,
                        },
                        balance: "0",
                        deposits: [],
                        expiryTimestamp: currentTimestamp + expiryMs,
                        createdAt: currentTimestamp,
                    }
                } else {
                    // REVIEW: Existing escrow - check not expired or claimed
                    const existingEscrow = escrowAccount.escrows[escrowAddress]
                    if (currentTimestamp > existingEscrow.expiryTimestamp) {
                        throw new Error(
                            `Cannot deposit to expired escrow. Expired on ${new Date(
                                existingEscrow.expiryTimestamp,
                            ).toISOString()}`,
                        )
                    }
                    if (existingEscrow.claimed) {
                        throw new Error(
                            `Cannot deposit to claimed escrow. Claimed by ${existingEscrow.claimedBy}`,
                        )
                    }
                }

                // REVIEW: Check deposits limit to prevent DoS attacks
                if (
                    escrowAccount.escrows[escrowAddress].deposits.length >=
                    MAX_DEPOSITS_PER_ESCROW
                ) {
                    throw new Error(
                        `Escrow has reached maximum of ${MAX_DEPOSITS_PER_ESCROW} deposits. ` +
                            "Please wait for claim or expiry.",
                    )
                }

                // Add deposit
                const deposit: EscrowDeposit = {
                    from: sender,
                    amount: BigInt(amount).toString(),
                    timestamp: currentTimestamp,
                }

                if (message) {
                    deposit.message = message
                }

                // REVIEW: Calculate prospective changes without mutating state (for simulate mode)
                const amountBig = BigInt(amount)
                const previousBalance = this.parseAmount(
                    escrowAccount.escrows[escrowAddress].balance,
                )
                const newBalance = previousBalance + amountBig

                // Prevent balance overflow attacks
                if (newBalance > MAX_BALANCE) {
                    throw new Error(
                        `Escrow balance would exceed maximum limit of ${MAX_BALANCE} DEM`,
                    )
                }

                // REVIEW: Apply mutations only when persisting (not during simulation)
                if (!simulate) {
                    // Deduct from sender's balance
                    senderAccount.balance -= amountBig

                    // Credit escrow balance
                    escrowAccount.escrows[escrowAddress].balance =
                        this.formatAmount(newBalance)
                    escrowAccount.escrows[escrowAddress].deposits.push(deposit)

                    // Persist both accounts atomically in transaction
                    await transactionalEntityManager.save([
                        senderAccount,
                        escrowAccount,
                    ])
                }

                // Return result data (same regardless of simulation)
                return {
                    escrowAddress,
                    newBalance: this.formatAmount(newBalance),
                }
            },
        )

        log.info(
            `[EscrowDeposit] ✓ Deposited ${amount} DEM to ${platform}:${username}. ` +
                `Total escrow balance: ${result.newBalance}`,
        )

        return {
            success: true,
            message: `Deposited ${amount} to escrow for ${platform}:${username}`,
            response: result,
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

        // REVIEW: Capture timestamp once for consistency across the operation
        const currentTimestamp = Date.now()

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

        // REVIEW: Add null/undefined check to prevent crash
        if (!identities || !Array.isArray(identities)) {
            log.warning(
                `[EscrowClaim] ✗ No identities found for ${claimant} on ${platform}`,
            )
            return {
                success: false,
                message: `No verified identities found for ${platform}. Please link your account first.`,
            }
        }

        const hasProof = identities.some((id: any) => {
            // REVIEW: Case-insensitive username comparison with null safety
            return (
                id?.username &&
                typeof id.username === "string" &&
                id.username.toLowerCase() === username.toLowerCase()
            )
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

        // REVIEW: Execute claim in a transaction with locking to prevent double-claim race condition
        const result = await gcrMainRepository.manager.transaction(
            async transactionalEntityManager => {
                // Get escrow account with pessimistic write lock
                const escrowAccount =
                    await transactionalEntityManager.findOne(GCRMain, {
                        where: { pubkey: escrowAddress },
                        lock: { mode: "pessimistic_write" },
                    })

                if (
                    !escrowAccount ||
                    !escrowAccount.escrows ||
                    !escrowAccount.escrows[escrowAddress]
                ) {
                    throw new Error(
                        `No escrow found for ${platform}:${username}`,
                    )
                }

                const escrow = escrowAccount.escrows[escrowAddress]

                // Check if already claimed (prevents race condition - now under lock)
                if (escrow.claimed) {
                    const claimedAt = escrow.claimedAt
                        ? new Date(escrow.claimedAt).toISOString()
                        : "unknown time"
                    log.warning(
                        `[EscrowClaim] ✗ Escrow already claimed by ${escrow.claimedBy} at ${claimedAt}`,
                    )
                    throw new Error(
                        `Escrow already claimed by ${escrow.claimedBy}`,
                    )
                }

                // Check expiry using consistent timestamp
                if (currentTimestamp > escrow.expiryTimestamp) {
                    log.warning(
                        `[EscrowClaim] ✗ Escrow expired at ${new Date(
                            escrow.expiryTimestamp,
                        )}`,
                    )
                    throw new Error(
                        `Escrow expired on ${new Date(
                            escrow.expiryTimestamp,
                        ).toISOString()}. ` +
                            "Original depositors can reclaim funds.",
                    )
                }

                // Get claimed amount
                const claimedAmount = this.parseAmount(escrow.balance)

                if (claimedAmount <= 0n) {
                    throw new Error("Escrow has zero balance")
                }

                // Get claimant's account with lock
                const lockedClaimantAccount =
                    await transactionalEntityManager.findOne(GCRMain, {
                        where: { pubkey: claimant },
                        lock: { mode: "pessimistic_write" },
                    })

                if (!lockedClaimantAccount) {
                    throw new Error("Claimant account not found")
                }

                // SECURITY: Prevent flagged/banned accounts from claiming escrow funds
                // REVIEW: Check INSIDE transaction after lock to prevent TOCTOU race condition
                if (lockedClaimantAccount.flagged) {
                    throw new Error(
                        "Account is flagged and cannot claim escrow funds. Please contact support.",
                    )
                }

                // REVIEW: Prevent balance overflow on claim (same as deposit check)
                const newClaimantBalance =
                    lockedClaimantAccount.balance + claimedAmount
                if (newClaimantBalance > MAX_BALANCE) {
                    throw new Error(
                        `Claim would exceed maximum balance limit of ${MAX_BALANCE} DEM`,
                    )
                }

                // REVIEW: Only modify state if not simulating
                if (!simulate) {
                    // Transfer funds atomically
                    // Mark as claimed (prevents race condition)
                    escrow.claimed = true
                    escrow.claimedBy = claimant
                    escrow.claimedAt = currentTimestamp
                    escrow.balance = this.formatAmount(0n) // Zero out escrow balance

                    // Credit claimant's account
                    lockedClaimantAccount.balance = newClaimantBalance

                    // Persist both accounts atomically in transaction
                    await transactionalEntityManager.save([
                        escrowAccount,
                        lockedClaimantAccount,
                    ])
                }

                return {
                    amount: claimedAmount.toString(),
                    escrowAddress,
                }
            },
        )

        log.info(
            `[EscrowClaim] ✓ ${claimant} claimed ${result.amount} DEM from ${platform}:${username}`,
        )

        return {
            success: true,
            message: `Claimed ${result.amount} DEM from ${platform}:${username}`,
            response: result,
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

        // REVIEW: Capture timestamp once for consistency
        const currentTimestamp = Date.now()

        // REVIEW: Execute refund in a transaction with locking to prevent race condition
        const result = await gcrMainRepository.manager.transaction(
            async transactionalEntityManager => {
                // Get escrow account with pessimistic write lock
                const escrowAccount =
                    await transactionalEntityManager.findOne(GCRMain, {
                        where: { pubkey: escrowAddress },
                        lock: { mode: "pessimistic_write" },
                    })

                if (!escrowAccount || !escrowAccount.escrows?.[escrowAddress]) {
                    throw new Error("Escrow not found")
                }

                const escrow = escrowAccount.escrows[escrowAddress]

                // REVIEW: Check if escrow was already claimed (prevents double-spend)
                if (escrow.claimed) {
                    throw new Error(
                        `Escrow was already claimed by ${escrow.claimedBy}. Refunds are not available for claimed escrows.`,
                    )
                }

                // Check escrow is expired using consistent timestamp
                if (currentTimestamp <= escrow.expiryTimestamp) {
                    throw new Error(
                        `Escrow not yet expired. Expires: ${new Date(
                            escrow.expiryTimestamp,
                        ).toISOString()}`,
                    )
                }

                // Verify refunder is one of the original depositors
                const isDepositor = escrow.deposits.some(
                    d => d.from === refunder,
                )

                if (!isDepositor) {
                    throw new Error(
                        "Only original depositors can claim refunds",
                    )
                }

                // Calculate refunder's portion
                const refunderDeposits = escrow.deposits.filter(
                    d => d.from === refunder,
                )
                const refundAmount = refunderDeposits.reduce(
                    (sum, d) => sum + this.parseAmount(d.amount),
                    0n,
                )

                if (refundAmount <= 0n) {
                    throw new Error("No refundable amount")
                }

                // Get refunder's account with lock
                const refunderAccount =
                    await transactionalEntityManager.findOne(GCRMain, {
                        where: { pubkey: refunder },
                        lock: { mode: "pessimistic_write" },
                    })

                if (!refunderAccount) {
                    throw new Error("Refunder account not found")
                }

                // REVIEW: Only modify state if not simulating
                if (!simulate) {
                    // REVIEW: Verify balance integrity BEFORE refund to detect accounting drift
                    const actualBalance = escrow.deposits.reduce(
                        (sum, d) => sum + this.parseAmount(d.amount),
                        0n,
                    )
                    const storedBalance = this.parseAmount(escrow.balance)

                    if (actualBalance !== storedBalance) {
                        log.error(
                            "[EscrowRefund] ACCOUNTING MISMATCH: " +
                                `Stored balance ${storedBalance} != Sum of deposits ${actualBalance}. ` +
                                `Escrow: ${escrowAddress}`,
                        )
                        throw new Error(
                            "CRITICAL: Escrow accounting mismatch detected. " +
                                `Stored: ${storedBalance}, Actual: ${actualBalance}. ` +
                                "Please contact support.",
                        )
                    }

                    // Credit refund to refunder's account
                    refunderAccount.balance += refundAmount

                    // Update escrow (remove refunder's deposits)
                    escrow.deposits = escrow.deposits.filter(
                        d => d.from !== refunder,
                    )

                    // Recalculate balance from remaining deposits (ensures accuracy)
                    const refundedBalance = escrow.deposits.reduce(
                        (sum, d) => sum + this.parseAmount(d.amount),
                        0n,
                    )

                    escrow.balance = this.formatAmount(refundedBalance)

                    // If no deposits left, delete escrow
                    if (escrow.deposits.length === 0) {
                        delete escrowAccount.escrows[escrowAddress]
                    }

                    // Persist both accounts atomically in transaction
                    await transactionalEntityManager.save([
                        refunderAccount,
                        escrowAccount,
                    ])
                }

                return {
                    amount: refundAmount.toString(),
                }
            },
        )

        log.info(`[EscrowRefund] ✓ ${refunder} refunded ${result.amount} DEM`)

        return {
            success: true,
            message: `Refunded ${result.amount} DEM from expired escrow`,
            response: result,
        }
    }

    /**
     * Rollback a deposit operation (inverse: remove deposit, refund sender)
     *
     * @param editOperation - Original deposit operation to rollback
     * @param gcrMainRepository - Database repository
     * @param simulate - If true, don't persist changes
     * @returns Success/failure result
     */
    static async rollbackEscrowDeposit(
        editOperation: GCREditEscrow,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { sender, platform, username, amount } = editOperation.data

        if (!sender || !platform || !username || !amount) {
            return {
                success: false,
                message: "Missing required fields for deposit rollback",
            }
        }

        const escrowAddress = this.getEscrowAddress(platform, username)
        const currentTimestamp = Date.now()

        log.info(
            `[EscrowDepositRollback] Rolling back deposit of ${amount} DEM from ${sender} to ${platform}:${username}`,
        )

        const result = await gcrMainRepository.manager.transaction(
            async transactionalEntityManager => {
                // Get both accounts with locks
                const [senderAccount, escrowAccount] = await Promise.all([
                    transactionalEntityManager.findOne(GCRMain, {
                        where: { pubkey: sender },
                        lock: { mode: "pessimistic_write" },
                    }),
                    transactionalEntityManager.findOne(GCRMain, {
                        where: { pubkey: escrowAddress },
                        lock: { mode: "pessimistic_write" },
                    }),
                ])

                if (!senderAccount) {
                    throw new Error("Sender account not found for rollback")
                }

                if (
                    !escrowAccount ||
                    !escrowAccount.escrows?.[escrowAddress]
                ) {
                    throw new Error(
                        "Escrow account not found for deposit rollback",
                    )
                }

                const escrow = escrowAccount.escrows[escrowAddress]
                const depositAmount = BigInt(amount)

                // Find and remove the most recent deposit from this sender with matching amount
                const depositIndex = [...escrow.deposits]
                    .reverse()
                    .findIndex(
                        d =>
                            d.from === sender &&
                            this.parseAmount(d.amount) === depositAmount,
                    )

                if (depositIndex === -1) {
                    throw new Error(
                        `No matching deposit found from ${sender} with amount ${amount} to rollback`,
                    )
                }

                // Convert reverse index to actual index
                const actualIndex = escrow.deposits.length - 1 - depositIndex

                // Remove the deposit
                escrow.deposits.splice(actualIndex, 1)

                // Recalculate escrow balance from remaining deposits
                const newEscrowBalance = escrow.deposits.reduce(
                    (sum, d) => sum + this.parseAmount(d.amount),
                    0n,
                )

                escrow.balance = this.formatAmount(newEscrowBalance)

                // Refund sender
                senderAccount.balance += depositAmount

                if (!simulate) {
                    await transactionalEntityManager.save([
                        senderAccount,
                        escrowAccount,
                    ])
                }

                return {
                    rolledBack: amount,
                    newEscrowBalance: escrow.balance,
                }
            },
        )

        log.info(
            `[EscrowDepositRollback] ✓ Rolled back ${amount} DEM deposit. New escrow balance: ${result.newEscrowBalance}`,
        )

        return {
            success: true,
            message: `Rolled back deposit of ${amount} DEM`,
            response: result,
        }
    }

    /**
     * Rollback a claim operation (inverse: restore escrow balance, deduct from claimant)
     *
     * @param editOperation - Original claim operation to rollback
     * @param gcrMainRepository - Database repository
     * @param simulate - If true, don't persist changes
     * @returns Success/failure result
     */
    static async rollbackEscrowClaim(
        editOperation: GCREditEscrow,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { claimant, platform, username } = editOperation.data

        if (!claimant || !platform || !username) {
            return {
                success: false,
                message: "Missing required fields for claim rollback",
            }
        }

        const escrowAddress = this.getEscrowAddress(platform, username)

        log.info(
            `[EscrowClaimRollback] Rolling back claim by ${claimant} for ${platform}:${username}`,
        )

        const result = await gcrMainRepository.manager.transaction(
            async transactionalEntityManager => {
                // Get both accounts with locks
                const [escrowAccount, claimantAccount] = await Promise.all([
                    transactionalEntityManager.findOne(GCRMain, {
                        where: { pubkey: escrowAddress },
                        lock: { mode: "pessimistic_write" },
                    }),
                    transactionalEntityManager.findOne(GCRMain, {
                        where: { pubkey: claimant },
                        lock: { mode: "pessimistic_write" },
                    }),
                ])

                if (
                    !escrowAccount ||
                    !escrowAccount.escrows?.[escrowAddress]
                ) {
                    throw new Error("Escrow not found for claim rollback")
                }

                if (!claimantAccount) {
                    throw new Error("Claimant account not found for rollback")
                }

                const escrow = escrowAccount.escrows[escrowAddress]

                // Verify this was actually claimed by this claimant
                if (!escrow.claimed || escrow.claimedBy !== claimant) {
                    throw new Error(
                        `Escrow was not claimed by ${claimant}, cannot rollback claim`,
                    )
                }

                // Recalculate original claimed amount from deposits
                const claimedAmount = escrow.deposits.reduce(
                    (sum, d) => sum + this.parseAmount(d.amount),
                    0n,
                )

                // Verify claimant has sufficient balance to return
                if (claimantAccount.balance < claimedAmount) {
                    throw new Error(
                        "Claimant has insufficient balance to rollback claim. " +
                            `Has: ${claimantAccount.balance}, needs: ${claimedAmount}`,
                    )
                }

                // Restore escrow state
                escrow.claimed = false
                escrow.claimedBy = undefined
                escrow.claimedAt = undefined
                escrow.balance = this.formatAmount(claimedAmount)

                // Deduct from claimant
                claimantAccount.balance -= claimedAmount

                if (!simulate) {
                    await transactionalEntityManager.save([
                        escrowAccount,
                        claimantAccount,
                    ])
                }

                return {
                    amount: claimedAmount.toString(),
                    restored: true,
                }
            },
        )

        log.info(
            `[EscrowClaimRollback] ✓ Rolled back claim of ${result.amount} DEM`,
        )

        return {
            success: true,
            message: `Rolled back claim of ${result.amount} DEM from ${platform}:${username}`,
            response: result,
        }
    }

    /**
     * Rollback a refund operation (inverse: restore deposits to escrow, deduct from refunder)
     *
     * @param editOperation - Original refund operation to rollback
     * @param gcrMainRepository - Database repository
     * @param simulate - If true, don't persist changes
     * @returns Success/failure result
     */
    static async rollbackEscrowRefund(
        editOperation: GCREditEscrow,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        const { refunder, platform, username } = editOperation.data

        if (!refunder || !platform || !username) {
            return {
                success: false,
                message: "Missing required fields for refund rollback",
            }
        }

        const escrowAddress = this.getEscrowAddress(platform, username)

        log.info(
            `[EscrowRefundRollback] Rolling back refund by ${refunder} for ${platform}:${username}`,
        )

        // PROBLEM: We need the original deposits that were refunded to restore them
        // But the original refund operation removed them from the escrow
        // We need to track what was refunded to be able to rollback properly

        return {
            success: false,
            message:
                "Refund rollback not fully implemented - requires tracking removed deposits in original operation",
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

        const operation = editOperation.operation

        // REVIEW: Handle rollbacks by performing inverse operations
        if (editOperation.isRollback) {
            log.info(
                `[Escrow] Rolling back ${operation} operation for ${editOperation.data.platform}:${editOperation.data.username}`,
            )
            // Route to rollback handlers
            switch (operation) {
                case "deposit":
                    return this.rollbackEscrowDeposit(
                        editOperation,
                        gcrMainRepository,
                        simulate,
                    )

                case "claim":
                    return this.rollbackEscrowClaim(
                        editOperation,
                        gcrMainRepository,
                        simulate,
                    )

                case "refund":
                    return this.rollbackEscrowRefund(
                        editOperation,
                        gcrMainRepository,
                        simulate,
                    )

                default:
                    return {
                        success: false,
                        message: `Cannot rollback unsupported escrow operation: ${operation}`,
                    }
            }
        }

        // Route to appropriate forward handler
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
