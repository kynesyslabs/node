import { Repository } from "typeorm"
import Datasource from "@/model/datasource"
import GCR from "@/libs/blockchain/gcr/gcr"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import { NetworkUpgradeVote } from "@/model/entities/NetworkUpgradeVote"
import { Validators } from "@/model/entities/Validators"
import {
    SUPERMAJORITY_DENOMINATOR,
    SUPERMAJORITY_NUMERATOR,
} from "@/features/networkUpgrade/constants"
import log from "@/utilities/logger"

export interface TallyOutcome {
    proposalId: string
    approveWeight: bigint
    snapshotWeight: bigint
    threshold: bigint
    status: "approved" | "rejected"
}

// Spec v2 §3 names four statuses (pending → approved → activating → active);
// we collapse approved+activating into one `activating` to save a DB write.
// SDK `ProposalStatus` still exposes all four for forward compat.
export default async function tallyUpgradeVotes(
    currentBlock: number,
    proposalRepo?: Repository<NetworkUpgrade>,
    voteRepo?: Repository<NetworkUpgradeVote>,
): Promise<TallyOutcome[]> {
    let upgrades = proposalRepo
    let votes = voteRepo
    if (!upgrades || !votes) {
        const db = await Datasource.getInstance()
        upgrades ??= db.getDataSource().getRepository(NetworkUpgrade)
        votes ??= db.getDataSource().getRepository(NetworkUpgradeVote)
    }

    const due = await upgrades.find({
        where: { status: "pending", tallyBlock: currentBlock },
    })
    if (due.length === 0) return []

    const outcomes: TallyOutcome[] = []
    for (const proposal of due) {
        const snapshotWeight = await computeSnapshotWeight(
            proposal.snapshotBlock,
        )
        const voteRows = await votes.find({
            where: { proposalId: proposal.proposalId },
        })
        let approve = 0n
        for (const v of voteRows) {
            if (v.approve) approve += safeBigInt(v.weight)
        }
        // Ceiling division so threshold meets/exceeds 2/3 even when
        // snapshotWeight isn't divisible by 3 — floor would let proposals
        // pass below the supermajority bar.
        const threshold = ceilDiv(
            snapshotWeight * SUPERMAJORITY_NUMERATOR,
            SUPERMAJORITY_DENOMINATOR,
        )
        const passed = snapshotWeight > 0n && approve >= threshold

        if (passed) {
            proposal.status = "activating"
            log.info(
                "GOVERNANCE",
                `[tally] ${proposal.proposalId} APPROVED: approve=${approve}/${snapshotWeight} (threshold=${threshold}) → activating until block ${proposal.effectiveAtBlock}`,
            )
        } else {
            proposal.status = "rejected"
            log.info(
                "GOVERNANCE",
                `[tally] ${proposal.proposalId} REJECTED: approve=${approve}/${snapshotWeight} (threshold=${threshold})`,
            )
        }
        await upgrades.save(proposal)
        outcomes.push({
            proposalId: proposal.proposalId,
            approveWeight: approve,
            snapshotWeight,
            threshold,
            status: passed ? "approved" : "rejected",
        })
    }
    return outcomes
}

async function computeSnapshotWeight(snapshotBlock: number): Promise<bigint> {
    try {
        const validators = (await GCR.getGCRValidatorsAtBlock(
            snapshotBlock,
        )) as Validators[]
        let total = 0n
        for (const v of validators) total += safeBigInt(v.staked_amount)
        return total
    } catch (e) {
        log.error(
            "GOVERNANCE",
            `[tally] snapshot weight(${snapshotBlock}) failed: ${(e as Error).message}`,
        )
        return 0n
    }
}

function ceilDiv(num: bigint, den: bigint): bigint {
    return (num + den - 1n) / den
}

function safeBigInt(s: string | null | undefined): bigint {
    if (!s) return 0n
    let v: bigint
    try {
        v = BigInt(s)
    } catch {
        log.warning("GOVERNANCE", `[tally] dropping malformed weight=${s}`)
        return 0n
    }
    if (v < 0n) {
        log.warning("GOVERNANCE", `[tally] dropping negative weight=${s}`)
        return 0n
    }
    return v
}
