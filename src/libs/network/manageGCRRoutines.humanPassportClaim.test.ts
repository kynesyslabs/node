/**
 * A wallet links Human Passport by signing the claim the node hands it.
 * Admission compares score, threshold and stamps with the provider, so the
 * read must hand back all of them, ready to sign: the bare score cannot
 * build a claim admission accepts.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { mockDatasource, mockLogger, mockXmLocalSdk } from "@/utilities/testSupport/coreMocks"

mockXmLocalSdk()
mockDatasource({})

const { default: manageGCRRoutines } = await import("./manageGCRRoutines")
const IdentityManager = (await import("@/libs/blockchain/gcr/gcr_routines/identityManager")).default
const { HumanPassportProvider } = await import("@/libs/identity/tools/humanpassport")
const { humanPassportRecord } = await import("@/libs/identity/humanPassportClaim")
const { resetHumanPassportClaimGate, CLAIM_FETCH_BURST } = await import("@/libs/identity/humanPassportClaimGate")

const SENDER = "0x" + "5e".repeat(32)
const EVM = "0x" + "ab".repeat(20)
const reported = {
    address: EVM,
    score: 25.5,
    passingScore: true,
    threshold: 20,
    stamps: ["Google", "Discord"],
    lastScoreTimestamp: "2026-10-27T10:00:00.000Z",
    expirationTimestamp: "2027-01-27T10:00:00.000Z",
}

describe("getHumanPassportClaim", () => {
    const spies: { mockRestore(): void }[] = []
    let fetches = 0
    beforeEach(() => {
        resetHumanPassportClaimGate()
        fetches = 0
        spies.push(
            spyOn(HumanPassportProvider, "getInstance").mockReturnValue({
                verifyAddress: async (address: string) => {
                    fetches++
                    return { ...reported, address }
                },
            } as any),
            spyOn(IdentityManager, "isXmWalletLinked").mockResolvedValue(true),
        )
    })
    afterEach(() => spies.splice(0).forEach(s => s.mockRestore()))

    it("returns a claim that admission accepts and apply can store", async () => {
        const res = await manageGCRRoutines(SENDER, { method: "getHumanPassportClaim", params: [EVM] })
        expect(res.result).toBe(200)

        const claim = res.response as any
        expect(typeof humanPassportRecord(claim)).toBe("object")
        const admitted = await IdentityManager.verifyHumanPassportPayload(claim, SENDER)
        expect(admitted).toEqual({ success: true, message: expect.stringContaining("verified") })
    })

    it("asks for an address", async () => {
        const res = await manageGCRRoutines(SENDER, { method: "getHumanPassportClaim", params: [] })
        expect(res.result).toBe(400)
    })

    it("leaves getHumanPassportScore answering the bare score, for existing callers", async () => {
        const res = await manageGCRRoutines(SENDER, { method: "getHumanPassportScore", params: [EVM] })
        expect(res.response).toBe(25.5)
    })

    it("charges getHumanPassportScore to the same cache and limit as the claim", async () => {
        await manageGCRRoutines(SENDER, { method: "getHumanPassportClaim", params: [EVM] })
        const score = await manageGCRRoutines(SENDER, { method: "getHumanPassportScore", params: [EVM] })
        expect(score.response).toBe(25.5)
        expect(fetches).toBe(1)

        const addresses = Array.from({ length: CLAIM_FETCH_BURST }, (_, i) =>
            "0x" + (i + 16).toString(16).padStart(2, "0").repeat(20),
        )
        const results = []
        for (const address of addresses) {
            results.push(await manageGCRRoutines(SENDER, { method: "getHumanPassportScore", params: [address] }))
        }
        expect(results.at(-1)!.result).toBe(429)
    })

    it("limits unsigned callers per source address, not as one shared bucket", async () => {
        const addresses = Array.from({ length: CLAIM_FETCH_BURST + 1 }, (_, i) =>
            "0x" + (i + 32).toString(16).padStart(2, "0").repeat(20),
        )
        const results = []
        for (const address of addresses) {
            results.push(await manageGCRRoutines("", { method: "getHumanPassportClaim", params: [address] }, "198.51.100.1"))
        }
        expect(results.at(-1)!.result).toBe(429)

        const otherClient = await manageGCRRoutines("", { method: "getHumanPassportClaim", params: [addresses.at(-1)] }, "198.51.100.2")
        expect(otherClient.result).toBe(200)
    })

    it("answers 400 to malformed addresses without using the caller's provider fetches", async () => {
        for (let i = 0; i < CLAIM_FETCH_BURST + 1; i++) {
            const bad = await manageGCRRoutines(SENDER, { method: "getHumanPassportClaim", params: [`0xbad${i}`] })
            expect(bad.result).toBe(400)
            expect(bad.extra.error).toContain("Invalid EVM address format")
        }
        expect(fetches).toBe(0)
        const valid = await manageGCRRoutines(SENDER, { method: "getHumanPassportClaim", params: [EVM] })
        expect(valid.result).toBe(200)
    })

    it("limits unsigned IPv6 callers per /64, like the HTTP limiter", async () => {
        const addresses = Array.from({ length: CLAIM_FETCH_BURST + 1 }, (_, i) =>
            "0x" + (i + 48).toString(16).padStart(2, "0").repeat(20),
        )
        const results = []
        for (const [i, address] of addresses.entries()) {
            results.push(await manageGCRRoutines("", { method: "getHumanPassportClaim", params: [address] }, `2001:db8:1:2::${i + 1}`))
        }
        expect(results.at(-1)!.result).toBe(429)

        const otherNetwork = await manageGCRRoutines("", { method: "getHumanPassportClaim", params: [addresses.at(-1)] }, "2001:db8:1:3::1")
        expect(otherNetwork.result).toBe(200)
    })

    it("answers a repeated address from the cache instead of the provider", async () => {
        const first = await manageGCRRoutines(SENDER, { method: "getHumanPassportClaim", params: [EVM] })
        const again = await manageGCRRoutines("0x" + "77".repeat(32), {
            method: "getHumanPassportClaim",
            params: [{ address: EVM.toUpperCase().replace("0X", "0x") }],
        })
        expect(again.result).toBe(200)
        expect(again.response).toEqual(first.response)
        expect(fetches).toBe(1)
    })

    it("refuses a caller past its provider fetches with 429 and a retry time", async () => {
        const addresses = Array.from({ length: CLAIM_FETCH_BURST + 1 }, (_, i) =>
            "0x" + i.toString(16).padStart(2, "0").repeat(20),
        )
        const results = []
        for (const address of addresses) {
            results.push(await manageGCRRoutines(SENDER, { method: "getHumanPassportClaim", params: [address] }))
        }
        expect(results.slice(0, -1).map(r => r.result)).toEqual(addresses.slice(0, -1).map(() => 200))
        const refused = results.at(-1)!
        expect(refused.result).toBe(429)
        expect(refused.response).toBeNull()
        expect(refused.extra).toEqual({ error: "Rate limit exceeded", retryAfter: expect.any(Number) })
        expect(refused.extra.retryAfter).toBeGreaterThan(0)
        expect(fetches).toBe(CLAIM_FETCH_BURST)

        // Another caller still gets its own fetches.
        const other = await manageGCRRoutines("0x" + "77".repeat(32), {
            method: "getHumanPassportClaim",
            params: [addresses.at(-1)],
        })
        expect(other.result).toBe(200)
    })
})
