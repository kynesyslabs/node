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
import { canonicalizeKey } from "./keys"
import type { MessageStatus, SerializedEncryptedMessage, StoredMessage } from "./types"

const MAX_OFFLINE_MESSAGES_PER_SENDER = 200

export interface ProcessMessageResult {
    success: boolean
    /** Row id of the accepted message (a retry reuses the failed row's id). */
    messageId?: string
    l2psTxHash?: string
    error?: string
    /** The sender already sent this message to this recipient; nothing was redone. */
    duplicate?: boolean
    /** Stored status of the original message, set when `duplicate` is true. */
    status?: MessageStatus
}

type MessageRepo = ReturnType<typeof dataSource.getRepository<L2PSMessage>>

export class L2PSMessagingService {
    private static instance: L2PSMessagingService
    private offlineMessageCounts = new Map<string, number>()
    /** Attempts still waiting for their L2PS outcome, by message identity. */
    private inFlight = new Map<string, Promise<ProcessMessageResult>>()

    static getInstance(): L2PSMessagingService {
        if (!L2PSMessagingService.instance) {
            L2PSMessagingService.instance = new L2PSMessagingService()
        }
        return L2PSMessagingService.instance
    }

    /**
     * Process and persist a message, then submit to L2PS mempool.
     * Returns the L2PS tx hash on success.
     *
     * Implementation split into discrete steps (dedup → quota →
     * persist → submit → update) to keep cognitive complexity bounded.
     *
     * A message is identified by subnet, sender, recipient and messageHash.
     * Clients reuse one hash when they fan a message out to several
     * recipients, and resend it when an acknowledgement is lost: the resend
     * gets the original outcome back, and a failed attempt can be retried.
     */
    async processMessage(
        fromKey: string,
        toKey: string,
        l2psUid: string,
        messageId: string,
        messageHash: string,
        encrypted: SerializedEncryptedMessage,
        recipientOnline: boolean,
    ): Promise<ProcessMessageResult> {
        const identity = { l2psUid, fromKey, toKey, messageHash }
        const key = [l2psUid, canonicalizeKey(fromKey), canonicalizeKey(toKey), messageHash].join("|")

        // A resend that arrives while the first attempt is still being
        // submitted gets that attempt's outcome, whatever it turns out to be,
        // rather than an acknowledgement for something that may yet fail.
        const pending = this.inFlight.get(key)
        if (pending) {
            const outcome = await pending
            return outcome.success ? { ...outcome, duplicate: true } : outcome
        }

        const attempt = this.attempt(identity, messageId, encrypted, recipientOnline)
        this.inFlight.set(key, attempt)
        try {
            return await attempt
        } finally {
            this.inFlight.delete(key)
        }
    }

    private async attempt(
        identity: { l2psUid: string; fromKey: string; toKey: string; messageHash: string },
        messageId: string,
        encrypted: SerializedEncryptedMessage,
        recipientOnline: boolean,
    ): Promise<ProcessMessageResult> {
        const { l2psUid, fromKey, toKey, messageHash } = identity
        const repo = dataSource.getRepository(L2PSMessage)

        const existing = await this.findExisting(repo, identity)
        if (existing && existing.status !== "failed") {
            return this.duplicateResult(existing)
        }

        const quotaError = this.reserveOfflineQuota(fromKey, recipientOnline)
        if (quotaError) return { success: false, error: quotaError }

        const now = Date.now()
        const status = recipientOnline ? "delivered" : "queued"
        const writeError = existing
            ? await this.claimFailed(repo, existing.id, { encrypted, now, status })
            : await this.persistMessage(
                repo,
                { messageId, fromKey, toKey, l2psUid, messageHash, encrypted, now, recipientOnline },
            )
        const id = existing?.id ?? messageId
        if (writeError) {
            this.releaseOfflineQuota(fromKey, recipientOnline)
            // A concurrent send of the same message got there first.
            const winner = await this.findExisting(repo, identity)
            if (winner && winner.status !== "failed") {
                return this.duplicateResult(winner)
            }
            return { success: false, error: writeError }
        }

        const l2psResult = await this.submitToL2PS(l2psUid, fromKey, toKey, id, messageHash, encrypted, now)

        if (!l2psResult.success) {
            await this.handleSubmissionFailure(repo, id, fromKey, recipientOnline)
            return { success: false, error: l2psResult.error }
        }

        if (l2psResult.txHash) {
            await repo.update(id, {
                l2psTxHash: l2psResult.txHash,
                status: recipientOnline ? "delivered" : "queued",
            })
        }

        return { success: true, l2psTxHash: l2psResult.txHash, messageId: id }
    }

    /**
     * Take a failed row back for a retry. Conditional on it still being
     * failed, so two concurrent retries cannot both resubmit it.
     */
    private async claimFailed(
        repo: MessageRepo,
        id: string,
        retry: { encrypted: SerializedEncryptedMessage; now: number; status: MessageStatus },
    ): Promise<string | null> {
        const result = await repo.update(
            { id, status: "failed" },
            { encrypted: retry.encrypted, timestamp: String(retry.now), status: retry.status, l2psTxHash: null },
        )
        return result.affected ? null : "Duplicate message"
    }

    /**
     * The recipient's socket dropped the frame: keep the message for offline
     * delivery and count it against the sender's offline quota, which
     * `markDelivered` releases.
     */
    async requeue(messageId: string, fromKey: string): Promise<void> {
        const repo = dataSource.getRepository(L2PSMessage)
        await repo.update({ id: messageId, status: "delivered" }, { status: "queued" })
        this.offlineMessageCounts.set(fromKey, (this.offlineMessageCounts.get(fromKey) ?? 0) + 1)
    }

    private findExisting(
        repo: MessageRepo,
        identity: { l2psUid: string; fromKey: string; toKey: string; messageHash: string },
    ): Promise<L2PSMessage | null> {
        return repo.findOneBy({
            l2psUid: identity.l2psUid,
            fromKey: canonicalizeKey(identity.fromKey),
            toKey: canonicalizeKey(identity.toKey),
            messageHash: identity.messageHash,
        })
    }

    private duplicateResult(existing: L2PSMessage): ProcessMessageResult {
        return {
            success: true,
            duplicate: true,
            messageId: existing.id,
            l2psTxHash: existing.l2psTxHash ?? undefined,
            status: existing.status,
        }
    }

    private releaseOfflineQuota(fromKey: string, recipientOnline: boolean): void {
        if (recipientOnline) return
        const count = this.offlineMessageCounts.get(fromKey) ?? 0
        if (count > 0) this.offlineMessageCounts.set(fromKey, count - 1)
    }

    /**
     * Reserve a per-sender offline-quota slot. Returns an error string
     * when the cap has been reached; null otherwise. The increment
     * here is rolled back by `handleSubmissionFailure` on L2PS submit
     * failure and decremented by `markDelivered` on queued-delivery.
     */
    private reserveOfflineQuota(
        fromKey: string,
        recipientOnline: boolean,
    ): string | null {
        if (recipientOnline) return null
        const count = this.offlineMessageCounts.get(fromKey) ?? 0
        if (count >= MAX_OFFLINE_MESSAGES_PER_SENDER) {
            return "Offline message limit reached"
        }
        this.offlineMessageCounts.set(fromKey, count + 1)
        return null
    }

    private async persistMessage(
        repo: MessageRepo,
        opts: {
            messageId: string
            fromKey: string
            toKey: string
            l2psUid: string
            messageHash: string
            encrypted: SerializedEncryptedMessage
            now: number
            recipientOnline: boolean
        },
    ): Promise<string | null> {
        const msg = new L2PSMessage()
        msg.id = opts.messageId
        // Canonicalise at the persistence boundary: every row lands under one
        // identity regardless of how the caller formatted the key, so canonical
        // reads (getQueuedMessages / getHistory) always match.
        msg.fromKey = canonicalizeKey(opts.fromKey)
        msg.toKey = canonicalizeKey(opts.toKey)
        msg.l2psUid = opts.l2psUid
        msg.messageHash = opts.messageHash
        msg.encrypted = opts.encrypted
        msg.l2psTxHash = null
        msg.timestamp = String(opts.now)
        msg.status = opts.recipientOnline ? "delivered" : "queued"
        try {
            await repo.save(msg)
            return null
        } catch (saveError: any) {
            // Catch duplicate-key constraint violation (TOCTOU race
            // between the findExisting guard and the insert).
            if (
                saveError?.code === "23505" ||
                saveError?.message?.includes("duplicate key")
            ) {
                return "Duplicate message"
            }
            throw saveError
        }
    }

    private async handleSubmissionFailure(
        repo: MessageRepo,
        messageId: string,
        fromKey: string,
        recipientOnline: boolean,
    ): Promise<void> {
        await repo.update(messageId, { status: "failed" as const })
        this.releaseOfflineQuota(fromKey, recipientOnline)
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

            // Record in L2PS transaction history. The envelope is what history
            // reads and peer sync serve once the queue row is swept; without
            // it, and with plaintext storage off, the row holds nothing.
            try {
                await L2PSTransactionExecutor.recordTransaction(
                    l2psUid, tx, "", encryptedTxHash, 0, "pending",
                    encryptedTx as unknown as Record<string, any>,
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
        // Rows are stored canonically (persist boundary + one-shot migration),
        // so a single canonical lookup covers every key variant.
        const messages = await repo.find({
            where: { toKey: canonicalizeKey(toKey), l2psUid, status: "queued" },
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
        // Rows are stored canonically, so both sides of the pair must be
        // canonicalised for the lookup to match.
        const a = canonicalizeKey(peerA)
        const b = canonicalizeKey(peerB)
        const qb = repo.createQueryBuilder("m")
            .where("m.l2ps_uid = :l2psUid", { l2psUid })
            .andWhere(
                "((m.from_key = :a AND m.to_key = :b) OR (m.from_key = :b AND m.to_key = :a))",
                { a, b },
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
