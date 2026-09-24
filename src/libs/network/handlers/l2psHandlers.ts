import { getSharedState } from "src/utilities/sharedState"
import L2PSMempool, { L2PS_STATUS } from "../../blockchain/l2ps_mempool"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"
import { resolveHistoryMessage, subnetDecryptor } from "@/libs/l2ps/historyPayload"

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
        } catch (error) {
            log.error("[L2PS] Failed to get mempool info:", error)
            const errorMsg = error instanceof Error ? error.message : String(error)
            response.result = 500
            response.response = "Failed to get L2PS mempool info"
            response.extra = errorMsg || "Internal error"
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
            // The cursor is one this node issued and the peer echoes back.
            // `since_timestamp` is still accepted from peers that predate the
            // cursor, but it is their clock, so it can only be honoured as a
            // starting point, never as a running high-water mark.
            const cursor = Math.max(0, Number(data.cursor) || Number(data.since_timestamp) || 0)
            const limit = Math.min(Math.max(1, data.limit || 500), 1000)

            // Served from the durable history table, not the aggregation
            // queue: the queue is swept minutes after confirmation, so a peer
            // that had been offline longer than that — or a client reopening
            // its history — got an empty answer for transactions that had in
            // fact executed.
            const { default: L2PSTransactionExecutor } = await import("../../l2ps/L2PSTransactionExecutor")
            const { rows, nextCursor } = await L2PSTransactionExecutor.getSubnetTransactions(
                data.l2psUid,
                limit,
                cursor,
            )

            // Rows written before the ciphertext was stored carry none, so
            // the queue still answers for them while it holds them.
            const missingPayload = rows.some(tx => !tx.encrypted_payload)
            const queued = missingPayload
                ? await L2PSMempool.getByUID(data.l2psUid, L2PS_STATUS.EXECUTED)
                : []
            const queuedByOriginalHash = new Map(queued.map(tx => [tx.original_hash, tx]))

            const transactions = rows
                .map(tx => ({
                    hash: tx.encrypted_hash || tx.hash,
                    l2ps_uid: tx.l2ps_uid,
                    original_hash: tx.hash,
                    encrypted_tx:
                        tx.encrypted_payload ??
                        queuedByOriginalHash.get(tx.hash)?.encrypted_tx ??
                        null,
                    timestamp: Number(tx.timestamp),
                    block_number: tx.l1_block_number,
                }))
                // A row from before the migration whose queue entry has been
                // swept has no ciphertext left anywhere. Sending it with a null
                // payload would only have the peer reject it as malformed; the
                // cursor still advances past it, so it cannot wedge the sync.
                .filter(tx => tx.encrypted_tx !== null)

            response.result = 200
            response.response = {
                l2psUid: data.l2psUid,
                transactions,
                /** Echo this back as `cursor` to continue; it is this node's clock. */
                nextCursor,
                /** Rows in this page with no recoverable ciphertext, skipped. */
                unrecoverable: rows.length - transactions.length,
                count: transactions.length,
                hasMore: rows.length === limit,
            }
        } catch (error) {
            log.error("[L2PS] Failed to get transactions:", error)
            const errorMsg = error instanceof Error ? error.message : String(error)
            response.result = 500
            response.response = "Failed to get L2PS transactions"
            response.extra = errorMsg || "Internal error"
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
                message: "Sign the message 'getL2PSHistory:{l2psUid}:{address}:{timestamp}' with your wallet",
                example: `getL2PSHistory:${data.l2psUid}:${data.address}:${Date.now()}`,
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
            // The subnet is part of what is signed. Without it one signature
            // would authorize a read of any subnet this node serves, so
            // anything able to relay the request could repoint it and still
            // present a signature that verifies.
            const expectedMessage = `getL2PSHistory:${data.l2psUid}:${data.address}:${data.timestamp}`

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
            const since = Math.max(0, Number(data.since) || 0)

            const { default: L2PSTransactionExecutor } = await import("../../l2ps/L2PSTransactionExecutor")
            // One past the page, so a full last page can say there is nothing
            // after it instead of inviting a request for an empty one.
            const fetched = await L2PSTransactionExecutor.getAccountTransactions(
                data.l2psUid,
                data.address,
                limit + 1,
                offset,
                since,
            )
            const hasMore = fetched.length > limit
            const transactions = hasMore ? fetched.slice(0, limit) : fetched

            // The payload is stored encrypted, so the message is decrypted
            // here — after the signature proved the caller owns the address —
            // rather than kept readable on disk.
            const decrypt = await subnetDecryptor(data.l2psUid)
            const messages = await Promise.all(
                transactions.map(tx => resolveHistoryMessage(tx, decrypt)),
            )

            response.result = 200
            response.response = {
                l2psUid: data.l2psUid,
                address: data.address,
                authenticated: true,
                transactions: transactions.map((tx, index) => ({
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
                    execution_message: messages[index],
                })),
                count: transactions.length,
                hasMore,
            }
        } catch (error) {
            log.error("[L2PS] Failed to get account transactions:", error)
            const errorMsg = error instanceof Error ? error.message : String(error)
            response.result = 500
            response.response = "Failed to get L2PS account transactions"
            response.extra = errorMsg || "Internal error"
        }
        return response
    },
}
