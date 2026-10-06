import { beforeEach, describe, expect, it, jest } from "bun:test"

const txStatics = {
    structured: jest.fn(() => ({ valid: true, message: "" })),
    isCoherent: jest.fn(() => true),
    validateSignature: jest.fn(async () => ({ success: true, message: "" })),
}
jest.mock("src/libs/blockchain/transaction", () => ({
    __esModule: true,
    default: txStatics,
}))

const chain = { checkTxExists: jest.fn(async () => false) }
jest.mock("src/libs/blockchain/chain", () => ({ __esModule: true, default: chain }))

const mempool = { checkTransactionByHash: jest.fn(async () => null) }
jest.mock("src/libs/blockchain/mempool", () => ({ __esModule: true, default: mempool }))

jest.mock("src/libs/blockchain/referenceBlockWindow", () => ({
    isWithinDeepWindow: (ref: number, head: number) => ref >= head - 5 && ref <= head,
}))

import { checkTxAdmissible } from "./txAdmission"

const tx = (referenceBlock?: number) =>
    ({ hash: "h1", content: {}, reference_block: referenceBlock }) as any

describe("checkTxAdmissible", () => {
    beforeEach(() => {
        for (const fn of Object.values(txStatics)) fn.mockClear()
        chain.checkTxExists.mockClear()
        mempool.checkTransactionByHash.mockClear()
        txStatics.structured.mockImplementation(() => ({ valid: true, message: "" }))
        txStatics.isCoherent.mockImplementation(() => true)
        txStatics.validateSignature.mockImplementation(async () => ({ success: true, message: "" }))
        chain.checkTxExists.mockImplementation(async () => false)
        mempool.checkTransactionByHash.mockImplementation(async () => null)
    })

    it("admits a well-formed, signed, coherent, unseen tx", async () => {
        expect(await checkTxAdmissible(tx(100), { head: 100 })).toEqual({ ok: true })
        expect(mempool.checkTransactionByHash).not.toHaveBeenCalled()
    })

    it("rejects malformed structure first, before any crypto", async () => {
        txStatics.structured.mockImplementation(() => ({ valid: false, message: "bad to" }))
        const v = await checkTxAdmissible(tx(100), { head: 100 })
        expect(v).toEqual({ ok: false, code: "structure", reason: "bad to" })
        expect(txStatics.validateSignature).not.toHaveBeenCalled()
    })

    it("enforces the reference window only when asked", async () => {
        expect((await checkTxAdmissible(tx(50), { head: 100 })).ok).toBe(true)
        const v = await checkTxAdmissible(tx(50), { head: 100, checkWindow: true })
        expect(v.ok).toBe(false)
        expect(v.code).toBe("window")
        expect((await checkTxAdmissible(tx(97), { head: 100, checkWindow: true })).ok).toBe(true)
        expect((await checkTxAdmissible(tx(), { head: 100, checkWindow: true })).code).toBe("window")
    })

    it("rejects hash mismatch before verifying the signature", async () => {
        txStatics.isCoherent.mockImplementation(() => false)
        const v = await checkTxAdmissible(tx(100), { head: 100 })
        expect(v.code).toBe("coherence")
        expect(txStatics.validateSignature).not.toHaveBeenCalled()
    })

    it("passes the request sender through to signature validation", async () => {
        await checkTxAdmissible(tx(100), { head: 100, sender: "0xabc" })
        expect(txStatics.validateSignature).toHaveBeenCalledWith(expect.anything(), "0xabc")
        await checkTxAdmissible(tx(100), { head: 100 })
        expect(txStatics.validateSignature).toHaveBeenLastCalledWith(expect.anything(), null)
    })

    it("surfaces the signature failure message", async () => {
        txStatics.validateSignature.mockImplementation(async () => ({ success: false, message: "nope" }))
        expect(await checkTxAdmissible(tx(100), { head: 100 })).toEqual({ ok: false, code: "signature", reason: "nope" })
    })

    it("rejects a tx already on chain", async () => {
        chain.checkTxExists.mockImplementation(async () => true)
        expect((await checkTxAdmissible(tx(100), { head: 100 })).code).toBe("on_chain")
    })

    it("rejects a tx already in the mempool only when asked", async () => {
        mempool.checkTransactionByHash.mockImplementation(async () => ({ hash: "h1" }))
        expect((await checkTxAdmissible(tx(100), { head: 100 })).ok).toBe(true)
        expect((await checkTxAdmissible(tx(100), { head: 100, checkMempool: true })).code).toBe("in_mempool")
    })
})
