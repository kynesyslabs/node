import { beforeEach, describe, expect, it, jest } from "@jest/globals"

const warning = jest.fn()
jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning, error: jest.fn() },
}))

let scheduled = true
jest.mock("@/forks/nftValidatorGatingGate", () => ({
    __esModule: true,
    nftGatingScheduled: () => scheduled,
}))

const loadNftAllowlist = jest.fn()
jest.mock("@/features/staking/nftAllowlist", () => ({
    __esModule: true,
    loadNftAllowlist,
}))

const probes: { url: string; ok: boolean }[] = []
const probeSolanaEndpoints = jest.fn(async () => probes)
jest.mock("@/features/staking/solanaRpc", () => ({
    __esModule: true,
    probeSolanaEndpoints,
}))

import { ensureNftGatingReady } from "@/features/staking/boot"

describe("ensureNftGatingReady", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        scheduled = true
        loadNftAllowlist.mockImplementation(() => undefined)
        probes.splice(0, probes.length, { url: "https://api.mainnet-beta.solana.com", ok: true })
    })

    it("checks nothing on a network that does not schedule NFT gating", async () => {
        scheduled = false
        await expect(ensureNftGatingReady()).resolves.toBeUndefined()
        expect(loadNftAllowlist).not.toHaveBeenCalled()
        expect(probeSolanaEndpoints).not.toHaveBeenCalled()
    })

    it("starts with a readable allowlist and an answering endpoint", async () => {
        await expect(ensureNftGatingReady()).resolves.toBeUndefined()
        expect(loadNftAllowlist).toHaveBeenCalledTimes(1)
        expect(warning).not.toHaveBeenCalled()
    })

    it("starts and warns when no endpoint answers", async () => {
        probes.splice(0, probes.length, { url: "https://api.mainnet-beta.solana.com", ok: false })
        await expect(ensureNftGatingReady()).resolves.toBeUndefined()
        expect(warning.mock.calls.map(call => String(call[0])).join("\n")).toContain(
            "no Solana endpoint answers",
        )
    })

    it("refuses to start when the allowlist does not match its pin", async () => {
        loadNftAllowlist.mockImplementation(() => {
            throw new Error("NFT allowlist digest mismatch")
        })
        await expect(ensureNftGatingReady()).rejects.toThrow("digest mismatch")
    })
})
