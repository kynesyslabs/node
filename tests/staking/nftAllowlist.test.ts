import { describe, expect, it, jest } from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))

jest.mock("src/config", () => ({
    __esModule: true,
    Config: { getInstance: () => ({ core: { validatorNftRequired: true } }) },
}))

import { allowlistDigest, parseAllowlist } from "@/features/staking/nftAllowlist"

const A = "7M7TxyCHoX3jmUNh68QxWWnUSbxJwEUTJoN5dHxTctGH"
const B = "2edqWDWbFkTjkcTb4zzj3PwQBHJeXbFuiAynm4bj46yP"
const C = "35MxXW1w6WodorZqZxoZVpXaukNo2n6q2T8zwgamPL3e"

describe("the NFT allowlist file", () => {
    it("hashes the sorted mints, whatever order the file lists them in", () => {
        expect(allowlistDigest([C, A, B])).toBe(allowlistDigest([A, B, C]))
        expect(allowlistDigest([A, B])).not.toBe(allowlistDigest([A, B, C]))
    })

    it("loads when the digest matches the configured one", () => {
        const digest = allowlistDigest([A, B])
        const mints = parseAllowlist(JSON.stringify({ sha256: digest, mints: [B, A] }), digest)
        expect([...mints].sort()).toEqual([A, B].sort())
    })

    it("refuses a file whose mints do not hash to the configured digest", () => {
        const pinned = allowlistDigest([A, B])
        expect(() => parseAllowlist(JSON.stringify({ mints: [A, B, C] }), pinned)).toThrow(
            "does not match the configured",
        )
    })

    it("refuses a file that contradicts its own digest", () => {
        expect(() =>
            parseAllowlist(JSON.stringify({ sha256: allowlistDigest([A]), mints: [A, B] }), ""),
        ).toThrow("file's own")
    })

    it("refuses duplicates and empty lists", () => {
        expect(() => parseAllowlist(JSON.stringify({ mints: [A, A] }), "")).toThrow("duplicate")
        expect(() => parseAllowlist(JSON.stringify({ mints: [] }), "")).toThrow("no mints")
    })

    it("matches the committed allowlist against its pinned digest", () => {
        const fs = jest.requireActual("fs") as typeof import("fs")
        const raw = fs.readFileSync("data/nft-allowlist.json", "utf8")
        const mints = parseAllowlist(
            raw,
            "3da7c881016692f1724c34c4d68ce6233e6f34eb3a5cf34323022c8930bab116",
        )
        expect(mints.size).toBe(460)
    })
})
