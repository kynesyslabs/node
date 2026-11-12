// Shared governance weight helpers.
//
// Two call sites need to compute the snapshot weight (one per validator
// active at a given block):
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

/** A vote counts one seat, whatever the row's staked_amount says. */
export const SEAT_WEIGHT = "1"

/**
 * One seat per validator active at `snapshotBlock`.
 *
 * A failed validator query does not throw: `GCR.getGCRValidatorsAtBlock`
 * answers it with [], so the weight comes out 0n, the same value the
 * on-chain tally falls back to on error. Only a failure to get the
 * datasource throws.
 */
export async function computeSnapshotWeight(
    snapshotBlock: number,
): Promise<bigint> {
    const validators = (await GCR.getGCRValidatorsAtBlock(
        snapshotBlock,
    )) as Validators[]
    return BigInt(validators.length)
}
