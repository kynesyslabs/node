/**
 * IPFS Operation Handlers
 *
 * Implements transaction handlers for IPFS operations on the Demos Network.
 * - ipfs_add: Upload content and auto-pin
 * - ipfs_pin: Pin existing CID
 * - ipfs_unpin: Remove pin from account
 *
 * REVIEW: Phase 5 - IPFS Tokenomics Integration
 * - Pricing calculations based on file size
 * - Genesis account detection and preferential pricing
 * - Fee deduction and RPC credit
 *
 * @fileoverview IPFS transaction operation handlers
 */

import {
    Operation,
    OperationResult as SDKOperationResult,
    IPFSPayload,
    IPFSAddPayload,
    IPFSPinPayload,
    IPFSUnpinPayload,
    IPFSExtendPinPayload,
    isIPFSAddPayload,
    isIPFSPinPayload,
    isIPFSUnpinPayload,
    isIPFSExtendPinPayload,
} from "@kynesyslabs/demosdk/types"

/**
 * Extended OperationResult for IPFS operations
 * Adds optional data field for returning operation details
 */
interface OperationResult extends SDKOperationResult {
    data?: {
        cid?: string
        size?: number
        cost?: string
        // REVIEW: DEM-481 - Pin expiration fields
        expiresAt?: number
        duration?: number
    }
}
import {
    PinnedContent,
    checkQuota,
    QuotaTier,
    validatePinDuration,
    PinDuration,
} from "@/model/entities/types/IPFSTypes"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import Datasource from "@/model/datasource"
import GCRIPFSRoutines from "../gcr/gcr_routines/GCRIPFSRoutines"
import GCR from "../gcr/gcr"
import { getIpfsManager } from "@/libs/network/routines/nodecalls/ipfs/ipfsManager"
import {
    isGenesisAccount,
    calculatePinCost,
    calculateFeeDistribution,
    hasInsufficientBalance,
    isTransactionAmountSufficient,
} from "./ipfsTokenomics"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"

/**
 * IPFS Operation Handlers
 *
 * Static class providing handlers for IPFS transaction operations.
 * Each handler validates input, executes IPFS operations, and updates account state.
 */
export default class IPFSOperations {
    /**
     * Handle IPFS_ADD operation
     *
     * Uploads content to IPFS and automatically pins it to the sender's account.
     *
     * Flow:
     * 1. Validate payload (base64 content required)
     * 2. Decode content and calculate size
     * 3. Calculate fee and validate transaction amount
     * 4. Deduct fee from sender, credit to hosting RPC
     * 5. Add content to IPFS
     * 6. Update account IPFS state (add pin with cost tracking)
     * 7. Return success with CID
     *
     * @param operation - Operation containing IPFS_ADD payload
     * @returns Operation result with CID in data
     */
    static async ipfsAdd(operation: Operation): Promise<OperationResult> {
        const from = operation.actor
        const payload = operation.params?.payload as IPFSPayload
        const transactionAmount = operation.params?.amount ?? 0
        // REVIEW: Phase 9 - Extract custom_charges for cost control
        const customCharges = operation.params?.custom_charges?.ipfs

        // REVIEW: Validate payload structure
        if (!payload || !isIPFSAddPayload(payload)) {
            return {
                success: false,
                message: "Invalid IPFS_ADD payload: missing or invalid payload structure",
            }
        }

        const addPayload = payload as IPFSAddPayload

        // Validate content exists
        if (!addPayload.content || addPayload.content.length === 0) {
            return {
                success: false,
                message: "Invalid IPFS_ADD payload: content is required",
            }
        }

        try {
            // Decode base64 content to get size
            let contentBuffer: Buffer
            try {
                contentBuffer = Buffer.from(addPayload.content, "base64")
            } catch (decodeError) {
                return {
                    success: false,
                    message: "Invalid base64 content encoding",
                }
            }

            const size = contentBuffer.length

            // REVIEW: Calculate fee and validate payment
            const isGenesis = await isGenesisAccount(from)
            const ipfsState = await GCRIPFSRoutines.getIPFSState(from)

            // REVIEW: DEM-480 - Consensus-level quota enforcement
            // This check prevents malicious nodes from bypassing storage limits
            const tier: QuotaTier = isGenesis ? "genesis" : "regular"
            const quotaCheck = checkQuota(ipfsState, size, tier)
            if (!quotaCheck.allowed) {
                return {
                    success: false,
                    message: quotaCheck.errorMessage,
                }
            }

            const costResult = calculatePinCost(
                size,
                isGenesis,
                ipfsState.usedFreeBytes,
                ipfsState.freeAllocationBytes,
            )

            // REVIEW: Phase 9 - Use custom_charges for cost validation if present
            // custom_charges.max_cost_dem is the signed maximum user agreed to pay
            // We charge actualCost which must be <= max_cost_dem (fair pricing)
            if (customCharges?.max_cost_dem !== undefined) {
                // Parse max_cost_dem as bigint for comparison
                const maxCostDem = BigInt(
                    Math.floor(parseFloat(String(customCharges.max_cost_dem)) * 1e8),
                )
                if (costResult.totalCost > maxCostDem) {
                    return {
                        success: false,
                        message: `Actual cost ${costResult.totalCost} exceeds signed maximum ${maxCostDem} DEM`,
                    }
                }
                // Log the fair pricing in action
                log.debug(
                    `[IPFSOperations] IPFS_ADD: Using custom_charges - max=${maxCostDem}, actual=${costResult.totalCost}`,
                )
            } else {
                // Legacy validation using transactionAmount
                if (!isTransactionAmountSufficient(transactionAmount, costResult.totalCost)) {
                    return {
                        success: false,
                        message: `Insufficient payment: required ${costResult.totalCost} DEM, provided ${transactionAmount} DEM`,
                    }
                }
            }

            // REVIEW: Check sender has sufficient balance
            const senderBalance = await GCR.getGCRNativeBalance(from)
            if (hasInsufficientBalance(BigInt(senderBalance), costResult.totalCost)) {
                return {
                    success: false,
                    message: `Insufficient balance: required ${costResult.totalCost} DEM, have ${senderBalance} DEM`,
                }
            }

            // Get IPFS manager instance
            const ipfs = getIpfsManager()
            if (!ipfs || !ipfs.isInitialized()) {
                return {
                    success: false,
                    message: "IPFS service is not available",
                }
            }

            // REVIEW: DEM-481 - Validate pin duration if specified
            const duration = (addPayload as { duration?: PinDuration }).duration ?? "permanent"
            const currentTimestamp = Date.now()
            const durationResult = validatePinDuration(duration, currentTimestamp)
            if (!durationResult.valid) {
                return {
                    success: false,
                    message: durationResult.errorMessage || "Invalid pin duration",
                }
            }

            // REVIEW: DEM-481 - Apply duration pricing multiplier to cost
            // Shorter durations = lower cost (incentivizes temporary storage)
            const adjustedCost =
                (costResult.totalCost * BigInt(Math.round(durationResult.pricingMultiplier * 1000))) /
                1000n

            // REVIEW: Process fee payment (only if cost > 0)
            // Fair pricing: charge actual cost, not the signed maximum
            if (adjustedCost > 0n) {
                const feeResult = await IPFSOperations.processFeePayment(
                    from,
                    adjustedCost,
                    operation.hash,
                )
                if (!feeResult.success) {
                    return feeResult
                }
            }

            // Add content to IPFS
            const cid = await ipfs.add(contentBuffer, addPayload.filename)

            // Create pin record with tokenomics tracking and expiration
            const pin: PinnedContent = {
                cid,
                size,
                timestamp: currentTimestamp,
                metadata: addPayload.metadata,
                // REVIEW: DEM-481 - Add duration and expiration
                duration: durationResult.durationSeconds,
                expiresAt: durationResult.expiresAt,
                wasFree: costResult.usedFreeTier,
                freeBytes: costResult.freeBytes,
                costPaid: adjustedCost.toString(),
            }

            // Update account IPFS state
            const stateResult = await GCRIPFSRoutines.addPin(from, pin)
            if (!stateResult.success) {
                // REVIEW: Should we unpin from IPFS if state update fails?
                // For now, we log the issue but still return success since content is on IPFS
                log.warning(
                    `[IPFSOperations] IPFS_ADD: Content added but state update failed: ${stateResult.message}`,
                )
            }

            // REVIEW: Update free tier usage if applicable
            if (costResult.usedFreeTier && costResult.freeBytes > 0) {
                await IPFSOperations.updateFreeTierUsage(from, costResult.freeBytes)
            }

            log.debug(
                `[IPFSOperations] IPFS_ADD successful: CID=${cid}, size=${size}, cost=${adjustedCost}, expiresAt=${durationResult.expiresAt ?? "permanent"}, from=${from}`,
            )

            return {
                success: true,
                message: "Content added and pinned successfully",
                data: {
                    cid,
                    size,
                    cost: adjustedCost.toString(),
                    expiresAt: durationResult.expiresAt,
                    duration: durationResult.durationSeconds,
                },
            }
        } catch (error) {
            log.error(`[IPFSOperations] IPFS_ADD failed: ${error}`)
            return {
                success: false,
                message: error instanceof Error ? error.message : "IPFS_ADD operation failed",
            }
        }
    }

    /**
     * Handle IPFS_PIN operation
     *
     * Pins an existing CID to the sender's account.
     * Content must already exist on IPFS network.
     *
     * Flow:
     * 1. Validate payload (CID required)
     * 2. Verify content exists on IPFS and get size
     * 3. Calculate fee and validate transaction amount
     * 4. Deduct fee from sender, credit to hosting RPC
     * 5. Pin content locally
     * 6. Update account IPFS state
     *
     * @param operation - Operation containing IPFS_PIN payload
     * @returns Operation result
     */
    static async ipfsPin(operation: Operation): Promise<OperationResult> {
        const from = operation.actor
        const payload = operation.params?.payload as IPFSPayload
        const transactionAmount = operation.params?.amount ?? 0
        // REVIEW: Phase 9 - Extract custom_charges for cost control
        const customCharges = operation.params?.custom_charges?.ipfs

        // REVIEW: Validate payload structure
        if (!payload || !isIPFSPinPayload(payload)) {
            return {
                success: false,
                message: "Invalid IPFS_PIN payload: missing or invalid payload structure",
            }
        }

        const pinPayload = payload as IPFSPinPayload

        // Validate CID exists
        if (!pinPayload.cid || pinPayload.cid.length === 0) {
            return {
                success: false,
                message: "Invalid IPFS_PIN payload: CID is required",
            }
        }

        try {
            // Get IPFS manager instance
            const ipfs = getIpfsManager()
            if (!ipfs || !ipfs.isInitialized()) {
                return {
                    success: false,
                    message: "IPFS service is not available",
                }
            }

            // Check if already pinned by this account
            const alreadyPinned = await GCRIPFSRoutines.isPinned(from, pinPayload.cid)
            if (alreadyPinned) {
                return {
                    success: false,
                    message: "Content is already pinned by this account",
                }
            }

            // Get content size (this also verifies content exists on IPFS network)
            let size: number
            try {
                size = await ipfs.getSize(pinPayload.cid)
            } catch (sizeError) {
                return {
                    success: false,
                    message: `Content not found on IPFS network: ${pinPayload.cid}`,
                }
            }

            // REVIEW: Calculate fee and validate payment
            const isGenesis = await isGenesisAccount(from)
            const ipfsState = await GCRIPFSRoutines.getIPFSState(from)

            // REVIEW: DEM-480 - Consensus-level quota enforcement
            // This check prevents malicious nodes from bypassing storage limits
            const tier: QuotaTier = isGenesis ? "genesis" : "regular"
            const quotaCheck = checkQuota(ipfsState, size, tier)
            if (!quotaCheck.allowed) {
                return {
                    success: false,
                    message: quotaCheck.errorMessage,
                }
            }

            const costResult = calculatePinCost(
                size,
                isGenesis,
                ipfsState.usedFreeBytes,
                ipfsState.freeAllocationBytes,
            )

            // REVIEW: Phase 9 - Use custom_charges for cost validation if present
            // custom_charges.max_cost_dem is the signed maximum user agreed to pay
            // We charge actualCost which must be <= max_cost_dem (fair pricing)
            if (customCharges?.max_cost_dem !== undefined) {
                // Parse max_cost_dem as bigint for comparison
                const maxCostDem = BigInt(
                    Math.floor(parseFloat(String(customCharges.max_cost_dem)) * 1e8),
                )
                if (costResult.totalCost > maxCostDem) {
                    return {
                        success: false,
                        message: `Actual cost ${costResult.totalCost} exceeds signed maximum ${maxCostDem} DEM`,
                    }
                }
                // Log the fair pricing in action
                log.debug(
                    `[IPFSOperations] IPFS_PIN: Using custom_charges - max=${maxCostDem}, actual=${costResult.totalCost}`,
                )
            } else {
                // Legacy validation using transactionAmount
                if (!isTransactionAmountSufficient(transactionAmount, costResult.totalCost)) {
                    return {
                        success: false,
                        message: `Insufficient payment: required ${costResult.totalCost} DEM, provided ${transactionAmount} DEM`,
                    }
                }
            }

            // REVIEW: Check sender has sufficient balance
            const senderBalance = await GCR.getGCRNativeBalance(from)
            if (hasInsufficientBalance(BigInt(senderBalance), costResult.totalCost)) {
                return {
                    success: false,
                    message: `Insufficient balance: required ${costResult.totalCost} DEM, have ${senderBalance} DEM`,
                }
            }

            // REVIEW: DEM-481 - Validate pin duration if specified
            const duration = (pinPayload.duration as PinDuration) ?? "permanent"
            const currentTimestamp = Date.now()
            const durationResult = validatePinDuration(duration, currentTimestamp)
            if (!durationResult.valid) {
                return {
                    success: false,
                    message: durationResult.errorMessage || "Invalid pin duration",
                }
            }

            // REVIEW: DEM-481 - Apply duration pricing multiplier to cost
            // Shorter durations = lower cost (incentivizes temporary storage)
            const adjustedCost =
                (costResult.totalCost * BigInt(Math.round(durationResult.pricingMultiplier * 1000))) /
                1000n

            // REVIEW: Process fee payment (only if cost > 0)
            // Fair pricing: charge actual cost, not the signed maximum
            if (adjustedCost > 0n) {
                const feeResult = await IPFSOperations.processFeePayment(
                    from,
                    adjustedCost,
                    operation.hash,
                )
                if (!feeResult.success) {
                    return feeResult
                }
            }

            // Pin content locally
            await ipfs.pin(pinPayload.cid)

            // Create pin record with tokenomics tracking and expiration
            const pin: PinnedContent = {
                cid: pinPayload.cid,
                size,
                timestamp: currentTimestamp,
                metadata: pinPayload.metadata,
                // REVIEW: DEM-481 - Add duration and expiration
                duration: durationResult.durationSeconds,
                expiresAt: durationResult.expiresAt,
                wasFree: costResult.usedFreeTier,
                freeBytes: costResult.freeBytes,
                costPaid: adjustedCost.toString(),
            }

            // Update account IPFS state
            const stateResult = await GCRIPFSRoutines.addPin(from, pin)
            if (!stateResult.success) {
                log.warning(
                    `[IPFSOperations] IPFS_PIN: Content pinned but state update failed: ${stateResult.message}`,
                )
            }

            // REVIEW: Update free tier usage if applicable
            if (costResult.usedFreeTier && costResult.freeBytes > 0) {
                await IPFSOperations.updateFreeTierUsage(from, costResult.freeBytes)
            }

            log.debug(
                `[IPFSOperations] IPFS_PIN successful: CID=${pinPayload.cid}, size=${size}, cost=${adjustedCost}, expiresAt=${durationResult.expiresAt ?? "permanent"}, from=${from}`,
            )

            return {
                success: true,
                message: "Content pinned successfully",
                data: {
                    cid: pinPayload.cid,
                    size,
                    cost: adjustedCost.toString(),
                    expiresAt: durationResult.expiresAt,
                    duration: durationResult.durationSeconds,
                },
            }
        } catch (error) {
            log.error(`[IPFSOperations] IPFS_PIN failed: ${error}`)
            return {
                success: false,
                message: error instanceof Error ? error.message : "IPFS_PIN operation failed",
            }
        }
    }

    /**
     * Handle IPFS_UNPIN operation
     *
     * Removes a pin from the sender's account.
     * Content may still exist on IPFS but sender no longer pays for hosting.
     * NOTE: No refund is issued on unpin (payment is final per spec)
     *
     * Flow:
     * 1. Validate payload (CID required)
     * 2. Verify pin exists in account state
     * 3. Remove pin from account state
     * 4. Unpin from local IPFS node
     *
     * @param operation - Operation containing IPFS_UNPIN payload
     * @returns Operation result
     */
    static async ipfsUnpin(operation: Operation): Promise<OperationResult> {
        const from = operation.actor
        const payload = operation.params?.payload as IPFSPayload

        // REVIEW: Validate payload structure
        if (!payload || !isIPFSUnpinPayload(payload)) {
            return {
                success: false,
                message: "Invalid IPFS_UNPIN payload: missing or invalid payload structure",
            }
        }

        const unpinPayload = payload as IPFSUnpinPayload

        // Validate CID exists
        if (!unpinPayload.cid || unpinPayload.cid.length === 0) {
            return {
                success: false,
                message: "Invalid IPFS_UNPIN payload: CID is required",
            }
        }

        try {
            // Check if pin exists in account state
            const isPinned = await GCRIPFSRoutines.isPinned(from, unpinPayload.cid)
            if (!isPinned) {
                return {
                    success: false,
                    message: "Content is not pinned by this account",
                }
            }

            // Remove from account state first
            const stateResult = await GCRIPFSRoutines.removePin(from, unpinPayload.cid)
            if (!stateResult.success) {
                return {
                    success: false,
                    message: `Failed to remove pin from account state: ${stateResult.message}`,
                }
            }

            // Get IPFS manager instance and unpin
            const ipfs = getIpfsManager()
            if (ipfs && ipfs.isInitialized()) {
                try {
                    await ipfs.unpin(unpinPayload.cid)
                } catch (unpinError) {
                    // Log but don't fail - state is already updated
                    // IPFS may still hold the content due to other pins
                    log.warning(
                        `[IPFSOperations] IPFS_UNPIN: State updated but IPFS unpin failed: ${unpinError}`,
                    )
                }
            }

            log.debug(
                `[IPFSOperations] IPFS_UNPIN successful: CID=${unpinPayload.cid}, from=${from}`,
            )

            return {
                success: true,
                message: "Content unpinned successfully",
                data: { cid: unpinPayload.cid },
            }
        } catch (error) {
            log.error(`[IPFSOperations] IPFS_UNPIN failed: ${error}`)
            return {
                success: false,
                message: error instanceof Error ? error.message : "IPFS_UNPIN operation failed",
            }
        }
    }

    // REVIEW: DEM-481 - Pin expiration extension
    /**
     * Handle IPFS_EXTEND_PIN operation
     *
     * Extends the expiration time of an existing pin.
     * User pays additional cost based on the extension duration and content size.
     *
     * Flow:
     * 1. Validate payload (CID and additionalDuration required)
     * 2. Verify pin exists in account state
     * 3. Validate and calculate extension duration
     * 4. Calculate extension cost (size * duration pricing)
     * 5. Process payment
     * 6. Update pin with new expiration
     *
     * @param operation - Operation containing IPFS_EXTEND_PIN payload
     * @returns Operation result with new expiration time
     */
    static async ipfsExtendPin(operation: Operation): Promise<OperationResult> {
        const from = operation.actor
        const payload = operation.params?.payload as IPFSPayload
        const transactionAmount = operation.params?.amount ?? 0
        const customCharges = operation.params?.custom_charges?.ipfs

        // Validate payload structure
        if (!payload || !isIPFSExtendPinPayload(payload)) {
            return {
                success: false,
                message: "Invalid IPFS_EXTEND_PIN payload: missing or invalid payload structure",
            }
        }

        const extendPayload = payload as IPFSExtendPinPayload

        // Validate CID exists
        if (!extendPayload.cid || extendPayload.cid.length === 0) {
            return {
                success: false,
                message: "Invalid IPFS_EXTEND_PIN payload: CID is required",
            }
        }

        // Validate additionalDuration exists
        if (extendPayload.additionalDuration === undefined) {
            return {
                success: false,
                message: "Invalid IPFS_EXTEND_PIN payload: additionalDuration is required",
            }
        }

        try {
            // Get account's IPFS state and find the pin
            const ipfsState = await GCRIPFSRoutines.getIPFSState(from)
            const existingPin = ipfsState.pins.find((p) => p.cid === extendPayload.cid)

            if (!existingPin) {
                return {
                    success: false,
                    message: "Content is not pinned by this account",
                }
            }

            // Validate the extension duration
            const currentTimestamp = Date.now()
            const durationResult = validatePinDuration(
                extendPayload.additionalDuration as PinDuration,
                currentTimestamp,
            )
            if (!durationResult.valid) {
                return {
                    success: false,
                    message: durationResult.errorMessage || "Invalid extension duration",
                }
            }

            // Calculate the new expiration time
            let newExpiresAt: number | undefined
            if (extendPayload.additionalDuration === "permanent") {
                // Converting to permanent - no expiration
                newExpiresAt = undefined
            } else if (existingPin.expiresAt) {
                // Extend from current expiration (or now if already expired)
                const baseTime = Math.max(existingPin.expiresAt, currentTimestamp)
                newExpiresAt = baseTime + durationResult.durationSeconds * 1000
            } else {
                // Pin was permanent, now adding expiration (shouldn't normally happen)
                newExpiresAt = currentTimestamp + durationResult.durationSeconds * 1000
            }

            // Calculate extension cost based on content size and duration
            const isGenesis = await isGenesisAccount(from)
            const costResult = calculatePinCost(
                existingPin.size,
                isGenesis,
                0, // No free tier for extensions
                0,
            )

            // Apply duration pricing multiplier
            const adjustedCost =
                (costResult.totalCost * BigInt(Math.round(durationResult.pricingMultiplier * 1000))) /
                1000n

            // Validate payment
            if (customCharges?.max_cost_dem !== undefined) {
                const maxCostDem = BigInt(
                    Math.floor(parseFloat(String(customCharges.max_cost_dem)) * 1e8),
                )
                if (adjustedCost > maxCostDem) {
                    return {
                        success: false,
                        message: `Actual cost ${adjustedCost} exceeds signed maximum ${maxCostDem} DEM`,
                    }
                }
            } else {
                if (!isTransactionAmountSufficient(transactionAmount, adjustedCost)) {
                    return {
                        success: false,
                        message: `Insufficient payment: required ${adjustedCost} DEM, provided ${transactionAmount} DEM`,
                    }
                }
            }

            // Check balance
            const senderBalance = await GCR.getGCRNativeBalance(from)
            if (hasInsufficientBalance(BigInt(senderBalance), adjustedCost)) {
                return {
                    success: false,
                    message: `Insufficient balance: required ${adjustedCost} DEM, have ${senderBalance} DEM`,
                }
            }

            // Process payment
            if (adjustedCost > 0n) {
                const feeResult = await IPFSOperations.processFeePayment(
                    from,
                    adjustedCost,
                    operation.hash,
                )
                if (!feeResult.success) {
                    return feeResult
                }
            }

            // Update the pin with new expiration
            const updatedPin: PinnedContent = {
                ...existingPin,
                expiresAt: newExpiresAt,
                duration: newExpiresAt ? durationResult.durationSeconds : 0,
            }

            // Update the account state
            const updateResult = await GCRIPFSRoutines.updatePin(from, extendPayload.cid, updatedPin)
            if (!updateResult.success) {
                log.warning(
                    `[IPFSOperations] IPFS_EXTEND_PIN: Payment processed but state update failed: ${updateResult.message}`,
                )
            }

            log.debug(
                `[IPFSOperations] IPFS_EXTEND_PIN successful: CID=${extendPayload.cid}, newExpiresAt=${newExpiresAt ?? "permanent"}, cost=${adjustedCost}, from=${from}`,
            )

            return {
                success: true,
                message: "Pin expiration extended successfully",
                data: {
                    cid: extendPayload.cid,
                    cost: adjustedCost.toString(),
                    expiresAt: newExpiresAt,
                    duration: durationResult.durationSeconds,
                },
            }
        } catch (error) {
            log.error(`[IPFSOperations] IPFS_EXTEND_PIN failed: ${error}`)
            return {
                success: false,
                message: error instanceof Error ? error.message : "IPFS_EXTEND_PIN operation failed",
            }
        }
    }

    /**
     * Process fee payment for IPFS operations
     *
     * Deducts fee from sender and credits hosting RPC (100% to host in MVP)
     *
     * @param from - Sender address
     * @param amount - Fee amount in DEM
     * @param txHash - Transaction hash for tracking
     * @returns Operation result
     */
    private static async processFeePayment(
        from: string,
        amount: bigint,
        txHash: string,
    ): Promise<OperationResult> {
        try {
            // Get current balances
            const senderBalance = await GCR.getGCRNativeBalance(from)

            // Calculate fee distribution (MVP: 100% to host)
            const feeDistribution = calculateFeeDistribution(amount)

            // Deduct from sender
            const newSenderBalance = senderBalance - Number(amount)
            await GCR.setGCRNativeBalance(from, newSenderBalance, txHash)

            // Credit hosting RPC (this node)
            // REVIEW: In MVP, 100% goes to the hosting RPC
            if (feeDistribution.hostShare > 0n) {
                const hostAddress = getSharedState.publicKeyHex
                if (hostAddress) {
                    const hostBalance = await GCR.getGCRNativeBalance(hostAddress)
                    const newHostBalance = hostBalance + Number(feeDistribution.hostShare)
                    await GCR.setGCRNativeBalance(hostAddress, newHostBalance, txHash)

                    log.debug(
                        `[IPFSOperations] Fee credited to RPC: ${feeDistribution.hostShare} DEM to ${hostAddress}`,
                    )
                }
            }

            // REVIEW: Update paidCosts in account IPFS state
            await GCRIPFSRoutines.updateCosts(from, amount)

            return {
                success: true,
                message: "Fee payment processed",
            }
        } catch (error) {
            log.error(`[IPFSOperations] Fee payment failed: ${error}`)
            return {
                success: false,
                message: error instanceof Error ? error.message : "Fee payment failed",
            }
        }
    }

    /**
     * Update free tier usage for an account
     *
     * @param pubkey - Account address
     * @param bytesUsed - Bytes to add to free tier usage
     */
    private static async updateFreeTierUsage(
        pubkey: string,
        bytesUsed: number,
    ): Promise<void> {
        try {
            const db = await Datasource.getInstance()
            const repo = db.getDataSource().getRepository(GCRMain)

            const account = await repo.findOneBy({ pubkey })
            if (!account || !account.ipfs) {
                return
            }

            account.ipfs.usedFreeBytes = (account.ipfs.usedFreeBytes ?? 0) + bytesUsed
            account.ipfs.lastUpdated = Date.now()
            await repo.save(account)

            log.debug(
                `[IPFSOperations] Updated free tier usage for ${pubkey}: +${bytesUsed} bytes`,
            )
        } catch (error) {
            log.warning(`[IPFSOperations] Failed to update free tier usage: ${error}`)
        }
    }
}
