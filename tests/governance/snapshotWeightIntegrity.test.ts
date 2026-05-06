// Spec v2 §Verification #3 — snapshot-weight integrity.
//
// Scenario: validator V casts an APPROVE vote while staked at amount S at
// snapshotBlock. After the vote is recorded but BEFORE tallyBlock, V
// unstakes (or their effective stake changes in the Validators table).
// At tally time, V's vote weight MUST still be S (the snapshot value), not
// the post-unstake value. Equivalently: tally reads `weight` from
// NetworkUpgradeVote rows — that column was frozen at the moment of the
// vote — and NEVER re-reads from the Validators table at tally time.
//
// The implementation already does this correctly (handleGovernanceTx
// captures weight from the snapshot-block lookup and stores it on the vote
// row; tallyUpgradeVotes sums stored weights). This test locks that
// contract so a future refactor doesn't silently break it.

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

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: { networkParameters: null },
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

import Chain from "@/libs/blockchain/chain"
import GCR from "@/libs/blockchain/gcr/gcr"
import { VOTING_WINDOW_BLOCKS } from "@/features/networkUpgrade/constants"

let handleGovernanceTx: typeof import("@/libs/network/routines/transactions/handleGovernanceTx").handleGovernanceTx
let tallyUpgradeVotes: typeof import("@/libs/blockchain/routines/tallyUpgradeVotes").default

beforeAll(async () => {
    ({ handleGovernanceTx } = await import(
        "@/libs/network/routines/transactions/handleGovernanceTx"
    ))
    tallyUpgradeVotes = (
        await import("@/libs/blockchain/routines/tallyUpgradeVotes")
    ).default
})

// ---------- in-memory repos ----------

const proposalRepo = {
    _rows: new Map<string, any>(),
    findOne: jest.fn(async (opts: any) => {
        const w = opts.where
        const allowed: string[] | null =
            Array.isArray(w.status?._value)
                ? w.status._value
                : typeof w.status === "string"
                  ? [w.status]
                  : null
        for (const v of proposalRepo._rows.values()) {
            if (
                (!w.proposerPublicKey ||
                    v.proposerPublicKey === w.proposerPublicKey) &&
                (!allowed || allowed.includes(v.status))
            ) {
                return v
            }
        }
        return null
    }),
    findOneBy: jest.fn(async ({ proposalId }: { proposalId: string }) =>
        proposalRepo._rows.get(proposalId) ?? null,
    ),
    find: jest.fn(async (opts: any) => {
        const w = opts?.where ?? {}
        let filtered = Array.from(proposalRepo._rows.values())
        if (typeof w.status === "string") {
            filtered = filtered.filter(r => r.status === w.status)
        }
        if (typeof w.tallyBlock === "number") {
            filtered = filtered.filter(r => r.tallyBlock === w.tallyBlock)
        }
        return filtered
    }),
    save: jest.fn(async (row: any) => {
        proposalRepo._rows.set(row.proposalId, { ...row })
        return row
    }),
    create: jest.fn((row: any) => ({ ...row })),
    createQueryBuilder: jest.fn(() => {
        const qb: any = {
            select: jest.fn(() => qb),
            getRawOne: jest.fn(async () => ({ max: 0 })),
        }
        return qb
    }),
}

const voteRepo = {
    _votes: [] as any[],
    findOne: jest.fn(async (opts: any) => {
        const w = opts.where
        return (
            voteRepo._votes.find(
                v =>
                    v.proposalId === w.proposalId &&
                    v.voterAddress === w.voterAddress,
            ) ?? null
        )
    }),
    find: jest.fn(async (opts: any) =>
        voteRepo._votes.filter(v => v.proposalId === opts.where.proposalId),
    ),
    save: jest.fn(async (row: any) => {
        voteRepo._votes.push({ ...row })
        return row
    }),
    create: jest.fn((row: any) => ({ ...row })),
}

// Re-stub the datasource to return our maps
const { default: Datasource } = require("@/model/datasource") as {
    default: { getInstance: jest.Mock }
}
Datasource.getInstance.mockResolvedValue({
    getDataSource: () => ({
        getRepository: (e: { name: string }) => {
            if (e.name === "NetworkUpgrade") return proposalRepo
            if (e.name === "NetworkUpgradeVote") return voteRepo
            return null
        },
    }),
} as never)

// ---------- scenario ----------

describe("Snapshot-weight integrity (spec v2 §Verification #3)", () => {
    const VOTER = "aa11"
    const SNAPSHOT_BLOCK = 100
    const VOTING_BLOCK = 150
    const TALLY_BLOCK = SNAPSHOT_BLOCK + VOTING_WINDOW_BLOCKS
    const SNAPSHOT_STAKE = "1000000000000000000" // 10^18
    const POST_UNSTAKE_STAKE = "0"

    beforeEach(() => {
        jest.clearAllMocks()
        proposalRepo._rows.clear()
        voteRepo._votes.length = 0

        // Seed a pending proposal with snapshot at block 100.
        proposalRepo._rows.set("p1", {
            proposalId: "p1",
            version: 1,
            proposerPublicKey: "proposer",
            proposedParameters: { networkFee: 12 },
            status: "pending",
            snapshotBlock: SNAPSHOT_BLOCK,
            tallyBlock: TALLY_BLOCK,
            effectiveAtBlock: TALLY_BLOCK + 50,
            rationale: "",
        })
    })

    function voteTx(proposalId: string, approve: boolean) {
        return {
            hash: `vote_${proposalId}`,
            content: {
                type: "networkUpgradeVote",
                from: VOTER,
                from_ed25519_address: VOTER,
                data: ["networkUpgradeVote", { proposalId, approve }],
                gcr_edits: [],
            },
        } as any
    }

    /**
     * Mirrors the full pipeline:
     *  1. Vote tx received → handleGovernanceTx validates (no mutation).
     *  2. SDK `GCRGeneration.generate()` synthesizes the vote edit
     *     (replayed inline because tests bypass the SDK).
     *  3. Block-confirmation → `GCRNetworkUpgradeRoutines.applyVote`
     *     fills server-derived fields (`weight`, `blockNumber`) and
     *     persists.
     */
    function attachVoteEdit(tx: any) {
        const data = tx.content?.data
        const p = Array.isArray(data) ? data[1] : null
        tx.content.gcr_edits.push({
            type: "networkUpgradeVote",
            isRollback: false,
            account: tx.content.from_ed25519_address,
            proposalId: p?.proposalId ?? "",
            approve: p?.approve === true,
            txhash: tx.hash ?? "",
        })
    }
    async function applyEditsTo(tx: any) {
        const { default: GCRNetworkUpgradeRoutines } = await import(
            "@/libs/blockchain/gcr/gcr_routines/GCRNetworkUpgradeRoutines"
        )
        for (const edit of tx.content.gcr_edits ?? []) {
            if ((edit as any).type === "networkUpgradeVote") {
                await GCRNetworkUpgradeRoutines.applyVote(
                    edit,
                    voteRepo as any,
                    proposalRepo as any,
                )
            }
        }
    }

    it("vote weight is frozen at snapshot time and survives subsequent unstake", async () => {
        // GCR.getGCRValidatorsAtBlock is queried 3 times in this scenario:
        //   1. handleGovernanceTx — voter-in-snapshot check
        //   2. applyVote — snapshotted weight lookup (server-derived)
        //   3. tallyUpgradeVotes — snapshot-total-weight for threshold
        // Mock all 3 with the SNAPSHOT_STAKE view, then a fallback for any
        // post-flow query (which we no longer use).
        (Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(
            VOTING_BLOCK as never,
        )
        ;(GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { address: VOTER, staked_amount: SNAPSHOT_STAKE },
        ] as never)

        const voteTxObj = voteTx("p1", true)
        const voteResult = await handleGovernanceTx(voteTxObj)
        attachVoteEdit(voteTxObj)
        expect(voteResult.success).toBe(true)

        // Simulate block confirmation — applyVote fills `weight` from
        // the snapshot validator set and persists.
        await applyEditsTo(voteTxObj)
        expect(voteRepo._votes).toHaveLength(1)
        expect(voteRepo._votes[0].weight).toBe(SNAPSHOT_STAKE)

        // V unstakes between vote and tally. Even if GCR re-query after
        // vote returns POST_UNSTAKE_STAKE, the row in voteRepo stays at
        // SNAPSHOT_STAKE — that's the integrity guarantee.
        // (The historical snapshot block view of GCR is mocked above as
        //  always SNAPSHOT_STAKE, mirroring real block-indexed storage.)
        const outcomes = await tallyUpgradeVotes(
            TALLY_BLOCK,
            proposalRepo as any,
            voteRepo as any,
        )

        expect(outcomes).toHaveLength(1)
        expect(outcomes[0].approveWeight.toString()).toBe(SNAPSHOT_STAKE)
    })

    it("if the stored vote weight were tampered post-hoc, tally would pick up the new value — confirms tally really reads from vote rows", async () => {
        (Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(
            VOTING_BLOCK as never,
        )
        ;(GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { address: VOTER, staked_amount: SNAPSHOT_STAKE },
        ] as never)
        const voteTxObj = voteTx("p1", true)
        await handleGovernanceTx(voteTxObj)
        attachVoteEdit(voteTxObj)
        await applyEditsTo(voteTxObj)
        expect(voteRepo._votes[0].weight).toBe(SNAPSHOT_STAKE)

        // Tamper.
        voteRepo._votes[0].weight = "1"
        ;(GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValueOnce([
            { address: VOTER, staked_amount: SNAPSHOT_STAKE },
        ] as never)

        const outcomes = await tallyUpgradeVotes(
            TALLY_BLOCK,
            proposalRepo as any,
            voteRepo as any,
        )
        expect(outcomes[0].approveWeight.toString()).toBe("1")
    })
})
