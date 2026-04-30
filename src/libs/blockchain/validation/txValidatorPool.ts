import { Worker } from "worker_threads"
import os from "os"
import { randomUUID } from "crypto"
import { Transaction } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import prefetchIdentities from "./prefetchIdentities"
import { validateTx } from "./txValidator"
import type {
    IdentityHintMap,
    TxValidationResult,
    WorkerRequest,
    WorkerResponse,
} from "./types"

const SMALL_BATCH_THRESHOLD = 16
const PER_CHUNK_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_DEFAULT_MS = 2_000

interface PendingRequest {
    resolve: (results: TxValidationResult[]) => void
    reject: (err: Error) => void
    timeout: ReturnType<typeof setTimeout>
}

interface WorkerHandle {
    worker: Worker
    pending: Map<string, PendingRequest>
}

function defaultWorkerCount(): number {
    return Math.max(2, Math.min(8, os.cpus().length - 1))
}

function workerScriptUrl(): URL {
    return new URL("./txValidatorWorker.ts", import.meta.url)
}

/**
 * Split items into `buckets` contiguous chunks, distributing remainder to the
 * lower-indexed buckets. Reorder is a simple flatten.
 */
function chunkContiguous<T>(items: T[], buckets: number): T[][] {
    const out: T[][] = []
    if (buckets <= 0) return [items]
    const base = Math.floor(items.length / buckets)
    const rem = items.length % buckets
    let cursor = 0
    for (let b = 0; b < buckets; b++) {
        const size = base + (b < rem ? 1 : 0)
        out.push(items.slice(cursor, cursor + size))
        cursor += size
    }
    return out
}

/**
 * Persistent worker pool for transaction validation.
 *
 * Public API:
 *   - `start(workerCount?)` — spawn workers (call once at boot).
 *   - `validate(txs)` — returns `TxValidationResult[]` in input order.
 *   - `stop(timeoutMs?)` — drain or terminate (call from gracefulShutdown).
 *
 * Behaviour:
 *   - Batches `< SMALL_BATCH_THRESHOLD` skip the pool and run inline.
 *   - Larger batches are split into N contiguous chunks (one per worker).
 *   - Each chunk dispatch is wrapped in a `PER_CHUNK_TIMEOUT_MS` defense timer.
 *   - Worker crashes reject the in-flight requests for that worker and a
 *     replacement worker is spawned; the process keeps running.
 *   - If the pool is not started or has no workers, `validate()` falls back to
 *     inline execution and logs a warning.
 */
export default class TxValidatorPool {
    private static _instance: TxValidatorPool | null = null
    private workers: WorkerHandle[] = []
    private started = false
    private stopping = false

    static getInstance(): TxValidatorPool {
        if (!this._instance) this._instance = new TxValidatorPool()
        return this._instance
    }

    async start(workerCount: number = defaultWorkerCount()): Promise<void> {
        if (this.started) return
        for (let slot = 0; slot < workerCount; slot++) {
            this.spawnWorker(slot)
        }
        this.started = true
        log.info(`[TxValidatorPool] Started with ${workerCount} workers`)
    }

    private spawnWorker(slot: number): void {
        const worker = new Worker(workerScriptUrl(), {
            // Inherit loader/runtime flags from the parent (tsx, tsconfig-paths, etc.)
            execArgv: process.execArgv,
        })
        const handle: WorkerHandle = { worker, pending: new Map() }
        worker.on("message", (msg: WorkerResponse) =>
            this.handleMessage(handle, msg),
        )
        worker.on("error", err =>
            this.handleWorkerFailure(
                slot,
                handle,
                err instanceof Error ? err : new Error(String(err)),
            ),
        )
        worker.on("exit", code => {
            if (code !== 0 && !this.stopping) {
                this.handleWorkerFailure(
                    slot,
                    handle,
                    new Error(`worker exited with code ${code}`),
                )
            }
        })
        this.workers[slot] = handle
    }

    private handleMessage(handle: WorkerHandle, msg: WorkerResponse): void {
        if (msg.type === "validateResult") {
            log.debug("[TxValidatorPool] validateResult received")
            const pending = handle.pending.get(msg.requestId)
            if (!pending) {
                log.warning(
                    `[TxValidatorPool] Result for unknown requestId ${msg.requestId}`,
                )
                return
            }
            handle.pending.delete(msg.requestId)
            clearTimeout(pending.timeout)
            pending.resolve(msg.results)
            return
        }
        if (msg.type === "fatal") {
            log.error(`[TxValidatorPool] Worker fatal: ${msg.error}`)
            if (msg.requestId) {
                const pending = handle.pending.get(msg.requestId)
                if (pending) {
                    handle.pending.delete(msg.requestId)
                    clearTimeout(pending.timeout)
                    pending.reject(new Error(`worker fatal: ${msg.error}`))
                }
            }
        }
    }

    private handleWorkerFailure(
        slot: number,
        handle: WorkerHandle,
        err: Error,
    ): void {
        log.error(
            `[TxValidatorPool] Worker ${slot} failed: ${err.message}. Recycling.`,
        )
        for (const pending of handle.pending.values()) {
            clearTimeout(pending.timeout)
            pending.reject(new Error(`worker crashed: ${err.message}`))
        }
        handle.pending.clear()
        if (this.stopping) return
        try {
            this.spawnWorker(slot)
        } catch (spawnErr) {
            log.error(
                `[TxValidatorPool] Failed to respawn worker ${slot}: ${
                    spawnErr instanceof Error
                        ? spawnErr.message
                        : String(spawnErr)
                }`,
            )
        }
    }

    async validate(txs: Transaction[]): Promise<TxValidationResult[]> {
        log.only("[TxValidatorPool] validate() called")
        log.only(`[TxValidatorPool] txs length: ${txs.length}`)

        if (txs.length === 0) return []

        if (!this.started || this.workers.length === 0) {
            log.warning(
                "[TxValidatorPool] validate() called but pool not started; using inline fallback",
            )
            return this.validateInline(txs)
        }

        // Small batches and unstarted pool both take the inline path.
        if (txs.length < SMALL_BATCH_THRESHOLD) {
            return this.validateInline(txs)
        }

        const now = Date.now()

        const hints = await prefetchIdentities(txs)
        const buckets = this.workers.length
        const chunks = chunkContiguous(txs, buckets)
        const dispatched = chunks.map(c =>
            c.length === 0
                ? Promise.resolve([] as TxValidationResult[])
                : this.dispatchChunk(c, hints),
        )
        const settled = await Promise.allSettled(dispatched)

        const out: TxValidationResult[] = []
        for (let b = 0; b < buckets; b++) {
            const result = settled[b]
            const bucketTxs = chunks[b]
            if (result.status === "fulfilled") {
                out.push(...result.value)
                continue
            }
            const reason =
                result.reason instanceof Error
                    ? result.reason.message
                    : String(result.reason)
            log.error(
                `[TxValidatorPool] Chunk ${b} (${bucketTxs.length} txs) failed: ${reason}`,
            )
            for (const tx of bucketTxs) {
                out.push({
                    hash: tx.hash,
                    valid: false,
                    reason: `validator pool error: ${reason}`,
                })
            }
        }
        const end = Date.now()
        log.only(`[TxValidatorPool] validate() took ${end - now}ms`)
        return out
    }

    private async validateInline(
        txs: Transaction[],
    ): Promise<TxValidationResult[]> {
        const hints = await prefetchIdentities(txs)
        return Promise.all(
            txs.map(tx => validateTx(tx, hints[tx.hash] ?? null)),
        )
    }

    private dispatchChunk(
        txs: Transaction[],
        hints: IdentityHintMap,
    ): Promise<TxValidationResult[]> {
        // Round-robin worker selection. We allow each worker to hold multiple
        // in-flight requests because validation throughput per worker is
        // bounded by ucrypto.verify, not by request count.
        const handle = this.pickWorker()
        if (!handle) {
            return Promise.reject(new Error("no workers available"))
        }

        const requestId = randomUUID()
        // Send only the hints relevant to this chunk to keep IPC payloads small.
        const subHints: IdentityHintMap = {}
        for (const tx of txs) {
            if (hints[tx.hash] !== undefined) {
                subHints[tx.hash] = hints[tx.hash]
            }
        }

        return new Promise<TxValidationResult[]>((resolve, reject) => {
            const timeout = setTimeout(() => {
                handle.pending.delete(requestId)
                reject(
                    new Error(
                        `validator request ${requestId} timed out after ${PER_CHUNK_TIMEOUT_MS}ms`,
                    ),
                )
            }, PER_CHUNK_TIMEOUT_MS)
            handle.pending.set(requestId, { resolve, reject, timeout })
            const req: WorkerRequest = {
                type: "validate",
                requestId,
                txs,
                identityHints: subHints,
            }
            try {
                handle.worker.postMessage(req)
            } catch (err) {
                handle.pending.delete(requestId)
                clearTimeout(timeout)
                reject(err instanceof Error ? err : new Error(String(err)))
            }
        })
    }

    private rrIndex = 0
    private pickWorker(): WorkerHandle | null {
        if (this.workers.length === 0) return null
        // Walk up to N slots in case some are temporarily empty (between
        // crash + respawn). Returns the first non-empty handle.
        for (let attempt = 0; attempt < this.workers.length; attempt++) {
            const slot = this.rrIndex % this.workers.length
            this.rrIndex = (this.rrIndex + 1) % this.workers.length
            const handle = this.workers[slot]
            if (handle) return handle
        }
        return null
    }

    async stop(timeoutMs: number = STOP_TIMEOUT_DEFAULT_MS): Promise<void> {
        if (!this.started) return
        this.stopping = true

        // Best-effort drain: wait for in-flight requests, then terminate.
        const drainPromises: Promise<void>[] = []
        for (const handle of this.workers) {
            if (!handle) continue
            try {
                handle.worker.postMessage({ type: "shutdown" })
            } catch {
                /* worker may already be dead */
            }
            drainPromises.push(
                new Promise<void>(resolve => {
                    const start = Date.now()
                    const tick = () => {
                        if (handle.pending.size === 0) return resolve()
                        if (Date.now() - start >= timeoutMs) return resolve()
                        setTimeout(tick, 50)
                    }
                    tick()
                }),
            )
        }
        await Promise.all(drainPromises)

        const terminations = this.workers
            .filter(h => h)
            .map(h => h.worker.terminate().catch(() => undefined))
        await Promise.all(terminations)

        this.workers = []
        this.started = false
        this.stopping = false
        TxValidatorPool._instance = null
        log.info("[TxValidatorPool] Stopped")
    }
}
