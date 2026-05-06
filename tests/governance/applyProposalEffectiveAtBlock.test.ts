// Unit test for applyProposal's effectiveAtBlock floor check.
//
// Background: handleGovernanceTx validates `effectiveAtBlock >= currentTip
// + VOTING_WINDOW_BLOCKS + GRACE_PERIOD_BLOCKS` at submission time. If the
// tx then sits in mempool for many blocks, the freshly-computed
// snapshotBlock at confirmation time can be much higher than the chain
// tip at submission, leaving an effectiveAtBlock that violates the
// grace-period invariant. applyProposal must re-check.

import {
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

jest.mock("@/libs/blockchain/chain", () => ({
    __esModule: true,
    default: { getLastBlockNumber: jest.fn() },
}))

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

import {
    GRACE_PERIOD_BLOCKS,
    VOTING_WINDOW_BLOCKS,
} from "@/features/networkUpgrade/constants"
import GCRNetworkUpgradeRoutines from "@/libs/blockchain/gcr/gcr_routines/GCRNetworkUpgradeRoutines"

function makeRepo() {
    const rows = new Map<string, any>()
    const nextVersion = 1
    return {
        _rows: rows,
        findOneBy: jest.fn(async ({ proposalId }: { proposalId: string }) =>
            rows.get(proposalId) ?? null,
        ),
        find: jest.fn(async () => []),
        create: jest.fn((row: any) => ({ ...row })),
        save: jest.fn(async (row: any) => {
            rows.set(row.proposalId, { ...row })
            return row
        }),
        createQueryBuilder: jest.fn(() => ({
            select: jest.fn().mockReturnThis(),
            getRawOne: jest.fn(async () => ({ max: nextVersion - 1 })),
        })),
    }
}

function makeEdit(overrides: Partial<any> = {}) {
    return {
        type: "networkUpgrade",
        proposalId: "p1",
        account: "0xproposer",
        proposedParameters: { networkFee: 20 },
        effectiveAtBlock: 200,
        rationale: "test",
        ...overrides,
    } as any
}

describe("GCRNetworkUpgradeRoutines.applyProposal — effectiveAtBlock floor", () => {
    let repo: ReturnType<typeof makeRepo>

    beforeEach(() => {
        jest.clearAllMocks()
        repo = makeRepo()
    })

    it("rejects a proposal whose effectiveAtBlock is below snapshot+window+grace", async () => {
        // snapshotBlock = 100; tally = 200; minEffective = 250.
        // Caller passes effectiveAtBlock = 200 — too low.
        const edit = makeEdit({ effectiveAtBlock: 200 })
        const result = await GCRNetworkUpgradeRoutines.applyProposal(
            edit,
            repo as any,
            100,
        )

        expect(result.success).toBe(false)
        expect(result.message).toContain("below minimum")
        expect(repo.save).not.toHaveBeenCalled()
        expect(repo._rows.size).toBe(0)
    })

    it("accepts a proposal exactly at snapshot+window+grace", async () => {
        // snapshotBlock = 100; tally = 200; minEffective = 250.
        const minEffective = 100 + VOTING_WINDOW_BLOCKS + GRACE_PERIOD_BLOCKS
        expect(minEffective).toBe(250)

        const edit = makeEdit({ effectiveAtBlock: 250 })
        const result = await GCRNetworkUpgradeRoutines.applyProposal(
            edit,
            repo as any,
            100,
        )

        expect(result.success).toBe(true)
        expect(repo.save).toHaveBeenCalledTimes(1)
    })

    it("accepts a proposal above snapshot+window+grace", async () => {
        const edit = makeEdit({ effectiveAtBlock: 300 })
        const result = await GCRNetworkUpgradeRoutines.applyProposal(
            edit,
            repo as any,
            100,
        )

        expect(result.success).toBe(true)
        expect(repo.save).toHaveBeenCalledTimes(1)
    })

    it("blocks the mempool-delay scenario (G-6 regression test)", async () => {
        // Tx submitted at block 100, RPC validation passes:
        //   effectiveAtBlock=250 (= 100 + window:100 + grace:50). OK at block 100.
        // Tx sits in mempool, confirmed at block 200. Now snapshotBlock=200,
        // tallyBlock=300, minEffective=350. effectiveAtBlock=250 must be
        // rejected at applyProposal time, not silently accepted with
        // zero grace.
        const edit = makeEdit({ effectiveAtBlock: 250 })
        const result = await GCRNetworkUpgradeRoutines.applyProposal(
            edit,
            repo as any,
            200,
        )

        expect(result.success).toBe(false)
        expect(result.message).toMatch(/250.*350|below minimum 350/)
        expect(repo.save).not.toHaveBeenCalled()
    })
})
