import { domainDigest } from "@/libs/atomic-work/digest"
import { atomicWorkProfile } from "@/libs/atomic-work/profile"

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * What a block commits to when it commits to a receipt.
 *
 * The commitment covers the receipt with its non-committed and
 * self-referential fields projected out: the commitment itself, finality
 * evidence, the block id, business-state evidence and slot-state evidence —
 * all of which are only knowable after the commit, so binding them would be
 * circular. A profile removes whatever else its own receipt embeds, through
 * `projectReceiptCore`.
 *
 * The input receipt is not mutated.
 */
export function computeReceiptCommitment(
    receipt: Record<string, unknown>,
    domain: string,
): string {
    const core = structuredClone(receipt) as Record<string, unknown>
    delete core.receiptCommitment
    delete core.finalityEvidence

    if (isPlainObject(core.blockRef)) delete core.blockRef.id
    if (isPlainObject(core.businessState)) delete core.businessState.evidence
    delete core.slotStateEvidence

    atomicWorkProfile(core.profile as string | undefined)?.projectReceiptCore?.(core)

    return domainDigest(domain, core)
}
