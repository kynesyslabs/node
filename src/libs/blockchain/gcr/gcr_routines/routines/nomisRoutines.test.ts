import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { applyNomisIdentityUpsert } from "./nomisRoutines"
import { NomisApiClient } from "@/libs/identity/tools/nomis"

const ADDRESS = "0x" + "AB".repeat(20)

function account(): any {
    return { pubkey: "0x" + "11".repeat(32), identities: { xm: {}, nomis: {} } }
}

const edit = (data: Record<string, unknown>) => ({
    account: "0x" + "11".repeat(32),
    data: { chain: "evm", subchain: "mainnet", address: ADDRESS, ...data },
})

describe("applyNomisIdentityUpsert", () => {
    let getWalletScore: ReturnType<typeof spyOn>
    let requested: Array<{ address: string; options: any }>

    beforeEach(() => {
        requested = []
        getWalletScore = spyOn(NomisApiClient.getInstance(), "getWalletScore").mockImplementation(
            async (address: string, options: any) => {
                requested.push({ address, options })
                return {
                    address,
                    score: 42,
                    scoreType: 0,
                    mintData: { mintedScore: 40, deadline: 123 },
                } as any
            },
        )
    })
    afterEach(() => getWalletScore.mockRestore())

    it("stores the score Nomis returns and ignores the one in the payload", async () => {
        const gcr = account()
        const r = await applyNomisIdentityUpsert(
            edit({
                score: 9_999,
                scoreType: 7,
                mintedScore: 9_999,
                lastSyncedAt: "2000-01-01T00:00:00.000Z",
                metadata: { referralCode: "forged" },
            }),
            gcr,
        )

        expect(r.success).toBe(true)
        const saved = gcr.identities.nomis.evm.mainnet[0]
        expect(saved.score).toBe(42)
        expect(saved.scoreType).toBe(0)
        expect(saved.mintedScore).toBe(40)
        expect(saved.metadata.referralCode).toBeUndefined()
        expect(saved.lastSyncedAt).not.toBe("2000-01-01T00:00:00.000Z")
    })

    it("does not need a score in the payload at all", async () => {
        const gcr = account()
        const r = await applyNomisIdentityUpsert(edit({}), gcr)
        expect(r.success).toBe(true)
        expect(gcr.identities.nomis.evm.mainnet[0].score).toBe(42)
    })

    it("asks Nomis for the default model, not the one the payload names", async () => {
        await applyNomisIdentityUpsert(edit({ scoreType: 7 }), account())
        expect(requested).toHaveLength(1)
        expect(requested[0].address).toBe(ADDRESS.toLowerCase())
        expect(requested[0].options).toEqual({ chain: "evm" })
    })

    it("refuses the identity when Nomis cannot be reached, instead of trusting the payload", async () => {
        getWalletScore.mockImplementation(async () => {
            throw new Error("down")
        })
        const gcr = account()
        const r = await applyNomisIdentityUpsert(edit({ score: 9_999 }), gcr)
        expect(r.success).toBe(false)
        expect(gcr.identities.nomis.evm).toBeUndefined()
    })

    it("refuses an identity for which Nomis has no score", async () => {
        getWalletScore.mockImplementation(async () => ({ score: 0 }) as any)
        const r = await applyNomisIdentityUpsert(edit({ score: 9_999 }), account())
        expect(r.success).toBe(false)
    })
})
