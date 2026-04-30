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

    // Atomicity here comes from the caller's wrapping transaction
    // (chainBlocks.insertBlock passes a transactionalEntityManager-scoped
    // repo). A batched save further guarantees no partial activation set
    // inside this routine: either all `ready` rows flip to active or none.
    const outcomes: ActivationOutcome[] = ready.map(p => ({
        proposalId: p.proposalId,
        effectiveAtBlock: p.effectiveAtBlock,
        applied: p.proposedParameters ?? {},
    }))
    for (const p of ready) p.status = "active"
    await repo.save(ready)
    for (const o of outcomes) {
        log.info(
            "GOVERNANCE",
            `[activate] ${o.proposalId} (effectiveAtBlock=${o.effectiveAtBlock}): ${JSON.stringify(o.applied)}`,
        )
    }
    return outcomes
}
