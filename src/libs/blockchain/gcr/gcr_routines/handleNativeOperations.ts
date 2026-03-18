import { GCREdit } from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/GCREdit"

import { Transaction } from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/Transaction"
import { INativePayload } from "node_modules/@kynesyslabs/demosdk/build/types/native"
import log from "src/utilities/logger"
import {
    extractDomain,
    getToken,
    markStored,
    TokenStatus,
} from "@/features/tlsnotary/tokenManager"

// REVIEW: TLSNotary native operation pricing (1 DEM = 1 unit, no decimals)
const TLSN_REQUEST_FEE = 1
const TLSN_STORE_BASE_FEE = 1
const TLSN_STORE_PER_KB_FEE = 1

// NOTE This class is responsible for handling native operations such as sending native tokens, etc.
export class HandleNativeOperations {
    static async handle(
        tx: Transaction,
        isRollback = false,
    ): Promise<GCREdit[]> {
        // TODO Implement this
        const edits: GCREdit[] = []
        log.debug("handleNativeOperations: " + tx.content.type)
        const nativePayloadData: ["native", INativePayload] = tx.content
            .data as ["native", INativePayload] // ? Is this typization correct and safe?
        const nativePayload: INativePayload = nativePayloadData[1]
        log.debug("nativePayload: " + JSON.stringify(nativePayload))
        log.debug("nativeOperation: " + nativePayload.nativeOperation)
        // Switching on the native operation type
        switch (nativePayload.nativeOperation) {
            // Balance operations for the send native method
            case "send": {
                const [to, amount] = nativePayload.args
                // First, remove the amount from the sender's balance
                log.debug("to: " + to)
                log.debug("amount: " + amount)
                const subtractEdit: GCREdit = {
                    type: "balance",
                    operation: "remove",
                    isRollback: isRollback,
                    account: tx.content.from as string, // ? Check and enforce string type as tx.content.from
                    txhash: tx.hash,
                    amount: amount,
                }
                edits.push(subtractEdit)
                // Then, add the amount to the receiver's balance
                const addEdit: GCREdit = {
                    type: "balance",
                    operation: "add",
                    isRollback: isRollback,
                    account: to,
                    txhash: tx.hash,
                    amount: amount,
                }
                edits.push(addEdit)
                break
            }
            // REVIEW: TLSNotary attestation request - burns 1 DEM fee, creates token
            case "tlsn_request": {
                const [targetUrl] = nativePayload.args as [string]
                log.info(
                    `[TLSNotary] Processing tlsn_request for ${targetUrl} from ${tx.content.from}`,
                )

                // Validate URL format
                try {
                    extractDomain(targetUrl) // Validates URL format
                    log.debug(`[TLSNotary] URL validated: ${targetUrl}`)
                } catch {
                    log.error(
                        `[TLSNotary] Invalid URL in tlsn_request: ${targetUrl}`,
                    )
                    throw new Error("Invalid URL in tlsn_request")
                }

                // Burn the fee (remove from sender, no add - effectively burns the token)
                const burnFeeEdit: GCREdit = {
                    type: "balance",
                    operation: "remove",
                    isRollback: isRollback,
                    account: tx.content.from as string,
                    txhash: tx.hash,
                    amount: TLSN_REQUEST_FEE,
                }
                edits.push(burnFeeEdit)

                // Token creation is handled as a native side-effect during mempool simulation
                // in `HandleGCR.processNativeSideEffects()` to avoid duplicate tokens.
                break
            }

            // REVIEW: TLSNotary proof storage - burns fee based on size, stores proof
            case "tlsn_store": {
                const [tokenId, proof, storageType] = nativePayload.args
                log.info(
                    `[TLSNotary] Processing tlsn_store for token ${tokenId}, storage: ${storageType}`,
                )

                // Validate token exists and belongs to sender
                const token = getToken(tokenId)
                if (!token) {
                    log.error(`[TLSNotary] Token not found: ${tokenId}`)
                    throw new Error("Token not found")
                }
                if (token.owner !== tx.content.from) {
                    log.error(
                        `[TLSNotary] Token owner mismatch: ${token.owner} !== ${tx.content.from}`,
                    )
                    throw new Error("Token owner mismatch")
                }
                // Token should be completed (attestation done) or active (in progress)
                if (
                    token.status !== TokenStatus.COMPLETED &&
                    token.status !== TokenStatus.ACTIVE
                ) {
                    log.error(
                        `[TLSNotary] Token not ready for storage: ${token.status}`,
                    )
                    throw new Error("Token not ready for storage")
                }

                // Calculate storage fee: base + per KB (use byte length, not string length)
                const proofBytes =
                    typeof proof === "string"
                        ? Buffer.byteLength(proof, "utf8")
                        : (proof as Uint8Array).byteLength

                const proofSizeKB = Math.ceil(proofBytes / 1024)
                const storageFee =
                    TLSN_STORE_BASE_FEE + proofSizeKB * TLSN_STORE_PER_KB_FEE
                log.info(
                    `[TLSNotary] Proof size: ${proofSizeKB}KB, fee: ${storageFee} DEM`,
                )

                // Burn the storage fee
                const burnStorageFeeEdit: GCREdit = {
                    type: "balance",
                    operation: "remove",
                    isRollback: isRollback,
                    account: tx.content.from as string,
                    txhash: tx.hash,
                    amount: storageFee,
                }
                edits.push(burnStorageFeeEdit)

                // Store the proof (on-chain via GCR)
                // For IPFS: in future, proof will be IPFS hash, actual data stored externally
                const storeProofEdit: GCREdit = {
                    type: "tlsnotary",
                    operation: "store",
                    account: tx.content.from as string,
                    data: {
                        tokenId: tokenId,
                        domain: token.domain,
                        proof: proof,
                        storageType: storageType,
                        timestamp: Date.now(),
                    },
                    txhash: tx.hash,
                    isRollback: isRollback,
                }
                edits.push(storeProofEdit)

                // Mark token as stored (only if not a rollback)
                if (!isRollback) {
                    markStored(tokenId)
                    log.info(`[TLSNotary] Token ${tokenId} marked as stored`)
                }
                break
            }

            default: {
                // Log unknown operations - INativePayload may have more operations than handled here
                // Cast needed because TypeScript narrows to never after exhaustive switch
                log.warning(
                    "Unknown native operation: " +
                        (nativePayload as INativePayload).nativeOperation,
                )
                break
            }
        }

        return edits
    }
}
