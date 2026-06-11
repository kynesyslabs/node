import { Worker } from "worker_threads"
import os from "os"
import { randomUUID } from "crypto"
import {
    SigningAlgorithm,
    Transaction,
} from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import { getSharedState } from "@/utilities/sharedState"
import prefetchIdentities from "./prefetchIdentities"
import { validateTx } from "./txValidator"
import type {
    IdentityHintMap,
    TxValidationResult,
    WorkerInitData,
    WorkerRequest,
    WorkerResponse,
} from "./types"
import type { signedObject } from "../../../../node_modules/@kynesyslabs/demosdk/build/encryption/unifiedCrypto"

// Validate batches of every size go through the pool. The point of the pool
// is to keep crypto work off the main event loop, not to amortize IPC; a
// single ed25519/PQC verify on the main thread can block the loop for tens
// of ms and that's exactly what we want to avoid. The inline path stays as a
// safety net for "validate() called before start()", but with start()
// blocking on identity load it should never fire in practice.
const SMALL_BATCH_THRESHOLD = 1
const PER_CHUNK_TIMEOUT_MS = 30_000
const PER_REQUEST_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_DEFAULT_MS = 2_000
const READY_TIMEOUT_DEFAULT_MS = 30_000

interface PendingRequest {
    // One resolver type for all request kinds; public methods cast at
    // dispatch time. Validated by message type in handleMessage.
    resolve: (value: any) => void
    reject: (err: Error) => void
    timeout: ReturnType<typeof setTimeout>
}

interface WorkerHandle {
    worker: Worker
    pending: Map<string, PendingRequest>
    ready: Promise<void>
    markReady: () => void
    markReadyFailed: (err: Error) => void
    isReady: boolean
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
 *   - `start()` blocks until every worker has signalled "ready", or rejects
 *     after `READY_TIMEOUT_DEFAULT_MS` if any worker fails to import.
 *   - Batches `< SMALL_BATCH_THRESHOLD` skip the pool and run inline.
 *   - Larger batches are split into N contiguous chunks (one per worker).
 *   - Each chunk dispatch is wrapped in a `PER_CHUNK_TIMEOUT_MS` defense timer.
 *   - Worker crashes (error event, non-zero exit, messageerror) are treated
 *     as fatal: in-flight requests reject and the node is sent SIGTERM so
 *     `gracefulShutdown` runs. We do NOT respawn — a crashing validator
 *     means a bug we want surfaced, not a degraded fallback.
 *   - If the pool is not started or has no workers, `validate()` falls back
 *     to inline execution and logs a warning. (Defensive only; `start()`
 *     succeeding implies all workers are ready.)
 */
export default class TxValidatorPool {
    private static _instance: TxValidatorPool | null = null
    private workers: WorkerHandle[] = []
    private started = false
    private stopping = false
    private nodeShutdownTriggered = false

    static getInstance(): TxValidatorPool {
        if (!this._instance) this._instance = new TxValidatorPool()
        return this._instance
    }

    async start(
        workerCount: number = defaultWorkerCount(),
        readyTimeoutMs: number = READY_TIMEOUT_DEFAULT_MS,
    ): Promise<void> {
        if (this.started) return

        // Workers need the node's master seed to call ucrypto.sign() as the
        // node. Identity is loaded inside warmup() → preMainLoop() →
        // identity.loadIdentity(); start() must be invoked after that.
        const masterSeed = getSharedState.identity?.masterSeed
        if (!masterSeed) {
            throw new Error(
                "TxValidatorPool.start() called before identity is loaded; getSharedState.identity.masterSeed is empty",
            )
        }
        const initData: WorkerInitData = { masterSeed }

        const startedAt = Date.now()
        log.info(
            `[TxValidatorPool] Spawning ${workerCount} workers; waiting up to ${readyTimeoutMs}ms for ready...`,
        )

        for (let slot = 0; slot < workerCount; slot++) {
            this.spawnWorker(slot, initData)
        }

        const allReady = Promise.all(this.workers.map(h => h.ready))
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null
        const timeout = new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
                const stragglers = this.workers
                    .map((h, i) => (h.isReady ? null : i))
                    .filter((i): i is number => i !== null)
                reject(
                    new Error(
                        `workers did not signal ready within ${readyTimeoutMs}ms (slots not ready: ${stragglers.join(", ")})`,
                    ),
                )
            }, readyTimeoutMs)
        })

        try {
            await Promise.race([allReady, timeout])
        } catch (err) {
            // Tear down any workers we did spawn before propagating.
            await this.terminateAll().catch(() => undefined)
            this.workers = []
            throw err
        } finally {
            if (timeoutHandle) clearTimeout(timeoutHandle)
        }

        this.started = true
        log.info(
            `[TxValidatorPool] Started with ${workerCount} workers in ${Date.now() - startedAt}ms`,
        )
    }

    private spawnWorker(slot: number, initData: WorkerInitData): void {
        let markReady!: () => void
        let markReadyFailed!: (err: Error) => void
        const ready = new Promise<void>((resolve, reject) => {
            markReady = resolve
            markReadyFailed = reject
        })

        const worker = new Worker(workerScriptUrl(), {
            // Inherit loader/runtime flags from the parent (tsx, tsconfig-paths, etc.)
            execArgv: process.execArgv,
            workerData: initData,
        })
        const handle: WorkerHandle = {
            worker,
            pending: new Map(),
            ready,
            markReady: () => {
                handle.isReady = true
                markReady()
            },
            markReadyFailed,
            isReady: false,
        }
        worker.on("message", (msg: WorkerResponse) =>
            this.handleMessage(handle, msg),
        )
        worker.on("error", err =>
            this.handleWorkerCrash(
                slot,
                handle,
                err instanceof Error ? err : new Error(String(err)),
            ),
        )
        worker.on("exit", code => {
            if (code !== 0 && !this.stopping) {
                this.handleWorkerCrash(
                    slot,
                    handle,
                    new Error(`worker exited with code ${code}`),
                )
            }
        })
        worker.on("messageerror", err =>
            this.handleWorkerCrash(
                slot,
                handle,
                new Error(
                    `messageerror (failed to deserialize parent→worker message): ${
                        err instanceof Error ? err.message : String(err)
                    }`,
                ),
            ),
        )
        this.workers[slot] = handle
    }

    private handleMessage(handle: WorkerHandle, msg: WorkerResponse): void {
        if (msg.type === "ready") {
            handle.markReady()
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
            return
        }
        const pending = handle.pending.get(msg.requestId)
        if (!pending) {
            log.warning(
                `[TxValidatorPool] Result for unknown requestId ${msg.requestId}`,
            )
            return
        }
        handle.pending.delete(msg.requestId)
        clearTimeout(pending.timeout)
        if (msg.type === "validateResult") {
            pending.resolve(msg.results)
        } else if (msg.type === "signResult") {
            pending.resolve(msg.signedObject)
        } else if (msg.type === "verifyResult") {
            pending.resolve(msg.result)
        }
    }

    /**
     * A worker should never crash. If one does, surface the cause loudly and
     * tear the node down via SIGTERM so the existing gracefulShutdown path
     * runs (DB/RPC/L2PS/etc. drain). Pre-ready crashes also reject the
     * `start()` promise so the node fails to boot rather than running with
     * a degraded validator.
     */
    private handleWorkerCrash(
        slot: number,
        handle: WorkerHandle,
        err: Error,
    ): void {
        if (this.stopping) return
        log.error(
            `[TxValidatorPool] Worker ${slot} crashed: ${err.message}`,
        )
        if (err.stack) log.error(err.stack)

        for (const pending of handle.pending.values()) {
            clearTimeout(pending.timeout)
            pending.reject(new Error(`worker ${slot} crashed: ${err.message}`))
        }
        handle.pending.clear()

        // If we're still booting, fail start() instead of triggering shutdown.
        if (!handle.isReady) {
            handle.markReadyFailed(err)
            return
        }

        this.triggerNodeShutdown(`worker ${slot} crashed: ${err.message}`)
    }

    private triggerNodeShutdown(reason: string): void {
        if (this.nodeShutdownTriggered) return
        this.nodeShutdownTriggered = true
        log.error(
            `[TxValidatorPool] Initiating node shutdown via SIGTERM: ${reason}`,
        )
        process.kill(process.pid, "SIGTERM")
    }

    private async terminateAll(): Promise<void> {
        const terminations = this.workers
            .filter((h): h is WorkerHandle => Boolean(h))
            .map(h => h.worker.terminate().catch(() => undefined))
        await Promise.all(terminations)
    }

    /**
     * @param isPostFork osDenomination fork state at the node-local chain tip,
     *   supplied by the caller (Mempool.receive). Threaded to the coherence
     *   check so it canonicalizes amounts identically to the signer/consensus
     *   (audit H1). The worker cannot compute it (no forkConfig/height).
     */
    async validate(
        txs: Transaction[],
        isPostFork: boolean,
    ): Promise<TxValidationResult[]> {
        log.only("[TxValidatorPool] validate() called")
        log.only(`[TxValidatorPool] txs length: ${txs.length}`)

        if (txs.length === 0) return []

        if (!this.started || this.workers.length === 0) {
            log.warning(
                "[TxValidatorPool] validate() called but pool not started; using inline fallback",
            )
            return this.validateInline(txs, isPostFork)
        }

        // Small batches and unstarted pool both take the inline path.
        if (txs.length < SMALL_BATCH_THRESHOLD) {
            return this.validateInline(txs, isPostFork)
        }

        const now = Date.now()

        const hints = await prefetchIdentities(txs)
        const buckets = this.workers.length
        const chunks = chunkContiguous(txs, buckets)
        const dispatched = chunks.map(c =>
            c.length === 0
                ? Promise.resolve([] as TxValidationResult[])
                : this.dispatchChunk(c, hints, isPostFork),
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

    /**
     * Drop-in replacement for `ucrypto.sign(algorithm, data)`
     *
     * If the pool isn't started, throws — callers should treat unstarted
     * pool as a programming error rather than silently signing on main.
     */
    async sign(
        algorithm: SigningAlgorithm,
        data: Uint8Array,
    ): Promise<signedObject> {
        if (!this.started || this.workers.length === 0) {
            throw new Error(
                "TxValidatorPool.sign() called but pool is not started",
            )
        }
        const handle = this.pickWorker()
        if (!handle) {
            throw new Error("no workers available")
        }
        const requestId = randomUUID()
        return this.dispatchOne<signedObject>(handle, requestId, {
            type: "sign",
            requestId,
            algorithm,
            data,
        })
    }

    /**
     * Drop-in replacement for `ucrypto.verify(signedObject)`
     */
    async verify(signed: signedObject): Promise<boolean> {
        if (!this.started || this.workers.length === 0) {
            throw new Error(
                "TxValidatorPool.verify() called but pool is not started",
            )
        }
        const handle = this.pickWorker()
        if (!handle) {
            throw new Error("no workers available")
        }
        const requestId = randomUUID()
        return this.dispatchOne<boolean>(handle, requestId, {
            type: "verify",
            requestId,
            signedObject: signed,
        })
    }

    /**
     * Generic single-request dispatcher used by sign() and verify(). Wraps
     * the postMessage in the same pending/timeout machinery as dispatchChunk
     * but for one request whose result type is known by the caller.
     */
    private dispatchOne<T>(
        handle: WorkerHandle,
        requestId: string,
        req: WorkerRequest,
    ): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
                handle.pending.delete(requestId)
                reject(
                    new Error(
                        `validator request ${requestId} timed out after ${PER_REQUEST_TIMEOUT_MS}ms`,
                    ),
                )
            }, PER_REQUEST_TIMEOUT_MS)
            handle.pending.set(requestId, { resolve, reject, timeout })
            try {
                handle.worker.postMessage(req)
            } catch (err) {
                handle.pending.delete(requestId)
                clearTimeout(timeout)
                reject(err instanceof Error ? err : new Error(String(err)))
            }
        })
    }

    private async validateInline(
        txs: Transaction[],
        isPostFork: boolean,
    ): Promise<TxValidationResult[]> {
        const hints = await prefetchIdentities(txs)
        return Promise.all(
            txs.map(tx => validateTx(tx, hints[tx.hash] ?? null, isPostFork)),
        )
    }

    private dispatchChunk(
        txs: Transaction[],
        hints: IdentityHintMap,
        isPostFork: boolean,
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
                isPostFork,
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

        await this.terminateAll()

        this.workers = []
        this.started = false
        this.stopping = false
        TxValidatorPool._instance = null
        log.info("[TxValidatorPool] Stopped")
    }
}
