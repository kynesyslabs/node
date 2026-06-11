/**
 * L2PSMessagingService
 *
 * Bridge between real-time WebSocket messaging and the L2PS rollup pipeline.
 * Handles: message → L2PS transaction creation → encrypt → submit to mempool.
 * Also manages offline message storage and delivery.
 */

import { dataSource } from "@/model/datasource"
import log from "@/utilities/logger"
import Transaction from "@/libs/blockchain/transaction"
import ParallelNetworks from "@/libs/l2ps/parallelNetworks"
import L2PSMempool from "@/libs/blockchain/l2ps_mempool"
import L2PSTransactionExecutor from "@/libs/l2ps/L2PSTransactionExecutor"
import { L2PSMessage } from "./entities/L2PSMessage"
import type { SerializedEncryptedMessage, StoredMessage } from "./types"

const MAX_OFFLINE_MESSAGES_PER_SENDER = 200

export class L2PSMessagingService {
    private static instance: L2PSMessagingService
    private offlineMessageCounts = new Map<string, number>()

    static getInstance(): L2PSMessagingService {
        if (!L2PSMessagingService.instance) {
            L2PSMessagingService.instance = new L2PSMessagingService()
        }
        return L2PSMessagingService.instance
    }

    /**
     * Process and persist a message, then submit to L2PS mempool.
     * Returns the L2PS tx hash on success.
     */
    async processMessage(
        fromKey: string,
        toKey: string,
        l2psUid: string,
        messageId: string,
        messageHash: string,
        encrypted: SerializedEncryptedMessage,
        recipientOnline: boolean,
    ): Promise<{ success: boolean; l2psTxHash?: string; error?: string }> {
        const repo = dataSource.getRepository(L2PSMessage)

        // Dedup check
        const exists = await repo.findOneBy({ messageHash })
        if (exists) {
            return { success: false, error: "Duplicate message" }
        }

        const status = recipientOnline ? "delivered" : "queued"
        const now = Date.now()

        // Rate-limit offline messages
        if (!recipientOnline) {
            const count = this.offlineMessageCounts.get(fromKey) ?? 0
            if (count >= MAX_OFFLINE_MESSAGES_PER_SENDER) {
                return { success: false, error: "Offline message limit reached" }
            }
            this.offlineMessageCounts.set(fromKey, count + 1)
        }

        // Store message in local DB
        const msg = new L2PSMessage()
        msg.id = messageId
        msg.fromKey = fromKey
        msg.toKey = toKey
        msg.l2psUid = l2psUid
        msg.messageHash = messageHash
        msg.encrypted = encrypted
        msg.l2psTxHash = null
        msg.timestamp = String(now)
        msg.status = status
        try {
            await repo.save(msg)
        } catch (saveError: any) {
            // Catch duplicate-key constraint violation (TOCTOU race)
            if (saveError?.code === "23505" || saveError?.message?.includes("duplicate key")) {
                return { success: false, error: "Duplicate message" }
            }
            throw saveError
        }

        // Submit to L2PS mempool
        const l2psResult = await this.submitToL2PS(l2psUid, fromKey, toKey, messageId, messageHash, encrypted, now)

        if (!l2psResult.success) {
            // Update DB status to reflect failure
            await repo.update(msg.id, { status: "failed" as const })
            // Rollback offline quota if recipient was offline
            if (!recipientOnline) {
                const count = this.offlineMessageCounts.get(fromKey) ?? 0
                if (count > 0) this.offlineMessageCounts.set(fromKey, count - 1)
            }
            return { success: false, error: l2psResult.error }
        }

        if (l2psResult.txHash) {
            await repo.update(msg.id, {
                l2psTxHash: l2psResult.txHash,
                status: recipientOnline ? "delivered" : "queued",
            })
        }

        return { success: true, l2psTxHash: l2psResult.txHash }
    }

    /**
     * Create an L2PS transaction for the message and submit to mempool.
     */
    private async submitToL2PS(
        l2psUid: string,
        fromKey: string,
        toKey: string,
        messageId: string,
        messageHash: string,
        encrypted: SerializedEncryptedMessage,
        timestamp: number,
    ): Promise<{ success: boolean; txHash?: string; error?: string }> {
        try {
            const parallelNetworks = ParallelNetworks.getInstance()
            const l2psInstance = await parallelNetworks.getL2PS(l2psUid)
            if (!l2psInstance) {
                return { success: false, error: "L2PS network not loaded" }
            }

            // Build a transaction that wraps the IM message
            const tx = new Transaction({
                content: {
                    type: "instantMessaging",
                    from: fromKey,
                    from_ed25519_address: fromKey,
                    to: toKey,
                    amount: 0,
                    data: ["instantMessaging", {
                        messageId,
                        messageHash,
                        encrypted,
                        timestamp,
                    }] as any,
                    gcr_edits: [],
                    nonce: timestamp,
                    timestamp,
                    transaction_fee: {
                        network_fee: 0,
                        rpc_fee: 0,
                        additional_fee: 0,
                        rpc_address: "",
                    },
                },
            })

            // Hash and sign with node key
            Transaction.hash(tx)
            const [signed, signature] = await Transaction.sign(tx)
            if (!signed) {
                return { success: false, error: "Failed to sign transaction" }
            }
            tx.signature = signature
            const originalHash = tx.hash!

            // Encrypt as L2PS transaction
            const encryptedTx = await parallelNetworks.encryptTransaction(l2psUid, tx)
            if (!encryptedTx?.hash) {
                // Defensive guard against the !-assertions below — if the
                // encrypted wrapper has no hash (unexpected shape from
                // parallelNetworks), mempool writes would silently land
                // a literal `undefined` and corrupt the per-tx lookup
                // index. Bail with a clear message instead.
                return {
                    success: false,
                    error: "L2PS encryption returned a transaction without a hash",
                }
            }
            const encryptedTxHash = encryptedTx.hash

            // Submit to L2PS mempool
            const mempoolResult = await L2PSMempool.addTransaction(
                l2psUid,
                encryptedTx as any,
                originalHash,
                "processed",
            )

            if (!mempoolResult.success) {
                log.warning(`[L2PS-IM] Mempool submit failed: ${mempoolResult.error}`)
                return { success: false, error: mempoolResult.error }
            }

            // Execute (IM messages have no state changes, so execution is lightweight)
            try {
                const execResult = await L2PSTransactionExecutor.execute(
                    l2psUid, tx, encryptedTxHash, false,
                )
                if (execResult.success) {
                    await L2PSMempool.updateStatus(encryptedTxHash, "executed")
                } else {
                    await L2PSMempool.updateStatus(encryptedTxHash, "failed")
                    log.warning(`[L2PS-IM] Execution failed: ${execResult.message}`)
                }
            } catch (execError) {
                log.warning(`[L2PS-IM] Execution error: ${execError}`)
                // Non-fatal — message is still in mempool
            }

            // Record in L2PS transaction history
            try {
                await L2PSTransactionExecutor.recordTransaction(
                    l2psUid, tx, "", encryptedTxHash, 0, "pending",
                )
            } catch (recordError) {
                log.warning(`[L2PS-IM] Record error: ${recordError}`)
            }

            log.info(`[L2PS-IM] Message ${messageId.slice(0, 8)}... submitted to L2PS`)
            return { success: true, txHash: encryptedTxHash }
        } catch (error) {
            const msg = error instanceof Error ? error.message : "Unknown error"
            log.error(`[L2PS-IM] Submit error: ${msg}`)
            return { success: false, error: msg }
        }
    }

    /**
     * Get queued messages for a peer (offline delivery).
     */
    async getQueuedMessages(toKey: string, l2psUid: string): Promise<StoredMessage[]> {
        const repo = dataSource.getRepository(L2PSMessage)
        const messages = await repo.find({
            where: { toKey, l2psUid, status: "queued" },
            order: { timestamp: "ASC" },
        })
        return messages.map(m => ({
            id: m.id,
            from: m.fromKey,
            to: m.toKey,
            messageHash: m.messageHash,
            encrypted: m.encrypted,
            l2psUid: m.l2psUid,
            l2psTxHash: m.l2psTxHash,
            timestamp: Number(m.timestamp),
            status: m.status,
        }))
    }

    /**
     * Mark queued messages as sent after offline delivery.
     *
     * Releases the per-sender offline-quota slot for each transition,
     * mirroring the increment in `processMessage`. Without this
     * decrement, a sender that bursts up to `MAX_OFFLINE_MESSAGES_PER_SENDER`
     * stays at the cap forever even after every recipient comes back
     * online and drains the queue.
     */
    async markDelivered(messageIds: string[]): Promise<void> {
        if (messageIds.length === 0) return
        const repo = dataSource.getRepository(L2PSMessage)

        // Pull `fromKey` + current status BEFORE the update so the
        // decrement only fires for rows that were genuinely queued
        // (status === "queued" → "sent"). A row already past "queued"
        // (e.g. re-delivered) must not decrement again.
        const rows = await repo.find({
            where: messageIds.map(id => ({ id })),
            select: ["id", "fromKey", "status"],
        })

        await repo.update(messageIds, { status: "sent" })

        for (const row of rows) {
            if (row.status !== "queued") continue
            const count = this.offlineMessageCounts.get(row.fromKey) ?? 0
            if (count > 0) {
                this.offlineMessageCounts.set(row.fromKey, count - 1)
            }
        }
    }

    /**
     * Get conversation history between two peers.
     */
    async getHistory(
        peerA: string,
        peerB: string,
        l2psUid: string,
        before?: number,
        limit = 50,
    ): Promise<{ messages: StoredMessage[]; hasMore: boolean }> {
        const repo = dataSource.getRepository(L2PSMessage)
        const qb = repo.createQueryBuilder("m")
            .where("m.l2ps_uid = :l2psUid", { l2psUid })
            .andWhere(
                "((m.from_key = :a AND m.to_key = :b) OR (m.from_key = :b AND m.to_key = :a))",
                { a: peerA, b: peerB },
            )
            .orderBy("m.timestamp", "DESC")
            .take(limit + 1)

        if (before) {
            qb.andWhere("m.timestamp < :before", { before: String(before) })
        }

        const results = await qb.getMany()
        const hasMore = results.length > limit
        const messages = results.slice(0, limit).map(m => ({
            id: m.id,
            from: m.fromKey,
            to: m.toKey,
            messageHash: m.messageHash,
            encrypted: m.encrypted,
            l2psUid: m.l2psUid,
            l2psTxHash: m.l2psTxHash,
            timestamp: Number(m.timestamp),
            status: m.status,
        }))

        return { messages, hasMore }
    }

    /**
     * Reset offline message count for a sender after delivery.
     */
    resetOfflineCount(senderKey: string): void {
        this.offlineMessageCounts.delete(senderKey)
    }
}
