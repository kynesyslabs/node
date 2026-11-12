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
import {
    getGenesisNetworkParameters,
    GRACE_PERIOD_BLOCKS,
    MAX_RATIONALE_LENGTH,
    VOTING_WINDOW_BLOCKS,
} from "@/features/networkUpgrade/constants"
import { checkSafetyBounds } from "@/features/networkUpgrade/safetyBounds"
import { SEAT_WEIGHT } from "@/features/networkUpgrade/governanceWeight"
import type { NetworkParameters } from "@/features/networkUpgrade/types"
import { VALIDATOR_STATUS_ACTIVE } from "@/features/staking/constants"
import { getSharedState } from "@/utilities/sharedState"
import { canonicalAddress } from "@/libs/network/utils/txHelpers"
import type { GCRResult } from "src/libs/blockchain/gcr/handleGCR"
import log from "src/utilities/logger"
import { readState } from "@/libs/blockchain/gcr/stateReadError"

// Server-derived fields filled in here (NOT carried in the edit):
//   proposal: version, snapshotBlock, tallyBlock
//   vote:     weight (from snapshot validator set), blockNumber
export default class GCRNetworkUpgradeRoutines {
    static async applyProposal(
        edit: GCREdit,
        repo?: Repository<NetworkUpgrade>,
        currentBlock?: number,
        stagedValidators?: Map<string, Validators | null>,
    ): Promise<GCRResult> {
        const e = edit as unknown as GCREditNetworkUpgrade
        if (e.type !== "networkUpgrade") {
            return { success: false, message: "Invalid GCREdit type" }
        }
        // Before the lookup: an undefined id there matches any row, which
        // would report a malformed proposal as already persisted.
        if (typeof e.proposalId !== "string" || e.proposalId === "") {
            return { success: false, message: "Invalid proposalId" }
        }
        // Canonicalise the proposer key before persistence so RPC reads
        // (which match against the lower-cased sender) line up.
        const proposerKey = canonicalAddress(e.account)
        const resolved =
            repo ??
            (await readState("datasource", async () =>
                (await Datasource.getInstance())
                    .getDataSource()
                    .getRepository(NetworkUpgrade),
            ))

        // Idempotent on duplicate proposalId.
        const existing = await readState("proposal", () =>
            resolved.findOneBy({ proposalId: e.proposalId }),
        )
        if (existing) {
            return {
                success: true,
                message: `Proposal ${e.proposalId} already persisted`,
            }
        }

        const refusal = await proposalRefusal(e, proposerKey, stagedValidators)
        if (refusal) {
            log.warning(
                "GOVERNANCE",
                `[gcr-edit] proposal ${e.proposalId} rejected: ${refusal}`,
            )
            return { success: false, message: refusal }
        }

        const open = await readState("open proposals", () =>
            resolved.find({
                where: { status: In(["pending", "approved", "activating"]) },
            }),
        )
        if (open.some(o => canonicalAddress(o.proposerPublicKey) === proposerKey)) {
            return {
                success: false,
                message: "Proposer already has an open proposal",
            }
        }

        // First proposal in block order wins the key — same on every node.
        const proposedKeys = Object.keys(e.proposedParameters ?? {})
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

        // Caller-provided block context > chain tip: when this runs as
        // part of applying block N, Chain.getLastBlockNumber() may return
        // N-1 (block not yet committed) and snapshotBlock would drift.
        const snapshotBlock =
            currentBlock ??
            (await readState("chain tip", () => Chain.getLastBlockNumber()))
        const tallyBlock = snapshotBlock + VOTING_WINDOW_BLOCKS
        // Re-validate effectiveAtBlock against the server-computed snapshotBlock.
        // RPC validation only checks the invariant against the chain tip at
        // submission time; mempool delay can leave a stale effectiveAtBlock
        // that violates the grace-period floor at confirmation time.
        const minEffectiveAtBlock = tallyBlock + GRACE_PERIOD_BLOCKS
        if (e.effectiveAtBlock < minEffectiveAtBlock) {
            log.warning(
                "GOVERNANCE",
                `[gcr-edit] proposal ${e.proposalId} rejected: effectiveAtBlock=${e.effectiveAtBlock} < minEffective=${minEffectiveAtBlock} (snapshot=${snapshotBlock} tally=${tallyBlock} +grace=${GRACE_PERIOD_BLOCKS})`,
            )
            return {
                success: false,
                message: `effectiveAtBlock ${e.effectiveAtBlock} below minimum ${minEffectiveAtBlock} (snapshot+window+grace)`,
            }
        }
        const nextVersion = await readState("proposal version", () =>
            computeNextVersion(resolved),
        )

        const row = resolved.create({
            proposalId: e.proposalId,
            version: nextVersion,
            proposerPublicKey: proposerKey,
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
        currentBlock?: number,
    ): Promise<GCRResult> {
        const e = edit as unknown as GCREditNetworkUpgradeVote
        if (e.type !== "networkUpgradeVote") {
            return { success: false, message: "Invalid GCREdit type" }
        }
        // Canonicalise voter address for both the snapshot lookup and the
        // persisted row so RPC reads (which lower-case the sender) match.
        const voterAddress = canonicalAddress(e.account)
        let votes = voteRepo
        let proposals = proposalRepo
        if (typeof e.proposalId !== "string" || e.proposalId === "") {
            return { success: false, message: "Invalid proposalId" }
        }
        if (!votes || !proposals) {
            const db = await readState("datasource", () => Datasource.getInstance())
            votes ??= db.getDataSource().getRepository(NetworkUpgradeVote)
            proposals ??= db.getDataSource().getRepository(NetworkUpgrade)
        }

        const existing = await readState("vote", () =>
            votes.findOne({
                where: {
                    proposalId: e.proposalId,
                    voterAddress,
                },
            }),
        )
        if (existing) {
            return {
                success: true,
                message: `Vote ${voterAddress}→${e.proposalId} already persisted`,
            }
        }

        const proposal = await readState("proposal", () =>
            proposals.findOneBy({
                proposalId: e.proposalId,
            }),
        )
        if (!proposal) {
            // Should have been rejected at RPC entry; skip silently here
            // so a leaked vote doesn't break block confirmation.
            return {
                success: true,
                message: `Vote skipped: proposal ${e.proposalId} not found`,
            }
        }
        if (proposal.status !== "pending") {
            return {
                success: true,
                message: `Vote skipped: proposal ${e.proposalId} status=${proposal.status}, voting closed`,
            }
        }
        const blockNumber =
            currentBlock ??
            (await readState("chain tip", () => Chain.getLastBlockNumber()))

        // Voter must be in the snapshot validator set; a vote counts one seat.
        // Validator rows are stored lower-cased (see GCRValidatorStakeRoutines)
        // so the comparison uses the canonical voter address.
        const snapshotValidators = (await readState("snapshot validators", () =>
            GCR.getGCRValidatorsAtBlockOrThrow(proposal.snapshotBlock),
        )) as Validators[]
        const v = snapshotValidators.find(x => x.address === voterAddress)
        if (!v) {
            return {
                success: true,
                message: `Vote skipped: ${voterAddress} not in snapshot validator set for ${e.proposalId}`,
            }
        }
        const weight = SEAT_WEIGHT

        const row = votes.create({
            proposalId: e.proposalId,
            voterAddress,
            approve: e.approve,
            weight,
            blockNumber,
        })
        await votes.save(row)
        log.info(
            "GOVERNANCE",
            `[gcr-edit] vote ${voterAddress} → ${e.proposalId} approve=${e.approve} weight=${weight}`,
        )
        return { success: true, message: "Vote persisted" }
    }
}

/**
 * The proposal checks RPC intake runs, run again where the proposal is
 * applied: a proposal that reached a block without passing them (another
 * node's intake, a crafted block) is refused the same way on every node.
 */
async function proposalRefusal(
    e: GCREditNetworkUpgrade,
    proposerKey: string,
    stagedValidators?: Map<string, Validators | null>,
): Promise<string | null> {
    if (typeof e.proposalId !== "string" || e.proposalId === "") {
        return "Invalid proposalId"
    }
    if (
        typeof e.rationale !== "string" ||
        Buffer.byteLength(e.rationale, "utf8") > MAX_RATIONALE_LENGTH
    ) {
        return `rationale must be <= ${MAX_RATIONALE_LENGTH} bytes`
    }
    if (
        typeof e.effectiveAtBlock !== "number" ||
        !Number.isInteger(e.effectiveAtBlock) ||
        e.effectiveAtBlock <= 0
    ) {
        return "effectiveAtBlock must be a positive integer"
    }
    const proposed = e.proposedParameters
    if (
        !proposed ||
        typeof proposed !== "object" ||
        Array.isArray(proposed) ||
        Object.keys(proposed).length === 0
    ) {
        return "proposedParameters must be a non-empty object"
    }

    // Also refuses a key that is not governable.
    const current =
        (getSharedState.networkParameters as NetworkParameters | null) ??
        getGenesisNetworkParameters()
    const bounds = checkSafetyBounds(
        current,
        proposed as Partial<NetworkParameters>,
    )
    if (bounds.ok === false) {
        return `Safety bounds violated [${bounds.key}]: ${bounds.reason}`
    }

    // A stake edit earlier in the block (an unstake, say) wins over the saved row.
    const validator = stagedValidators?.has(proposerKey)
        ? stagedValidators.get(proposerKey)
        : await GCR.getGCRValidatorStatus(proposerKey, null, true)
    if (!validator || validator.status !== VALIDATOR_STATUS_ACTIVE) {
        return "Proposer is not an active validator"
    }
    return null
}

async function computeNextVersion(
    repo: Repository<NetworkUpgrade>,
): Promise<number> {
    return ((await repo.maximum("version")) ?? 0) + 1
}
