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

const sharedStateStub: { networkParameters: unknown } = {
    networkParameters: null,
}
jest.mock("@/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: sharedStateStub,
}))

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: { getInstance: jest.fn() },
}))

import { GENESIS_NETWORK_PARAMETERS } from "@/features/networkUpgrade/constants"
import type { NetworkParameters } from "@/features/networkUpgrade/types"

let applyNetworkUpgrade: typeof import("@/libs/blockchain/routines/applyNetworkUpgrade").default

beforeAll(async () => {
    applyNetworkUpgrade = (
        await import("@/libs/blockchain/routines/applyNetworkUpgrade")
    ).default
})

function makeProposalRepo(rows: any[]) {
    const store = rows.map(r => ({ ...r }))
    return {
        _rows: store,
        find: jest.fn(async (opts: any) => {
            const status = opts.where.status
            const filtered = store.filter(r => r.status === status)
            // Match TypeORM's ORDER BY effectiveAtBlock ASC, proposalId ASC.
            filtered.sort((a, b) => {
                if (a.effectiveAtBlock !== b.effectiveAtBlock) {
                    return a.effectiveAtBlock - b.effectiveAtBlock
                }
                return a.proposalId.localeCompare(b.proposalId)
            })
            return filtered
        }),
        save: jest.fn(async (row: any) => {
            const i = store.findIndex(r => r.proposalId === row.proposalId)
            if (i >= 0) store[i] = { ...row }
            return row
        }),
    }
}

describe("applyNetworkUpgrade", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        sharedStateStub.networkParameters = null
    })

    it("returns [] when no activating proposals exist", async () => {
        const repo = makeProposalRepo([])
        const outcomes = await applyNetworkUpgrade(1000, repo as any)
        expect(outcomes).toEqual([])
    })

    it("returns [] when activating proposals' effectiveAtBlock is in the future", async () => {
        const repo = makeProposalRepo([
            {
                proposalId: "p1",
                status: "activating",
                effectiveAtBlock: 999,
                proposedParameters: { networkFee: 42 },
            },
        ])
        const outcomes = await applyNetworkUpgrade(500, repo as any)
        expect(outcomes).toEqual([])
        expect(repo._rows[0].status).toBe("activating")
    })

    it("applies a single proposal — flips status to active in DB (sharedState refresh deferred to caller)", async () => {
        const repo = makeProposalRepo([
            {
                proposalId: "p1",
                status: "activating",
                effectiveAtBlock: 500,
                proposedParameters: { networkFee: 42 },
            },
        ])
        const outcomes = await applyNetworkUpgrade(500, repo as any)
        expect(outcomes).toHaveLength(1)
        expect(outcomes[0].proposalId).toBe("p1")
        expect(outcomes[0].applied).toEqual({ networkFee: 42 })
        expect(repo._rows[0].status).toBe("active")
        // sharedState is NOT mutated here — that happens via
        // loadNetworkParameters() in chainBlocks.insertBlock after the
        // transaction commits.
        expect(sharedStateStub.networkParameters).toBeNull()
    })

    it("processes proposals in (effectiveAtBlock, proposalId) order — outcomes ordered + all flipped to active", async () => {
        const repo = makeProposalRepo([
            {
                proposalId: "p_B",
                status: "activating",
                effectiveAtBlock: 500,
                proposedParameters: { networkFee: 30 },
            },
            {
                proposalId: "p_A",
                status: "activating",
                effectiveAtBlock: 500,
                proposedParameters: { networkFee: 20 },
            },
        ])
        const outcomes = await applyNetworkUpgrade(500, repo as any)
        // p_A sorts first lexicographically, so p_B applied last in outcomes.
        expect(outcomes.map(o => o.proposalId)).toEqual(["p_A", "p_B"])
        expect(repo._rows.every((r: any) => r.status === "active")).toBe(true)
    })

    it("skips future-effective proposals while applying past-due ones", async () => {
        const repo = makeProposalRepo([
            {
                proposalId: "p_now",
                status: "activating",
                effectiveAtBlock: 500,
                proposedParameters: { networkFee: 42 },
            },
            {
                proposalId: "p_later",
                status: "activating",
                effectiveAtBlock: 1000,
                proposedParameters: { networkFee: 99 },
            },
        ])
        await applyNetworkUpgrade(500, repo as any)
        expect(
            repo._rows.find(r => r.proposalId === "p_now")!.status,
        ).toBe("active")
        expect(
            repo._rows.find(r => r.proposalId === "p_later")!.status,
        ).toBe("activating")
    })
})
