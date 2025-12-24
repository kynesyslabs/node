/**
 * IPFS Operation Handlers
 *
 * Implements transaction handlers for IPFS operations on the Demos Network.
 * - ipfs_add: Upload content and auto-pin
 * - ipfs_pin: Pin existing CID
 * - ipfs_unpin: Remove pin from account
 *
 * @fileoverview IPFS transaction operation handlers
 */

import {
    Operation,
    OperationResult,
    IPFSPayload,
    IPFSAddPayload,
    IPFSPinPayload,
    IPFSUnpinPayload,
    isIPFSAddPayload,
    isIPFSPinPayload,
    isIPFSUnpinPayload,
} from "@kynesyslabs/demosdk/types"
import { PinnedContent } from "@/model/entities/types/IPFSTypes"
import GCRIPFSRoutines from "../gcr/gcr_routines/GCRIPFSRoutines"
import { ensureIpfsManager, getIpfsManager } from "@/libs/network/routines/nodecalls/ipfs/ipfsManager"
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
     * 2. Decode and add content to IPFS
     * 3. Get content size
     * 4. Update account IPFS state (add pin)
     * 5. Return success with CID
     *
     * @param operation - Operation containing IPFS_ADD payload
     * @returns Operation result with CID in data
     */
    static async ipfsAdd(operation: Operation): Promise<OperationResult> {
        const from = operation.actor
        const payload = operation.params?.payload as IPFSPayload

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
            // Get IPFS manager instance
            const ipfs = getIpfsManager()
            if (!ipfs || !ipfs.isInitialized()) {
                return {
                    success: false,
                    message: "IPFS service is not available",
                }
            }

            // Decode base64 content
            let contentBuffer: Buffer
            try {
                contentBuffer = Buffer.from(addPayload.content, "base64")
            } catch (decodeError) {
                return {
                    success: false,
                    message: "Invalid base64 content encoding",
                }
            }

            // Add content to IPFS
            const cid = await ipfs.add(contentBuffer, addPayload.filename)

            // Get content size for state tracking
            const size = contentBuffer.length

            // Create pin record
            const pin: PinnedContent = {
                cid,
                size,
                timestamp: Date.now(),
                metadata: addPayload.metadata,
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

            log.debug(
                `[IPFSOperations] IPFS_ADD successful: CID=${cid}, size=${size}, from=${from}`,
            )

            return {
                success: true,
                message: "Content added and pinned successfully",
                data: { cid, size },
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
     * 2. Verify content exists on IPFS
     * 3. Get content size
     * 4. Pin content locally
     * 5. Update account IPFS state
     *
     * @param operation - Operation containing IPFS_PIN payload
     * @returns Operation result
     */
    static async ipfsPin(operation: Operation): Promise<OperationResult> {
        const from = operation.actor
        const payload = operation.params?.payload as IPFSPayload

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

            // Pin content locally
            await ipfs.pin(pinPayload.cid)

            // Calculate expiration if duration specified
            let expiresAt: number | undefined
            if (pinPayload.duration && pinPayload.duration > 0) {
                // REVIEW: Duration is in blocks for now, convert to timestamp later with block time
                // For MVP, treat duration as milliseconds from now
                expiresAt = Date.now() + pinPayload.duration
            }

            // Create pin record
            const pin: PinnedContent = {
                cid: pinPayload.cid,
                size,
                timestamp: Date.now(),
                metadata: pinPayload.metadata,
                expiresAt,
            }

            // Update account IPFS state
            const stateResult = await GCRIPFSRoutines.addPin(from, pin)
            if (!stateResult.success) {
                log.warning(
                    `[IPFSOperations] IPFS_PIN: Content pinned but state update failed: ${stateResult.message}`,
                )
            }

            log.debug(
                `[IPFSOperations] IPFS_PIN successful: CID=${pinPayload.cid}, size=${size}, from=${from}`,
            )

            return {
                success: true,
                message: "Content pinned successfully",
                data: { cid: pinPayload.cid, size },
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
}
