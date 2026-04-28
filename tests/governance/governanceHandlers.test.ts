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

const proposalRepoMock = {
    find: jest.fn(),
    findOneBy: jest.fn(),
}
const voteRepoMock = { find: jest.fn() }

jest.mock("@/model/datasource", () => ({
    __esModule: true,
    default: {
        getInstance: jest.fn(async () => ({
            getDataSource: () => ({
                getRepository: (e: { name: string }) => {
                    if (e.name === "NetworkUpgrade") return proposalRepoMock
                    if (e.name === "NetworkUpgradeVote") return voteRepoMock
                    return null
                },
            }),
        })),
    },
}))

jest.mock("@/libs/blockchain/gcr/gcr", () => ({
    __esModule: true,
    default: { getGCRValidatorsAtBlock: jest.fn() },
}))

import GCR from "@/libs/blockchain/gcr/gcr"
import { getGenesisNetworkParameters } from "@/features/networkUpgrade/constants"
const GENESIS = getGenesisNetworkParameters()

let governanceHandlers: typeof import("@/libs/network/handlers/governanceHandlers").governanceHandlers
let tallyVotes: typeof import("@/libs/network/handlers/governanceHandlers").tallyVotes

beforeAll(async () => {
    const mod = await import("@/libs/network/handlers/governanceHandlers")
    governanceHandlers = mod.governanceHandlers
    tallyVotes = mod.tallyVotes
})

function emptyResponse() {
    return {
        result: 200,
        response: null as unknown,
        require_reply: false,
        extra: null as unknown,
    }
}

describe("governanceHandlers.getNetworkParameters", () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it("returns the sharedState.networkParameters when populated", async () => {
        sharedStateStub.networkParameters = {
            ...GENESIS,
            networkFee: 77,
        }
        const r = await governanceHandlers.getNetworkParameters(
            {},
            emptyResponse(),
        )
        expect((r.response as { networkFee: number }).networkFee).toBe(77)
    })

    it("falls back to genesis defaults when sharedState is empty", async () => {
        sharedStateStub.networkParameters = null
        const r = await governanceHandlers.getNetworkParameters(
            {},
            emptyResponse(),
        )
        expect(r.response).toEqual(GENESIS)
    })
})

describe("governanceHandlers.getActiveProposals", () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it("serializes pending/approved/activating proposals", async () => {
        proposalRepoMock.find.mockResolvedValue([
            {
                proposalId: "p1",
                version: 1,
                proposerPublicKey: "aa",
                proposedParameters: { networkFee: 20 },
                rationale: "bump fee",
                status: "pending",
                snapshotBlock: 100,
                tallyBlock: 200,
                effectiveAtBlock: 250,
            },
        ])
        const r = await governanceHandlers.getActiveProposals(
            {},
            emptyResponse(),
        )
        expect(r.response).toEqual([
            {
                proposalId: "p1",
                version: 1,
                proposerPublicKey: "aa",
                proposedParameters: { networkFee: 20 },
                rationale: "bump fee",
                status: "pending",
                snapshotBlock: 100,
                tallyBlock: 200,
                effectiveAtBlock: 250,
            },
        ])
    })

    it("returns 500 on repo error", async () => {
        proposalRepoMock.find.mockRejectedValue(new Error("db down"))
        const r = await governanceHandlers.getActiveProposals(
            {},
            emptyResponse(),
        )
        expect(r.result).toBe(500)
    })
})

describe("governanceHandlers.getProposalVotes", () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it("returns null for unknown proposal", async () => {
        proposalRepoMock.findOneBy.mockResolvedValue(null)
        const r = await governanceHandlers.getProposalVotes(
            { proposalId: "nope" },
            emptyResponse(),
        )
        expect(r.response).toBeNull()
    })

    it("rejects a missing proposalId", async () => {
        const r = await governanceHandlers.getProposalVotes(
            {},
            emptyResponse(),
        )
        expect(r.result).toBe(400)
    })

    it("computes tally weighted against the snapshot total (abstentions = NO)", async () => {
        proposalRepoMock.findOneBy.mockResolvedValue({
            proposalId: "p1",
            snapshotBlock: 100,
        })
        voteRepoMock.find.mockResolvedValue([
            { voterAddress: "v1", approve: true, weight: "40" },
            { voterAddress: "v2", approve: false, weight: "10" },
        ])
        // snapshot has 100 total stake (including v3 who abstains with 50)
        ;(GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { staked_amount: "40" },
            { staked_amount: "10" },
            { staked_amount: "50" },
        ] as never)

        const r = await governanceHandlers.getProposalVotes(
            { proposalId: "p1" },
            emptyResponse(),
        )
        const tally = r.response as {
            approveWeight: string
            rejectWeight: string
            totalStakedWeight: string
            threshold: string
            passed: boolean
        }
        expect(tally.approveWeight).toBe("40")
        expect(tally.rejectWeight).toBe("10")
        expect(tally.totalStakedWeight).toBe("100")
        // 2/3 of 100 = 66 (bigint floor division)
        expect(tally.threshold).toBe("66")
        // 40 approve < 66 threshold → NOT passed
        expect(tally.passed).toBe(false)
    })
})

describe("governanceHandlers.getUpgradeHistory", () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it("returns active proposals in ascending activation order", async () => {
        proposalRepoMock.find.mockResolvedValue([
            {
                proposalId: "p_a",
                version: 1,
                proposerPublicKey: "x",
                proposedParameters: {},
                rationale: "",
                status: "active",
                snapshotBlock: 1,
                tallyBlock: 10,
                effectiveAtBlock: 50,
            },
            {
                proposalId: "p_b",
                version: 2,
                proposerPublicKey: "y",
                proposedParameters: {},
                rationale: "",
                status: "active",
                snapshotBlock: 100,
                tallyBlock: 110,
                effectiveAtBlock: 150,
            },
        ])
        const r = await governanceHandlers.getUpgradeHistory(
            {},
            emptyResponse(),
        )
        const out = r.response as Array<{ proposalId: string }>
        expect(out).toHaveLength(2)
        expect(out[0].proposalId).toBe("p_a")
        expect(out[1].proposalId).toBe("p_b")
    })
})

describe("tallyVotes helper", () => {
    it("computes exact 2/3 boundary as passing", () => {
        const result = tallyVotes(
            "p1",
            [
                { voterAddress: "v1", approve: true, weight: "66" } as any,
                { voterAddress: "v2", approve: false, weight: "33" } as any,
            ],
            99n,
        )
        // 2/3 of 99 = 66 (floor). approve=66 >= 66 → pass
        expect(result.threshold).toBe("66")
        expect(result.passed).toBe(true)
    })

    it("rejects one below threshold", () => {
        const result = tallyVotes(
            "p1",
            [
                { voterAddress: "v1", approve: true, weight: "65" } as any,
                { voterAddress: "v2", approve: false, weight: "34" } as any,
            ],
            99n,
        )
        expect(result.passed).toBe(false)
    })

    it("without snapshotTotalWeight, falls back to voted-weight threshold", () => {
        const result = tallyVotes(
            "p1",
            [
                { voterAddress: "v1", approve: true, weight: "10" } as any,
                { voterAddress: "v2", approve: false, weight: "5" } as any,
            ],
        )
        expect(result.totalStakedWeight).toBe("15")
        // 2/3 of 15 = 10 (floor). approve=10 >= 10 → pass
        expect(result.passed).toBe(true)
    })

    it("never passes on empty votes with no snapshot", () => {
        const result = tallyVotes("p1", [])
        expect(result.passed).toBe(false)
    })
})
