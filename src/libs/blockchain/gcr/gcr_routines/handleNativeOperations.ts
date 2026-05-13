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
import { isForkActive } from "@/forks"
import { generateSpecialOpsFeeEdits } from "./feeDistribution"
import { getSharedState } from "@/utilities/sharedState"

// DEM-665: TLSNotary native-operation pricing.
//
// Pre-fork (legacy): each fee is "1" — single DEM unit. The legacy
// path treats this as a single-remove burn (no recipient).
//
// Post-fork: each fee is 1 DEM = 10^9 OS = 1_000_000_000. The
// fee-distribution rule routes it as 25/50/25 burn/rpc/treasury via
// generateSpecialOpsFeeEdits.
//
// The constants below are the pre-fork legacy values. Post-fork we
// scale them by ONE_DEM at call time so re-syncing pre-fork blocks
// stays bit-identical.
const ONE_DEM = 1_000_000_000
const TLSN_REQUEST_FEE = 1
const TLSN_STORE_BASE_FEE = 1
const TLSN_STORE_PER_KB_FEE = 1

/**
 * DEM-665 — returns the per-tx TLSN fee constants scaled to the active
 * denomination at `blockHeight`. Pre-fork: legacy DEM-1 units;
 * post-fork: OS = legacy × 10^9. Centralised so the magnitude switch
 * is documented once.
 */
function getTlsnFees(blockHeight: number): {
    request: number
    storeBase: number
    storePerKb: number
} {
    const mult = isForkActive("gasFeeSeparation", blockHeight) ? ONE_DEM : 1
    return {
        request: TLSN_REQUEST_FEE * mult,
        storeBase: TLSN_STORE_BASE_FEE * mult,
        storePerKb: TLSN_STORE_PER_KB_FEE * mult,
    }
}

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

                // DEM-665: fork-gated fee handling.
                //  - Pre-fork: legacy single-remove burn (no recipient,
                //    fees vanish from the supply).
                //  - Post-fork: split 25/50/25 burn/rpc/treasury via
                //    generateSpecialOpsFeeEdits, scaled to OS via ONE_DEM.
                const blockHeight =
                    tx.blockNumber ?? getSharedState.lastBlockNumber ?? 0
                const fees = getTlsnFees(blockHeight)
                if (isForkActive("gasFeeSeparation", blockHeight)) {
                    const rpcAddress =
                        tx.content.transaction_fee?.rpc_address ?? null
                    const specialOpsEdits = generateSpecialOpsFeeEdits(
                        tx.content.from as string,
                        rpcAddress,
                        fees.request,
                        tx.hash,
                        isRollback,
                    )
                    // PR #817 Greptile P1 (silent fee bypass): mirror the
                    // applyGasFeeSeparation guard. generateSpecialOpsFeeEdits
                    // returns [] when requireFeeDistribution() is null —
                    // either feeDistribution was never primed, or every
                    // percentage is 0. With fees.request > 0 the tx must
                    // not silently proceed with zero edits; refuse it.
                    if (fees.request > 0 && specialOpsEdits.length === 0) {
                        throw new Error(
                            "fee distribution not primed — refusing tlsn_request " +
                                `(requestFee=${fees.request}, but generateSpecialOpsFeeEdits returned 0 edits)`,
                        )
                    }
                    edits.push(...(specialOpsEdits as GCREdit[]))
                } else {
                    const burnFeeEdit: GCREdit = {
                        type: "balance",
                        operation: "remove",
                        isRollback: isRollback,
                        account: tx.content.from as string,
                        txhash: tx.hash,
                        amount: fees.request,
                    }
                    edits.push(burnFeeEdit)
                }

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
                const storeBlockHeight =
                    tx.blockNumber ?? getSharedState.lastBlockNumber ?? 0
                const storeFees = getTlsnFees(storeBlockHeight)
                const storageFee =
                    storeFees.storeBase + proofSizeKB * storeFees.storePerKb
                log.info(
                    `[TLSNotary] Proof size: ${proofSizeKB}KB, fee: ${storageFee} (denom-scaled)`,
                )

                // DEM-665: fork-gated storage fee handling — same
                // contract as tlsn_request above.
                if (isForkActive("gasFeeSeparation", storeBlockHeight)) {
                    const rpcAddress =
                        tx.content.transaction_fee?.rpc_address ?? null
                    const specialOpsEdits = generateSpecialOpsFeeEdits(
                        tx.content.from as string,
                        rpcAddress,
                        storageFee,
                        tx.hash,
                        isRollback,
                    )
                    // PR #817 Greptile P1 (silent fee bypass) — see
                    // matching guard above on the tlsn_request branch.
                    if (storageFee > 0 && specialOpsEdits.length === 0) {
                        throw new Error(
                            "fee distribution not primed — refusing tlsn_store " +
                                `(storageFee=${storageFee}, but generateSpecialOpsFeeEdits returned 0 edits)`,
                        )
                    }
                    edits.push(...(specialOpsEdits as GCREdit[]))
                } else {
                    const burnStorageFeeEdit: GCREdit = {
                        type: "balance",
                        operation: "remove",
                        isRollback: isRollback,
                        account: tx.content.from as string,
                        txhash: tx.hash,
                        amount: storageFee,
                    }
                    edits.push(burnStorageFeeEdit)
                }

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
