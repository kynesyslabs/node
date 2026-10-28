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

    it("skips when there is no record yet", () => {
        expect(
            judgeOwnSignature(block(500, "x"), null, "genesis-a", never).kind,
        ).toBe("ours")
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

    it("does nothing on a fresh node", () => {
        expect(checkOwnSignature(block(11, "bb", 1010)).kind).toBe("ours")
        expect(signingHaltReason()).toBeNull()
    })

    it("does not stop signing when the record cannot be read", () => {
        fs.writeFileSync(`${sharedState.identityFile}.signed.json`, "{")
        expect(checkOwnSignature(block(11, "bb", 1010)).kind).toBe("ours")
        expect(signingHaltReason()).toBeNull()
        expect(warning).toHaveBeenCalled()
    })
})
