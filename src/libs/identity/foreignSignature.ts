import log from "src/utilities/logger"
import { getSharedState } from "src/utilities/sharedState"
import { getMetricsService } from "src/features/metrics/MetricsService"
import {
    cachedSigningRecord,
    currentSigningRecord,
    haltSigning,
    signedByThisProcess,
    signingHaltMarkerPath,
    signingRecordPath,
    type SigningRecord,
} from "./signingRecord"

export interface SignedBlock {
    number: number
    hash: string
    timestamp: number
}

export type OwnSignatureVerdict =
    | { kind: "ours" }
    | { kind: "ambiguous"; reason: string }
    | { kind: "foreign"; reason: string }

/**
 * Decide whether a block carrying a valid signature by our key could have
 * been signed by this node. Every signature this node releases is in the
 * record first, so one above the record, or a different block for the
 * recorded round, came from another holder of the key.
 */
export function judgeOwnSignature(
    block: SignedBlock,
    record: SigningRecord | null,
    genesisHash: string | null,
    signedHere: (hash: string) => boolean,
): OwnSignatureVerdict {
    // No record: a fresh node, or a chain signed before records existed.
    if (!record) return { kind: "ours" }
    // A record of another chain says nothing about this one.
    if (!genesisHash || record.genesisHash !== genesisHash) {
        return { kind: "ours" }
    }
    if (signedHere(block.hash)) return { kind: "ours" }
    if (block.number < record.height) return { kind: "ours" }
    if (block.number === record.height && block.hash === record.hash) {
        return { kind: "ours" }
    }
    const seen = `block ${block.number} (hash ${block.hash}, timestamp ${block.timestamp})`
    const last = `last recorded signature: height ${record.height}, timestamp ${record.timestamp}, hash ${record.hash}`
    if (block.number > record.height) {
        return {
            kind: "foreign",
            reason: `our key signed ${seen} above the ${last}`,
        }
    }
    // An earlier round at the recorded height may be ours from before a
    // restart: retries replace the record, and the shard can still finalise
    // the earlier block. Only a round at or after the recorded one is proof.
    if (block.timestamp < record.timestamp) {
        return {
            kind: "ambiguous",
            reason: `our key signed ${seen}, an earlier round than the ${last}`,
        }
    }
    return {
        kind: "foreign",
        reason: `our key signed ${seen}, a different block for the ${last}`,
    }
}

function countForeignSignature(): void {
    try {
        getMetricsService().incrementCounter("foreign_signature_total")
    } catch {
        // metrics must never break block verification
    }
}

/**
 * Called for a peer's block that verified with our key among its signers.
 * A signature this node never recorded means the key runs somewhere else;
 * signing stops so this copy cannot be the one that double-signs.
 */
export function checkOwnSignature(block: SignedBlock): OwnSignatureVerdict {
    const identityFile = getSharedState.identityFile
    const genesisHash = getSharedState.genesisBlockHash
    // History below the last known record is the common case on resync;
    // it needs no disk access.
    const known = cachedSigningRecord(identityFile)
    if (
        known &&
        known.genesisHash === genesisHash &&
        block.number < known.height
    ) {
        return { kind: "ours" }
    }
    let record: SigningRecord | null
    try {
        record = currentSigningRecord(identityFile)
    } catch (e) {
        // Signing already refuses an unreadable record.
        log.warning(
            `[SIGNING] cannot check block ${block.number} against the signing record: ${(e as Error).message}`,
        )
        return { kind: "ours" }
    }
    const verdict = judgeOwnSignature(
        block,
        record,
        genesisHash,
        signedByThisProcess,
    )
    if (verdict.kind === "ambiguous") {
        log.warning(`[SIGNING] ${verdict.reason}`)
    } else if (verdict.kind === "foreign") {
        countForeignSignature()
        const reason = `another process is signing with this node's key: ${verdict.reason} (record ${signingRecordPath(identityFile)})`
        if (haltSigning(reason, identityFile)) {
            log.error(
                `[SIGNING] ${reason}. Block signing is stopped, also across restarts, until ${signingHaltMarkerPath(identityFile)} is deleted: ` +
                    "stop every copy of this key and find the second host first",
            )
        }
    }
    return verdict
}
