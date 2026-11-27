import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const sharedState: any = { identityFile: "", genesisBlockHash: "genesis-a" }
const error = jest.fn()
const warning = jest.fn()
const incrementCounter = jest.fn()

jest.mock("src/utilities/logger", () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warning, error },
}))
jest.mock("src/utilities/sharedState", () => ({ getSharedState: sharedState }))
jest.mock("src/features/metrics/MetricsService", () => ({
    getMetricsService: () => ({ incrementCounter }),
}))

const { checkOwnSignature, judgeOwnSignature } = await import(
    "./foreignSignature"
)
const {
    __resetSigningHalt,
    checkBlockSignature,
    DoubleSignError,
    recordBlockSignature,
    signingHaltMarkerPath,
    signingHaltReason,
} = await import("./signingRecord")

const record = {
    genesisHash: "genesis-a",
    height: 100,
    timestamp: 5000,
    hash: "recorded",
    signedAt: 1,
}
const block = (number: number, hash: string, timestamp = 5000) => ({
    number,
    hash,
    timestamp,
})
const never = () => false

describe("judgeOwnSignature", () => {
    it("accepts the recorded block", () => {
        expect(
            judgeOwnSignature(block(100, "recorded"), record, "genesis-a", never)
                .kind,
        ).toBe("ours")
    })

    it("accepts history below the record", () => {
        expect(
            judgeOwnSignature(block(99, "older", 1), record, "genesis-a", never)
                .kind,
        ).toBe("ours")
    })

    it("only warns when there is no record for a known chain", () => {
        const verdict = judgeOwnSignature(
            block(500, "x"),
            null,
            "genesis-a",
            never,
        )
        expect(verdict.kind).toBe("ambiguous")
        expect((verdict as { reason: string }).reason).toContain("500")
        expect((verdict as { reason: string }).reason).toContain("hash x")
        expect((verdict as { reason: string }).reason).toContain(
            "no signing record",
        )
    })

    it("accepts a block this process signed when there is no record", () => {
        expect(
            judgeOwnSignature(
                block(500, "mine"),
                null,
                "genesis-a",
                hash => hash === "mine",
            ).kind,
        ).toBe("ours")
    })

    it("skips when there is no record and the genesis is unknown", () => {
        expect(judgeOwnSignature(block(500, "x"), null, null, never).kind).toBe(
            "ours",
        )
    })

    it("skips a record of another chain or an unknown genesis", () => {
        expect(
            judgeOwnSignature(block(500, "x"), record, "genesis-b", never).kind,
        ).toBe("ours")
        expect(judgeOwnSignature(block(500, "x"), record, null, never).kind).toBe(
            "ours",
        )
    })

    it("flags a signature above the recorded height", () => {
        const verdict = judgeOwnSignature(
            block(101, "x", 6000),
            record,
            "genesis-a",
            never,
        )
        expect(verdict.kind).toBe("foreign")
        expect((verdict as { reason: string }).reason).toContain("101")
        expect((verdict as { reason: string }).reason).toContain("recorded")
    })

    it("flags another block at the recorded round or a later one", () => {
        expect(
            judgeOwnSignature(block(100, "x", 5000), record, "genesis-a", never)
                .kind,
        ).toBe("foreign")
        expect(
            judgeOwnSignature(block(100, "x", 5010), record, "genesis-a", never)
                .kind,
        ).toBe("foreign")
    })

    it("only warns for an earlier round at the recorded height", () => {
        expect(
            judgeOwnSignature(block(100, "x", 4990), record, "genesis-a", never)
                .kind,
        ).toBe("ambiguous")
    })

    it("accepts any block this process signed", () => {
        expect(
            judgeOwnSignature(
                block(101, "mine", 6000),
                record,
                "genesis-a",
                hash => hash === "mine",
            ).kind,
        ).toBe("ours")
    })
})

describe("checkOwnSignature", () => {
    let dir: string
    const round = (height: number, timestamp: number, hash: string) => ({
        genesisHash: "genesis-a",
        height,
        timestamp,
        hash,
    })

    beforeEach(() => {
        __resetSigningHalt()
        error.mockClear()
        warning.mockClear()
        incrementCounter.mockClear()
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "demos-foreign-"))
        sharedState.identityFile = path.join(dir, ".demos_identity")
    })
    afterEach(() => {
        __resetSigningHalt()
        fs.rmSync(dir, { recursive: true, force: true })
    })

    it("stops signing, logs once and counts when another signer shows up", () => {
        recordBlockSignature(sharedState.identityFile, round(10, 1000, "aa"))
        __resetSigningHalt()

        expect(checkOwnSignature(block(11, "bb", 1010)).kind).toBe("foreign")
        expect(checkOwnSignature(block(12, "cc", 1020)).kind).toBe("foreign")

        expect(signingHaltReason()).toContain("another process")
        expect(error).toHaveBeenCalledTimes(1)
        expect(incrementCounter).toHaveBeenCalledWith("foreign_signature_total")
        expect(() =>
            checkBlockSignature(sharedState.identityFile, round(13, 1030, "dd")),
        ).toThrow(DoubleSignError)
        expect(fs.existsSync(signingHaltMarkerPath(sharedState.identityFile))).toBe(
            true,
        )
    })

    it("judges history below the known record without reading the file", () => {
        recordBlockSignature(sharedState.identityFile, round(10, 1000, "aa"))
        fs.writeFileSync(`${sharedState.identityFile}.signed.json`, "{")
        expect(checkOwnSignature(block(9, "old", 900)).kind).toBe("ours")
        expect(warning).not.toHaveBeenCalled()
    })

    it("leaves signing alone for blocks this process signed", () => {
        recordBlockSignature(sharedState.identityFile, round(10, 1000, "aa"))
        recordBlockSignature(sharedState.identityFile, round(10, 1005, "bb"))
        // The shard finalised the first round after this node retried.
        expect(checkOwnSignature(block(10, "aa", 1000)).kind).toBe("ours")
        expect(checkOwnSignature(block(10, "bb", 1005)).kind).toBe("ours")
        expect(signingHaltReason()).toBeNull()
        expect(() =>
            checkBlockSignature(sharedState.identityFile, round(11, 1010, "cc")),
        ).not.toThrow()
    })

    it("only warns on a fresh node with no signing record", () => {
        expect(checkOwnSignature(block(11, "bb", 1010)).kind).toBe("ambiguous")
        expect(signingHaltReason()).toBeNull()
        expect(warning).toHaveBeenCalledTimes(1)
        expect(error).not.toHaveBeenCalled()
        expect(incrementCounter).not.toHaveBeenCalled()
        expect(fs.existsSync(signingHaltMarkerPath(sharedState.identityFile))).toBe(
            false,
        )
    })

    it("warns without stopping signing when our key signed a block with no record", () => {
        const verdict = checkOwnSignature(block(42, "unrecorded", 4200))
        expect(verdict.kind).toBe("ambiguous")
        expect(warning).toHaveBeenCalledTimes(1)
        expect(warning.mock.calls[0][0]).toContain("42")
        expect(warning.mock.calls[0][0]).toContain("unrecorded")
        expect(warning.mock.calls[0][0]).toContain("no signing record")
        expect(error).not.toHaveBeenCalled()
        expect(incrementCounter).not.toHaveBeenCalled()
        expect(signingHaltReason()).toBeNull()
        expect(fs.existsSync(signingHaltMarkerPath(sharedState.identityFile))).toBe(
            false,
        )
        expect(() =>
            checkBlockSignature(sharedState.identityFile, round(43, 4300, "next")),
        ).not.toThrow()
    })

    it("rate-limits the no-record warning during a long resync", () => {
        // 5000 distinct blocks; the first 600 arrive twice, so the running
        // count runs ahead of the number of distinct blocks.
        for (let i = 0; i < 5000; i++) {
            const seen = block(7001 + i, `nr-${7001 + i}`, 1)
            const times = i < 600 ? 2 : 1
            for (let n = 0; n < times; n++) {
                expect(checkOwnSignature(seen).kind).toBe("ambiguous")
            }
        }

        expect(warning.mock.calls.length).toBeLessThanOrEqual(6)
        expect(warning.mock.calls.length).toBeGreaterThanOrEqual(2)
        const lines = warning.mock.calls.map(call => call[0] as string)
        expect(lines[0]).toContain("block 7001 (hash nr-7001")
        expect(lines[0]).toContain("no signing record")
        // The 1000th occurrence is the repeat of block 7500.
        const summary = lines.find(line =>
            line.includes("1000 occurrences so far"),
        )
        expect(summary).toBeDefined()
        expect(summary).toContain("block 7500 (hash nr-7500")
        expect(error).not.toHaveBeenCalled()
        expect(incrementCounter).not.toHaveBeenCalled()
        expect(signingHaltReason()).toBeNull()
        expect(fs.existsSync(signingHaltMarkerPath(sharedState.identityFile))).toBe(
            false,
        )
    })

    it("warns every time for an earlier round at the recorded height", () => {
        recordBlockSignature(sharedState.identityFile, round(10, 1000, "aa"))
        warning.mockClear()
        for (let i = 0; i < 25; i++) {
            expect(checkOwnSignature(block(10, `early-${i}`, 990)).kind).toBe(
                "ambiguous",
            )
        }
        expect(warning).toHaveBeenCalledTimes(25)
        expect(warning.mock.calls[24][0]).toContain("early-24")
        expect(warning.mock.calls[24][0]).toContain("earlier round")
        expect(signingHaltReason()).toBeNull()
    })

    it("does not stop signing when the record cannot be read", () => {
        fs.writeFileSync(`${sharedState.identityFile}.signed.json`, "{")
        expect(checkOwnSignature(block(11, "bb", 1010)).kind).toBe("ours")
        expect(signingHaltReason()).toBeNull()
        expect(warning).toHaveBeenCalled()
    })
})
