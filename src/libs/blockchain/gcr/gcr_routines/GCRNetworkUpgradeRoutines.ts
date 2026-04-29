import type { GCREdit } from "@kynesyslabs/demosdk/types"
import type {
    GCREditNetworkUpgrade,
    GCREditNetworkUpgradeVote,
} from "@kynesyslabs/demosdk/types"
import { In, Repository } from "typeorm"
import Datasource from "@/model/datasource"
import Chain from "@/libs/blockchain/chain"
import GCR from "@/libs/blockchain/gcr/gcr"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import { NetworkUpgradeVote } from "@/model/entities/NetworkUpgradeVote"
import { Validators } from "@/model/entities/Validators"
import { VOTING_WINDOW_BLOCKS } from "@/features/networkUpgrade/constants"
import type { GCRResult } from "src/libs/blockchain/gcr/handleGCR"
import log from "src/utilities/logger"

// Server-derived fields filled in here (NOT carried in the edit):
//   proposal: version, snapshotBlock, tallyBlock
//   vote:     weight (from snapshot validator set), blockNumber
export default class GCRNetworkUpgradeRoutines {
    static async applyProposal(
        edit: GCREdit,
        repo?: Repository<NetworkUpgrade>,
    ): Promise<GCRResult> {
        const e = edit as unknown as GCREditNetworkUpgrade
        if (e.type !== "networkUpgrade") {
            return { success: false, message: "Invalid GCREdit type" }
        }
        const resolved =
            repo ??
            (await Datasource.getInstance())
                .getDataSource()
                .getRepository(NetworkUpgrade)

        // Idempotent on duplicate proposalId.
        const existing = await resolved.findOneBy({ proposalId: e.proposalId })
        if (existing) {
            return {
                success: true,
                message: `Proposal ${e.proposalId} already persisted`,
            }
        }

        // First proposal in block order wins the key — same on every node.
        const proposedKeys = Object.keys(e.proposedParameters ?? {})
        const open = await resolved.find({
            where: { status: In(["pending", "approved", "activating"]) },
        })
        for (const o of open) {
            for (const k of Object.keys(o.proposedParameters ?? {})) {
                if (proposedKeys.includes(k)) {
                    log.info(
                        "GOVERNANCE",
                        `[gcr-edit] proposal ${e.proposalId} skipped — key '${k}' locked by ${o.proposalId}`,
                    )
                    return {
                        success: true,
                        message: `Skipped: parameter ${k} locked by ${o.proposalId}`,
                    }
                }
            }
        }

        const snapshotBlock = await Chain.getLastBlockNumber()
        const tallyBlock = snapshotBlock + VOTING_WINDOW_BLOCKS
        const nextVersion = await computeNextVersion(resolved)

        const row = resolved.create({
            proposalId: e.proposalId,
            version: nextVersion,
            proposerPublicKey: e.account,
            proposedParameters: e.proposedParameters,
            status: "pending",
            snapshotBlock,
            tallyBlock,
            effectiveAtBlock: e.effectiveAtBlock,
            rationale: e.rationale,
        })
        await resolved.save(row)
        log.info(
            "GOVERNANCE",
            `[gcr-edit] proposal ${e.proposalId} v${nextVersion} persisted: snapshot=${snapshotBlock} tally=${tallyBlock} effective=${e.effectiveAtBlock}`,
        )
        return { success: true, message: "Proposal persisted" }
    }

    static async applyVote(
        edit: GCREdit,
        voteRepo?: Repository<NetworkUpgradeVote>,
        proposalRepo?: Repository<NetworkUpgrade>,
    ): Promise<GCRResult> {
        const e = edit as unknown as GCREditNetworkUpgradeVote
        if (e.type !== "networkUpgradeVote") {
            return { success: false, message: "Invalid GCREdit type" }
        }
        let votes = voteRepo
        let proposals = proposalRepo
        if (!votes || !proposals) {
            const db = await Datasource.getInstance()
            votes ??= db.getDataSource().getRepository(NetworkUpgradeVote)
            proposals ??= db.getDataSource().getRepository(NetworkUpgrade)
        }

        const existing = await votes.findOne({
            where: {
                proposalId: e.proposalId,
                voterAddress: e.account,
            },
        })
        if (existing) {
            return {
                success: true,
                message: `Vote ${e.account}→${e.proposalId} already persisted`,
            }
        }

        const proposal = await proposals.findOneBy({
            proposalId: e.proposalId,
        })
        if (!proposal) {
            // Should have been rejected at RPC entry; skip silently here
            // so a leaked vote doesn't break block confirmation.
            return {
                success: true,
                message: `Vote skipped: proposal ${e.proposalId} not found`,
            }
        }
        const blockNumber = await Chain.getLastBlockNumber()

        // Voter must be in the snapshot validator set; otherwise the vote
        // would be persisted with weight="0", contaminating tallies.
        const snapshotValidators = (await GCR.getGCRValidatorsAtBlock(
            proposal.snapshotBlock,
        )) as Validators[]
        const v = snapshotValidators.find(x => x.address === e.account)
        if (!v || !v.staked_amount) {
            return {
                success: true,
                message: `Vote skipped: ${e.account} not in snapshot validator set for ${e.proposalId}`,
            }
        }
        const weight = v.staked_amount

        const row = votes.create({
            proposalId: e.proposalId,
            voterAddress: e.account,
            approve: e.approve,
            weight,
            blockNumber,
        })
        await votes.save(row)
        log.info(
            "GOVERNANCE",
            `[gcr-edit] vote ${e.account} → ${e.proposalId} approve=${e.approve} weight=${weight}`,
        )
        return { success: true, message: "Vote persisted" }
    }
}

async function computeNextVersion(
    repo: Repository<NetworkUpgrade>,
): Promise<number> {
    const row = await repo
        .createQueryBuilder("u")
        .select("MAX(u.version)", "max")
        .getRawOne<{ max: number | null }>()
    return (row?.max ?? 0) + 1
}
