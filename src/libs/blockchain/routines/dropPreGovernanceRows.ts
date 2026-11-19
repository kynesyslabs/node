import { LessThan, Repository } from "typeorm"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import { NetworkUpgradeVote } from "@/model/entities/NetworkUpgradeVote"
import log from "@/utilities/logger"

/**
 * Deletes the proposals and votes recorded before `networkGovernance`
 * activates at `activationHeight`.
 *
 * Until then every governance edit is refused, so such rows were written by
 * an older binary and only the nodes that kept them hold them: tallied or
 * activated, or read by the next proposal and vote checks, they would move
 * only those nodes. A row the fork admits comes from block
 * activationHeight + 1 or later and records the tip it was applied on, so
 * its snapshot or vote block is at least `activationHeight` and it stays.
 */
export default async function dropPreGovernanceRows(
    activationHeight: number,
    proposalRepo: Repository<NetworkUpgrade>,
    voteRepo: Repository<NetworkUpgradeVote>,
): Promise<{ proposals: number; votes: number }> {
    const proposals = await proposalRepo.delete({
        snapshotBlock: LessThan(activationHeight),
    })
    const votes = await voteRepo.delete({
        blockNumber: LessThan(activationHeight),
    })
    const dropped = {
        proposals: proposals.affected ?? 0,
        votes: votes.affected ?? 0,
    }
    if (dropped.proposals > 0 || dropped.votes > 0) {
        log.warning(
            "GOVERNANCE",
            `[activation] dropped ${dropped.proposals} proposal(s) and ${dropped.votes} vote(s) recorded before block ${activationHeight}`,
        )
    }
    return dropped
}
