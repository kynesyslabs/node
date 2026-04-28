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

jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorsAtBlock: jest.fn() },
}))

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

import GCR from "@/libs/blockchain/gcr/gcr"

let tallyUpgradeVotes: typeof import("@/libs/blockchain/routines/tallyUpgradeVotes").default

beforeAll(async () => {
    tallyUpgradeVotes = (
        await import("@/libs/blockchain/routines/tallyUpgradeVotes")
    ).default
})

function makeProposalRepo(rows: any[]) {
    const store = rows.map(r => ({ ...r }))
    return {
        _rows: store,
        find: jest.fn(async (opts: any) => {
            const status = opts.where.status
            const tallyBlock = opts.where.tallyBlock
            return store.filter(
                r => r.status === status && r.tallyBlock === tallyBlock,
            )
        }),
        save: jest.fn(async (row: any) => {
            const i = store.findIndex(r => r.proposalId === row.proposalId)
            if (i >= 0) store[i] = { ...row }
            return row
        }),
    }
}

function makeVoteRepo(votes: Record<string, any[]>) {
    return {
        find: jest.fn(async (opts: any) => votes[opts.where.proposalId] ?? []),
    }
}

describe("tallyUpgradeVotes", () => {
    beforeEach(() => jest.clearAllMocks())

    it("returns [] when no proposals are due at currentBlock", async () => {
        const proposals = makeProposalRepo([
            {
                proposalId: "p1",
                status: "pending",
                snapshotBlock: 100,
                tallyBlock: 200,
                effectiveAtBlock: 300,
            },
        ])
        const votes = makeVoteRepo({})
        const outcomes = await tallyUpgradeVotes(
            150,
            proposals as any,
            votes as any,
        )
        expect(outcomes).toEqual([])
    })

    it("approves a proposal that crosses the 2/3 threshold on snapshot weight", async () => {
        ;(GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { staked_amount: "60" },
            { staked_amount: "30" },
            { staked_amount: "10" },
        ] as never)
        const proposals = makeProposalRepo([
            {
                proposalId: "p1",
                status: "pending",
                snapshotBlock: 100,
                tallyBlock: 200,
                effectiveAtBlock: 300,
            },
        ])
        const votes = makeVoteRepo({
            p1: [
                { approve: true, weight: "60" },
                { approve: true, weight: "10" },
                // 2/3 of 100 = 66; approve=70 ≥ 66 → pass
            ],
        })
        const outcomes = await tallyUpgradeVotes(
            200,
            proposals as any,
            votes as any,
        )
        expect(outcomes).toHaveLength(1)
        expect(outcomes[0].status).toBe("approved")
        expect(outcomes[0].approveWeight).toBe(70n)
        expect(outcomes[0].snapshotWeight).toBe(100n)
        expect(outcomes[0].threshold).toBe(66n)
        expect(proposals._rows[0].status).toBe("activating")
    })

    it("rejects one vote below the threshold (abstention = NO)", async () => {
        ;(GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { staked_amount: "100" },
        ] as never)
        const proposals = makeProposalRepo([
            {
                proposalId: "p1",
                status: "pending",
                snapshotBlock: 100,
                tallyBlock: 200,
                effectiveAtBlock: 300,
            },
        ])
        const votes = makeVoteRepo({
            p1: [
                { approve: true, weight: "65" }, // 2/3 of 100 = 66; 65 < 66
            ],
        })
        const outcomes = await tallyUpgradeVotes(
            200,
            proposals as any,
            votes as any,
        )
        expect(outcomes[0].status).toBe("rejected")
        expect(proposals._rows[0].status).toBe("rejected")
    })

    it("rejects when no validators exist in the snapshot (empty weight)", async () => {
        ;(GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue(
            [] as never,
        )
        const proposals = makeProposalRepo([
            {
                proposalId: "p1",
                status: "pending",
                snapshotBlock: 100,
                tallyBlock: 200,
                effectiveAtBlock: 300,
            },
        ])
        const votes = makeVoteRepo({
            p1: [{ approve: true, weight: "999" }],
        })
        const outcomes = await tallyUpgradeVotes(
            200,
            proposals as any,
            votes as any,
        )
        expect(outcomes[0].status).toBe("rejected")
        expect(outcomes[0].snapshotWeight).toBe(0n)
    })

    it("ignores proposals not at tallyBlock even if status is pending", async () => {
        ;(GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { staked_amount: "100" },
        ] as never)
        const proposals = makeProposalRepo([
            {
                proposalId: "p1",
                status: "pending",
                snapshotBlock: 100,
                tallyBlock: 999, // not due yet
                effectiveAtBlock: 1100,
            },
        ])
        const votes = makeVoteRepo({})
        const outcomes = await tallyUpgradeVotes(
            200,
            proposals as any,
            votes as any,
        )
        expect(outcomes).toEqual([])
    })

    it("processes multiple proposals due at the same block independently", async () => {
        ;(GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { staked_amount: "30" },
        ] as never)
        const proposals = makeProposalRepo([
            {
                proposalId: "p1",
                status: "pending",
                snapshotBlock: 100,
                tallyBlock: 200,
                effectiveAtBlock: 300,
            },
            {
                proposalId: "p2",
                status: "pending",
                snapshotBlock: 100,
                tallyBlock: 200,
                effectiveAtBlock: 301,
            },
        ])
        const votes = makeVoteRepo({
            p1: [{ approve: true, weight: "30" }], // 2/3 of 30 = 20; 30 ≥ 20 → pass
            p2: [{ approve: false, weight: "30" }], // 0 approve < 20 → reject
        })
        const outcomes = await tallyUpgradeVotes(
            200,
            proposals as any,
            votes as any,
        )
        expect(outcomes).toHaveLength(2)
        expect(outcomes.find(o => o.proposalId === "p1")!.status).toBe(
            "approved",
        )
        expect(outcomes.find(o => o.proposalId === "p2")!.status).toBe(
            "rejected",
        )
    })
})
