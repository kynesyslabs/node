/**
 * IPFS Tokenomics Module
 *
 * Implements the economic model for IPFS operations on the Demos Network.
 * - Pricing calculations based on file size
 * - Genesis account detection and preferential pricing
 * - Fee distribution to hosting RPCs
 *
 * @fileoverview IPFS tokenomics and pricing calculations
 */

import Chain from "../chain"
import log from "@/utilities/logger"

// ============================================================================
// PRICING CONFIGURATION
// ============================================================================

/**
 * IPFS Pricing Configuration Constants
 *
 * REVIEW: These values are for MVP. Future enhancements may include:
 * - Dynamic pricing based on network demand
 * - Time-based renewal pricing
 * - Multi-node replication pricing
 */
export const IPFS_PRICING_CONFIG = {
    // Regular account pricing
    /** Minimum cost for any pin operation (1 DEM) */
    REGULAR_MIN_COST: 1n,
    /** Bytes per pricing unit for regular accounts (100 MB) */
    REGULAR_BYTES_PER_UNIT: 100 * 1024 * 1024,
    /** Cost per unit for regular accounts (1 DEM per 100MB) */
    REGULAR_COST_PER_UNIT: 1n,

    // Genesis account pricing
    /** Free allocation for genesis accounts (1 GB) */
    GENESIS_FREE_BYTES: 1024 * 1024 * 1024,
    /** Bytes per pricing unit for genesis accounts (1 GB) */
    GENESIS_BYTES_PER_UNIT: 1024 * 1024 * 1024,
    /** Cost per unit for genesis accounts (1 DEM per GB after free tier) */
    GENESIS_COST_PER_UNIT: 1n,

    // Fee distribution (MVP: 100% to host)
    // REVIEW: Future target is 70/20/10 (Host/Treasury/Consensus)
    /** Percentage of fee going to hosting RPC */
    HOST_SHARE_PERCENT: 100,
    /** Percentage of fee going to treasury */
    TREASURY_SHARE_PERCENT: 0,
    /** Percentage of fee going to consensus shard */
    CONSENSUS_SHARE_PERCENT: 0,
} as const

// ============================================================================
// GENESIS ACCOUNT DETECTION
// ============================================================================

/**
 * Cache for genesis addresses to avoid repeated block queries
 * Set to null initially, populated on first check
 */
let genesisAddressesCache: Set<string> | null = null

/**
 * Check if an address is a genesis account
 *
 * Genesis accounts are those that received initial balance allocation
 * in the genesis block. They receive preferential IPFS pricing.
 *
 * @param address - The account address to check
 * @returns Promise<boolean> - True if the address is a genesis account
 */
export async function isGenesisAccount(address: string): Promise<boolean> {
    // Use cached result if available
    if (genesisAddressesCache !== null) {
        return genesisAddressesCache.has(address.toLowerCase())
    }

    try {
        // Load genesis addresses from genesis block
        const genesisBlock = await Chain.getGenesisBlock()
        if (!genesisBlock) {
            log.warning("[IPFSTokenomics] Genesis block not found, treating all accounts as regular")
            genesisAddressesCache = new Set()
            return false
        }

        // Get genesis data from block content
        // Genesis data is stored as JSON string in content.extra.genesisData
        let genesisData = genesisBlock.content?.extra?.genesisData
        if (!genesisData) {
            log.warning("[IPFSTokenomics] Genesis data not found in block")
            genesisAddressesCache = new Set()
            return false
        }

        // Parse if it's a JSON string
        if (typeof genesisData === "string") {
            genesisData = JSON.parse(genesisData)
        }

        // Extract balances from genesis data
        // Genesis data has format: { balances: [[address, amount], ...], ... }
        const balances = genesisData?.balances || []

        // Build cache of genesis addresses (lowercase for case-insensitive matching)
        genesisAddressesCache = new Set(
            balances.map((entry: [string, unknown]) => entry[0].toLowerCase()),
        )

        log.debug(`[IPFSTokenomics] Loaded ${genesisAddressesCache.size} genesis addresses`)
        return genesisAddressesCache.has(address.toLowerCase())
    } catch (error) {
        log.error(`[IPFSTokenomics] Error checking genesis account: ${error}`)
        return false
    }
}

/**
 * Clear the genesis addresses cache
 * Useful for testing or when genesis block is modified
 */
export function clearGenesisCache(): void {
    genesisAddressesCache = null
}

// ============================================================================
// PRICING CALCULATIONS
// ============================================================================

/**
 * Cost calculation result with breakdown
 */
export interface PinCostResult {
    /** Total cost in DEM (as bigint) */
    totalCost: bigint
    /** Whether the free tier was used */
    usedFreeTier: boolean
    /** Bytes covered by free tier */
    freeBytes: number
    /** Bytes that were charged */
    chargeableBytes: number
    /** Whether this is a genesis account */
    isGenesis: boolean
}

/**
 * Calculate the cost to pin a file
 *
 * Pricing model:
 * - Regular accounts: 1 DEM per 100MB (minimum 1 DEM)
 * - Genesis accounts: First 1GB free, then 1 DEM per 1GB
 *
 * @param fileSizeBytes - Size of the file in bytes
 * @param isGenesis - Whether the account is a genesis account
 * @param usedFreeBytes - How many free bytes the account has already used (genesis only)
 * @param freeAllocationBytes - Total free allocation (genesis: 1GB, regular: 0)
 * @returns IPFSCostResult with cost breakdown
 */
export function calculatePinCost(
    fileSizeBytes: number,
    isGenesis: boolean,
    usedFreeBytes = 0,
    freeAllocationBytes: number = isGenesis ? IPFS_PRICING_CONFIG.GENESIS_FREE_BYTES : 0,
): PinCostResult {
    if (fileSizeBytes <= 0) {
        return {
            totalCost: 0n,
            usedFreeTier: false,
            freeBytes: 0,
            chargeableBytes: 0,
            isGenesis,
        }
    }

    if (isGenesis) {
        return calculateGenesisCost(fileSizeBytes, usedFreeBytes, freeAllocationBytes)
    }

    return calculateRegularCost(fileSizeBytes)
}

/**
 * Calculate cost for regular accounts
 *
 * Formula: max(1, ceil(fileSizeBytes / 100MB))
 *
 * @param fileSizeBytes - Size of the file in bytes
 * @returns IPFSCostResult
 */
function calculateRegularCost(fileSizeBytes: number): PinCostResult {
    const units = Math.ceil(fileSizeBytes / IPFS_PRICING_CONFIG.REGULAR_BYTES_PER_UNIT)
    const cost = BigInt(Math.max(1, units)) * IPFS_PRICING_CONFIG.REGULAR_COST_PER_UNIT

    return {
        totalCost: cost,
        usedFreeTier: false,
        freeBytes: 0,
        chargeableBytes: fileSizeBytes,
        isGenesis: false,
    }
}

/**
 * Calculate cost for genesis accounts
 *
 * Genesis accounts get 1GB free, then pay 1 DEM per 1GB
 *
 * @param fileSizeBytes - Size of the file in bytes
 * @param usedFreeBytes - How many free bytes already used
 * @param freeAllocationBytes - Total free allocation available
 * @returns IPFSCostResult
 */
function calculateGenesisCost(
    fileSizeBytes: number,
    usedFreeBytes: number,
    freeAllocationBytes: number,
): PinCostResult {
    const remainingFree = Math.max(0, freeAllocationBytes - usedFreeBytes)

    // Case 1: Entire file fits in free tier
    if (fileSizeBytes <= remainingFree) {
        return {
            totalCost: 0n,
            usedFreeTier: true,
            freeBytes: fileSizeBytes,
            chargeableBytes: 0,
            isGenesis: true,
        }
    }

    // Case 2: File partially or fully exceeds free tier
    const freeBytes = remainingFree
    const chargeableBytes = fileSizeBytes - freeBytes

    // Calculate cost: ceil(chargeableBytes / 1GB)
    const units = Math.ceil(chargeableBytes / IPFS_PRICING_CONFIG.GENESIS_BYTES_PER_UNIT)
    const cost = BigInt(units) * IPFS_PRICING_CONFIG.GENESIS_COST_PER_UNIT

    return {
        totalCost: cost,
        usedFreeTier: freeBytes > 0,
        freeBytes,
        chargeableBytes,
        isGenesis: true,
    }
}

// ============================================================================
// FEE DISTRIBUTION
// ============================================================================

/**
 * Fee distribution result
 */
export interface FeeDistribution {
    /** Amount going to hosting RPC */
    hostShare: bigint
    /** Amount going to treasury (future) */
    treasuryShare: bigint
    /** Amount going to consensus shard (future) */
    consensusShare: bigint
}

/**
 * Calculate fee distribution for an IPFS operation
 *
 * MVP: 100% goes to hosting RPC
 * Future: 70% RPC, 20% Treasury, 10% Consensus
 *
 * @param totalFee - Total fee amount in DEM
 * @returns FeeDistribution breakdown
 */
export function calculateFeeDistribution(totalFee: bigint): FeeDistribution {
    const hostShare =
        (totalFee * BigInt(IPFS_PRICING_CONFIG.HOST_SHARE_PERCENT)) / 100n
    const treasuryShare =
        (totalFee * BigInt(IPFS_PRICING_CONFIG.TREASURY_SHARE_PERCENT)) / 100n
    const consensusShare =
        (totalFee * BigInt(IPFS_PRICING_CONFIG.CONSENSUS_SHARE_PERCENT)) / 100n

    return {
        hostShare,
        treasuryShare,
        consensusShare,
    }
}

// ============================================================================
// VALIDATION HELPERS
// ============================================================================

/**
 * Validate that an account has sufficient balance for an IPFS operation
 *
 * @param accountBalance - Current account balance in DEM
 * @param requiredCost - Required cost for the operation
 * @returns boolean - True if balance is sufficient
 */
export function hasInsufficientBalance(accountBalance: bigint, requiredCost: bigint): boolean {
    return accountBalance < requiredCost
}

/**
 * Validate that the transaction amount matches the expected cost
 *
 * @param transactionAmount - Amount specified in the transaction
 * @param expectedCost - Expected cost based on file size
 * @returns boolean - True if amount is sufficient
 */
export function isTransactionAmountSufficient(
    transactionAmount: number | bigint,
    expectedCost: bigint,
): boolean {
    const amount = typeof transactionAmount === "number" ? BigInt(transactionAmount) : transactionAmount
    return amount >= expectedCost
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
    IPFS_PRICING_CONFIG,
    isGenesisAccount,
    clearGenesisCache,
    calculatePinCost,
    calculateFeeDistribution,
    hasInsufficientBalance,
    isTransactionAmountSufficient,
}
