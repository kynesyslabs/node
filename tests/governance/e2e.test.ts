// End-to-end integration: stake → propose → vote → tally → activate →
// sharedState updated → unstake → exit.
//
// Exercises the full Phase 0 + Phase 1 wiring without a real database —
// both governance repos and the Validators repo are in-memory fakes; the
// tally / apply routines operate on those fakes exactly as they would on
// TypeORM repositories. This is the "one big happy path" test; targeted
// unit tests cover branch coverage separately.

import {
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    jest,
} from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: {
        info: jest.fn(),
        debug: jest.fn(),
        warning: jest.fn(),
        error: jest.fn(),
        custom: jest.fn(),
    },
}))

const sharedStateStub: {
    networkParameters: unknown
    rpcFee: number
    shardSize: number
} = {
    networkParameters: null,
    rpcFee: 10,
    shardSize: 4,
}
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: sharedStateStub,
}))

jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: jest.fn() },
}))

jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: {
        getGCRValidatorStatus: jest.fn(),
        getGCRValidatorsAtBlock: jest.fn(),
    },
}))

// In-memory Validators table, proposal table, vote table. The jest
// datasource mock routes repo lookups to them by entity name.
const validatorsRepo = makeValidatorsRepo()
const proposalRepo = makeProposalRepo()
const voteRepo = makeVoteRepo()

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: jest.fn(async () => ({
            getDataSource: () => ({
                getRepository: (e: { name: string }) => {
                    if (e.name === "Validators") return validatorsRepo
                    if (e.name === "NetworkUpgrade") return proposalRepo
                    if (e.name === "NetworkUpgradeVote") return voteRepo
                    return null
                },
            }),
        })),
    },
}))

import Chain from "@/libs/blockchain/chain"
import GCR from "@/libs/blockchain/gcr/gcr"
import {
    GENESIS_NETWORK_PARAMETERS,
    GRACE_PERIOD_BLOCKS,
    VOTING_WINDOW_BLOCKS,
} from "@/features/networkUpgrade/constants"
import {
    DEFAULT_MIN_VALIDATOR_STAKE,
    UNSTAKE_LOCK_BLOCKS,
    VALIDATOR_STATUS_ACTIVE,
    VALIDATOR_STATUS_EXITED,
    VALIDATOR_STATUS_UNSTAKING,
} from "@/features/staking/constants"
import type { NetworkParameters } from "@/features/networkUpgrade/types"

let handleStakingTx: typeof import("@/libs/network/routines/transactions/handleStakingTx").handleStakingTx
let handleGovernanceTx: typeof import("@/libs/network/routines/transactions/handleGovernanceTx").handleGovernanceTx
let GCRValidatorStakeRoutines: typeof import("@/libs/blockchain/gcr/gcr_routines/GCRValidatorStakeRoutines").default
let tallyUpgradeVotes: typeof import("@/libs/blockchain/routines/tallyUpgradeVotes").default
let applyNetworkUpgrade: typeof import("@/libs/blockchain/routines/applyNetworkUpgrade").default
let loadNetworkParameters: typeof import("@/libs/blockchain/routines/loadNetworkParameters").loadNetworkParameters

beforeAll(async () => {
    ;({ handleStakingTx } = await import(
        "@/libs/network/routines/transactions/handleStakingTx"
    ))
    ;({ handleGovernanceTx } = await import(
        "@/libs/network/routines/transactions/handleGovernanceTx"
    ))
    GCRValidatorStakeRoutines = (
        await import("@/libs/blockchain/gcr/gcr_routines/GCRValidatorStakeRoutines")
    ).default
    tallyUpgradeVotes = (
        await import("@/libs/blockchain/routines/tallyUpgradeVotes")
    ).default
    applyNetworkUpgrade = (
        await import("@/libs/blockchain/routines/applyNetworkUpgrade")
    ).default
    ;({ loadNetworkParameters } = await import(
        "@/libs/blockchain/routines/loadNetworkParameters"
    ))
})

// ---------- in-memory fake repos ----------

function makeValidatorsRepo() {
    const rows = new Map<string, any>()
    return {
        _rows: rows,
        findOneBy: jest.fn(async ({ address }: { address: string }) =>
            rows.get(address) ?? null,
        ),
        save: jest.fn(async (row: any) => {
            rows.set(row.address, { ...row })
            return rows.get(row.address)
        }),
        create: jest.fn((row: any) => ({ ...row })),
        find: jest.fn(async () => Array.from(rows.values())),
    }
}

function makeProposalRepo() {
    const rows = new Map<string, any>()
    const queryBuilderFn = () => {
        const filters: any = {}
        const qb: any = {
            select: jest.fn(() => qb),
            getRawOne: jest.fn(async () => {
                let max = 0
                for (const v of rows.values()) max = Math.max(max, v.version ?? 0)
                return { max }
            }),
        }
        return qb
    }
    return {
        _rows: rows,
        findOne: jest.fn(async (opts: any) => {
            const w = opts.where
            for (const v of rows.values()) {
                if (
                    (!w.proposerPublicKey ||
                        v.proposerPublicKey === w.proposerPublicKey) &&
                    (!w.status ||
                        (Array.isArray(w.status?._value)
                            ? w.status._value.includes(v.status)
                            : v.status === w.status))
                ) {
                    return v
                }
            }
            return null
        }),
        findOneBy: jest.fn(async ({ proposalId }: { proposalId: string }) =>
            rows.get(proposalId) ?? null,
        ),
        find: jest.fn(async (opts: any) => {
            const w = opts?.where ?? {}
            const allowedStatuses: string[] | null =
                Array.isArray(w.status?._value)
                    ? w.status._value
                    : typeof w.status === "string"
                      ? [w.status]
                      : null
            let filtered = Array.from(rows.values())
            if (allowedStatuses) {
                filtered = filtered.filter(r =>
                    allowedStatuses.includes(r.status),
                )
            }
            if (typeof w.tallyBlock === "number") {
                filtered = filtered.filter(r => r.tallyBlock === w.tallyBlock)
            }
            const order = opts?.order
            if (order?.effectiveAtBlock) {
                filtered.sort((a, b) => {
                    if (a.effectiveAtBlock !== b.effectiveAtBlock) {
                        return a.effectiveAtBlock - b.effectiveAtBlock
                    }
                    return a.proposalId.localeCompare(b.proposalId)
                })
            }
            return filtered
        }),
        save: jest.fn(async (row: any) => {
            rows.set(row.proposalId, { ...row })
            return rows.get(row.proposalId)
        }),
        create: jest.fn((row: any) => ({ ...row })),
        createQueryBuilder: jest.fn(queryBuilderFn),
    }
}

function makeVoteRepo() {
    const votes: any[] = []
    return {
        _votes: votes,
        findOne: jest.fn(async (opts: any) => {
            const w = opts.where
            return (
                votes.find(
                    v =>
                        v.proposalId === w.proposalId &&
                        v.voterAddress === w.voterAddress,
                ) ?? null
            )
        }),
        find: jest.fn(async (opts: any) =>
            votes.filter(v => v.proposalId === opts.where.proposalId),
        ),
        save: jest.fn(async (row: any) => {
            votes.push({ ...row })
            return row
        }),
        create: jest.fn((row: any) => ({ ...row })),
    }
}

// ---------- tx factories ----------

const V1 = "aa11"
const V2 = "bb22"
const V3 = "cc33"
const STAKE = DEFAULT_MIN_VALIDATOR_STAKE // 10^25

function stakeTx(sender: string, amount = STAKE, hash = `stake_${sender}`) {
    return {
        hash,
        content: {
            type: "validatorStake",
            from: sender,
            from_ed25519_address: sender,
            data: [
                "validatorStake",
                { amount, connectionUrl: `https://${sender}.v` },
            ],
            gcr_edits: [],
        },
    } as any
}

function unstakeTx(sender: string) {
    return {
        hash: `unstake_${sender}`,
        content: {
            type: "validatorUnstake",
            from: sender,
            from_ed25519_address: sender,
            data: ["validatorUnstake", {}],
            gcr_edits: [],
        },
    } as any
}

function exitTx(sender: string) {
    return {
        hash: `exit_${sender}`,
        content: {
            type: "validatorExit",
            from: sender,
            from_ed25519_address: sender,
            data: ["validatorExit", {}],
            gcr_edits: [],
        },
    } as any
}

function proposalTx(
    proposer: string,
    proposalId: string,
    patch: Partial<NetworkParameters>,
    effectiveAtBlock: number,
) {
    return {
        hash: `prop_${proposalId}`,
        content: {
            type: "networkUpgrade",
            from: proposer,
            from_ed25519_address: proposer,
            data: [
                "networkUpgrade",
                {
                    proposalId,
                    proposedParameters: patch,
                    rationale: "e2e",
                    effectiveAtBlock,
                },
            ],
        },
    } as any
}

function voteTxFrom(voter: string, proposalId: string, approve: boolean) {
    return {
        hash: `vote_${voter}_${proposalId}`,
        content: {
            type: "networkUpgradeVote",
            from: voter,
            from_ed25519_address: voter,
            data: ["networkUpgradeVote", { proposalId, approve }],
        },
    } as any
}

// ---------- helpers to drive the pipeline ----------

function setBlock(n: number) {
    ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(n as never)
}

function setActiveValidator(address: string) {
    ;(GCR.getGCRValidatorStatus as jest.Mock).mockImplementation(
        async (addr: string) => {
            const row = validatorsRepo._rows.get(addr)
            if (!row) return null
            return row
        },
    )
}

function setSnapshot() {
    ;(GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue(
        Array.from(validatorsRepo._rows.values()).filter(
            r => r.status !== VALIDATOR_STATUS_EXITED,
        ),
    )
}

/**
 * Mirrors what SDK's `GCRGeneration.generate()` does for staking txs —
 * synthesizes the validator-state edit before signing. Tests bypass the
 * SDK so we replay this step inline.
 */
function attachStakingEdit(tx: any) {
    tx.content.gcr_edits = tx.content.gcr_edits ?? []
    const data = tx.content?.data
    const p = Array.isArray(data) ? data[1] : null
    if (tx.content.type === "validatorStake") {
        tx.content.gcr_edits.push({
            type: "validatorStake",
            isRollback: false,
            account: tx.content.from_ed25519_address,
            operation: "stake",
            amount: p?.amount ?? "0",
            connectionUrl: p?.connectionUrl ?? "",
            txhash: tx.hash ?? "",
        })
    } else if (tx.content.type === "validatorUnstake") {
        tx.content.gcr_edits.push({
            type: "validatorStake",
            isRollback: false,
            account: tx.content.from_ed25519_address,
            operation: "unstake",
            amount: "0",
            txhash: tx.hash ?? "",
        })
    } else if (tx.content.type === "validatorExit") {
        tx.content.gcr_edits.push({
            type: "validatorStake",
            isRollback: false,
            account: tx.content.from_ed25519_address,
            operation: "exit",
            amount: "0",
            txhash: tx.hash ?? "",
        })
    }
}

/**
 * Applies whatever GCR edit was attached to the tx — mimics
 * `HandleGCR.applyTransactions` at block confirmation.
 */
async function applyStakingEdits(tx: any, atBlock: number) {
    attachStakingEdit(tx)
    for (const edit of tx.content.gcr_edits ?? []) {
        await GCRValidatorStakeRoutines.apply(
            edit,
            validatorsRepo as any,
            atBlock,
        )
    }
}

/**
 * Mirrors what `SDK GCRGeneration.generate()` does for governance txs —
 * attaches the type-specific edit before signing. Tests bypass the SDK
 * so we replay this step inline.
 */
function attachGovernanceEdit(tx: any) {
    tx.content.gcr_edits = tx.content.gcr_edits ?? []
    const data = tx.content?.data
    const p = Array.isArray(data) ? data[1] : null
    if (tx.content.type === "networkUpgrade") {
        tx.content.gcr_edits.push({
            type: "networkUpgrade",
            isRollback: false,
            account: tx.content.from_ed25519_address,
            proposalId: p?.proposalId ?? "",
            proposedParameters: p?.proposedParameters ?? {},
            rationale: p?.rationale ?? "",
            effectiveAtBlock: p?.effectiveAtBlock ?? 0,
            txhash: tx.hash ?? "",
        })
    } else if (tx.content.type === "networkUpgradeVote") {
        tx.content.gcr_edits.push({
            type: "networkUpgradeVote",
            isRollback: false,
            account: tx.content.from_ed25519_address,
            proposalId: p?.proposalId ?? "",
            approve: p?.approve === true,
            txhash: tx.hash ?? "",
        })
    }
    return tx
}

/**
 * Apply governance edits — this is what insertBlock → applyTransactions
 * → handleGCR.applyGCREdit does on every node when a block is confirmed.
 */
async function applyGovernanceEdits(tx: any) {
    const { default: GCRNetworkUpgradeRoutines } = await import(
        "@/libs/blockchain/gcr/gcr_routines/GCRNetworkUpgradeRoutines"
    )
    for (const edit of tx.content.gcr_edits ?? []) {
        if (edit?.type === "networkUpgrade") {
            await GCRNetworkUpgradeRoutines.applyProposal(
                edit,
                proposalRepo as any,
            )
        } else if (edit?.type === "networkUpgradeVote") {
            await GCRNetworkUpgradeRoutines.applyVote(
                edit,
                voteRepo as any,
                proposalRepo as any,
            )
        }
    }
}

/** Fire the post-block governance hooks the way `insertBlock` does:
 *  tally + apply inside the (simulated) transaction, then refresh
 *  sharedState from DB after commit.
 */
async function postBlockHooks(blockNumber: number) {
    await tallyUpgradeVotes(
        blockNumber,
        proposalRepo as any,
        voteRepo as any,
    )
    await applyNetworkUpgrade(blockNumber, proposalRepo as any)
    // Mimic chainBlocks.insertBlock's post-commit refresh.
    await loadNetworkParameters(proposalRepo as any)
}

// ---------- the one big happy path ----------

describe("E2E: staking + governance happy path", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        validatorsRepo._rows.clear()
        proposalRepo._rows.clear()
        voteRepo._votes.length = 0
        sharedStateStub.networkParameters = null
        sharedStateStub.rpcFee = GENESIS_NETWORK_PARAMETERS.rpcFee
        sharedStateStub.shardSize = GENESIS_NETWORK_PARAMETERS.shardSize
    })

    it("three validators stake, one proposes fee change, two vote yes, proposal activates and sharedState updates", async () => {
        // ---------------- 1. STARTUP ----------------
        // preMainLoop equivalent: load params from empty DB → genesis.
        await loadNetworkParameters(proposalRepo as any)
        expect(
            (sharedStateStub.networkParameters as NetworkParameters).networkFee,
        ).toBe(GENESIS_NETWORK_PARAMETERS.networkFee)

        // ---------------- 2. STAKING ----------------
        setActiveValidator("")
        for (const [sender, block] of [
            [V1, 100],
            [V2, 101],
            [V3, 102],
        ] as [string, number][]) {
            setBlock(block)
            const tx = stakeTx(sender)
            const r = await handleStakingTx(tx)
            expect(r.success).toBe(true)
            await applyStakingEdits(tx, block)
        }
        expect(validatorsRepo._rows.size).toBe(3)
        for (const v of validatorsRepo._rows.values()) {
            expect(v.status).toBe(VALIDATOR_STATUS_ACTIVE)
            expect(v.staked_amount).toBe(STAKE)
        }

        // ---------------- 3. PROPOSAL ----------------
        const proposalBlock = 1000
        setBlock(proposalBlock)
        setSnapshot()
        const effectiveAtBlock =
            proposalBlock + VOTING_WINDOW_BLOCKS + GRACE_PERIOD_BLOCKS
        const pTx = proposalTx(V1, "p_fee", { networkFee: 15 }, effectiveAtBlock)
        const pr = await handleGovernanceTx(pTx)
        expect(pr.success).toBe(true)
        // Edit synthesized SDK-side, then applied at block-confirm.
        attachGovernanceEdit(pTx)
        await applyGovernanceEdits(pTx)
        expect(proposalRepo._rows.get("p_fee").status).toBe("pending")

        // ---------------- 4. VOTES ----------------
        // Two yes, one abstain. Total snapshot weight = 3 * STAKE. Approve
        // weight = 2 * STAKE. 2/3 threshold = 2 * STAKE. 2*STAKE ≥ 2*STAKE
        // on floor division → pass.
        setBlock(proposalBlock + 10)
        const v1Tx = voteTxFrom(V1, "p_fee", true)
        const v1Result = await handleGovernanceTx(v1Tx)
        expect(v1Result.success).toBe(true)
        attachGovernanceEdit(v1Tx)
        await applyGovernanceEdits(v1Tx)
        const v2Tx = voteTxFrom(V2, "p_fee", true)
        const v2Result = await handleGovernanceTx(v2Tx)
        expect(v2Result.success).toBe(true)
        attachGovernanceEdit(v2Tx)
        await applyGovernanceEdits(v2Tx)
        // V3 abstains (doesn't vote)
        expect(voteRepo._votes).toHaveLength(2)

        // ---------------- 5. TALLY ----------------
        const tallyBlock = proposalRepo._rows.get("p_fee").tallyBlock
        setBlock(tallyBlock)
        await postBlockHooks(tallyBlock)
        expect(proposalRepo._rows.get("p_fee").status).toBe("activating")

        // ---------------- 6. ACTIVATION ----------------
        setBlock(effectiveAtBlock)
        await postBlockHooks(effectiveAtBlock)
        expect(proposalRepo._rows.get("p_fee").status).toBe("active")
        expect(
            (sharedStateStub.networkParameters as NetworkParameters).networkFee,
        ).toBe(15)
        // flat-field mirroring from applyNetworkUpgrade
        expect(sharedStateStub.shardSize).toBe(
            GENESIS_NETWORK_PARAMETERS.shardSize,
        )

        // ---------------- 7. UNSTAKE + EXIT ----------------
        setBlock(effectiveAtBlock + 10)
        const uTx = unstakeTx(V1)
        const ur = await handleStakingTx(uTx)
        expect(ur.success).toBe(true)
        await applyStakingEdits(uTx, effectiveAtBlock + 10)
        expect(validatorsRepo._rows.get(V1).status).toBe(
            VALIDATOR_STATUS_UNSTAKING,
        )
        expect(validatorsRepo._rows.get(V1).unstake_available_at).toBe(
            effectiveAtBlock + 10 + UNSTAKE_LOCK_BLOCKS,
        )

        // Exit attempt BEFORE lock elapses → rejected at validation.
        const earlyBlock = effectiveAtBlock + 500
        setBlock(earlyBlock)
        const early = await handleStakingTx(exitTx(V1))
        expect(early.success).toBe(false)
        expect(validatorsRepo._rows.get(V1).status).toBe(
            VALIDATOR_STATUS_UNSTAKING,
        )

        // Exit at exactly unstake_available_at → succeeds, state = EXITED.
        const exitBlock = effectiveAtBlock + 10 + UNSTAKE_LOCK_BLOCKS
        setBlock(exitBlock)
        const eTx = exitTx(V1)
        const er = await handleStakingTx(eTx)
        expect(er.success).toBe(true)
        await applyStakingEdits(eTx, exitBlock)
        expect(validatorsRepo._rows.get(V1).status).toBe(
            VALIDATOR_STATUS_EXITED,
        )
        expect(validatorsRepo._rows.get(V1).staked_amount).toBe("0")
    })

    it("below-threshold proposal is rejected at tallyBlock and never activates", async () => {
        // two validators; one votes yes, one votes no → 1/2 approve < 2/3
        await loadNetworkParameters(proposalRepo as any)
        setActiveValidator("")
        for (const [sender, block] of [
            [V1, 100],
            [V2, 101],
        ] as [string, number][]) {
            setBlock(block)
            const tx = stakeTx(sender)
            await handleStakingTx(tx)
            await applyStakingEdits(tx, block)
        }

        const proposalBlock = 500
        setBlock(proposalBlock)
        setSnapshot()
        const effectiveAtBlock =
            proposalBlock + VOTING_WINDOW_BLOCKS + GRACE_PERIOD_BLOCKS
        const pTx = proposalTx(V1, "p_rej", { networkFee: 5 }, effectiveAtBlock)
        await handleGovernanceTx(pTx)
        attachGovernanceEdit(pTx)
        await applyGovernanceEdits(pTx)

        setBlock(proposalBlock + 10)
        const yesTx = voteTxFrom(V1, "p_rej", true)
        await handleGovernanceTx(yesTx)
        attachGovernanceEdit(yesTx)
        await applyGovernanceEdits(yesTx)
        const noTx = voteTxFrom(V2, "p_rej", false)
        await handleGovernanceTx(noTx)
        attachGovernanceEdit(noTx)
        await applyGovernanceEdits(noTx)

        const tallyBlock = proposalRepo._rows.get("p_rej").tallyBlock
        setBlock(tallyBlock)
        await postBlockHooks(tallyBlock)
        expect(proposalRepo._rows.get("p_rej").status).toBe("rejected")

        // Activation pass does nothing — parameters unchanged.
        setBlock(effectiveAtBlock)
        await postBlockHooks(effectiveAtBlock)
        expect(
            (sharedStateStub.networkParameters as NetworkParameters).networkFee,
        ).toBe(GENESIS_NETWORK_PARAMETERS.networkFee)
    })
})
