import { beforeEach, describe, expect, it, jest } from "@jest/globals"

jest.mock("@/utilities/logger", () => ({
    __esModule: true,
    default: { info: jest.fn(), debug: jest.fn(), warning: jest.fn(), error: jest.fn() },
}))

const identity = { heliusApiKey: "" }
jest.mock("src/config", () => ({
    __esModule: true,
    Config: { getInstance: () => ({ identity }) },
}))

const gating = { enabled: true }
const loadNftAllowlist = jest.fn()
jest.mock("@/features/staking/nftAllowlist", () => ({
    __esModule: true,
    isNftGatingEnabled: () => gating.enabled,
    loadNftAllowlist,
}))

const probes: { url: string; ok: boolean }[] = []
jest.mock("@/features/staking/solanaRpc", () => ({
    __esModule: true,
    probeSolanaEndpoints: jest.fn(async () => probes),
}))

import { ensureNftGatingReady } from "@/features/staking/boot"

describe("ensureNftGatingReady", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        gating.enabled = true
        identity.heliusApiKey = "key"
        probes.splice(0, probes.length, { url: "https://mainnet.helius-rpc.com", ok: true })
    })

    it("refuses to start without a Helius key while gating is on", async () => {
        identity.heliusApiKey = "  "
        await expect(ensureNftGatingReady()).rejects.toThrow("HELIUS_API_KEY is not set")
        expect(loadNftAllowlist).not.toHaveBeenCalled()
    })

    it("starts with a key, a readable allowlist and an answering endpoint", async () => {
        await expect(ensureNftGatingReady()).resolves.toBeUndefined()
        expect(loadNftAllowlist).toHaveBeenCalledTimes(1)
    })

    it("refuses when no endpoint answers", async () => {
        probes.splice(0, probes.length, { url: "https://mainnet.helius-rpc.com", ok: false })
        await expect(ensureNftGatingReady()).rejects.toThrow("no Solana endpoint answers")
    })

    it("needs nothing when gating is off", async () => {
        gating.enabled = false
        identity.heliusApiKey = ""
        await expect(ensureNftGatingReady()).resolves.toBeUndefined()
        expect(loadNftAllowlist).not.toHaveBeenCalled()
    })
})
