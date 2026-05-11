import { Repository } from "typeorm"

import {
    GCREdit,
    GCREditTLSNotary,
} from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/GCREdit"

import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
import log from "@/utilities/logger"

import { GCRTLSNotaryResult } from "../handleGCR"

// REVIEW: TLSNotary proof storage routines for GCR
/**
 * GCRTLSNotaryRoutines handles the storage and retrieval of TLSNotary attestation proofs.
 * Proofs are stored via the tlsn_store native operation after fee burning.
 */
export class GCRTLSNotaryRoutines {
    /**
     * Apply a TLSNotary GCR edit operation (store proof)
     * @param editOperation - The GCREditTLSNotary operation
     * @param entity - The in-memory GCRTLSNotary entity (null if not yet stored)
     * @param simulate - If true, don't mutate the entity
     */
    static async apply(
        editOperation: GCREdit,
        entity: GCRTLSNotary | null,
        simulate: boolean,
    ): Promise<GCRTLSNotaryResult> {
        if (editOperation.type !== "tlsnotary") {
            return {
                success: false,
                message: "Invalid GCREdit type",
                tlsNotary: null,
            }
        }

        const tlsnEdit = editOperation as GCREditTLSNotary

        log.debug(
            `[TLSNotary] Applying GCREdit: ${tlsnEdit.operation} for token ${tlsnEdit.data.tokenId} ` +
                `(${tlsnEdit.isRollback ? "ROLLBACK" : "NORMAL"})`,
        )

        // Handle rollback: mark for deletion (handled by caller)
        if (tlsnEdit.isRollback) {
            entity = null
            log.info(
                `[TLSNotary] Rolled back proof for token ${tlsnEdit.data.tokenId}`,
            )
            return {
                success: true,
                message: "TLSNotary proof rolled back",
                tlsNotary: null,
            }
        }

        // Handle store operation
        if (tlsnEdit.operation === "store") {
            // Check if proof already exists for this token
            if (entity) {
                log.warning(
                    `[TLSNotary] Proof already exists for token ${tlsnEdit.data.tokenId}`,
                )
                return {
                    success: false,
                    message: "Proof already stored for this token",
                    tlsNotary: entity,
                }
            }

            // Create new proof entry in-memory
            const proofEntry = new GCRTLSNotary()
            proofEntry.tokenId = tlsnEdit.data.tokenId
            proofEntry.owner = tlsnEdit.account
            proofEntry.domain = tlsnEdit.data.domain
            proofEntry.proof = tlsnEdit.data.proof
            proofEntry.storageType = tlsnEdit.data.storageType
            proofEntry.txhash = tlsnEdit.txhash
            proofEntry.proofTimestamp = String(tlsnEdit.data.timestamp)

            if (!simulate) {
                log.info(
                    `[TLSNotary] Stored proof for token ${tlsnEdit.data.tokenId}, ` +
                        `domain: ${tlsnEdit.data.domain}, type: ${tlsnEdit.data.storageType}`,
                )
            }

            return {
                success: true,
                message: "TLSNotary proof stored",
                tlsNotary: proofEntry,
            }
        }

        return {
            success: false,
            message: `Unknown TLSNotary operation: ${tlsnEdit.operation}`,
            tlsNotary: null,
        }
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
