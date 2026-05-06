import type { Transaction } from "@kynesyslabs/demosdk/types"
import type {
    NetworkUpgradePayload,
    NetworkUpgradeVotePayload,
} from "@kynesyslabs/demosdk/types"
import Chain from "@/libs/blockchain/chain"
import GCR from "@/libs/blockchain/gcr/gcr"
import Datasource from "@/model/datasource"
import { NetworkUpgrade } from "@/model/entities/NetworkUpgrade"
import { NetworkUpgradeVote } from "@/model/entities/NetworkUpgradeVote"
import { Validators } from "@/model/entities/Validators"
import {
    getGenesisNetworkParameters,
    GRACE_PERIOD_BLOCKS,
    MAX_RATIONALE_LENGTH,
    PHASE_1_GOVERNABLE_KEYS,
    VOTING_WINDOW_BLOCKS,
} from "@/features/networkUpgrade/constants"
import { checkSafetyBounds } from "@/features/networkUpgrade/safetyBounds"
import type { NetworkParameters } from "@/features/networkUpgrade/types"
import { getSharedState } from "@/utilities/sharedState"
import { VALIDATOR_STATUS_ACTIVE } from "@/features/staking/constants"
import {
    canonicalAddress,
    requireSender,
} from "@/libs/network/utils/txHelpers"
import log from "@/utilities/logger"
import { In } from "typeorm"

interface GovernanceTxResult {
    success: boolean
    message: string
}

// Validation only. Persistence happens at block-confirmation in
// GCRNetworkUpgradeRoutines so it replicates atomically on every node.
export async function handleGovernanceTx(
    tx: Transaction,
): Promise<GovernanceTxResult> {
    const type = tx.content.type
    const sender = requireSender(tx)
    if (!sender) return { success: false, message: "Missing sender" }

    switch (type) {
        case "networkUpgrade":
            return handleUpgradeProposal(tx, sender)
        case "networkUpgradeVote":
            return handleUpgradeVote(tx, sender)
        default:
            return {
                success: false,
                message: `Unknown governance tx type: ${type}`,
            }
    }
}

// ------------------------------------------------------------------
// Proposal
// ------------------------------------------------------------------

async function handleUpgradeProposal(
    tx: Transaction,
    sender: string,
): Promise<GovernanceTxResult> {
    const payload = extractProposalPayload(tx)
    if (!payload) {
        return { success: false, message: "Missing proposal payload" }
    }
    if (!payload.proposalId || typeof payload.proposalId !== "string") {
        return { success: false, message: "Invalid proposalId" }
    }
    if (
        typeof payload.rationale !== "string" ||
        Buffer.byteLength(payload.rationale, "utf8") > MAX_RATIONALE_LENGTH
    ) {
        return {
            success: false,
            message: `rationale must be <= ${MAX_RATIONALE_LENGTH} bytes`,
        }
    }
    if (
        !payload.proposedParameters ||
        typeof payload.proposedParameters !== "object" ||
        Object.keys(payload.proposedParameters).length === 0
    ) {
        return {
            success: false,
            message: "proposedParameters must be a non-empty object",
        }
    }

    const validator = await GCR.getGCRValidatorStatus(sender)
    if (!validator || validator.status !== VALIDATOR_STATUS_ACTIVE) {
        return {
            success: false,
            message: "Proposer is not an active validator",
        }
    }

    if (
        typeof payload.effectiveAtBlock !== "number" ||
        !Number.isInteger(payload.effectiveAtBlock) ||
        payload.effectiveAtBlock <= 0
    ) {
        return {
            success: false,
            message: "effectiveAtBlock must be a positive integer",
        }
    }
    const currentBlock = await Chain.getLastBlockNumber()
    const minEffective =
        currentBlock + VOTING_WINDOW_BLOCKS + GRACE_PERIOD_BLOCKS
    if (payload.effectiveAtBlock < minEffective) {
        return {
            success: false,
            message: `effectiveAtBlock must be >= ${minEffective}`,
        }
    }

    const current =
        (getSharedState.networkParameters as NetworkParameters | null) ??
        getGenesisNetworkParameters()
    const bounds = checkSafetyBounds(current, payload.proposedParameters)
    if (bounds.ok === false) {
        return {
            success: false,
            message: `Safety bounds violated [${bounds.key}]: ${bounds.reason}`,
        }
    }

    const db = await Datasource.getInstance()
    const repo = db.getDataSource().getRepository(NetworkUpgrade)

    const pendingByProposer = await repo.findOne({
        where: {
            proposerPublicKey: sender,
            status: In(["pending", "approved", "activating"]),
        },
    })
    if (pendingByProposer) {
        return {
            success: false,
            message: "Proposer already has an open proposal",
        }
    }

    const duplicateId = await repo.findOneBy({ proposalId: payload.proposalId })
    if (duplicateId) {
        return { success: false, message: "proposalId already exists" }
    }

    const openProposals = await repo.find({
        where: { status: In(["pending", "approved", "activating"]) },
    })
    const proposedKeys = new Set(Object.keys(payload.proposedParameters))
    for (const open of openProposals) {
        for (const k of Object.keys(open.proposedParameters ?? {})) {
            if (proposedKeys.has(k)) {
                return {
                    success: false,
                    message: `parameter ${k} is locked by proposal ${open.proposalId}`,
                }
            }
        }
    }

    for (const k of proposedKeys) {
        if (!PHASE_1_GOVERNABLE_KEYS.has(k as keyof NetworkParameters)) {
            return {
                success: false,
                message: `parameter ${k} is not governable in Phase 1`,
            }
        }
    }

    log.info(
        "GOVERNANCE",
        `[proposal] ${payload.proposalId} by ${sender}: validated, effective=${payload.effectiveAtBlock}`,
    )
    return { success: true, message: "Proposal accepted" }
}

// ------------------------------------------------------------------
// Vote
// ------------------------------------------------------------------

async function handleUpgradeVote(
    tx: Transaction,
    sender: string,
): Promise<GovernanceTxResult> {
    const payload = extractVotePayload(tx)
    if (!payload) {
        return { success: false, message: "Missing vote payload" }
    }

    const db = await Datasource.getInstance()
    const proposalRepo = db.getDataSource().getRepository(NetworkUpgrade)
    const voteRepo = db.getDataSource().getRepository(NetworkUpgradeVote)

    const proposal = await proposalRepo.findOneBy({
        proposalId: payload.proposalId,
    })
    if (!proposal) {
        return { success: false, message: "Proposal not found" }
    }
    if (proposal.status !== "pending") {
        return {
            success: false,
            message: `Proposal not open for voting (status=${proposal.status})`,
        }
    }

    const currentBlock = await Chain.getLastBlockNumber()
    if (currentBlock > proposal.tallyBlock) {
        return {
            success: false,
            message: `Voting window closed at block ${proposal.tallyBlock}`,
        }
    }
    if (currentBlock <= proposal.snapshotBlock) {
        return {
            success: false,
            message: "Voting window has not opened yet",
        }
    }

    const snapshotValidators =
        (await GCR.getGCRValidatorsAtBlock(
            proposal.snapshotBlock,
        )) as Validators[]
    const voterInSnapshot = snapshotValidators.find(v => v.address === sender)
    if (!voterInSnapshot) {
        return {
            success: false,
            message: "Voter is not in the snapshot validator set",
        }
    }

    const existing = await voteRepo.findOne({
        where: {
            proposalId: payload.proposalId,
            voterAddress: sender,
        },
    })
    if (existing) {
        return { success: false, message: "Validator already voted" }
    }

    log.info(
        "GOVERNANCE",
        `[vote] ${sender} → ${payload.proposalId} approve=${payload.approve} — validated`,
    )
    return { success: true, message: "Vote recorded" }
}

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

function extractProposalPayload(
    tx: Transaction,
): NetworkUpgradePayload | null {
    const data = tx.content?.data as unknown as [string, unknown] | undefined
    if (!Array.isArray(data) || data.length < 2) return null
    const p = data[1]
    if (!p || typeof p !== "object") return null
    return p as NetworkUpgradePayload
}

function extractVotePayload(
    tx: Transaction,
): NetworkUpgradeVotePayload | null {
    const data = tx.content?.data as unknown as [string, unknown] | undefined
    if (!Array.isArray(data) || data.length < 2) return null
    const p = data[1] as Partial<NetworkUpgradeVotePayload> | null
    if (!p || typeof p.proposalId !== "string") return null
    if (typeof p.approve !== "boolean") return null
    return p as NetworkUpgradeVotePayload
}


