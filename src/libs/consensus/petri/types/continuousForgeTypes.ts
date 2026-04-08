import type { ClassifiedTransaction } from "./classificationTypes"
import type { PeerDelta, StateDelta } from "./stateDelta"

/**
 * Represents a single 2-second forge cycle within the Continuous Forge loop.
 *
 * Each round:
 * 1. Sync mempool with shard members
 * 2. Speculatively execute TO_APPROVE transactions
 * 3. Exchange delta hashes with shard members
 * 4. Evaluate agreement (7/10 threshold)
 * 5. Promote agreed txs to PRE_APPROVED, flag disagreements as PROBLEMATIC
 */
export interface ContinuousForgeRound {
    roundNumber: number
    startedAt: number
    endedAt?: number
    transactions: ClassifiedTransaction[]
    localDeltas: StateDelta[]
    peerDeltas: PeerDelta[]
    promotedTxHashes: string[] // txs that reached agreement this round
    problematicTxHashes: string[] // txs flagged as PROBLEMATIC this round
}

/**
 * Configuration for the Continuous Forge loop.
 */
export interface ForgeConfig {
    forgeIntervalMs: number // duration of one forge cycle (default: 2000)
    agreementThreshold: number // minimum shard members that must agree (default: 7)
    problematicTTLRounds: number // max rounds before auto-rejecting PROBLEMATIC tx (default: 5)
}

/**
 * Runtime state of the Continuous Forge loop.
 */
export interface ForgeState {
    isRunning: boolean
    isPaused: boolean // paused during block compilation
    currentRound: number
    lastRoundStartedAt: number
    pendingTransactions: Map<string, ClassifiedTransaction> // txHash -> classified tx
}
