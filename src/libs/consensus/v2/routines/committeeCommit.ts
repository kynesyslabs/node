import { verifiedSignersOf } from "@/libs/blockchain/validation/verifyBlock"
import { verifierThreshold } from "../quorum"

interface SignedBlock {
    number: number
    hash: string
    validation_data?: { signatures?: Record<string, unknown> }
}

/**
 * Why a producer must not commit `block` under committeeBinding, or null
 * when it may. The vote tally counts peers that answered pro; sync counts
 * the verified committee signatures the block carries. Checking the second
 * with sync's own counting and threshold before committing means a producer
 * never finalizes a block every syncing node would reject.
 */
export async function committeeCommitShortfall(
    block: SignedBlock,
    committee: string[],
    shardSize: number,
): Promise<string | null> {
    const signatures = block.validation_data?.signatures
    const signed =
        signatures && typeof signatures === "object"
            ? (await verifiedSignersOf(block.hash, signatures, new Set(committee))).size
            : 0
    const needed = verifierThreshold(shardSize, committee.length, true)
    if (signed >= needed) return null
    return (
        `block ${block.number} carries ${signed} verified signatures of its bound ` +
        `committee of ${committee.length}, below the ${needed} sync requires`
    )
}

/**
 * The producer's commit gate: the reason to abort instead of committing
 * `block`, or null to proceed. `committee` is the round's bound committee,
 * null before committeeBinding, when the vote tally alone decides.
 */
export async function producerCommitRefusal(
    block: SignedBlock,
    committee: string[] | null,
    shardSize: number,
): Promise<string | null> {
    if (!committee) return null
    const shortfall = await committeeCommitShortfall(block, committee, shardSize)
    return shortfall ? `Not committing: ${shortfall}` : null
}
