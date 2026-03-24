/**
 * ContinuousForge — Petri Consensus Phase 2
 *
 * The 2-second continuous forge loop running within a shard.
 * Each cycle:
 *   1. Sync mempools with shard members
 *   2. Get TO_APPROVE transactions from mempool
 *   3. Run speculative execution to produce delta hashes
 *   4. Exchange delta hashes with shard members (all-to-all)
 *   5. Feed into DeltaAgreementTracker
 *   6. Promote agreed txs (TO_APPROVE → PRE_APPROVED) or flag (→ PROBLEMATIC)
 *   7. Update mempool classifications
 *
 * Gated by getSharedState.petriConsensus feature flag.
 */

import type { Peer } from "@/libs/peer"
import type { ForgeState } from "@/libs/consensus/petri/types/continuousForgeTypes"
import type { PetriConfig } from "@/libs/consensus/petri/types/petriConfig"
import { TransactionClassification } from "@/libs/consensus/petri/types/classificationTypes"
import { DeltaAgreementTracker } from "./deltaAgreementTracker"
import { executeSpeculatively } from "@/libs/consensus/petri/execution/speculativeExecutor"
import { classifyTransaction } from "@/libs/consensus/petri/classifier/transactionClassifier"
import Mempool from "@/libs/blockchain/mempool_v2"
import { mergeMempools } from "@/libs/consensus/v2/routines/mergeMempools"
import { getSharedState } from "@/utilities/sharedState"
import log from "@/utilities/logger"

export class ContinuousForge {
    private state: ForgeState = {
        isRunning: false,
        isPaused: false,
        currentRound: 0,
        lastRoundStartedAt: 0,
        pendingTransactions: new Map(),
    }

    private tracker: DeltaAgreementTracker
    private config: PetriConfig
    private shard: Peer[] = []
    private timer: ReturnType<typeof setTimeout> | null = null
    private currentRoundPromise: Promise<void> | null = null

    /** Our local delta hashes for the current round — exposed for RPC handler */
    private currentRoundDeltas: Record<string, string> = {}

    constructor(config: PetriConfig) {
        this.config = config
        this.tracker = new DeltaAgreementTracker(
            config.agreementThreshold,
            config.problematicTTLRounds,
        )
    }

    /**
     * Start the continuous forge loop for a given shard.
     */
    start(shard: Peer[]): void {
        if (this.state.isRunning) {
            log.warn("[ContinuousForge] Already running, ignoring start()")
            return
        }

        this.shard = shard
        this.state.isRunning = true
        this.state.isPaused = false
        this.state.currentRound = 0
        log.info(
            `[ContinuousForge] Starting forge loop (${this.config.forgeIntervalMs}ms interval, ` +
            `${shard.length} shard members)`,
        )

        this.scheduleNextRound()
    }

    /**
     * Stop the forge loop. Called at block boundary or shutdown.
     */
    stop(): void {
        this.state.isRunning = false
        if (this.timer) {
            clearTimeout(this.timer)
            this.timer = null
        }
        log.info(
            `[ContinuousForge] Stopped after round ${this.state.currentRound}`,
        )
    }

    /**
     * Pause the forge loop (e.g., during block compilation).
     * The timer continues but rounds are skipped.
     */
    pause(): void {
        this.state.isPaused = true
        log.debug("[ContinuousForge] Paused")
    }

    /**
     * Pause and wait for any in-flight forge round to complete.
     * Ensures no round is mutating state when the caller proceeds.
     */
    async drain(): Promise<void> {
        this.state.isPaused = true
        if (this.currentRoundPromise) {
            log.debug("[ContinuousForge] Draining in-flight round...")
            await this.currentRoundPromise
        }
        log.debug("[ContinuousForge] Drained")
    }

    /**
     * Resume after pause.
     */
    resume(): void {
        this.state.isPaused = false
        log.debug("[ContinuousForge] Resumed")
    }

    /**
     * Reset tracker state and round counter. Called at block boundary.
     */
    reset(): void {
        this.tracker.reset()
        this.state.currentRound = 0
        this.currentRoundDeltas = {}
        this.state.pendingTransactions.clear()
        log.debug("[ContinuousForge] Reset state")
    }

    /**
     * Get the current round's local delta map (for RPC response).
     */
    getCurrentDeltas(): Record<string, string> {
        return { ...this.currentRoundDeltas }
    }

    /**
     * Get current forge state (for diagnostics).
     */
    getState(): Readonly<ForgeState> {
        return { ...this.state }
    }

    /**
     * Number of transactions currently tracked by the delta agreement tracker.
     */
    getTrackerCount(): number {
        return this.tracker.trackedCount
    }

    // --- Private ---

    private scheduleNextRound(): void {
        if (!this.state.isRunning) return

        this.timer = setTimeout(async () => {
            if (this.state.isRunning && !this.state.isPaused) {
                this.currentRoundPromise = this.runForgeRound()
                await this.currentRoundPromise
                this.currentRoundPromise = null
            }
            this.scheduleNextRound()
        }, this.config.forgeIntervalMs)
    }

    /**
     * Execute a single forge round (the core 2s cycle).
     */
    async runForgeRound(): Promise<void> {
        this.state.currentRound++
        this.state.lastRoundStartedAt = Date.now()
        this.currentRoundDeltas = {}
        const round = this.state.currentRound

        log.debug(`[ContinuousForge] Round ${round} starting`)

        try {
            // Step 1: Sync mempools with shard
            const ourMempool = await Mempool.getMempool()
            await mergeMempools(ourMempool, this.shard)

            // Step 1b: Classify any unclassified TXs (arrived via mempool merge)
            const unclassified = await Mempool.getUnclassified()
            if (unclassified.length > 0) {
                log.debug(`[ContinuousForge] Round ${round}: classifying ${unclassified.length} unclassified txs`)
                for (const mempoolTx of unclassified) {
                    const tx = mempoolTx as unknown as import("@kynesyslabs/demosdk/types").Transaction
                    const classResult = await classifyTransaction(tx)
                    if (classResult.classification === TransactionClassification.TO_APPROVE) {
                        const specResult = await executeSpeculatively(tx, classResult.gcrEdits)
                        if (specResult.success && specResult.delta) {
                            await Mempool.updateClassification(
                                mempoolTx.hash,
                                TransactionClassification.TO_APPROVE,
                                specResult.delta.hash,
                            )
                        } else {
                            await Mempool.updateClassification(
                                mempoolTx.hash,
                                TransactionClassification.FAILED,
                            )
                        }
                    } else {
                        await Mempool.updateClassification(
                            mempoolTx.hash,
                            classResult.classification,
                        )
                    }
                }
            }

            // Step 2: Get TO_APPROVE transactions
            const toApproveTxs = await Mempool.getByClassification(
                TransactionClassification.TO_APPROVE,
            )

            if (toApproveTxs.length === 0) {
                log.debug(`[ContinuousForge] Round ${round}: no TO_APPROVE txs`)
                return
            }

            // Step 3: Speculatively execute each and build local delta map
            const localDeltas: Record<string, string> = {}

            for (const mempoolTx of toApproveTxs) {
                // Use existing delta_hash if already computed at insertion
                if (mempoolTx.delta_hash) {
                    localDeltas[mempoolTx.hash] = mempoolTx.delta_hash
                    continue
                }

                // Otherwise compute now (for txs received via merge without classification)
                const tx = mempoolTx as unknown as import("@kynesyslabs/demosdk/types").Transaction
                const classResult = await classifyTransaction(tx)
                if (classResult.classification === TransactionClassification.TO_APPROVE) {
                    const specResult = await executeSpeculatively(tx, classResult.gcrEdits)
                    if (specResult.success && specResult.delta) {
                        localDeltas[mempoolTx.hash] = specResult.delta.hash
                        // Update mempool with computed delta
                        await Mempool.updateClassification(
                            mempoolTx.hash,
                            TransactionClassification.TO_APPROVE,
                            specResult.delta.hash,
                        )
                    }
                }
            }

            this.currentRoundDeltas = localDeltas

            // Step 4: Exchange delta hashes with shard members (all-to-all)
            const peerDeltas = await this.exchangeDeltas(round, localDeltas)

            // Step 5: Record all deltas (local + peer) in tracker
            const ourKey = getSharedState.publicKeyHex
            for (const [txHash, deltaHash] of Object.entries(localDeltas)) {
                this.tracker.recordDelta(txHash, deltaHash, ourKey, round)
            }

            for (const [peerKey, deltas] of Object.entries(peerDeltas)) {
                for (const [txHash, deltaHash] of Object.entries(deltas)) {
                    this.tracker.recordDelta(txHash, deltaHash, peerKey, round)
                }
            }

            // Step 6: Evaluate agreement
            const { promoted, flagged } = this.tracker.evaluate(
                this.shard.length + 1, // +1 for self
                round,
            )

            // Step 7: Update mempool classifications
            for (const txHash of promoted) {
                await Mempool.updateClassification(
                    txHash,
                    TransactionClassification.PRE_APPROVED,
                )
            }

            for (const txHash of flagged) {
                await Mempool.updateClassification(
                    txHash,
                    TransactionClassification.PROBLEMATIC,
                )
            }

            if (promoted.length > 0 || flagged.length > 0) {
                log.info(
                    `[ContinuousForge] Round ${round}: ${promoted.length} promoted, ` +
                    `${flagged.length} flagged, ${this.tracker.trackedCount} pending`,
                )
            }
        } catch (error) {
            log.error(`[ContinuousForge] Round ${round} error: ${error}`)
        }
    }

    /**
     * Exchange delta hashes with all shard members via RPC.
     * Returns a map of peerKey -> { txHash -> deltaHash }.
     */
    private async exchangeDeltas(
        roundNumber: number,
        localDeltas: Record<string, string>,
    ): Promise<Record<string, Record<string, string>>> {
        const peerDeltas: Record<string, Record<string, string>> = {}

        const ourKey = getSharedState.publicKeyHex
        const peers = this.shard.filter(p => p.identity !== ourKey)

        const promises = peers.map(async peer => {
            try {
                const response = await peer.longCall(
                    {
                        method: "consensus_routine",
                        params: [{
                            method: "petri_exchangeDeltas",
                            params: [{ roundNumber, deltas: localDeltas }],
                        }],
                    },
                    true,
                    { sleepTime: 250, retries: 2 },
                )

                if (response.result === 200 && response.response) {
                    const data = response.response as { deltas?: unknown }
                    if (data.deltas && typeof data.deltas === "object" && !Array.isArray(data.deltas)) {
                        peerDeltas[peer.identity] = data.deltas as Record<string, string>
                    }
                }
            } catch (error) {
                log.warn(
                    `[ContinuousForge] Delta exchange failed with ${peer.identity.substring(0, 16)}...: ${error}`,
                )
            }
        })

        // Timeout the entire exchange to prevent round stalls from slow/dead peers
        const exchangeTimeoutMs = this.config.forgeIntervalMs ?? 2000
        await Promise.race([
            Promise.all(promises),
            new Promise<void>(resolve => setTimeout(resolve, exchangeTimeoutMs)),
        ])
        return peerDeltas
    }
}
