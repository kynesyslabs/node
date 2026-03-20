/**
 * DeltaAgreementTracker — Petri Consensus Phase 2
 *
 * Tracks per-transaction delta agreement across forge rounds within a shard.
 * For each TO_APPROVE transaction, shard members exchange delta hashes.
 * When enough members agree (threshold), the tx is promoted to PRE_APPROVED.
 * If no agreement after TTL rounds, the tx is flagged PROBLEMATIC.
 *
 * This is the core BFT-as-exception-handler mechanism:
 * agreement is the fast path, disagreement triggers the slow path.
 */

import type { DeltaComparison, RoundDeltaResult } from "@/libs/consensus/petri/types/deltaComparison"
import log from "@/utilities/logger"

interface TxDeltaState {
    /** Delta hashes received from each member (memberKey -> deltaHash) */
    memberHashes: Map<string, string>
    /** First round this tx was seen */
    firstSeenRound: number
    /** Number of rounds this tx has been tracked */
    roundsTracked: number
}

export class DeltaAgreementTracker {
    /** Per-tx tracking state: txHash -> TxDeltaState */
    private txStates = new Map<string, TxDeltaState>()

    /** Agreement threshold (default: 7 out of 10) */
    private readonly threshold: number

    /** Max rounds before auto-flagging as PROBLEMATIC */
    private readonly ttlRounds: number

    constructor(threshold: number, ttlRounds: number) {
        this.threshold = threshold
        this.ttlRounds = ttlRounds
    }

    /**
     * Record a shard member's delta hash for a transaction.
     * Called once per member per tx per round during delta exchange.
     */
    recordDelta(
        txHash: string,
        deltaHash: string,
        memberKey: string,
        currentRound: number,
    ): void {
        let state = this.txStates.get(txHash)
        if (!state) {
            state = {
                memberHashes: new Map(),
                firstSeenRound: currentRound,
                roundsTracked: 0,
            }
            this.txStates.set(txHash, state)
        }
        state.memberHashes.set(memberKey, deltaHash)
    }

    /**
     * Evaluate all tracked transactions for agreement or TTL expiry.
     * Returns which txs should be promoted and which should be flagged.
     *
     * @param shardSize - Total number of members in the shard
     * @param currentRound - The current forge round number
     */
    evaluate(
        shardSize: number,
        currentRound: number,
    ): { promoted: string[]; flagged: string[] } {
        const promoted: string[] = []
        const flagged: string[] = []

        for (const [txHash, state] of this.txStates.entries()) {
            // Count how many rounds this tx has been tracked
            state.roundsTracked = currentRound - state.firstSeenRound + 1

            // Find the most popular delta hash (majority vote)
            const hashCounts = new Map<string, number>()
            for (const hash of state.memberHashes.values()) {
                hashCounts.set(hash, (hashCounts.get(hash) ?? 0) + 1)
            }

            // Check if any hash has reached the agreement threshold
            let agreed = false
            for (const [hash, count] of hashCounts.entries()) {
                if (count >= this.threshold) {
                    log.debug(
                        `[DeltaTracker] TX ${txHash} PROMOTED: ${count}/${shardSize} agree on hash ${hash.substring(0, 16)}...`,
                    )
                    promoted.push(txHash)
                    agreed = true
                    break
                }
            }

            if (agreed) {
                continue
            }

            // Check TTL expiry
            if (state.roundsTracked >= this.ttlRounds) {
                log.warn(
                    `[DeltaTracker] TX ${txHash} FLAGGED: no agreement after ${state.roundsTracked} rounds ` +
                    `(best: ${Math.max(...hashCounts.values())}/${this.threshold} needed)`,
                )
                flagged.push(txHash)
            }
        }

        // Clean up promoted and flagged txs from tracking
        for (const txHash of [...promoted, ...flagged]) {
            this.txStates.delete(txHash)
        }

        return { promoted, flagged }
    }

    /**
     * Build a detailed DeltaComparison for a specific transaction.
     * Used for diagnostics and the RoundDeltaResult.
     */
    getComparison(
        txHash: string,
        localDeltaHash: string,
        totalMembers: number,
    ): DeltaComparison | null {
        const state = this.txStates.get(txHash)
        if (!state) return null

        let agreeCount = 0
        let disagreeCount = 0

        for (const hash of state.memberHashes.values()) {
            if (hash === localDeltaHash) {
                agreeCount++
            } else {
                disagreeCount++
            }
        }

        const missingCount = totalMembers - state.memberHashes.size

        return {
            txHash,
            localDeltaHash,
            peerHashes: new Map(state.memberHashes),
            agreeCount,
            disagreeCount,
            missingCount,
            totalMembers,
            agreed: agreeCount >= this.threshold,
        }
    }

    /**
     * Clear all tracking state. Called at block boundary or forge reset.
     */
    reset(): void {
        this.txStates.clear()
    }

    /**
     * Number of transactions currently being tracked.
     */
    get trackedCount(): number {
        return this.txStates.size
    }
}
