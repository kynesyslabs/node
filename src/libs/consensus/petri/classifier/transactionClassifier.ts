/**
 * TransactionClassifier — Petri Consensus Phase 1
 *
 * Classifies incoming transactions based on whether they produce GCR state edits:
 * - Empty edits array → PRE_APPROVED (read-only: dahr, tlsn, identity attestation)
 * - Non-empty edits → TO_APPROVE (state-changing: transfers, storage, XM, etc.)
 *
 * Classification happens at validation time, gated by the petriConsensus feature flag.
 */

import type { Transaction, GCREdit } from "@kynesyslabs/demosdk/types"
import { GCRGeneration } from "@kynesyslabs/demosdk/websdk"
import { TransactionClassification } from "@/libs/consensus/petri/types/classificationTypes"
import log from "@/utilities/logger"

export interface ClassificationResult {
    classification: TransactionClassification
    gcrEdits: GCREdit[]
}

/**
 * Classify a transaction by generating its GCR edits and checking if any state changes result.
 *
 * @param tx - The validated transaction to classify
 * @param precomputedEdits - Optional pre-computed GCR edits (avoids redundant generation if already available)
 * @returns Classification result with the edits array for downstream use
 */
export async function classifyTransaction(
    tx: Transaction,
    precomputedEdits?: GCREdit[],
): Promise<ClassificationResult> {
    let gcrEdits: GCREdit[]

    if (precomputedEdits) {
        gcrEdits = precomputedEdits
    } else {
        gcrEdits = await GCRGeneration.generate(tx)
        // Clear txhash to match validation normalization
        gcrEdits.forEach((edit: GCREdit) => {
            edit.txhash = ""
        })
    }

    // Filter out fee-only edits (gas fees are always present for valid txs)
    // A tx is read-only if the ONLY edits are fee-related balance removals
    const nonFeeEdits = gcrEdits.filter((edit: GCREdit) => {
        // Fee edits are balance removals from the sender
        if (
            edit.type === "balance" &&
            edit.operation === "remove" &&
            edit.account === tx.content.from
        ) {
            return false
        }
        // Nonce increments are always present — not a state change indicator
        if (edit.type === "nonce") {
            return false
        }
        return true
    })

    if (nonFeeEdits.length === 0) {
        log.debug(
            `[PetriClassifier] TX ${tx.hash} → PRE_APPROVED (${gcrEdits.length} fee/nonce-only edits)`,
        )
        return {
            classification: TransactionClassification.PRE_APPROVED,
            gcrEdits,
        }
    }

    log.debug(
        `[PetriClassifier] TX ${tx.hash} → TO_APPROVE (${nonFeeEdits.length} state-changing edits)`,
    )
    return {
        classification: TransactionClassification.TO_APPROVE,
        gcrEdits,
    }
}
