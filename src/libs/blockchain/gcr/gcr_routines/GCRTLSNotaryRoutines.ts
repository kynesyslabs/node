import { Repository } from "typeorm"

import { GCREdit, GCREditTLSNotary } from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/GCREdit"

import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
import log from "@/utilities/logger"

import { GCRResult } from "../handleGCR"

// REVIEW: TLSNotary proof storage routines for GCR
/**
 * GCRTLSNotaryRoutines handles the storage and retrieval of TLSNotary attestation proofs.
 * Proofs are stored via the tlsn_store native operation after fee burning.
 */
export class GCRTLSNotaryRoutines {
    /**
     * Apply a TLSNotary GCR edit operation (store proof)
     * @param editOperation - The GCREditTLSNotary operation
     * @param gcrTLSNotaryRepository - TypeORM repository for GCRTLSNotary
     * @param simulate - If true, don't persist changes
     */
    static async apply(
        editOperation: GCREdit,
        gcrTLSNotaryRepository: Repository<GCRTLSNotary>,
        simulate: boolean,
    ): Promise<GCRResult> {
        if (editOperation.type !== "tlsnotary") {
            return { success: false, message: "Invalid GCREdit type" }
        }

        const tlsnEdit = editOperation as GCREditTLSNotary

        log.debug(
            `[TLSNotary] Applying GCREdit: ${tlsnEdit.operation} for token ${tlsnEdit.data.tokenId} ` +
                `(${tlsnEdit.isRollback ? "ROLLBACK" : "NORMAL"})`,
        )

        // Handle rollback: delete the stored proof
        if (tlsnEdit.isRollback) {
            if (!simulate) {
                try {
                    await gcrTLSNotaryRepository.delete({
                        tokenId: tlsnEdit.data.tokenId,
                    })
                    log.info(`[TLSNotary] Rolled back proof for token ${tlsnEdit.data.tokenId}`)
                } catch (error) {
                    log.error(`[TLSNotary] Failed to rollback proof: ${error}`)
                    return { success: false, message: "Failed to rollback TLSNotary proof" }
                }
            }
            return { success: true, message: "TLSNotary proof rolled back" }
        }

        // Handle store operation
        if (tlsnEdit.operation === "store") {
            // Check if proof already exists for this token
            const existing = await gcrTLSNotaryRepository.findOneBy({
                tokenId: tlsnEdit.data.tokenId,
            })

            if (existing) {
                log.warning(`[TLSNotary] Proof already exists for token ${tlsnEdit.data.tokenId}`)
                return { success: false, message: "Proof already stored for this token" }
            }

            // Create new proof entry
            const proofEntry = new GCRTLSNotary()
            proofEntry.tokenId = tlsnEdit.data.tokenId
            proofEntry.owner = tlsnEdit.account
            proofEntry.domain = tlsnEdit.data.domain
            proofEntry.proof = tlsnEdit.data.proof
            proofEntry.storageType = tlsnEdit.data.storageType
            proofEntry.txhash = tlsnEdit.txhash
            proofEntry.proofTimestamp = String(tlsnEdit.data.timestamp)

            if (!simulate) {
                try {
                    await gcrTLSNotaryRepository.save(proofEntry)
                    log.info(
                        `[TLSNotary] Stored proof for token ${tlsnEdit.data.tokenId}, ` +
                            `domain: ${tlsnEdit.data.domain}, type: ${tlsnEdit.data.storageType}`,
                    )
                } catch (error) {
                    log.error(`[TLSNotary] Failed to store proof: ${error}`)
                    return { success: false, message: "Failed to store TLSNotary proof" }
                }
            }

            return { success: true, message: "TLSNotary proof stored" }
        }

        return { success: false, message: `Unknown TLSNotary operation: ${tlsnEdit.operation}` }
    }

    /**
     * Get a stored proof by tokenId
     * @param tokenId - The token ID to look up
     * @param gcrTLSNotaryRepository - TypeORM repository
     */
    static async getProof(
        tokenId: string,
        gcrTLSNotaryRepository: Repository<GCRTLSNotary>,
    ): Promise<GCRTLSNotary | null> {
        return gcrTLSNotaryRepository.findOneBy({ tokenId })
    }

    /**
     * Get all proofs for an owner
     * @param owner - The account address
     * @param gcrTLSNotaryRepository - TypeORM repository
     */
    static async getProofsByOwner(
        owner: string,
        gcrTLSNotaryRepository: Repository<GCRTLSNotary>,
    ): Promise<GCRTLSNotary[]> {
        return gcrTLSNotaryRepository.findBy({ owner })
    }

    /**
     * Get all proofs for a domain
     * @param domain - The domain to look up
     * @param gcrTLSNotaryRepository - TypeORM repository
     */
    static async getProofsByDomain(
        domain: string,
        gcrTLSNotaryRepository: Repository<GCRTLSNotary>,
    ): Promise<GCRTLSNotary[]> {
        return gcrTLSNotaryRepository.findBy({ domain })
    }
}
