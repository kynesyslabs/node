/**
 * SpeculativeExecutor — Petri Consensus Phase 1
 *
 * Executes a transaction's GCR edits speculatively (simulate=true)
 * to produce a deterministic StateDelta without mutating the actual GCR state.
 *
 * The resulting delta hash is used for cross-node agreement in the Continuous Forge.
 * Two honest nodes processing the same tx against the same confirmed state
 * MUST produce the same delta hash.
 */

import type { Transaction, GCREdit } from "@kynesyslabs/demosdk/types"
import type { StateDelta } from "@/libs/consensus/petri/types/stateDelta"
import { canonicalJson } from "@/libs/consensus/petri/utils/canonicalJson"
import Hashing from "@/libs/crypto/hashing"
import HandleGCR from "@/libs/blockchain/gcr/handleGCR"
import log from "@/utilities/logger"
import Chain from "@/libs/blockchain/chain"

/**
 * Result of speculative execution — either a delta or an error.
 */
export interface SpeculativeResult {
    success: boolean
    delta?: StateDelta
    error?: string
}

/**
 * Execute a transaction's GCR edits in simulation mode (no state mutation).
 * Produces a deterministic StateDelta with a canonical hash.
 *
 * @param tx - The transaction to execute speculatively
 * @param gcrEdits - The pre-computed GCR edits for this transaction
 * @returns SpeculativeResult with the delta on success
 */
export async function executeSpeculatively(
    tx: Transaction,
    gcrEdits: GCREdit[],
): Promise<SpeculativeResult> {
    // Use the new in-memory GCR pattern: batch-load accounts, then apply in simulation mode
    const accounts = await HandleGCR.prepareAccounts([tx])
    const applyResult = await HandleGCR.applyTransaction(
        accounts,
        tx,
        false, // not a rollback
        true, // simulate — no DB write
    )

    if (!applyResult.success) {
        log.warn(
            `[PetriSpecExec] Simulation failed for TX ${tx.hash}: ${applyResult.message}`,
        )
        return {
            success: false,
            error: `Simulation failed: ${applyResult.message}`,
        }
    }

    // Produce the canonical delta hash
    // This is the critical determinism point — same edits → same hash on all nodes
    // GCREdit is a discriminated union — cast through Record for uniform access
    const editsForHashing = gcrEdits.map(edit => {
        const e = edit as unknown as Record<string, unknown>
        const amount = e.amount
        return {
            type: e.type,
            operation: e.operation ?? "",
            account: e.account ?? "",
            amount: typeof amount === "bigint"
                ? amount.toString()
                : String(amount ?? ""),
        }
    })

    const canonicalEdits = canonicalJson(editsForHashing)
    const deltaHash = Hashing.sha256(canonicalEdits)

    const lastBlock = await Chain.getLastBlockNumber()

    const delta: StateDelta = {
        txHash: tx.hash,
        edits: gcrEdits,
        hash: deltaHash,
        executedAt: Date.now(),
        blockRef: lastBlock,
    }

    log.debug(
        `[PetriSpecExec] TX ${tx.hash} → deltaHash=${deltaHash.substring(0, 16)}... (${gcrEdits.length} edits)`,
    )

    return { success: true, delta }
}
