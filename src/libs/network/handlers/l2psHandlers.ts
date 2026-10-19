import { getSharedState } from "src/utilities/sharedState"
import L2PSMempool, { L2PS_STATUS } from "../../blockchain/l2ps_mempool"
import log from "src/utilities/logger"
import { sanitizeForLog } from "src/utilities/logSafe"
import { canonicalizeKey } from "@/features/l2ps-messaging/keys"
import type { NodeCallHandler } from "./types"
import type { L2PSTransaction } from "@/model/entities/L2PSTransactions"
import { resolveHistoryEntry, subnetDecryptor } from "@/libs/l2ps/historyPayload"
import { historyAuthMessageV2, readPageValue, type HistoryPageParams } from "@/libs/l2ps/historyAuth"
import { isRefusal, parseHistoryRequest } from "@/libs/l2ps/historyRequest"

const historyAuthHint = (data: any) => ({
    messageV2:
        "Set signatureVersion to 2 and sign 'getL2PSHistory/2:{l2psUid}:{address}:{timestamp}:{host}:{limit}:{offset}:{since}'. host is the node's ed25519 address (the identity /info reports), which is always accepted, or its advertised hostname. limit, offset and since are the applied page values (defaults 100, 0, 0)",
    message: "Sign the message 'getL2PSHistory:{l2psUid}:{address}:{timestamp}' with your wallet (legacy)",
    example: `getL2PSHistory:${data.l2psUid}:${data.address}:${Date.now()}`,
})

/** `l2ps_transactions.id` is a 32-bit serial: a cursor above this is not a row id the table can compare. */
export const MAX_ROW_CURSOR = 2_147_483_647
/** The latest instant a JS Date, and so a millisecond timestamp the node issues, can name. */
export const MAX_EPOCH_MS = 8.64e15

/**
 * A number or numeric string as a whole number in [0, max]. Something that is
 * not a number at all reads as 0, like an omitted field; a number outside the
 * bound is null, because clamping it would hide that the peer's cursor is not
 * one this node issued.
 */
function boundedWhole(raw: unknown, max: number): number | null {
    const value = readPageValue(raw)
    if (value === undefined) return 0
    const whole = Math.floor(value)
    return whole < 0 || whole > max ? null : whole
}

/**
 * What an authenticated account history read answers with on success.
 *
 * `decryption` says whether this node holds a key for the subnet. When it is
 * "unavailable" every row's `content` and `execution_message` is null because
 * the node cannot read them, not because the rows failed to decrypt; the
 * ciphertext in `encrypted_payload` is still returned for the member to read.
 */
export interface L2PSAccountHistoryResponse {
    l2psUid: string
    address: string
    authenticated: true
    decryption: "available" | "unavailable"
    transactions: Array<{
        hash: string
        encrypted_hash: string | null
        l1_batch_hash: string | null
        type: string
        from: string
        to: string
        amount: string
        status: string
        timestamp: string
        l1_block_number: number | null
        execution_message: string | null
        content: Record<string, any> | null
        encrypted_payload: Record<string, any> | null
    }>
    count: number
    hasMore: boolean
}

/** Verifies an ed25519 signature given as hex, with or without a 0x prefix; any failure to decode is a failed check. */
async function signatureVerifies(message: string, signature: string, address: string): Promise<boolean> {
    const strip = (hex: string) => (hex.startsWith("0x") ? hex.slice(2) : hex)
    const Cryptography = (await import("../../crypto/cryptography")).default
    try {
        return Cryptography.verify(message, strip(signature), strip(address))
    } catch (verifyError: any) {
        log.warning(`[L2PS] Signature verification error: ${verifyError.message}`)
        return false
    }
}

/**
 * The string the caller signed. The subnet is part of it: without that one
 * signature would authorize a read of any subnet this node serves, and
 * anything able to relay the request could repoint it and still present a
 * signature that verifies. The legacy form leaves the host and the page
 * parameters unsigned and is kept only so existing clients keep working.
 */
function signedHistoryMessage(data: Record<string, any>, isV2: boolean, page: HistoryPageParams): string {
    return isV2
        ? historyAuthMessageV2(data.l2psUid, data.address, String(data.timestamp), data.host, page)
        : `getL2PSHistory:${data.l2psUid}:${data.address}:${data.timestamp}`
}

/**
 * Rows are stored under the sender's own spelling of an address, and instant
 * messages under the canonical one, so a lookup by the spelling the caller
 * happened to sign with misses the rest. The signature was already checked
 * over the raw form.
 */
function accountKeyForms(address: string): string[] {
    const canonical = canonicalizeKey(address)
    return [...new Set([address, canonical, `0x${canonical}`])]
}

function historyRow(
    tx: L2PSTransaction,
    entry: { message: string | null; content: Record<string, any> | null },
): L2PSAccountHistoryResponse["transactions"][number] {
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
        execution_message: entry.message,
        content: entry.content,
        // The stored ciphertext, as the unauthenticated subnet listing already
        // serves it. A member holding the subnet key decrypts it locally and
        // verifies the hash, instead of trusting a plaintext this node would
        // hand back.
        encrypted_payload: tx.encrypted_payload ?? null,
    }
}

export const l2psHandlers: Record<string, NodeCallHandler> = {
    getL2PSParticipationById: async (data, response) => {
        log.debug("[L2PS] Received L2PS participation query")
        if (!data.l2psUid || typeof data.l2psUid !== "string") {
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
        if (!data.l2psUid || typeof data.l2psUid !== "string") {
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
            response.result = 500
            response.response = "Failed to get L2PS mempool info"
            // The cause is in the log; the caller is not told what the
            // database or the filesystem said.
            response.extra = "Internal error"
        }
        return response
    },

    getL2PSTransactions: async (data, response) => {
        log.debug("[L2PS] Received L2PS transactions sync request")
        if (!data.l2psUid || typeof data.l2psUid !== "string") {
            response.result = 400
            response.response = "No L2PS UID specified"
            return response
        }

        try {
            // The cursor is a row id this node issued and the peer echoes back.
            // `since_timestamp` is still accepted from peers that predate the
            // cursor, but it is their clock, so it can only be honoured as a
            // starting point, never as a running high-water mark.
            // This is open to any caller, so a value the table cannot take
            // must not reach it: an error from the comparison would come back
            // as a 500. Each cursor has the bound of the column it is compared
            // with.
            const afterId = boundedWhole(data.cursor, MAX_ROW_CURSOR)
            const sinceMs = boundedWhole(data.since_timestamp, MAX_EPOCH_MS)
            if (afterId === null || sinceMs === null) {
                response.result = 400
                response.response = "cursor or since_timestamp is out of range"
                return response
            }
            const limit = Math.min(Math.max(1, Math.floor(readPageValue(data.limit) || 500)), 1000)

            // Served from the durable history table, not the aggregation
            // queue: the queue is swept minutes after confirmation, so a peer
            // that had been offline longer than that — or a client reopening
            // its history — got an empty answer for transactions that had in
            // fact executed.
            const { default: L2PSTransactionExecutor } = await import("../../l2ps/L2PSTransactionExecutor")
            const { rows, nextCursor, hasMore } = await L2PSTransactionExecutor.getSubnetTransactions(
                data.l2psUid,
                limit,
                { afterId, sinceMs },
            )

            // Rows written before the ciphertext was stored carry none, so
            // the queue still answers for them while it holds them — in any
            // status that follows execution, since batching moves them on
            // long before the sweep deletes them.
            const missingPayload = rows.some(tx => !tx.encrypted_payload)
            const queued = missingPayload
                ? await L2PSMempool.getByUID(data.l2psUid, [
                    L2PS_STATUS.EXECUTED,
                    L2PS_STATUS.BATCHED,
                    L2PS_STATUS.CONFIRMED,
                ])
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
                /** Echo this back as `cursor` to continue; it is a row id on this node. */
                nextCursor,
                /** Rows in this page with no recoverable ciphertext, skipped. */
                unrecoverable: rows.length - transactions.length,
                count: transactions.length,
                hasMore,
            }
        } catch (error) {
            log.error("[L2PS] Failed to get transactions:", error)
            response.result = 500
            response.response = "Failed to get L2PS transactions"
            // The cause is in the log; the caller is not told what the
            // database or the filesystem said.
            response.extra = "Internal error"
        }
        return response
    },

    getL2PSAccountTransactions: async (data, response) => {
        log.debug("[L2PS] Received account transactions request")
        const parsed = parseHistoryRequest(data, Date.now(), () => historyAuthHint(data))
        if (isRefusal(parsed)) {
            response.result = parsed.result
            response.response = parsed.response
            if (parsed.extra !== undefined) response.extra = parsed.extra
            return response
        }
        const { isV2, page: { limit, offset, since } } = parsed

        try {
            const expectedMessage = signedHistoryMessage(data, isV2, { limit, offset, since })
            const isValid = await signatureVerifies(expectedMessage, data.signature, data.address)

            if (!isValid) {
                response.result = 403
                response.response = "Invalid signature. Unable to verify address ownership."
                return response
            }

            log.info(`[L2PS] Authenticated request for ${sanitizeForLog(data.address, 16)}`)

            const { default: L2PSTransactionExecutor } = await import("../../l2ps/L2PSTransactionExecutor")
            // One past the page, so a full last page can say there is nothing
            // after it instead of inviting a request for an empty one.
            const fetched = await L2PSTransactionExecutor.getAccountTransactions(
                data.l2psUid,
                accountKeyForms(data.address),
                limit + 1,
                offset,
                since,
            )
            const hasMore = fetched.length > limit
            const transactions = hasMore ? fetched.slice(0, limit) : fetched

            // The payload is stored encrypted, so the message and content are
            // decrypted here — after the signature proved the caller owns the
            // address — rather than kept readable on disk. One decrypt per row
            // feeds both.
            const decrypt = await subnetDecryptor(data.l2psUid)
            const entries = await Promise.all(
                transactions.map(tx => resolveHistoryEntry(tx, decrypt)),
            )

            response.result = 200
            const body: L2PSAccountHistoryResponse = {
                l2psUid: data.l2psUid,
                address: data.address,
                authenticated: true,
                decryption: decrypt?.unavailable === true ? "unavailable" : "available",
                transactions: transactions.map((tx, index) => historyRow(tx, entries[index])),
                count: transactions.length,
                hasMore,
            }
            response.response = body
        } catch (error) {
            log.error("[L2PS] Failed to get account transactions:", error)
            response.result = 500
            response.response = "Failed to get L2PS account transactions"
            // The cause is in the log; the caller is not told what the
            // database or the filesystem said.
            response.extra = "Internal error"
        }
        return response
    },
}
