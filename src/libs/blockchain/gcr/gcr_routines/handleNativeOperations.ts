import { GCREdit } from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/GCREdit"

import { Transaction } from "node_modules/@kynesyslabs/demosdk/build/types/blockchain/Transaction"
import { INativePayload } from "node_modules/@kynesyslabs/demosdk/build/types/native"
import log from "src/utilities/logger"
import { createToken, extractDomain, getToken, markStored, TokenStatus } from "@/features/tlsnotary/tokenManager"

// REVIEW: TLSNotary native operation pricing (1 DEM = 1 unit, no decimals)
const TLSN_REQUEST_FEE = 1
const TLSN_STORE_BASE_FEE = 1
const TLSN_STORE_PER_KB_FEE = 1

// NOTE This class is responsible for handling native operations such as sending native tokens, etc.
export class HandleNativeOperations {
    static async handle(tx: Transaction, isRollback = false): Promise<GCREdit[]> {
        // TODO Implement this
        const edits: GCREdit[] = []
        log.debug("handleNativeOperations: " + tx.content.type)
        const nativePayloadData: ["native", INativePayload] = tx.content.data as ["native", INativePayload] // ? Is this typization correct and safe?
        const nativePayload: INativePayload = nativePayloadData[1]
        log.debug("nativePayload: " + JSON.stringify(nativePayload))
        log.debug("nativeOperation: " + nativePayload.nativeOperation)
        // Switching on the native operation type
        switch (nativePayload.nativeOperation) {
            // Balance operations for the send native method
            case "send":
                // eslint-disable-next-line no-var
                var [to, amount] = nativePayload.args
                // First, remove the amount from the sender's balance
                log.debug("to: " + to)
                log.debug("amount: " + amount)
                var subtractEdit: GCREdit = {
                    type: "balance",
                    operation: "remove",
                    isRollback: isRollback,
                    account: tx.content.from as string, // ? Check and enforce string type as tx.content.from
                    txhash: tx.hash,
                    amount: amount,
                }
                edits.push(subtractEdit)
                // Then, add the amount to the receiver's balance
                var addEdit: GCREdit = {
                    type: "balance",
                    operation: "add",
                    isRollback: isRollback,
                    account: to,
                    txhash: tx.hash,
                    amount: amount,
                }
                edits.push(addEdit)
                break
            // REVIEW: TLSNotary attestation request - burns 1 DEM fee, creates token
            case "tlsn_request":
                // eslint-disable-next-line no-var
                var [targetUrl] = nativePayload.args as [string]
                log.info(`[TLSNotary] Processing tlsn_request for ${targetUrl} from ${tx.content.from}`)

                // Validate URL format and extract domain
                try {
                    const domain = extractDomain(targetUrl)
                    log.debug(`[TLSNotary] Domain extracted: ${domain}`)
                } catch (urlError) {
                    log.error(`[TLSNotary] Invalid URL in tlsn_request: ${targetUrl}`)
                    // Return empty edits - tx will fail validation elsewhere
                    break
                }

                // Burn the fee (remove from sender, no add - effectively burns the token)
                // eslint-disable-next-line no-var
                var burnFeeEdit: GCREdit = {
                    type: "balance",
                    operation: "remove",
                    isRollback: isRollback,
                    account: tx.content.from as string,
                    txhash: tx.hash,
                    amount: TLSN_REQUEST_FEE,
                }
                edits.push(burnFeeEdit)

                // Create the attestation token (only if not a rollback)
                // Token creation is side-effect that happens during tx processing
                if (!isRollback) {
                    try {
                        const token = createToken(
                            tx.content.from as string,
                            targetUrl,
                            tx.hash,
                        )
                        log.info(`[TLSNotary] Created token ${token.id} for tx ${tx.hash}`)
                        // Token ID is stored in the transaction result/logs
                        // The SDK will extract it from the tx response
                    } catch (tokenError) {
                        log.error(`[TLSNotary] Failed to create token: ${tokenError}`)
                        // Continue - the fee was already burned, token creation failure is logged
                    }
                }
                break

            // REVIEW: TLSNotary proof storage - burns fee based on size, stores proof
            case "tlsn_store":
                // eslint-disable-next-line no-var
                var [tokenId, proof, storageType] = nativePayload.args
                log.info(`[TLSNotary] Processing tlsn_store for token ${tokenId}, storage: ${storageType}`)

                // Validate token exists and belongs to sender
                // eslint-disable-next-line no-var
                var token = getToken(tokenId)
                if (!token) {
                    log.error(`[TLSNotary] Token not found: ${tokenId}`)
                    break
                }
                if (token.owner !== tx.content.from) {
                    log.error(`[TLSNotary] Token owner mismatch: ${token.owner} !== ${tx.content.from}`)
                    break
                }
                // Token should be completed (attestation done) or active (in progress)
                if (token.status !== TokenStatus.COMPLETED && token.status !== TokenStatus.ACTIVE) {
                    log.error(`[TLSNotary] Token not ready for storage: ${token.status}`)
                    break
                }

                // Calculate storage fee: base + per KB
                // eslint-disable-next-line no-var
                var proofSizeKB = Math.ceil(proof.length / 1024)
                // eslint-disable-next-line no-var
                var storageFee = TLSN_STORE_BASE_FEE + (proofSizeKB * TLSN_STORE_PER_KB_FEE)
                log.info(`[TLSNotary] Proof size: ${proofSizeKB}KB, fee: ${storageFee} DEM`)

                // Burn the storage fee
                // eslint-disable-next-line no-var
                var burnStorageFeeEdit: GCREdit = {
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
                // eslint-disable-next-line no-var
                var storeProofEdit: GCREdit = {
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

            default: {
                // Exhaustive check - this should never be reached if all operations are handled
                const _exhaustiveCheck: never = nativePayload
                log.warning("Unknown native operation: " + (_exhaustiveCheck as INativePayload).nativeOperation)
                break
            }
        }

        return edits
    }
}

