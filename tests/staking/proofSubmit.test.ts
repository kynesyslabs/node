import { describe, expect, it, jest } from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))
jest.mock("src/utilities/sharedState", () => ({
    __esModule: true,
    getSharedState: { peerListFile: "demos_peerlist.json", exposedUrl: "http://me:53550", identityFile: ".demos_identity" },
}))

const withSolana = jest.fn<(what: string, read: unknown) => Promise<unknown>>()
jest.mock("@/features/staking/solanaRpc", () => ({ __esModule: true, withSolana }))

// The anchor's replies, scripted per test.
const anchor = {
    validatorInfo: jest.fn<() => Promise<unknown>>(),
    nodeCall: jest.fn<() => Promise<unknown>>(),
}
jest.mock("@kynesyslabs/demosdk/websdk", () => ({
    __esModule: true,
    Demos: class {
        async connect() {}
        getValidatorInfo() {
            return anchor.validatorInfo()
        }
        nodeCall() {
            return anchor.nodeCall()
        }
    },
}))

import { resolveAnchorRpc } from "@/features/staking/proofSubmit"
import { AnchorUnreachableError } from "@/features/staking/validationHandlers"

const peers = (map: Record<string, unknown>) => () => JSON.stringify(map)

describe("resolveAnchorRpc", () => {
    it("takes the first peerlist entry that is not this node", () => {
        const list = peers({ a: "http://me:53550/", b: "http://anchor:53550/", c: "http://other:53550" })
        expect(resolveAnchorRpc(list, "http://me:53550")).toBe("http://anchor:53550")
    })

    it("falls back to this node's own URL when the peerlist has only itself or nothing", () => {
        expect(resolveAnchorRpc(peers({ a: "http://me:53550" }), "http://me:53550/")).toBe("http://me:53550")
        expect(resolveAnchorRpc(peers({}), "http://me:53550")).toBe("http://me:53550")
        expect(resolveAnchorRpc(() => { throw new Error("ENOENT") }, "http://me:53550")).toBe("http://me:53550")
        expect(resolveAnchorRpc(() => "not json", "http://me:53550")).toBe("http://me:53550")
    })

    it("is null with no peers and no exposed URL", () => {
        expect(resolveAnchorRpc(peers({}), "")).toBeNull()
        expect(resolveAnchorRpc(peers({ a: 42 }), " ")).toBeNull()
    })
})

describe("sendProofToSolana", () => {
    it("answers with the signature on success and the endpoint failures as a refusal", async () => {
        const { sendProofToSolana } = await import("@/features/staking/proofSubmit")
        withSolana.mockResolvedValueOnce("5sig")
        expect(await sendProofToSolana(new Uint8Array([1]))).toEqual({ accepted: true, message: "proof sent to Solana" })
        withSolana.mockRejectedValueOnce(new Error("sendRawTransaction(proof): helius: blockhash not found"))
        expect(await sendProofToSolana(new Uint8Array([1]))).toEqual({
            accepted: false,
            message: "sendRawTransaction(proof): helius: blockhash not found",
        })
    })
})

describe("nodeHoldsSeat", () => {
    const ME = "0x" + "a".repeat(64)
    const load = async () => {
        const m = await import("@/features/staking/proofSubmit")
        m.resetAnchorCacheForTesting()
        anchor.validatorInfo.mockReset()
        return m
    }

    it("caches a row with a status, and an explicit null, as definite answers", async () => {
        const { nodeHoldsSeat, resetAnchorCacheForTesting } = await load()
        anchor.validatorInfo.mockResolvedValue({ address: ME, status: "2" })
        expect(await nodeHoldsSeat(ME)).toBe(true)
        anchor.validatorInfo.mockResolvedValue(null)
        expect(await nodeHoldsSeat(ME)).toBe(true)
        expect(anchor.validatorInfo).toHaveBeenCalledTimes(1)

        resetAnchorCacheForTesting()
        expect(await nodeHoldsSeat(ME)).toBe(false)
        anchor.validatorInfo.mockResolvedValue({ address: ME, status: "2" })
        expect(await nodeHoldsSeat(ME)).toBe(false)
        expect(anchor.validatorInfo).toHaveBeenCalledTimes(2)
    })

    it("keys the cached answer by address, so another address reads the anchor", async () => {
        const { nodeHoldsSeat } = await load()
        const OTHER = "0x" + "b".repeat(64)
        anchor.validatorInfo.mockResolvedValue({ address: ME, status: "2" })
        expect(await nodeHoldsSeat(ME)).toBe(true)
        anchor.validatorInfo.mockResolvedValue(null)
        expect(await nodeHoldsSeat(OTHER)).toBe(false)
        expect(await nodeHoldsSeat(OTHER.toUpperCase().replace("0X", "0x"))).toBe(false)
        expect(anchor.validatorInfo).toHaveBeenCalledTimes(2)
    })

    it("reads an exited row as no seat", async () => {
        const { nodeHoldsSeat } = await load()
        anchor.validatorInfo.mockResolvedValue({ address: ME, status: "4" })
        expect(await nodeHoldsSeat(ME)).toBe(false)
    })

    for (const [name, reply] of [
        ["an error body", { error: "failed to load validators" }],
        ["a row without a status", { address: ME }],
        ["undefined", undefined],
        ["a string", "not found"],
    ] as const) {
        it(`reports ${name} as an unreachable anchor and caches nothing`, async () => {
            const { nodeHoldsSeat } = await load()
            anchor.validatorInfo.mockResolvedValue(reply)
            await expect(nodeHoldsSeat(ME)).rejects.toBeInstanceOf(AnchorUnreachableError)
            anchor.validatorInfo.mockResolvedValue({ address: ME, status: "3" })
            expect(await nodeHoldsSeat(ME)).toBe(true)
            expect(anchor.validatorInfo).toHaveBeenCalledTimes(2)
        })
    }

    it("reports a failed call as an unreachable anchor and caches nothing", async () => {
        const { nodeHoldsSeat } = await load()
        anchor.validatorInfo.mockRejectedValue(new Error("ECONNRESET"))
        await expect(nodeHoldsSeat(ME)).rejects.toBeInstanceOf(AnchorUnreachableError)
        anchor.validatorInfo.mockResolvedValue(null)
        expect(await nodeHoldsSeat(ME)).toBe(false)
    })
})

describe("mintHolder", () => {
    it("answers the holder or null, and reports any other reply as an unreachable anchor", async () => {
        const { mintHolder } = await import("@/features/staking/proofSubmit")
        anchor.nodeCall.mockResolvedValueOnce({ address: "0xabc", status: "2" })
        expect(await mintHolder("M")).toBe("0xabc")
        anchor.nodeCall.mockResolvedValueOnce(null)
        expect(await mintHolder("M")).toBeNull()
        anchor.nodeCall.mockResolvedValueOnce({ error: "failed to load validator" })
        await expect(mintHolder("M")).rejects.toBeInstanceOf(AnchorUnreachableError)
    })
})
