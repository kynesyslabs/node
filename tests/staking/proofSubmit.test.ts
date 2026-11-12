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

import { resolveAnchorRpc } from "@/features/staking/proofSubmit"

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
