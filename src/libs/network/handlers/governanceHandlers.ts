import Datasource from "@/model/datasource"
import GCR from "@/libs/blockchain/gcr/gcr"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import { NetworkUpgradeVote } from "@/model/entities/NetworkUpgradeVote"
import { Validators } from "@/model/entities/Validators"
import { getSharedState } from "@/utilities/sharedState"
import {
    getGenesisNetworkParameters,
    SUPERMAJORITY_DENOMINATOR,
    SUPERMAJORITY_NUMERATOR,
} from "@/features/networkUpgrade/constants"
import type {
    NetworkParameters,
    ProposalVoteInfo,
} from "@/features/networkUpgrade/types"
import log from "@/utilities/logger"
import { In } from "typeorm"
import type { NodeCallHandler } from "./types"

/**
 * Phase-1 RPC surface for on-chain governance.
 *
 * Reads are split between shared state (`getNetworkParameters` — already
 * folded by `loadNetworkParameters()` at startup) and the NetworkUpgrade /
 * NetworkUpgradeVote tables (proposal lifecycle + tally).
 */
export const governanceHandlers: Record<string, NodeCallHandler> = {
    /** Current active NetworkParameters. */
    getNetworkParameters: async (_data, response) => {
        response.response =
            (getSharedState.networkParameters as NetworkParameters | null) ??
            getGenesisNetworkParameters()
        return response
    },

    /** Open proposals — pending tally or approved/activating. */
    getActiveProposals: async (_data, response) => {
        try {
            const db = await Datasource.getInstance()
            const repo = db.getDataSource().getRepository(NetworkUpgrade)
            const rows = await repo.find({
                where: { status: In(["pending", "approved", "activating"]) },
                order: { effectiveAtBlock: "ASC", proposalId: "ASC" },
            })
            response.response = rows.map(serializeProposal)
        } catch (e) {
            log.error(
                "governanceHandlers",
                `getActiveProposals: ${(e as Error).message}`,
            )
            response.result = 500
            response.response = { error: "failed to load proposals" }
        }
        return response
    },

    /** Live tally for a specific proposalId. Null if proposal not found. */
    getProposalVotes: async (data, response) => {
        const proposalId = extractProposalId(data)
        if (!proposalId) {
            response.result = 400
            response.response = { error: "proposalId required" }
            return response
        }

        try {
            const db = await Datasource.getInstance()
            const proposalRepo = db
                .getDataSource()
                .getRepository(NetworkUpgrade)
            const voteRepo = db
                .getDataSource()
                .getRepository(NetworkUpgradeVote)

            const proposal = await proposalRepo.findOneBy({ proposalId })
            if (!proposal) {
                response.response = null
                return response
            }

            const voteRows = await voteRepo.find({ where: { proposalId } })
            const snapshotWeight = await computeSnapshotWeight(
                proposal.snapshotBlock,
            )
            response.response = tallyVotes(
                proposalId,
                voteRows,
                snapshotWeight,
            )
        } catch (e) {
            log.error(
                "governanceHandlers",
                `getProposalVotes: ${(e as Error).message}`,
            )
            response.result = 500
            response.response = { error: "failed to load votes" }
        }
        return response
    },

    /** Historical record — proposals that reached `active`. */
    getUpgradeHistory: async (_data, response) => {
        try {
            const db = await Datasource.getInstance()
            const repo = db.getDataSource().getRepository(NetworkUpgrade)
            const rows = await repo.find({
                where: { status: "active" },
                order: { effectiveAtBlock: "ASC", proposalId: "ASC" },
            })
            response.response = rows.map(serializeProposal)
        } catch (e) {
            log.error(
                "governanceHandlers",
                `getUpgradeHistory: ${(e as Error).message}`,
            )
            response.result = 500
            response.response = { error: "failed to load history" }
        }
        return response
    },
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

function extractProposalId(data: unknown): string | null {
    if (typeof data === "string") return data
    if (data && typeof data === "object") {
        const v = (data as { proposalId?: unknown }).proposalId
        if (typeof v === "string" && v.length > 0) return v
    }
    return null
}

function serializeProposal(p: NetworkUpgrade) {
    return {
        proposalId: p.proposalId,
        version: p.version,
        proposerPublicKey: p.proposerPublicKey,
        proposedParameters: p.proposedParameters,
        rationale: p.rationale,
        status: p.status,
        snapshotBlock: p.snapshotBlock,
        tallyBlock: p.tallyBlock,
        effectiveAtBlock: p.effectiveAtBlock,
    }
}

/**
 * Tally recomputation — always re-derived from stored vote rows (per v2 spec
 * §3 "tally is always re-derived from on-chain votes, never cached").
 *
 * `snapshotTotalWeight` is the total staked weight of ALL validators at the
 * proposal's snapshotBlock. Abstentions count as NO: the threshold is
 * `(2/3) * snapshotTotalWeight`, NOT `(2/3) * (approve + reject)`. If the
 * caller can't supply the snapshot total (for progress-only views), they
 * may pass null and the function falls back to voted-weight-only arithmetic.
 */
export function tallyVotes(
    proposalId: string,
    votes: NetworkUpgradeVote[],
    snapshotTotalWeight: bigint | null = null,
): ProposalVoteInfo {
    let approveWeight = 0n
    let rejectWeight = 0n
    for (const v of votes) {
        const w = safeBigInt(v.weight)
        if (v.approve) approveWeight += w
        else rejectWeight += w
    }
    const totalForThreshold =
        snapshotTotalWeight ?? approveWeight + rejectWeight
    // Ceiling division — must agree with tallyUpgradeVotes.
    const threshold =
        (totalForThreshold * SUPERMAJORITY_NUMERATOR +
            SUPERMAJORITY_DENOMINATOR -
            1n) /
        SUPERMAJORITY_DENOMINATOR
    return {
        proposalId,
        totalStakedWeight: totalForThreshold.toString(),
        approveWeight: approveWeight.toString(),
        rejectWeight: rejectWeight.toString(),
        votes: votes.map(v => ({
            voter: v.voterAddress,
            approve: v.approve,
            weight: v.weight,
        })),
        threshold: threshold.toString(),
        passed: approveWeight >= threshold && totalForThreshold > 0n,
    }
}

/**
 * Sums `staked_amount` across every validator that was active at
 * `snapshotBlock`. This is what the governance system calls "total staked
 * weight" for threshold math.
 */
async function computeSnapshotWeight(
    snapshotBlock: number,
): Promise<bigint> {
    // Throws on validator-set lookup failure so callers can surface the
    // error instead of silently producing a passed-with-zero-weight tally.
    const validators =
        (await GCR.getGCRValidatorsAtBlock(snapshotBlock)) as Validators[]
    let total = 0n
    for (const v of validators) {
        total += safeBigInt(v.staked_amount)
    }
    return total
}

function safeBigInt(s: string | null | undefined): bigint {
    if (!s) return 0n
    let v: bigint
    try {
        v = BigInt(s)
    } catch {
        log.warning(
            "governanceHandlers",
            `safeBigInt: dropping malformed weight=${s}`,
        )
        return 0n
    }
    if (v < 0n) {
        log.warning(
            "governanceHandlers",
            `safeBigInt: dropping negative weight=${s}`,
        )
        return 0n
    }
    return v
}
