import { getSharedState } from "src/utilities/sharedState"
import L2PSMempool, { L2PS_STATUS } from "../../blockchain/l2ps_mempool"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"

export const l2psHandlers: Record<string, NodeCallHandler> = {
    getL2PSParticipationById: async (data, response) => {
        log.debug("[L2PS] Received L2PS participation query")
        if (!data.l2psUid) {
            response.result = 400
            response.response = "No L2PS UID specified"
            return response
        }
        try {
            const joinedUIDs = getSharedState.l2psJoinedUids || []
            const isParticipating = joinedUIDs.includes(data.l2psUid)

            response.result = 200
            response.response = {
                participating: isParticipating,
                l2psUid: data.l2psUid,
                nodeIdentity: getSharedState.publicKeyHex,
            }

            log.debug(`[L2PS] Participation query for ${data.l2psUid}: ${isParticipating}`)
        } catch (error) {
            log.error("[L2PS] Error checking L2PS participation:", error)
            response.result = 500
            response.response = "Internal error checking L2PS participation"
        }
        return response
    },

    getL2PSMempoolInfo: async (data, response) => {
        log.debug("[L2PS] Received L2PS mempool info request")
        if (!data.l2psUid) {
            response.result = 400
            response.response = "No L2PS UID specified"
            return response
        }

        try {
            const transactions = await L2PSMempool.getByUID(data.l2psUid, L2PS_STATUS.EXECUTED)

            response.result = 200
            response.response = {
                l2psUid: data.l2psUid,
                transactionCount: transactions.length,
                lastTimestamp: transactions.at(-1)?.timestamp ?? 0,
                oldestTimestamp: transactions.at(0)?.timestamp ?? 0,
            }
        } catch (error: any) {
            log.error("[L2PS] Failed to get mempool info:", error)
            response.result = 500
            response.response = "Failed to get L2PS mempool info"
            response.extra = error.message || "Internal error"
        }
        return response
    },

    getL2PSTransactions: async (data, response) => {
        log.debug("[L2PS] Received L2PS transactions sync request")
        if (!data.l2psUid) {
            response.result = 400
            response.response = "No L2PS UID specified"
            return response
        }

        try {
            const sinceTimestamp = data.since_timestamp || 0

            let transactions = await L2PSMempool.getByUID(data.l2psUid, L2PS_STATUS.EXECUTED)

            if (sinceTimestamp > 0) {
                transactions = transactions.filter(tx => tx.timestamp > sinceTimestamp)
            }

            response.result = 200
            response.response = {
                l2psUid: data.l2psUid,
                transactions: transactions.map(tx => ({
                    hash: tx.hash,
                    l2ps_uid: tx.l2ps_uid,
                    original_hash: tx.original_hash,
                    encrypted_tx: tx.encrypted_tx,
                    timestamp: tx.timestamp,
                    block_number: tx.block_number,
                })),
                count: transactions.length,
            }
        } catch (error: any) {
            log.error("[L2PS] Failed to get transactions:", error)
            response.result = 500
            response.response = "Failed to get L2PS transactions"
            response.extra = error.message || "Internal error"
        }
        return response
    },

    getL2PSAccountTransactions: async (data, response) => {
        log.debug("[L2PS] Received account transactions request")
        if (!data.l2psUid || !data.address) {
            response.result = 400
            response.response = "L2PS UID and address are required"
            return response
        }

        if (!data.signature || !data.timestamp) {
            response.result = 401
            response.response = "Authentication required. Provide signature and timestamp."
            response.extra = {
                message: "Sign the message 'getL2PSHistory:{address}:{timestamp}' with your wallet",
                example: `getL2PSHistory:${data.address}:${Date.now()}`
            }
            return response
        }

        const requestTime = Number.parseInt(data.timestamp, 10)
        const now = Date.now()
        if (Number.isNaN(requestTime) || now - requestTime > 5 * 60 * 1000 || requestTime > now + 60 * 1000) {
            response.result = 401
            response.response = "Request expired or invalid timestamp."
            return response
        }

        try {
            const expectedMessage = `getL2PSHistory:${data.address}:${data.timestamp}`

            const Cryptography = (await import("../../crypto/cryptography")).default

            let signature = data.signature
            let publicKey = data.address

            if (signature.startsWith("0x")) signature = signature.slice(2)
            if (publicKey.startsWith("0x")) publicKey = publicKey.slice(2)

            let isValid = false
            try {
                isValid = Cryptography.verify(expectedMessage, signature, publicKey)
            } catch (verifyError: any) {
                log.warning(`[L2PS] Signature verification error: ${verifyError.message}`)
                isValid = false
            }

            if (!isValid) {
                response.result = 403
                response.response = "Invalid signature. Unable to verify address ownership."
                return response
            }

            log.info(`[L2PS] Authenticated request for ${data.address.slice(0, 16)}...`)

            const maxLimit = 1000
            const limit = Math.min(Math.max(1, data.limit || 100), maxLimit)
            const offset = Math.max(0, data.offset || 0)

            const { default: L2PSTransactionExecutor } = await import("../../l2ps/L2PSTransactionExecutor")
            const transactions = await L2PSTransactionExecutor.getAccountTransactions(
                data.l2psUid,
                data.address,
                limit,
                offset
            )

            response.result = 200
            response.response = {
                l2psUid: data.l2psUid,
                address: data.address,
                authenticated: true,
                transactions: transactions.map(tx => {
                    let txMessage = tx.execution_message
                    if (!txMessage && tx.content?.data?.[1]?.message) {
                        txMessage = tx.content.data[1].message
                    }

                    return {
                        hash: tx.hash,
                        encrypted_hash: tx.encrypted_hash,
                        l1_batch_hash: tx.l1_batch_hash,
                        type: tx.type,
                        from: tx.from_address,
                        to: tx.to_address,
                        amount: tx.amount?.toString() || "0",
                        status: tx.status,
                        timestamp: tx.timestamp?.toString() || "0",
                        l1_block_number: tx.l1_block_number,
                        execution_message: txMessage
                    }
                }),
                count: transactions.length,
                hasMore: transactions.length === limit
            }
        } catch (error: any) {
            log.error("[L2PS] Failed to get account transactions:", error)
            response.result = 500
            response.response = "Failed to get L2PS account transactions"
            response.extra = error.message || "Internal error"
        }
        return response
    },
}
