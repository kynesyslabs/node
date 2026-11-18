import { Repository } from "typeorm"

import {
    GCREdit,
    GCREditTLSNotary,
} from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/GCREdit"

import { GCRTLSNotary } from "@/model/entities/GCRv2/GCR_TLSNotary"
import { tlsnRequestOf, tlsnRequestRefusal } from "@/libs/tlsnotary/onchainRequests"
import log from "@/utilities/logger"

import { GCRTLSNotaryResult } from "../handleGCR"
import type {
    GCREditTlsnDerived,
    GCREditTlsnRequest,
    GCREditTlsnVerifiedStore,
} from "../tlsnTransitions"

const refused = (message: string): GCRTLSNotaryResult => ({
    success: false,
    message,
    tlsNotary: null,
})

/** A token row as a request leaves it, before any store. */
function pendingRow(base: Pick<GCRTLSNotary, "tokenId" | "owner" | "domain" | "requestHeight" | "expiresAtHeight">): GCRTLSNotary {
    const row = new GCRTLSNotary()
    row.tokenId = base.tokenId
    row.owner = base.owner
    row.domain = base.domain
    row.proof = null
    row.storageType = null
    row.txhash = base.tokenId
    row.proofTimestamp = "0"
    row.status = "pending"
    row.requestHeight = base.requestHeight
    row.expiresAtHeight = base.expiresAtHeight
    row.attestationId = null
    row.storedAtHeight = null
    return row
}

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
        rows?: ReadonlyMap<string, GCRTLSNotary | null>,
    ): Promise<GCRTLSNotaryResult> {
        if (editOperation.type !== "tlsnotary") {
            return {
                success: false,
                message: "Invalid GCREdit type",
                tlsNotary: null,
            }
        }

        const operation = (editOperation as { operation?: unknown }).operation
        if (operation === "request" || operation === "verifiedStore") {
            return this.applyDerived(editOperation as unknown as GCREditTlsnDerived, entity, rows)
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
     * A node-derived edit of `tlsnVerified` (see tlsnTransitions.ts). The
     * returned row replaces `entity` in the caches; null deletes it. `rows`
     * is the block's TLSN cache, which holds every row already carrying the
     * edit's attestation id.
     */
    private static applyDerived(
        edit: GCREditTlsnDerived,
        entity: GCRTLSNotary | null,
        rows: ReadonlyMap<string, GCRTLSNotary | null> | undefined,
    ): GCRTLSNotaryResult {
        return edit.operation === "request"
            ? this.applyRequest(edit, entity)
            : this.applyVerifiedStore(edit, entity, rows)
    }

    private static applyRequest(
        edit: GCREditTlsnRequest,
        entity: GCRTLSNotary | null,
    ): GCRTLSNotaryResult {
        const { tokenId } = edit.data
        if (edit.isRollback) {
            const request = tlsnRequestOf(entity)
            // A store on it is undone first, in reverse order; anything else
            // means the row is not the one this request wrote.
            if (!request || request.status !== "pending" || request.owner !== edit.account) {
                return refused(`TLSNotary request ${tokenId} cannot be rolled back: its row is not the pending token it wrote`)
            }
            return { success: true, message: "TLSNotary request rolled back", tlsNotary: null }
        }
        if (entity) return refused(`TLSNotary token ${tokenId} already exists`)
        return {
            success: true,
            message: "TLSNotary request token written",
            tlsNotary: pendingRow({
                tokenId,
                owner: edit.account,
                domain: edit.data.domain,
                requestHeight: edit.data.requestHeight,
                expiresAtHeight: edit.data.expiresAtHeight,
            }),
        }
    }

    private static applyVerifiedStore(
        edit: GCREditTlsnVerifiedStore,
        entity: GCRTLSNotary | null,
        rows: ReadonlyMap<string, GCRTLSNotary | null> | undefined,
    ): GCRTLSNotaryResult {
        const { tokenId } = edit.data
        const request = tlsnRequestOf(entity)
        if (edit.isRollback) {
            if (!entity || !request || request.status !== "stored" || entity.txhash !== edit.txhash) {
                return refused(`TLSNotary store ${edit.txhash} cannot be rolled back: token ${tokenId} does not hold its proof`)
            }
            return { success: true, message: "TLSNotary store rolled back", tlsNotary: pendingRow(entity) }
        }

        const refusal = tlsnRequestRefusal(request, {
            sender: edit.account,
            height: edit.data.storedAtHeight,
            domain: edit.data.serverName,
            pendingOnly: true,
        })
        if (refusal) return refused(`TLSNotary store refused for token ${tokenId}: ${refusal}`)

        const { attestationId } = edit.data
        for (const row of rows?.values() ?? []) {
            if (row && row.attestationId === attestationId) {
                return refused(`TLSNotary attestation ${attestationId} is already stored on token ${row.tokenId}`)
            }
        }

        const row = pendingRow(entity!)
        row.proof = edit.data.proof
        row.storageType = "onchain"
        row.txhash = edit.txhash
        row.proofTimestamp = String(edit.data.attestedTimeSec * 1000)
        row.status = "stored"
        row.attestationId = attestationId
        row.storedAtHeight = edit.data.storedAtHeight
        return { success: true, message: "TLSNotary proof stored", tlsNotary: row }
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
