import { beforeEach, describe, expect, it, mock } from "bun:test"
import { createHash, generateKeyPairSync, sign, verify as verifySignature } from "node:crypto"
const verify = mock(async (_block: unknown): Promise<{ valid: boolean; reason?: string }> => ({ valid: true }))
const { publicKey, privateKey } = generateKeyPairSync("ed25519")
const ourKey = `0x${publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`
const signed = (hash: string) => sign(null, Buffer.from(hash), privateKey).toString("hex")
const haltSigning = mock(() => undefined)
const checkOwn = mock(async (block: any): Promise<void> => {
    const signature = block.validation_data.signatures[ourKey]
    if (signature && verifySignature(null, Buffer.from(block.hash), publicKey, Buffer.from(signature, "hex")) && block.number > 100) haltSigning()
})
const lookup = mock(async (_hash: string): Promise<unknown> => null)
const quiet = () => undefined
mock.module("src/utilities/logger", () => ({ default: { debug: quiet, warning: quiet } }))
mock.module("@/utilities/sharedState", () => ({ getSharedState: { lastBlockNumber: 100, publicKeyHex: ourKey } }))
mock.module("src/libs/consensus/stakedSet", () => ({
    getStakedSet: async () => new Set(), getStakedSetHeight: () => 100, isStaked: async () => false,
}))
mock.module("src/libs/blockchain/validation/validityData", () => ({ verifyValidityDataSignature: quiet }))
mock.module("src/libs/blockchain/validation/verifyBlock", () => ({ verifyBlock: verify, checkKnownBlockOwnSignature: checkOwn }))
mock.module("src/libs/blockchain/chain", () => ({ default: { getBlockByHash: lookup } }))
mock.module("@/forks", () => ({ serializeBlockContent: JSON.stringify }))
const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex")
mock.module("src/libs/crypto/hashing", () => ({ default: { sha256, sha256Bytes: sha256 } }))
mock.module("./records", () => ({ isHeightsRecordShape: () => false, verifyHeightsRecord: quiet }))
mock.module("./metrics", () => ({ recordVerdict: quiet, countTxRateLimited: quiet }))
const { validateBlockMessage, confirmBlock, applyingBlocks } = await import("./validators")
const encode = (b: unknown) => new TextEncoder().encode(JSON.stringify(b))
let seq = 0
function block(number = 101) {
    const content = { nonce: ++seq }
    return {
        number, hash: sha256(JSON.stringify(content)), content,
        validation_data: { signatures: { alice: "a", bob: "b" } as Record<string, string> },
    }
}
beforeEach(() => {
    applyingBlocks.clear()
    verify.mockReset()
    verify.mockResolvedValue({ valid: true })
    for (const fn of [checkOwn, haltSigning]) fn.mockClear()
    lookup.mockReset()
    lookup.mockResolvedValue(null)
})
describe("block gossip admission", () => {
    it("checks our signature on a stored block at its real height", async () => {
        const b = block(99)
        const stored = { ...b, content: { ...b.content } }
        b.validation_data.signatures[ourKey] = signed(b.hash)
        lookup.mockResolvedValue(stored)
        expect(await validateBlockMessage(encode(b))).toEqual({ result: "ignore", knownHash: b.hash })
        expect(await validateBlockMessage(encode(b))).toEqual({ result: "ignore", knownHash: b.hash })
        expect(checkOwn).toHaveBeenCalledTimes(1)
        const checked = checkOwn.mock.calls[0][0] as typeof b
        expect(checked.number).toBe(stored.number)
        expect(checked.content).toBe(stored.content)
        expect(haltSigning).not.toHaveBeenCalled()
    })
    it("does not inspect our signature on a confirmed copy with altered height and content", async () => {
        const b = block()
        expect((await validateBlockMessage(encode(b))).result).toBe("accept")
        confirmBlock(b.hash)
        const forged = { ...b, number: 102, content: { nonce: -1 },
            validation_data: { signatures: { [ourKey]: signed(b.hash) } } }
        expect(await validateBlockMessage(encode(forged))).toEqual({ result: "ignore", knownHash: b.hash })
        expect(haltSigning).not.toHaveBeenCalled()
        expect(checkOwn).not.toHaveBeenCalled()
    })
    it("does not inspect our signature on a stored block re-gossiped at another height", async () => {
        const stored = block(99)
        lookup.mockResolvedValue(stored)
        const forged = { ...stored, number: 101,
            validation_data: { signatures: { [ourKey]: signed(stored.hash) } } }
        expect(await validateBlockMessage(encode(forged))).toEqual({ result: "ignore", knownHash: stored.hash })
        expect(haltSigning).not.toHaveBeenCalled()
        expect(checkOwn).not.toHaveBeenCalled()
    })

    it("verifies certificate variants until the block is stored, then ignores them", async () => {
        const b = block()
        expect((await validateBlockMessage(encode(b))).result).toBe("accept")
        b.validation_data.signatures = { bob: "b", alice: "a", padding: "bad" }
        expect((await validateBlockMessage(encode(b))).result).toBe("accept")
        confirmBlock(b.hash)
        expect(await validateBlockMessage(encode(b))).toEqual({ result: "ignore", knownHash: b.hash })
        expect(verify).toHaveBeenCalledTimes(2)
    })

    it("skips certificate variants while the hash is applying and verifies them after a failed apply", async () => {
        const b = block()
        applyingBlocks.add(b.hash)
        expect(await validateBlockMessage(encode(b))).toEqual({ result: "ignore" })
        b.validation_data.signatures = { bob: "b", alice: "a" }
        expect(await validateBlockMessage(encode(b))).toEqual({ result: "ignore" })
        expect(verify).not.toHaveBeenCalled()
        applyingBlocks.delete(b.hash)
        expect((await validateBlockMessage(encode(b))).result).toBe("accept")
        expect(verify).toHaveBeenCalledTimes(1)
    })

    it("bounds concurrent checks even across distinct hashes", async () => {
        let release!: (v: null) => void
        const pending = new Promise<null>(resolve => { release = resolve })
        lookup.mockImplementation(() => pending)
        const checks = Array.from({ length: 128 }, () => validateBlockMessage(encode(block())))
        expect(await validateBlockMessage(encode(block()))).toEqual({ result: "ignore" })
        expect(lookup).toHaveBeenCalledTimes(128)
        release(null)
        expect((await Promise.all(checks)).every(v => v.result === "accept")).toBe(true)
    })
})
