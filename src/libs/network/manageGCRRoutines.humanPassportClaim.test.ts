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
    beforeEach(() => {
        spies.push(
            spyOn(HumanPassportProvider, "getInstance").mockReturnValue({
                verifyAddress: async () => reported,
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
})
