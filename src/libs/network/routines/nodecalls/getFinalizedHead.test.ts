/**
 * Finalized head: the latest inserted block with its age and signatures, a
 * node that is behind still answering with nodeSynced false, 503 with no
 * block and 500 on a failed read, and a body that always serialises.
 */

import { beforeEach, describe, expect, it, jest } from "bun:test"
import type { Blocks } from "src/model/entities/Blocks"

const getLastBlock = jest.fn(async () => null as any)
const getAheadValidatorPeers = jest.fn(async () => [] as unknown[])
const getNetworkTimestamp = jest.fn(() => 1_800_000_100)
const sharedState: Record<string, unknown> = { syncStatus: true, inSyncLoop: false }
const COMMITTEE = ["0xaa", "0xbb", "0xcc", "0xdd"]
const signerRuleOf = jest.fn(async (_n: number) => ({ bound: true, members: COMMITTEE, threshold: 3 }) as any)

jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: { getLastBlock } }))
jest.mock("src/libs/consensus/v2/routines/networkAheadVeto", () => ({ __esModule: true, getAheadValidatorPeers }))
jest.mock("src/libs/blockchain/validation/signerRule", () => ({ __esModule: true, signerRuleOf }))
jest.mock("src/libs/utils/calibrateTime", () => ({ __esModule: true, getNetworkTimestamp }))
jest.mock("src/utilities/sharedState", () => ({ __esModule: true, getSharedState: sharedState }))
jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), warning: jest.fn(), error: jest.fn(), only: jest.fn() },
}))

const { default: getFinalizedHead } = await import("./getFinalizedHead")

const SIGNATURES = { "0xaa": "sig-a", "0xbb": "sig-b", "0xcc": "sig-c" }

function block(overrides: Record<string, unknown> = {}) {
    return {
        number: 4242,
        hash: "e3b0c442",
        content: { timestamp: 1_800_000_000, ordered_transactions: [] },
        validation_data: { signatures: SIGNATURES },
        ...overrides,
    }
}

beforeEach(() => {
    getLastBlock.mockReset()
    getAheadValidatorPeers.mockReset()
    getNetworkTimestamp.mockReset()
    signerRuleOf.mockReset()
    signerRuleOf.mockResolvedValue({ bound: true, members: COMMITTEE, threshold: 3 })
    getLastBlock.mockResolvedValue(block())
    getAheadValidatorPeers.mockResolvedValue([])
    getNetworkTimestamp.mockReturnValue(1_800_000_100)
    sharedState.syncStatus = true
    sharedState.inSyncLoop = false
    sharedState.forkConfig = undefined
})

describe("getFinalizedHead", () => {
    it("answers the latest block with its age and signatures on a synced node", async () => {
        const reply = await getFinalizedHead()
        expect(reply.result).toBe(200)
        expect(reply.response).toEqual({
            number: 4242,
            hash: "e3b0c442",
            timestamp: 1_800_000_000,
            ageSeconds: 100,
            nodeSynced: true,
            checkedThroughBlock: 4242,
            signatureCount: 3,
            signatures: SIGNATURES,
            round: null,
            signedMessage: "e3b0c442",
            committee: COMMITTEE,
            committeeRule: "bound_committee",
            threshold: 3,
        })
    })

    it("names the signer set and threshold sync applies to the head", async () => {
        signerRuleOf.mockResolvedValue({ bound: false, members: ["0xaa", "0xbb"], threshold: 2 })
        getLastBlock.mockResolvedValue(block({ number: 77, hash: "0177" }))
        const reply = await getFinalizedHead()
        expect(signerRuleOf).toHaveBeenCalledWith(77)
        expect(reply.response.committee).toEqual(["0xaa", "0xbb"])
        expect(reply.response.committeeRule).toBe("eligible_pool")
        expect(reply.response.threshold).toBe(2)
    })

    it("reads the signer set once per head", async () => {
        getLastBlock.mockResolvedValue(block({ number: 78, hash: "0178" }))
        await getFinalizedHead()
        await getFinalizedHead()
        expect(signerRuleOf).toHaveBeenCalledTimes(1)
    })

    it("still answers the head with a null signer set when it cannot be read", async () => {
        signerRuleOf.mockRejectedValue(new Error("block 78 not found"))
        getLastBlock.mockResolvedValue(block({ number: 79, hash: "0179" }))
        const reply = await getFinalizedHead()
        expect(reply.result).toBe(200)
        expect(reply.response.number).toBe(79)
        expect(reply.response.committee).toBeNull()
        expect(reply.response.committeeRule).toBeNull()
        expect(reply.response.threshold).toBeNull()
    })

    it("still answers the head with nodeSynced false before the node is synced", async () => {
        sharedState.syncStatus = false
        const reply = await getFinalizedHead()
        expect(reply.result).toBe(200)
        expect(reply.response.nodeSynced).toBe(false)
        expect(reply.response.number).toBe(4242)
        expect(reply.response.ageSeconds).toBe(100)
        expect(getAheadValidatorPeers).not.toHaveBeenCalled()
    })

    it("reports nodeSynced false while a validator peer is ahead", async () => {
        getAheadValidatorPeers.mockResolvedValue([{ identity: "0xdd" }])
        const reply = await getFinalizedHead()
        expect(reply.result).toBe(200)
        expect(reply.response.nodeSynced).toBe(false)
    })

    it("reports nodeSynced false when the network-ahead check fails", async () => {
        getAheadValidatorPeers.mockRejectedValue(new Error("no active validators"))
        const reply = await getFinalizedHead()
        expect(reply.result).toBe(200)
        expect(reply.response.nodeSynced).toBe(false)
    })

    it("keeps reporting synced during the sync pass every round starts with", async () => {
        sharedState.inSyncLoop = true
        expect((await getFinalizedHead()).response.nodeSynced).toBe(true)
    })

    it("answers 503 node_not_synced with the body state when the node holds no block", async () => {
        getLastBlock.mockResolvedValue(null)
        const reply = await getFinalizedHead()
        expect(reply.result).toBe(503)
        expect(reply.extra).toEqual({ reason: "node_not_synced" })
        expect(reply.response).toEqual({
            number: null,
            hash: null,
            timestamp: null,
            ageSeconds: null,
            nodeSynced: false,
            checkedThroughBlock: null,
            signatureCount: 0,
            signatures: {},
            round: null,
            signedMessage: null,
            committee: null,
            committeeRule: null,
            threshold: null,
        })
    })

    it("answers a failed read as 500 lookup_failed, keeping nodeSynced in the body", async () => {
        getLastBlock.mockRejectedValue(new Error("connection terminated"))
        const reply = await getFinalizedHead()
        expect(reply.result).toBe(500)
        expect(reply.response).toEqual({ error: "INTERNAL_ERROR", nodeSynced: false })
        expect(reply.extra).toEqual({ reason: "lookup_failed", error: "connection terminated" })
    })

    it("never reports a negative age for a block stamped ahead of this node's clock", async () => {
        getLastBlock.mockResolvedValue(block({ content: { timestamp: 1_800_000_130 } }))
        expect((await getFinalizedHead()).response.ageSeconds).toBe(0)
    })

    it("reads a genesis stored in milliseconds as seconds", async () => {
        getLastBlock.mockResolvedValue(
            block({ number: 0, content: { timestamp: 1_800_000_040_123 }, validation_data: { signatures: { "0x000000000000000000000000": "0x0" } } }),
        )
        const reply = await getFinalizedHead()
        expect(reply.result).toBe(200)
        expect(reply.response.number).toBe(0)
        expect(reply.response.checkedThroughBlock).toBe(0)
        expect(reply.response.timestamp).toBe(1_800_000_040)
        expect(reply.response.ageSeconds).toBe(60)
        expect(reply.response.signatureCount).toBe(1)
        expect(reply.response.committee).toBeNull()
        expect(reply.response.threshold).toBeNull()
        expect(signerRuleOf).not.toHaveBeenCalled()
    })

    it("reads a genesis configured in seconds as is", async () => {
        getLastBlock.mockResolvedValue(block({ number: 0, content: { timestamp: 1_692_734_616 } }))
        expect((await getFinalizedHead()).response.ageSeconds).toBe(1_800_000_100 - 1_692_734_616)
    })

    it("answers ageSeconds null rather than a guess for a block without a usable timestamp", async () => {
        for (const timestamp of [undefined, null, "soon", -5, Number.NaN]) {
            getLastBlock.mockResolvedValue(block({ content: { timestamp } }))
            const reply = await getFinalizedHead()
            expect(reply.result).toBe(200)
            expect(reply.response.ageSeconds).toBeNull()
        }
    })

    it("answers a block with no stored validation data as zero signatures", async () => {
        getLastBlock.mockResolvedValue(block({ validation_data: null }))
        const reply = await getFinalizedHead()
        expect(reply.response.signatureCount).toBe(0)
        expect(reply.response.signatures).toEqual({})
    })

    it("reports the timestamp in seconds when the stored value is a bigint", async () => {
        getLastBlock.mockResolvedValue(block({ content: { timestamp: 1_800_000_000n } }))
        const reply = await getFinalizedHead()
        expect(reply.response.timestamp).toBe(1_800_000_000)
        expect(reply.response.ageSeconds).toBe(100)
        expect(() => JSON.stringify(reply)).not.toThrow()
        expect(JSON.parse(JSON.stringify(reply)).response.number).toBe(4242)
    })
    it("gives the precommit message the certificate signs under commitLock", async () => {
        sharedState.forkConfig = {
            commitLock: { activationHeight: 0 },
            committeeBinding: { activationHeight: 0 },
        }
        // Typed as the stored row so the type check covers the round field.
        const validationData: Blocks["validation_data"] = { signatures: SIGNATURES, round: 2 }
        getLastBlock.mockResolvedValue(block({ validation_data: validationData }))
        const reply = await getFinalizedHead()
        expect(reply.response.round).toBe(2)
        expect(reply.response.signedMessage).toMatch(/:4242:2:e3b0c442$/)
        expect(reply.response.signedMessage).not.toBe("e3b0c442")
    })

    it("gives no signed message under commitLock when the block carries no round", async () => {
        sharedState.forkConfig = {
            commitLock: { activationHeight: 0 },
            committeeBinding: { activationHeight: 0 },
        }
        const reply = await getFinalizedHead()
        expect(reply.response.round).toBeNull()
        expect(reply.response.signedMessage).toBeNull()
    })

    it("does not run the network-ahead check when the node holds no block", async () => {
        getLastBlock.mockResolvedValue(null)
        await getFinalizedHead()
        expect(getAheadValidatorPeers).not.toHaveBeenCalled()
    })
})
