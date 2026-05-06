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

const proposalRepoMock = {
    findOne: jest.fn(),
    findOneBy: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
    create: jest.fn((row: unknown) => ({ ...(row as object) })),
    createQueryBuilder: jest.fn(() => ({
        select: jest.fn().mockReturnThis(),
        getRawOne: jest.fn(async () => ({ max: 0 })),
    })),
}
const voteRepoMock = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((row: unknown) => ({ ...(row as object) })),
}

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

import Chain from "@/libs/blockchain/chain"
import GCR from "@/libs/blockchain/gcr/gcr"
import {
    GRACE_PERIOD_BLOCKS,
    VOTING_WINDOW_BLOCKS,
    GENESIS_NETWORK_PARAMETERS,
} from "@/features/networkUpgrade/constants"
import { VALIDATOR_STATUS_ACTIVE } from "@/features/staking/constants"

let handleGovernanceTx: typeof import("@/libs/network/routines/transactions/handleGovernanceTx").handleGovernanceTx

beforeAll(async () => {
    ({ handleGovernanceTx } = await import(
        "@/libs/network/routines/transactions/handleGovernanceTx"
    ))
})

// ---------- factories ----------

const PROPOSER = "aa11"
const CURRENT_BLOCK = 1000
const MIN_EFFECTIVE =
    CURRENT_BLOCK + VOTING_WINDOW_BLOCKS + GRACE_PERIOD_BLOCKS

function proposalTx(overrides: Record<string, unknown> = {}) {
    return {
        content: {
            type: "networkUpgrade",
            from: PROPOSER,
            from_ed25519_address: PROPOSER,
            data: [
                "networkUpgrade",
                {
                    proposalId: "p1",
                    proposedParameters: { networkFee: 15 },
                    rationale: "bump fee",
                    effectiveAtBlock: MIN_EFFECTIVE,
                    ...overrides,
                },
            ],
            gcr_edits: [],
        },
        hash: "0xprop",
    } as any
}

function voteTx(
    proposalId: string,
    approve: boolean,
    voter: string = PROPOSER,
) {
    return {
        content: {
            type: "networkUpgradeVote",
            from: voter,
            from_ed25519_address: voter,
            data: ["networkUpgradeVote", { proposalId, approve }],
            gcr_edits: [],
        },
        hash: "0xvote",
    } as any
}

// ---------- proposal ----------

describe("handleGovernanceTx — networkUpgrade", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        // Stage a non-genesis networkFee so proposalTx()'s default of 15
        // sits inside the 50% percent cap. Genesis defaults are 1/1/1
        // (post-#62), too low to express meaningful fee proposals
        // without changing every fixture.
        sharedStateStub.networkParameters = {
            ...GENESIS_NETWORK_PARAMETERS,
            networkFee: 10,
        }
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(
            CURRENT_BLOCK as never,
        )
        ;(GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue({
            address: PROPOSER,
            status: VALIDATOR_STATUS_ACTIVE,
        } as never)
        proposalRepoMock.findOne.mockResolvedValue(null)
        proposalRepoMock.findOneBy.mockResolvedValue(null)
        proposalRepoMock.find.mockResolvedValue([])
        proposalRepoMock.save.mockResolvedValue({})
        proposalRepoMock.createQueryBuilder.mockReturnValue({
            select: jest.fn().mockReturnThis(),
            getRawOne: jest.fn(async () => ({ max: 2 })),
        })
    })

    it("accepts a well-formed proposal (validation only)", async () => {
        const r = await handleGovernanceTx(proposalTx())
        expect(r.success).toBe(true)
        // Edit attachment is handled by SDK's GCRGeneration.generate(),
        // not by the handler. The handler is a pure validator now —
        // confirms policy, no mutation. Persistence happens at apply
        // time on every node.
        expect(proposalRepoMock.save).not.toHaveBeenCalled()
    })

    it("rejects a proposal from a non-validator", async () => {
        (GCR.getGCRValidatorStatus as jest.Mock).mockResolvedValue(
            null as never,
        )
        const r = await handleGovernanceTx(proposalTx())
        expect(r.success).toBe(false)
        expect(r.message).toContain("not an active validator")
    })

    it("rejects a proposal with effectiveAtBlock too soon", async () => {
        const r = await handleGovernanceTx(
            proposalTx({ effectiveAtBlock: CURRENT_BLOCK + 10 }),
        )
        expect(r.success).toBe(false)
        expect(r.message).toMatch(/effectiveAtBlock/)
    })

    it("rejects a proposal that violates safety bounds", async () => {
        const r = await handleGovernanceTx(
            proposalTx({ proposedParameters: { networkFee: 100000 } }), // ceiling 5000
        )
        expect(r.success).toBe(false)
        expect(r.message).toContain("Safety bounds violated")
    })

    it("rejects a proposal when the proposer already has one open", async () => {
        proposalRepoMock.findOne.mockResolvedValue({
            proposalId: "prev",
            status: "pending",
        })
        const r = await handleGovernanceTx(proposalTx())
        expect(r.success).toBe(false)
        expect(r.message).toContain("already has an open proposal")
    })

    it("rejects a proposal with a duplicate proposalId", async () => {
        proposalRepoMock.findOneBy.mockResolvedValue({
            proposalId: "p1",
        })
        const r = await handleGovernanceTx(proposalTx())
        expect(r.success).toBe(false)
        expect(r.message).toContain("proposalId already exists")
    })

    it("rejects a proposal whose keys overlap an open proposal", async () => {
        proposalRepoMock.find.mockResolvedValue([
            {
                proposalId: "other",
                proposedParameters: { networkFee: 20 },
                status: "activating",
            },
        ])
        const r = await handleGovernanceTx(proposalTx())
        expect(r.success).toBe(false)
        expect(r.message).toContain("locked by proposal other")
    })

    it("rejects rationale longer than 1024 bytes", async () => {
        const r = await handleGovernanceTx(
            proposalTx({ rationale: "A".repeat(1025) }),
        )
        expect(r.success).toBe(false)
        expect(r.message).toContain("rationale must be <= 1024 bytes")
    })

    it("rejects an empty proposedParameters object", async () => {
        const r = await handleGovernanceTx(
            proposalTx({ proposedParameters: {} }),
        )
        expect(r.success).toBe(false)
        expect(r.message).toContain("non-empty object")
    })
})

// ---------- vote ----------

describe("handleGovernanceTx — networkUpgradeVote", () => {
    const SNAPSHOT = 900
    const TALLY = SNAPSHOT + VOTING_WINDOW_BLOCKS

    beforeEach(() => {
        jest.clearAllMocks()
        ;(Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(
            (SNAPSHOT + 10) as never,
        )
        proposalRepoMock.findOneBy.mockResolvedValue({
            proposalId: "p1",
            status: "pending",
            snapshotBlock: SNAPSHOT,
            tallyBlock: TALLY,
        })
        ;(GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { address: PROPOSER, staked_amount: "100" },
            { address: "bb22", staked_amount: "50" },
        ] as never)
        voteRepoMock.findOne.mockResolvedValue(null)
        voteRepoMock.save.mockResolvedValue({})
    })

    it("records a vote (validation only)", async () => {
        const r = await handleGovernanceTx(voteTx("p1", true))
        expect(r.success).toBe(true)
        expect(voteRepoMock.save).not.toHaveBeenCalled()
    })

    it("rejects a vote on an unknown proposal", async () => {
        proposalRepoMock.findOneBy.mockResolvedValue(null)
        const r = await handleGovernanceTx(voteTx("ghost", true))
        expect(r.success).toBe(false)
        expect(r.message).toContain("Proposal not found")
    })

    it("rejects a vote on a non-pending proposal", async () => {
        proposalRepoMock.findOneBy.mockResolvedValue({
            proposalId: "p1",
            status: "approved",
            snapshotBlock: SNAPSHOT,
            tallyBlock: TALLY,
        })
        const r = await handleGovernanceTx(voteTx("p1", true))
        expect(r.success).toBe(false)
        expect(r.message).toMatch(/not open for voting/)
    })

    it("rejects a vote after the voting window closes", async () => {
        (Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(
            (TALLY + 1) as never,
        )
        const r = await handleGovernanceTx(voteTx("p1", true))
        expect(r.success).toBe(false)
        expect(r.message).toContain("Voting window closed")
    })

    it("rejects a vote from a non-snapshot validator", async () => {
        (GCR.getGCRValidatorsAtBlock as jest.Mock).mockResolvedValue([
            { address: "other", staked_amount: "100" },
        ] as never)
        const r = await handleGovernanceTx(voteTx("p1", false))
        expect(r.success).toBe(false)
        expect(r.message).toContain("not in the snapshot validator set")
    })

    it("rejects a duplicate vote from the same validator", async () => {
        voteRepoMock.findOne.mockResolvedValue({ id: 1 })
        const r = await handleGovernanceTx(voteTx("p1", true))
        expect(r.success).toBe(false)
        expect(r.message).toContain("already voted")
    })

    // Gaps flagged during the plan audit (missing-sender / malformed payloads /
    // pre-snapshot vote / unknown type). Add them here so every reject branch
    // in handleGovernanceTx has a dedicated unit assertion.

    it("rejects a proposal with empty sender (from + from_ed25519_address both missing)", async () => {
        const tx = proposalTx()
        tx.content.from = ""
        tx.content.from_ed25519_address = ""
        const r = await handleGovernanceTx(tx)
        expect(r.success).toBe(false)
        expect(r.message).toContain("Missing sender")
    })

    it("rejects a proposal with missing payload (data[1] undefined)", async () => {
        const tx = proposalTx()
        tx.content.data = ["networkUpgrade"] as unknown as [string, unknown]
        const r = await handleGovernanceTx(tx)
        expect(r.success).toBe(false)
        expect(r.message).toContain("Missing proposal payload")
    })

    it("rejects a vote with malformed payload (proposalId missing)", async () => {
        const tx = voteTx("ignored", true)
        tx.content.data = [
            "networkUpgradeVote",
            { approve: true },
        ] as unknown as [string, unknown]
        const r = await handleGovernanceTx(tx)
        expect(r.success).toBe(false)
        expect(r.message).toContain("Missing vote payload")
    })

    it("rejects a vote with non-boolean approve", async () => {
        const tx = voteTx("p1", true)
        tx.content.data = [
            "networkUpgradeVote",
            { proposalId: "p1", approve: "yes" },
        ] as unknown as [string, unknown]
        const r = await handleGovernanceTx(tx)
        expect(r.success).toBe(false)
        expect(r.message).toContain("Missing vote payload")
    })

    it("rejects a vote cast at or before the snapshot block (voting window not yet open)", async () => {
        // Vote describe-block seeds snapshotBlock=900. currentBlock<=snapshot
        // is the "window not yet open" boundary.
        (Chain.getLastBlockNumber as jest.Mock).mockResolvedValue(
            900 as never,
        )
        const r = await handleGovernanceTx(voteTx("p1", true))
        expect(r.success).toBe(false)
        expect(r.message).toContain("not opened yet")
    })

    it("rejects an unknown governance tx type", async () => {
        const tx = {
            hash: "0xunknown",
            content: {
                type: "somethingElse",
                from: PROPOSER,
                from_ed25519_address: PROPOSER,
                data: ["somethingElse", {}],
            },
        } as any
        const r = await handleGovernanceTx(tx)
        expect(r.success).toBe(false)
        expect(r.message).toContain("Unknown governance tx type")
    })
})
