import {
    getBoundCommittee,
    getEligiblePool,
} from "src/libs/consensus/v2/routines/getShard"
import { verifierThreshold } from "src/libs/consensus/v2/quorum"
import { isForkActive } from "@/forks/forkGates"
import { getSharedState } from "@/utilities/sharedState"

/** Who may sign a block at a height, and how many verified signatures it needs. */
export interface SignerRule {
    /** The bound committee under committeeBinding, else the eligible signer pool. */
    bound: boolean
    members: string[]
    threshold: number
}

/**
 * The signer rule sync applies to block `blockNumber`. Under committeeBinding
 * only the committee drawn from the chain up to the parent signs; before it,
 * any member of the eligible pool at the parent does. The bar is pinned to
 * shardSize, not to the forger's liveness view; under quorumParity it is also
 * the producer's, and committeeBinding implies the same bar, since the
 * overlap of two accepted blocks is bounded against shardSize.
 *
 * @throws when the committee or pool cannot be read
 */
export async function signerRuleOf(blockNumber: number): Promise<SignerRule> {
    const bound = isForkActive("committeeBinding", blockNumber)
    const members = bound
        ? await getBoundCommittee(blockNumber - 1)
        : await getEligiblePool(blockNumber - 1)
    const threshold = verifierThreshold(
        getSharedState.shardSize,
        members.length,
        bound || isForkActive("quorumParity", blockNumber),
    )
    return { bound, members, threshold }
}
