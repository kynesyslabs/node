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
            const tb = opts.where.tallyBlock
            // tb may be a raw number (legacy tests) or a TypeORM
            // LessThanOrEqual operator (now exposes ._value).
            const tbCap =
                typeof tb === "number"
                    ? tb
                    : (tb?._value as number | undefined)
            return store.filter(
                r =>
                    r.status === status &&
                    (tbCap === undefined || r.tallyBlock <= tbCap),
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
        (GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { staked_amount: "0" },
            { staked_amount: "0" },
            { staked_amount: "0" },
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
                { approve: true, weight: "1" },
                { approve: true, weight: "1" },
                // ceil(2*3/3) = 2; approve=2 ≥ 2 → pass
            ],
        })
        const outcomes = await tallyUpgradeVotes(
            200,
            proposals as any,
            votes as any,
        )
        expect(outcomes).toHaveLength(1)
        expect(outcomes[0].status).toBe("approved")
        expect(outcomes[0].approveWeight).toBe(2n)
        expect(outcomes[0].snapshotWeight).toBe(3n)
        expect(outcomes[0].threshold).toBe(2n)
        expect(proposals._rows[0].status).toBe("activating")
    })

    it("rejects one vote below the threshold (abstention = NO)", async () => {
        (GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { staked_amount: "0" },
            { staked_amount: "0" },
            { staked_amount: "0" },
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
                { approve: true, weight: "1" }, // ceil(2*3/3) = 2; 1 < 2
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
        (GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue(
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

    it("tallies overdue proposals whose tallyBlock was skipped (G-5 regression)", async () => {
        // Chain reaches block 205 without the post-block hook firing at 200
        // (devnet reset, reorg around the exact tallyBlock, etc.). The
        // proposal must still be tallied, not stuck in 'pending' forever.
        (GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { staked_amount: "100" },
        ] as never)
        const proposals = makeProposalRepo([
            {
                proposalId: "p_overdue",
                status: "pending",
                snapshotBlock: 100,
                tallyBlock: 200,
                effectiveAtBlock: 300,
            },
        ])
        const votes = makeVoteRepo({
            p_overdue: [{ approve: true, weight: "1" }],
        })
        const outcomes = await tallyUpgradeVotes(
            205,
            proposals as any,
            votes as any,
        )
        expect(outcomes).toHaveLength(1)
        expect(outcomes[0].proposalId).toBe("p_overdue")
        expect(outcomes[0].status).toBe("approved")
    })

    it("ignores proposals not at tallyBlock even if status is pending", async () => {
        (GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
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
        (GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
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
            p1: [{ approve: true, weight: "1" }], // 2/3 of 1 seat = 1; 1 ≥ 1 → pass
            p2: [{ approve: false, weight: "1" }], // 0 approve < 1 → reject
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
