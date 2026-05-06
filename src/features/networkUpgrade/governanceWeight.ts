// Shared governance weight helpers.
//
// Two call sites need to compute the snapshot weight (sum of validator
// stakes at a given block):
//   - `tallyUpgradeVotes`         — must be deterministic on every node.
//                                   Wraps the kernel in try/catch and
//                                   returns 0n on lookup failure (safe
//                                   fallback that simply rejects the
//                                   proposal at threshold check time).
//   - `governanceHandlers` (RPC)  — must surface lookup errors to the
//                                   caller so the operator notices a
//                                   broken validator-set view.
//
// The kernel is shared; each caller wraps it with its own error policy.

import GCR from "@/libs/blockchain/gcr/gcr"
import { Validators } from "@/model/entities/Validators"
import log from "@/utilities/logger"

/**
 * Parse a stake amount stored as a bigint-as-string. Defensive against
 * malformed or negative values: emits a warning and returns 0n. Used in
 * weight aggregation so a single bad row cannot corrupt the snapshot
 * total.
 */
export function safeBigInt(
    s: string | null | undefined,
    logScope = "governance",
): bigint {
    if (!s) return 0n
    let v: bigint
    try {
        v = BigInt(s)
    } catch {
        log.warning(logScope, `safeBigInt: dropping malformed weight=${s}`)
        return 0n
    }
    if (v < 0n) {
        log.warning(logScope, `safeBigInt: dropping negative weight=${s}`)
        return 0n
    }
    return v
}

/**
 * Sum `staked_amount` across every validator active at `snapshotBlock`.
 *
 * Re-throws on `GCR.getGCRValidatorsAtBlock` failure. Callers that need
 * a deterministic on-chain fallback should wrap this in try/catch and
 * substitute 0n on error. Callers serving an RPC view should let the
 * exception surface so the operator sees the problem.
 */
export async function computeSnapshotWeight(
    snapshotBlock: number,
): Promise<bigint> {
    const validators = (await GCR.getGCRValidatorsAtBlock(
        snapshotBlock,
    )) as Validators[]
    let total = 0n
    for (const v of validators) {
        total += safeBigInt(v.staked_amount)
    }
    return total
}
