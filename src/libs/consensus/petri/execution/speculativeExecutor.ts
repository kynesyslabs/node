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
import type { Repository } from "typeorm"
import type { StateDelta } from "@/libs/consensus/petri/types/stateDelta"
import { canonicalJson } from "@/libs/consensus/petri/utils/canonicalJson"
import Hashing from "@/libs/crypto/hashing"
import Datasource from "@/model/datasource"
import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import GCRBalanceRoutines from "@/libs/blockchain/gcr/gcr_routines/GCRBalanceRoutines"
import GCRNonceRoutines from "@/libs/blockchain/gcr/gcr_routines/GCRNonceRoutines"
import GCRIdentityRoutines from "@/libs/blockchain/gcr/gcr_routines/GCRIdentityRoutines"
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
    const db = await Datasource.getInstance()
    const gcrMainRepo: Repository<GCRMain> = db
        .getDataSource()
        .getRepository(GCRMain)

    // REVIEW: Execute each GCR edit in simulation mode (simulate=true)
    // This runs the full logic but skips the database save
    for (const edit of gcrEdits) {
        let result: { success: boolean; message: string }

        switch (edit.type) {
            case "balance":
                result = await GCRBalanceRoutines.apply(
                    edit,
                    gcrMainRepo,
                    true, // simulate — no DB write
                )
                break
            case "nonce":
                result = await GCRNonceRoutines.apply(
                    edit,
                    gcrMainRepo,
                    true,
                )
                break
            case "identity":
                result = await GCRIdentityRoutines.apply(
                    edit,
                    gcrMainRepo,
                    true,
                )
                break
            default:
                // For other GCR edit types (storage, tls, etc.), we still produce a delta
                // but skip simulation — the edit presence itself is the state change signal
                result = { success: true, message: "passthrough" }
                break
        }

        if (!result.success) {
            log.warn(
                `[PetriSpecExec] Simulation failed for TX ${tx.hash}, edit type=${edit.type}: ${result.message}`,
            )
            return {
                success: false,
                error: `Simulation failed: ${result.message}`,
            }
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
