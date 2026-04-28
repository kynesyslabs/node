import { Repository } from "typeorm"
import Datasource from "@/model/datasource"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import type { NetworkParameters } from "@/features/networkUpgrade/types"
import log from "@/utilities/logger"

export interface ActivationOutcome {
    proposalId: string
    effectiveAtBlock: number
    applied: Partial<NetworkParameters>
}

// Order by (effectiveAtBlock, proposalId) — same activation order on every node.
export default async function applyNetworkUpgrade(
    currentBlock: number,
    proposalRepo?: Repository<NetworkUpgrade>,
): Promise<ActivationOutcome[]> {
    let repo = proposalRepo
    if (!repo) {
        const db = await Datasource.getInstance()
        repo = db.getDataSource().getRepository(NetworkUpgrade)
    }

    const due = await repo.find({
        where: { status: "activating" },
        order: { effectiveAtBlock: "ASC", proposalId: "ASC" },
    })
    const ready = due.filter(p => p.effectiveAtBlock <= currentBlock)
    if (ready.length === 0) return []

    const outcomes: ActivationOutcome[] = []
    for (const proposal of ready) {
        const patch = proposal.proposedParameters ?? {}
        proposal.status = "active"
        await repo.save(proposal)
        outcomes.push({
            proposalId: proposal.proposalId,
            effectiveAtBlock: proposal.effectiveAtBlock,
            applied: patch,
        })
        log.info(
            "GOVERNANCE",
            `[activate] ${proposal.proposalId} (effectiveAtBlock=${proposal.effectiveAtBlock}): ${JSON.stringify(patch)}`,
        )
    }
    return outcomes
}
